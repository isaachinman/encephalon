import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { EncephalonError, fail, failWithCause, wrapIo } from './errors.ts'
import { cacheDirectory, withOperationLock } from './lock.ts'
import { canonicalRecordPath, readRecords } from './records.ts'
import { resolveRepository } from './repository.ts'
import { MAX_RECORD_BYTES, parseRecordFile, validateArtifactPath } from './schema.ts'
import type {
  BrainRecord,
  CompactBrainRecord,
  GatherInput,
  GatherResult,
  HydrateResult,
  ListRecordsInput,
  PrepareResult,
  RootInput,
  SearchRecordsInput,
  ShowRecordInput,
} from './types.ts'

const PACKAGE_VERSION = '0.1.0'
const SCHEMA_VERSION = '1'
const MAX_REPOSITORY_CHANGE_RETRIES = 3
const DATABASE_FILENAME = 'brain.sqlite'
const MAX_CACHE_METADATA_BYTES = 1024 * 1024
const MAX_CACHE_RECORD_BYTES = MAX_RECORD_BYTES + 4096
const MAX_CACHE_RECORDS = 100_000
const METADATA_KEYS = [
  'artifactPaths',
  'manifest',
  'packageVersion',
  'recordsIndexed',
  'repositoryRealpath',
  'schemaVersion',
] as const

type SQLiteModule = {
  DatabaseSync: new (path: string) => DatabaseSync
}

type Metadata = {
  schemaVersion: string
  packageVersion: string
  repositoryRealpath: string
  manifest: string
  artifactPaths: string[]
  recordsIndexed: number
}

type ManifestEntry = {
  path: string
  type: 'directory' | 'file' | 'missing' | 'other' | 'symlink'
  size?: string
  mtimeNanoseconds?: string
  ctimeNanoseconds?: string
}

type RecordRow = {
  record_json: unknown
}

type CompactRow = {
  id: unknown
  kind: unknown
  subject: unknown
  path: unknown
  summary: unknown
  rank: unknown
  snippet: unknown
}

class CacheSchemaMismatch extends Error {}

let sqliteModule: SQLiteModule | undefined
let sqliteFeaturesVerified = false

const loadSQLite = () => {
  if (sqliteModule === undefined) {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
    if (major < 24 || (major === 24 && minor < 15)) {
      return fail('UNSUPPORTED_RUNTIME', 'Encephalon requires Node.js 24.15.0 or newer.', {
        runtime: process.versions.node,
      })
    }
    try {
      sqliteModule = createRequire(import.meta.url)('node:sqlite') as SQLiteModule
    } catch (error) {
      return failWithCause(
        'UNSUPPORTED_RUNTIME',
        'This Node.js runtime does not provide the required built-in SQLite API.',
        { runtime: process.versions.node },
        error,
      )
    }
  }
  return sqliteModule
}

const databasePath = (root: string) => resolve(cacheDirectory(root), DATABASE_FILENAME)

const isRecoverableCacheFailure = (error: unknown) => {
  const sqlite = error as { errcode?: unknown; message?: unknown }
  return (
    error instanceof CacheSchemaMismatch ||
    sqlite.errcode === 11 ||
    sqlite.errcode === 26 ||
    (typeof sqlite.message === 'string' &&
      /database disk image is malformed|file is not a database|malformed database schema|no such (?:column|table)|has no column named/i.test(
        sqlite.message,
      ))
  )
}

const assertTableColumns = (database: DatabaseSync, table: string, expected: string[]) => {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  const names = columns.map(column => column.name)
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new CacheSchemaMismatch(`The ${table} cache table has an incompatible schema.`)
  }
}

const removeCorruptCache = (root: string) => {
  const path = databasePath(root)
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(candidate, { force: true })
  }
}

const verifySQLiteFeatures = (DatabaseConstructor: SQLiteModule['DatabaseSync']) => {
  if (sqliteFeaturesVerified) {
    return
  }
  const probe = new DatabaseConstructor(':memory:')
  try {
    probe.exec('CREATE VIRTUAL TABLE record_search_probe USING fts5(text)')
    probe
      .prepare(
        "SELECT bm25(record_search_probe), snippet(record_search_probe, 0, '[', ']', '…', 8) FROM record_search_probe WHERE record_search_probe MATCH ?",
      )
      .all('probe')
    sqliteFeaturesVerified = true
  } catch (error) {
    return failWithCause(
      'UNSUPPORTED_RUNTIME',
      'The built-in SQLite runtime does not provide the required FTS5, bm25, and snippet features.',
      {},
      error,
    )
  } finally {
    probe.close()
  }
}

const openDatabase = (root: string) => {
  const { DatabaseSync: DatabaseConstructor } = loadSQLite()
  verifySQLiteFeatures(DatabaseConstructor)
  const database = new DatabaseConstructor(databasePath(root))
  try {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
    database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        path TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        summary TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_active_order
        ON records(active, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS records_kind_subject
        ON records(kind, subject);
      CREATE VIRTUAL TABLE IF NOT EXISTS record_search USING fts5(
        id UNINDEXED,
        text
      );
    `)
    assertTableColumns(database, 'metadata', ['key', 'value'])
    assertTableColumns(database, 'records', [
      'id',
      'kind',
      'subject',
      'source',
      'created_at',
      'path',
      'active',
      'summary',
      'record_json',
    ])
    assertTableColumns(database, 'record_search', ['id', 'text'])
    const searchSchema = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record_search'")
      .get() as { sql?: unknown } | undefined
    if (typeof searchSchema?.sql !== 'string' || !/\bUSING\s+fts5\b/i.test(searchSchema.sql)) {
      throw new CacheSchemaMismatch('The record_search cache table is not an FTS5 table.')
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

const posixRelative = (root: string, path: string) =>
  path
    .slice(root.length)
    .replace(/^[/\\]+/, '')
    .replaceAll('\\', '/')

const statEntry = (root: string, path: string): ManifestEntry => {
  if (!existsSync(path)) {
    return { path: posixRelative(root, path), type: 'missing' }
  }
  const linkMetadata = lstatSync(path)
  if (linkMetadata.isSymbolicLink()) {
    return { path: posixRelative(root, path), type: 'symlink' }
  }
  const metadata = statSync(path, { bigint: true })
  let type: ManifestEntry['type']
  if (metadata.isDirectory()) {
    type = 'directory'
  } else if (metadata.isFile()) {
    type = 'file'
  } else {
    type = 'other'
  }
  return {
    ctimeNanoseconds: metadata.ctimeNs.toString(),
    mtimeNanoseconds: metadata.mtimeNs.toString(),
    path: posixRelative(root, path),
    size: metadata.size.toString(),
    type,
  }
}

const recordManifestEntries = (root: string) => {
  const brainDirectory = resolve(root, 'encephalon')
  if (!existsSync(brainDirectory)) {
    return [{ path: 'encephalon', type: 'missing' as const }]
  }
  const brainEntry = statEntry(root, brainDirectory)
  if (brainEntry.type !== 'directory') {
    return [brainEntry]
  }
  const children = readdirSync(brainDirectory, { withFileTypes: true })
    .filter(entry => entry.name !== '_artifacts')
    .sort((first, second) => first.name.localeCompare(second.name))
    .flatMap(entry => {
      const kindPath = resolve(brainDirectory, entry.name)
      const kindEntry = statEntry(root, kindPath)
      if (!entry.isDirectory() || entry.isSymbolicLink() || kindEntry.type !== 'directory') {
        return [kindEntry]
      }
      const recordEntries = readdirSync(kindPath, { withFileTypes: true })
        .sort((first, second) => first.name.localeCompare(second.name))
        .map(recordEntry => statEntry(root, resolve(kindPath, recordEntry.name)))
      return [kindEntry, ...recordEntries]
    })
  return [brainEntry, ...children]
}

const repositoryManifest = (root: string, artifactPaths: string[]) => {
  const entries = [
    ...recordManifestEntries(root),
    ...[...artifactPaths]
      .sort((first, second) => first.localeCompare(second))
      .map(path => statEntry(root, resolve(root, 'encephalon', ...path.split('/')))),
  ]
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')

function assertCacheValueSize(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string') {
    throw new CacheSchemaMismatch('Cached values must be text.')
  }
  if (byteLength(value) > maximum) {
    throw new CacheSchemaMismatch('A cached value exceeds its size limit.')
  }
}

const parseCacheJson = (value: unknown, maximum: number) => {
  assertCacheValueSize(value, maximum)
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new CacheSchemaMismatch('The cache contains malformed JSON.', { cause: error })
  }
}

const validateCachedArtifactPath = (value: unknown) => {
  if (typeof value !== 'string') {
    throw new CacheSchemaMismatch('Cached artifact metadata must contain strings.')
  }
  const [, kind, id] = value.split('/')
  if (kind === undefined || id === undefined) {
    throw new CacheSchemaMismatch('Cached artifact metadata contains an invalid path.')
  }
  try {
    return validateArtifactPath(value, kind, id)
  } catch (error) {
    throw new CacheSchemaMismatch('Cached artifact metadata contains an invalid path.', { cause: error })
  }
}

const parseCachedRecord = (value: unknown): BrainRecord => {
  const parsed = parseCacheJson(value, MAX_CACHE_RECORD_BYTES)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CacheSchemaMismatch('Cached record JSON must be an object.')
  }
  const { path, ...recordFile } = parsed as Record<string, unknown>
  if (typeof path !== 'string') {
    throw new CacheSchemaMismatch('Cached record JSON must include a runtime path.')
  }
  try {
    const record = parseRecordFile(recordFile)
    if (path === canonicalRecordPath(record)) {
      return { ...record, path }
    }
  } catch {
    // Normalise every cached-row validation failure into disposable cache corruption.
  }
  throw new CacheSchemaMismatch('Cached record JSON does not match the canonical record schema.')
}

const summaryForRecord = (record: BrainRecord) => {
  if (record.payload !== null && !Array.isArray(record.payload) && typeof record.payload === 'object') {
    const { summary } = record.payload
    if (typeof summary === 'string' && summary.trim().length > 0) {
      return summary.trim()
    }
  }
  return null
}

const readMetadata = (database: DatabaseSync): Metadata | undefined => {
  const rows = database.prepare('SELECT key, value FROM metadata').all() as Array<{
    key?: unknown
    value?: unknown
  }>
  if (rows.length === 0) {
    return
  }
  const values = new Map<string, string>()
  for (const row of rows) {
    if (
      typeof row.key !== 'string' ||
      typeof row.value !== 'string' ||
      !(METADATA_KEYS as readonly string[]).includes(row.key)
    ) {
      throw new CacheSchemaMismatch('The cache metadata contains invalid keys or values.')
    }
    assertCacheValueSize(row.value, MAX_CACHE_METADATA_BYTES)
    values.set(row.key, row.value)
  }
  if (values.size !== METADATA_KEYS.length || METADATA_KEYS.some(key => values.get(key) === undefined)) {
    throw new CacheSchemaMismatch('The cache metadata key set is incomplete.')
  }
  const artifactPathsValue = values.get('artifactPaths')
  const recordsIndexedValue = values.get('recordsIndexed')
  if (artifactPathsValue === undefined || recordsIndexedValue === undefined) {
    throw new CacheSchemaMismatch('The cache metadata key set is incomplete.')
  }
  const artifactPaths = parseCacheJson(artifactPathsValue, MAX_CACHE_METADATA_BYTES)
  const recordsIndexed = Number(recordsIndexedValue)
  if (
    !Array.isArray(artifactPaths) ||
    artifactPaths.length > MAX_CACHE_RECORDS ||
    !Number.isSafeInteger(recordsIndexed) ||
    recordsIndexed < 0 ||
    recordsIndexed > MAX_CACHE_RECORDS
  ) {
    throw new CacheSchemaMismatch('The cache metadata contains invalid values.')
  }
  const validatedArtifactPaths = artifactPaths.map(validateCachedArtifactPath)
  return {
    artifactPaths: validatedArtifactPaths,
    manifest: values.get('manifest') ?? '',
    packageVersion: values.get('packageVersion') ?? '',
    recordsIndexed,
    repositoryRealpath: values.get('repositoryRealpath') ?? '',
    schemaVersion: values.get('schemaVersion') ?? '',
  }
}

const comparablePath = (path: string) => {
  const normalized = path.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const assertCacheScope = (root: string, metadata: Metadata | undefined) => {
  if (
    metadata !== undefined &&
    comparablePath(metadata.repositoryRealpath) !== comparablePath(realpathSync.native(root))
  ) {
    return fail('CACHE_SCOPE_MISMATCH', 'The Encephalon cache belongs to a different repository.', {
      cachedRepository: metadata.repositoryRealpath,
      expectedRepository: realpathSync.native(root),
    })
  }
}

const assertCacheContentConsistent = (database: DatabaseSync, metadata: Metadata) => {
  const recordRows = database
    .prepare('SELECT id, kind, subject, source, created_at, path, active, summary, record_json FROM records')
    .all() as Array<
    RecordRow & {
      active?: unknown
      created_at?: unknown
      id?: unknown
      kind?: unknown
      path?: unknown
      source?: unknown
      subject?: unknown
      summary?: unknown
    }
  >
  if (recordRows.length !== metadata.recordsIndexed || recordRows.length > MAX_CACHE_RECORDS) {
    throw new CacheSchemaMismatch('The cache record table does not match its metadata.')
  }
  const records = recordRows.map(row => ({ record: parseCachedRecord(row.record_json), row }))
  const superseded = new Set(records.flatMap(({ record }) => record.supersedes ?? []))
  for (const { record, row } of records) {
    const active = superseded.has(record.id) ? 0 : 1
    if (
      row.id !== record.id ||
      row.kind !== record.kind ||
      row.subject !== record.subject ||
      row.source !== record.source ||
      row.created_at !== record.createdAt ||
      row.path !== record.path ||
      row.active !== active ||
      row.summary !== summaryForRecord(record)
    ) {
      throw new CacheSchemaMismatch('The cache record table does not match its canonical JSON.')
    }
  }
  const counts = database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM records) AS records,
        (SELECT COUNT(*) FROM record_search) AS searchRows,
        (SELECT COUNT(DISTINCT id) FROM record_search) AS distinctSearchRows,
        (SELECT COUNT(*) FROM records LEFT JOIN record_search ON records.id = record_search.id WHERE record_search.id IS NULL) AS missingSearchRows,
        (SELECT COUNT(*) FROM record_search LEFT JOIN records ON records.id = record_search.id WHERE records.id IS NULL) AS orphanSearchRows
      `,
    )
    .get() as {
    distinctSearchRows?: unknown
    missingSearchRows?: unknown
    orphanSearchRows?: unknown
    records?: unknown
    searchRows?: unknown
  }
  if (
    counts.records !== metadata.recordsIndexed ||
    counts.searchRows !== metadata.recordsIndexed ||
    counts.distinctSearchRows !== metadata.recordsIndexed ||
    counts.missingSearchRows !== 0 ||
    counts.orphanSearchRows !== 0
  ) {
    throw new CacheSchemaMismatch('The cache record and search tables are inconsistent.')
  }
}

const metadataIsFresh = (
  root: string,
  database: DatabaseSync,
  metadata: Metadata | undefined,
): metadata is Metadata => {
  assertCacheScope(root, metadata)
  const fresh =
    metadata !== undefined &&
    metadata.schemaVersion === SCHEMA_VERSION &&
    metadata.packageVersion === PACKAGE_VERSION &&
    metadata.manifest === repositoryManifest(root, metadata.artifactPaths)
  if (fresh) {
    assertCacheContentConsistent(database, metadata)
  }
  return fresh
}

const searchDocumentForRecord = (record: BrainRecord) =>
  [
    record.kind,
    record.subject,
    record.source,
    summaryForRecord(record),
    JSON.stringify(record.payload),
    record.searchText ?? '',
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')

const writeMetadata = (database: DatabaseSync, metadata: Metadata) => {
  const statement = database.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)')
  const values = {
    artifactPaths: JSON.stringify(metadata.artifactPaths),
    manifest: metadata.manifest,
    packageVersion: metadata.packageVersion,
    recordsIndexed: String(metadata.recordsIndexed),
    repositoryRealpath: metadata.repositoryRealpath,
    schemaVersion: metadata.schemaVersion,
  }
  for (const [key, value] of Object.entries(values)) {
    statement.run(key, value)
  }
}

const rebuildCache = (root: string): PrepareResult => {
  const attempts = Array.from({ length: MAX_REPOSITORY_CHANGE_RETRIES }, (_, index) => index)
  for (const attempt of attempts) {
    const recordManifestBefore = repositoryManifest(root, [])
    let records: BrainRecord[]
    try {
      records = readRecords({ root })
    } catch (error) {
      if (repositoryManifest(root, []) !== recordManifestBefore) {
        if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
          return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
        }
        continue
      }
      throw error
    }
    const artifactPaths = [...new Set(records.flatMap(record => record.artifacts ?? []))].sort((first, second) =>
      first.localeCompare(second),
    )
    const manifestBefore = repositoryManifest(root, artifactPaths)
    if (repositoryManifest(root, []) !== recordManifestBefore) {
      if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
        return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
      }
      continue
    }
    const superseded = new Set(records.flatMap(record => record.supersedes ?? []))
    let database: DatabaseSync
    try {
      database = openDatabase(root)
    } catch (error) {
      if (!isRecoverableCacheFailure(error)) {
        throw error
      }
      removeCorruptCache(root)
      database = openDatabase(root)
    }
    try {
      let existingMetadata: Metadata | undefined
      try {
        existingMetadata = readMetadata(database)
      } catch (error) {
        if (!(error instanceof CacheSchemaMismatch)) {
          throw error
        }
      }
      assertCacheScope(root, existingMetadata)
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec('DELETE FROM record_search; DELETE FROM records; DELETE FROM metadata;')
        const insertRecord = database.prepare(`
          INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const insertSearch = database.prepare('INSERT INTO record_search(id, text) VALUES (?, ?)')
        for (const record of records) {
          insertRecord.run(
            record.id,
            record.kind,
            record.subject,
            record.source,
            record.createdAt,
            record.path,
            superseded.has(record.id) ? 0 : 1,
            summaryForRecord(record),
            JSON.stringify(record),
          )
          insertSearch.run(record.id, searchDocumentForRecord(record))
        }
        writeMetadata(database, {
          artifactPaths,
          manifest: manifestBefore,
          packageVersion: PACKAGE_VERSION,
          recordsIndexed: records.length,
          repositoryRealpath: realpathSync.native(root),
          schemaVersion: SCHEMA_VERSION,
        })
        if (repositoryManifest(root, artifactPaths) === manifestBefore) {
          database.exec('COMMIT')
          return { hydrated: true, recordsIndexed: records.length }
        }
        database.exec('ROLLBACK')
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // The original transaction failure is more useful than a secondary rollback failure.
        }
        throw error
      }
    } finally {
      database.close()
    }
    if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
      return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
    }
  }
  return fail('INTERNAL_ERROR', 'The Encephalon cache rebuild ended unexpectedly.')
}

const prepareResolvedWithoutCorruptionRecovery = (root: string): PrepareResult => {
  if (!existsSync(databasePath(root))) {
    return withOperationLock(root, () => {
      if (existsSync(databasePath(root))) {
        const recheck = openDatabase(root)
        try {
          const metadata = readMetadata(recheck)
          if (metadataIsFresh(root, recheck, metadata)) {
            return {
              hydrated: false,
              recordsIndexed: metadata.recordsIndexed,
            }
          }
        } finally {
          recheck.close()
        }
      }
      return rebuildCache(root)
    })
  }
  const database = openDatabase(root)
  try {
    const metadata = readMetadata(database)
    if (metadataIsFresh(root, database, metadata)) {
      return { hydrated: false, recordsIndexed: metadata.recordsIndexed }
    }
  } finally {
    database.close()
  }
  return withOperationLock(root, () => {
    const recheck = openDatabase(root)
    try {
      const metadata = readMetadata(recheck)
      if (metadataIsFresh(root, recheck, metadata)) {
        return {
          hydrated: false,
          recordsIndexed: metadata.recordsIndexed,
        }
      }
    } finally {
      recheck.close()
    }
    return rebuildCache(root)
  })
}

const prepareResolved = (root: string): PrepareResult => {
  try {
    return prepareResolvedWithoutCorruptionRecovery(root)
  } catch (error) {
    if (!isRecoverableCacheFailure(error)) {
      throw error
    }
    return withOperationLock(root, () => rebuildCache(root))
  }
}

export const hydrateResolvedRepository = (root: string, lock = true): PrepareResult =>
  lock ? withOperationLock(root, () => rebuildCache(root)) : rebuildCache(root)

export const prepare = (input: RootInput = {}): PrepareResult => {
  const root = resolveRepository(input)
  try {
    return prepareResolved(root)
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to prepare the Encephalon cache.', error)
  }
}

export const hydrate = (input: RootInput = {}): HydrateResult => {
  const root = resolveRepository(input)
  try {
    const result = hydrateResolvedRepository(root)
    return { recordsIndexed: result.recordsIndexed }
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to hydrate the Encephalon cache.', error)
  }
}

const positiveLimit = (value: unknown, fallback = 20) => {
  const limit = value === undefined ? fallback : value
  if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= 1000) {
    return limit
  }
  return fail('INVALID_ARGUMENT', 'limit must be an integer between 1 and 1000.', { field: 'limit' })
}

const readFreshDatabase = <Result>(root: string, read: (database: DatabaseSync) => Result) => {
  const database = openDatabase(root)
  try {
    const metadata = readMetadata(database)
    if (!metadataIsFresh(root, database, metadata)) {
      throw new CacheSchemaMismatch('The cache is stale before read.')
    }
    return read(database)
  } finally {
    database.close()
  }
}

const withPreparedDatabase = <Result>(input: RootInput, read: (database: DatabaseSync) => Result) => {
  const root = resolveRepository(input)
  try {
    prepareResolved(root)
    return readFreshDatabase(root, read)
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    if (isRecoverableCacheFailure(error)) {
      withOperationLock(root, () => rebuildCache(root))
      try {
        return readFreshDatabase(root, read)
      } catch (retryError) {
        if (retryError instanceof EncephalonError) {
          throw retryError
        }
        return wrapIo('Unable to read the Encephalon cache.', retryError)
      }
    }
    return wrapIo('Unable to read the Encephalon cache.', error)
  }
}

const parseRecordRow = (row: RecordRow) => parseCachedRecord(row.record_json)

export const listRecords = (input: ListRecordsInput = {}): BrainRecord[] =>
  withPreparedDatabase(input, database => {
    const conditions = [
      input.includeSuperseded === true ? undefined : 'active = 1',
      input.kind === undefined ? undefined : 'kind = ?',
      input.subject === undefined ? undefined : 'subject = ?',
    ].filter((value): value is string => value !== undefined)
    const parameters = [
      ...(input.kind === undefined ? [] : [input.kind]),
      ...(input.subject === undefined ? [] : [input.subject]),
      positiveLimit(input.limit),
    ]
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const rows = database
      .prepare(`SELECT record_json FROM records ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...parameters) as RecordRow[]
    return rows.map(parseRecordRow)
  })

export const showRecord = (input: ShowRecordInput): BrainRecord | null =>
  withPreparedDatabase(input, database => {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      return fail('INVALID_ARGUMENT', 'id must be a non-empty string.', {
        field: 'id',
      })
    }
    const activeClause = input.activeOnly === true ? ' AND active = 1' : ''
    const row = database.prepare(`SELECT record_json FROM records WHERE id = ?${activeClause}`).get(input.id) as
      | RecordRow
      | undefined
    return row === undefined ? null : parseRecordRow(row)
  })

const literalMatchQuery = (query: unknown) => {
  if (typeof query !== 'string') {
    return fail('INVALID_ARGUMENT', 'query must be a string.', {
      field: 'query',
    })
  }
  const terms = query.split(/[^A-Za-z0-9_]+/u).filter(term => term.length > 0)
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
}

const searchRows = (database: DatabaseSync, input: SearchRecordsInput) => {
  const match = literalMatchQuery(input.query)
  if (match.length === 0) {
    return []
  }
  const conditions = [
    'record_search MATCH ?',
    input.includeSuperseded === true ? undefined : 'records.active = 1',
    input.kind === undefined ? undefined : 'records.kind = ?',
  ].filter((value): value is string => value !== undefined)
  const parameters = [match, ...(input.kind === undefined ? [] : [input.kind]), positiveLimit(input.limit)]
  return database
    .prepare(`
    SELECT
      records.record_json,
      records.id,
      records.kind,
      records.subject,
      records.path,
      records.summary,
      bm25(record_search) AS rank,
      snippet(record_search, 1, '[', ']', '...', 16) AS snippet
    FROM record_search
    JOIN records ON records.id = record_search.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank ASC, records.created_at DESC, records.id DESC
    LIMIT ?
  `)
    .all(...parameters) as Array<RecordRow & CompactRow>
}

const compactRank = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  throw new CacheSchemaMismatch('Cached search rank must be a finite number.')
}

const compactSnippet = (value: unknown) => {
  if (typeof value === 'string') {
    return value
  }
  throw new CacheSchemaMismatch('Cached search snippet must be text.')
}

export const searchRecords = (input: SearchRecordsInput): BrainRecord[] =>
  withPreparedDatabase(input, database => searchRows(database, input).map(parseRecordRow))

export const searchCompactRecords = (input: SearchRecordsInput): CompactBrainRecord[] =>
  withPreparedDatabase(input, database =>
    searchRows(database, input).map(row => {
      const record = parseRecordRow(row)
      return {
        id: record.id,
        kind: record.kind,
        path: record.path,
        rank: compactRank(row.rank),
        snippet: compactSnippet(row.snippet),
        subject: record.subject,
        summary: summaryForRecord(record),
      }
    }),
  )

const readGatherFromDatabase = (
  database: DatabaseSync,
  input: GatherInput,
  hydrated: HydrateResult | null,
): GatherResult => {
  const searches = input.searches ?? []
  const shows = input.shows ?? []
  return {
    hydrated,
    records: shows.map(id => {
      const activeClause = input.includeSuperseded === true ? '' : ' AND active = 1'
      const row = database.prepare(`SELECT record_json FROM records WHERE id = ?${activeClause}`).get(id) as
        | RecordRow
        | undefined
      return { id, record: row === undefined ? null : parseRecordRow(row) }
    }),
    searches: searches.map(query => ({
      kind: input.kind ?? null,
      query,
      results: searchRows(database, { ...input, query }).map(row => {
        const record = parseRecordRow(row)
        return {
          id: record.id,
          kind: record.kind,
          path: record.path,
          rank: compactRank(row.rank),
          snippet: compactSnippet(row.snippet),
          subject: record.subject,
          summary: summaryForRecord(record),
        }
      }),
    })),
  }
}

export const gatherRecords = (input: GatherInput): GatherResult => {
  const root = resolveRepository(input)
  try {
    let hydrated: HydrateResult | null = null
    if (input.hydrate === true) {
      hydrated = {
        recordsIndexed: hydrateResolvedRepository(root).recordsIndexed,
      }
    } else {
      prepareResolved(root)
    }
    const searches = input.searches ?? []
    const shows = input.shows ?? []
    if (!(Array.isArray(searches) && searches.every(query => typeof query === 'string'))) {
      return fail('INVALID_ARGUMENT', 'searches must be an array of strings.', {
        field: 'searches',
      })
    }
    if (!(Array.isArray(shows) && shows.every(id => typeof id === 'string'))) {
      return fail('INVALID_ARGUMENT', 'shows must be an array of strings.', {
        field: 'shows',
      })
    }
    return readFreshDatabase(root, database => readGatherFromDatabase(database, input, hydrated))
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    if (isRecoverableCacheFailure(error)) {
      const recovered = withOperationLock(root, () => rebuildCache(root))
      try {
        return readFreshDatabase(root, database =>
          readGatherFromDatabase(
            database,
            input,
            input.hydrate === true ? { recordsIndexed: recovered.recordsIndexed } : null,
          ),
        )
      } catch (retryError) {
        if (retryError instanceof EncephalonError) {
          throw retryError
        }
        return wrapIo('Unable to gather Encephalon records.', retryError)
      }
    }
    return wrapIo('Unable to gather Encephalon records.', error)
  }
}
