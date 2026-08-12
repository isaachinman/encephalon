import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  parseGatherInput,
  parseListRecordsInput,
  parseRootInput,
  parseSearchRecordsInput,
  parseShowRecordInput,
} from './api-input.ts'
import {
  assertCacheDatabase,
  CacheDatabaseFailure,
  CacheDatabaseSidecarChanged,
  type CacheLocation,
  cacheDatabaseDidOpen,
  cacheDatabaseWillOpen,
  failCacheDatabase,
  inspectCacheDatabase,
  inspectCacheLocation,
  MAX_CACHE_DATABASE_OPEN_ATTEMPTS,
  prepareCacheDatabase,
  quarantineCacheDatabase,
  refreshCacheDatabase,
} from './cache-location.ts'
import { EncephalonError, fail, failWithCause, wrapIo } from './errors.ts'
import { PACKAGE_VERSION } from './generated/version.ts'
import { withOperationLock } from './lock.ts'
import { ordinalStringCompare } from './order.ts'
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

const SCHEMA_VERSION = '1'
const MAX_REPOSITORY_CHANGE_RETRIES = 3
export const MAX_QUERY_BYTES = 1024
export const MAX_QUERY_TERMS = 32
export const MAX_GATHER_SEARCHES = 16
export const MAX_GATHER_SHOWS = 64
export const MAX_FULL_RESULT_LIMIT = 50
export const MAX_COMPACT_RESULT_LIMIT = 100
export const MAX_FULL_RESPONSE_BYTES = 4 * 1024 * 1024
const SQLITE_BUSY_TIMEOUT_MILLISECONDS = 1000
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
  DatabaseSync: new (
    path: string,
    options?: {
      readOnly?: boolean
      timeout?: number
    },
  ) => DatabaseSync
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
  record_bytes?: unknown
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

type SearchStatementInput = Pick<SearchRecordsInput, 'includeSuperseded' | 'kind' | 'limit'>

type CacheReadTestHooks = {
  afterCompactSearchRead?: ((query: string) => void) | undefined
  afterShowRead?: ((id: string) => void) | undefined
  onCompactSearchPrepare?: ((source: string) => void) | undefined
  onShowPrepare?: ((source: string) => void) | undefined
}

class CacheSchemaMismatch extends Error {}

let sqliteModule: SQLiteModule | undefined
let sqliteFeaturesVerified = false

export const cacheReadTestHooks: CacheReadTestHooks = {}

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

const isRecoverableCacheFailure = (error: unknown) => {
  const failure = error instanceof CacheDatabaseFailure ? error.failure : error
  const sqlite = failure as { errcode?: unknown; message?: unknown }
  return (
    failure instanceof CacheSchemaMismatch ||
    sqlite.errcode === 8 ||
    sqlite.errcode === 14 ||
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

const removeCorruptCache = (location: CacheLocation, error: unknown) => {
  if (error instanceof CacheDatabaseFailure) {
    return quarantineCacheDatabase(location, error.database)
  }
  throw error
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

const assertCacheSchema = (database: DatabaseSync) => {
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
}

const createCacheSchema = (database: DatabaseSync) => {
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
}

const openWriterDatabase = (location: CacheLocation) => {
  const { DatabaseSync: DatabaseConstructor } = loadSQLite()
  verifySQLiteFeatures(DatabaseConstructor)
  let cacheDatabase = prepareCacheDatabase(location, 'brain.sqlite')
  const attempts = Array.from({ length: MAX_CACHE_DATABASE_OPEN_ATTEMPTS }, (_, index) => index)
  for (const attempt of attempts) {
    cacheDatabaseWillOpen(cacheDatabase)
    cacheDatabase = assertCacheDatabase(location, cacheDatabase)
    let database: DatabaseSync
    try {
      database = new DatabaseConstructor(cacheDatabase.path, {
        timeout: SQLITE_BUSY_TIMEOUT_MILLISECONDS,
      })
    } catch (error) {
      return failCacheDatabase(error, cacheDatabase)
    }
    try {
      cacheDatabaseDidOpen(cacheDatabase)
      // Node's SQLite API accepts only pathnames, leaving a narrow replacement race
      // between this identity check and SQLite's internal open.
      cacheDatabase = assertCacheDatabase(location, cacheDatabase)
      database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
      cacheDatabase = refreshCacheDatabase(location, cacheDatabase)
      createCacheSchema(database)
      assertCacheSchema(database)
      cacheDatabase = assertCacheDatabase(location, cacheDatabase)
      return database
    } catch (error) {
      if (error instanceof CacheDatabaseSidecarChanged) {
        database.close()
        cacheDatabase = error.database
        if (attempt === MAX_CACHE_DATABASE_OPEN_ATTEMPTS - 1) {
          throw error
        }
      } else {
        let validationError: unknown
        try {
          cacheDatabase = assertCacheDatabase(location, cacheDatabase)
        } catch (candidate) {
          validationError = candidate
        }
        database.close()
        if (validationError !== undefined) {
          throw validationError
        }
        if (error instanceof EncephalonError) {
          throw error
        }
        return failCacheDatabase(error, cacheDatabase)
      }
    }
  }
  return fail('INTERNAL_ERROR', 'The Encephalon writer database open ended unexpectedly.')
}

const openReaderDatabase = (location: CacheLocation) => {
  const { DatabaseSync: DatabaseConstructor } = loadSQLite()
  verifySQLiteFeatures(DatabaseConstructor)
  let cacheDatabase = inspectCacheDatabase(location, 'brain.sqlite')
  if (cacheDatabase === undefined) {
    throw new CacheSchemaMismatch('The cache database disappeared before it was opened.')
  }
  const attempts = Array.from({ length: MAX_CACHE_DATABASE_OPEN_ATTEMPTS }, (_, index) => index)
  for (const attempt of attempts) {
    cacheDatabaseWillOpen(cacheDatabase)
    cacheDatabase = assertCacheDatabase(location, cacheDatabase)
    let database: DatabaseSync
    try {
      database = new DatabaseConstructor(cacheDatabase.path, {
        readOnly: true,
        timeout: SQLITE_BUSY_TIMEOUT_MILLISECONDS,
      })
    } catch (error) {
      return failCacheDatabase(error, cacheDatabase)
    }
    try {
      cacheDatabaseDidOpen(cacheDatabase)
      cacheDatabase = assertCacheDatabase(location, cacheDatabase)
      assertCacheSchema(database)
      cacheDatabase = assertCacheDatabase(location, cacheDatabase)
      return database
    } catch (error) {
      if (error instanceof CacheDatabaseSidecarChanged) {
        database.close()
        cacheDatabase = error.database
        if (attempt === MAX_CACHE_DATABASE_OPEN_ATTEMPTS - 1) {
          throw error
        }
      } else {
        let validationError: unknown
        try {
          cacheDatabase = assertCacheDatabase(location, cacheDatabase)
        } catch (candidate) {
          validationError = candidate
        }
        database.close()
        if (validationError !== undefined) {
          throw validationError
        }
        if (error instanceof EncephalonError) {
          throw error
        }
        return failCacheDatabase(error, cacheDatabase)
      }
    }
  }
  return fail('INTERNAL_ERROR', 'The Encephalon reader database open ended unexpectedly.')
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
    .sort((first, second) => ordinalStringCompare(first.name, second.name))
    .flatMap(entry => {
      const kindPath = resolve(brainDirectory, entry.name)
      const kindEntry = statEntry(root, kindPath)
      if (!entry.isDirectory() || entry.isSymbolicLink() || kindEntry.type !== 'directory') {
        return [kindEntry]
      }
      const recordEntries = readdirSync(kindPath, { withFileTypes: true })
        .sort((first, second) => ordinalStringCompare(first.name, second.name))
        .map(recordEntry => statEntry(root, resolve(kindPath, recordEntry.name)))
      return [kindEntry, ...recordEntries]
    })
  return [brainEntry, ...children]
}

const repositoryManifest = (root: string, artifactPaths: string[]) => {
  const entries = [
    ...recordManifestEntries(root),
    ...[...artifactPaths]
      .sort(ordinalStringCompare)
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

const readFreshMetadata = (root: string, location: CacheLocation): Metadata | undefined => {
  const database = openReaderDatabase(location)
  try {
    const metadata = readMetadata(database)
    return metadataIsFresh(root, database, metadata) ? metadata : undefined
  } finally {
    database.close()
  }
}

const rebuildCache = (root: string, location: CacheLocation = inspectCacheLocation(root)): PrepareResult => {
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
      ordinalStringCompare(first, second),
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
      database = openWriterDatabase(location)
    } catch (error) {
      if (!isRecoverableCacheFailure(error)) {
        throw error
      }
      removeCorruptCache(location, error)
      database = openWriterDatabase(location)
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

const prepareResolvedWithoutCorruptionRecovery = (
  root: string,
  location: CacheLocation,
  lock = true,
): PrepareResult => {
  const serialize = <Result>(operation: (captured: CacheLocation) => Result) =>
    lock ? withOperationLock(root, operation, {}, location) : operation(location)
  if (inspectCacheDatabase(location, 'brain.sqlite') === undefined) {
    return serialize(captured => {
      if (inspectCacheDatabase(captured, 'brain.sqlite') !== undefined) {
        try {
          const metadata = readFreshMetadata(root, captured)
          if (metadata !== undefined) {
            return { hydrated: false, recordsIndexed: metadata.recordsIndexed }
          }
        } catch (error) {
          if (!isRecoverableCacheFailure(error)) {
            throw error
          }
        }
      }
      return rebuildCache(root, captured)
    })
  }
  const cachedMetadata = readFreshMetadata(root, location)
  if (cachedMetadata !== undefined) {
    return { hydrated: false, recordsIndexed: cachedMetadata.recordsIndexed }
  }
  return serialize(captured => {
    try {
      const metadata = readFreshMetadata(root, captured)
      if (metadata !== undefined) {
        return { hydrated: false, recordsIndexed: metadata.recordsIndexed }
      }
    } catch (error) {
      if (!isRecoverableCacheFailure(error)) {
        throw error
      }
    }
    return rebuildCache(root, captured)
  })
}

const prepareResolved = (
  root: string,
  lock = true,
  capturedLocation: CacheLocation = inspectCacheLocation(root),
): PrepareResult => {
  try {
    return prepareResolvedWithoutCorruptionRecovery(root, capturedLocation, lock)
  } catch (error) {
    if (!isRecoverableCacheFailure(error)) {
      throw error
    }
    return lock
      ? withOperationLock(root, location => rebuildCache(root, location), {}, capturedLocation)
      : rebuildCache(root, capturedLocation)
  }
}

export const prepareResolvedRepository = (root: string, lock = true, location?: CacheLocation): PrepareResult =>
  prepareResolved(root, lock, location)

export const hydrateResolvedRepository = (root: string, lock = true, location?: CacheLocation): PrepareResult => {
  const captured = location ?? inspectCacheLocation(root)
  return lock
    ? withOperationLock(root, heldLocation => rebuildCache(root, heldLocation), {}, captured)
    : rebuildCache(root, captured)
}

export const prepare = (input: RootInput = {}): PrepareResult => {
  const root = resolveRepository(parseRootInput(input, 'prepare'))
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
  const root = resolveRepository(parseRootInput(input, 'hydrate'))
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

const budgetFailure = (field: string, budget: string, maximum: number, message: string) =>
  fail('INVALID_ARGUMENT', message, {
    budget,
    field,
    maximum,
  })

const positiveLimit = (value: unknown, maximum: number, budget: string, fallback = 20) => {
  const limit = value === undefined ? fallback : value
  if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && limit <= maximum) {
    return limit
  }
  return budgetFailure('limit', budget, maximum, `limit must be an integer between 1 and ${maximum}.`)
}

const fullResultLimit = (value: unknown) => positiveLimit(value, MAX_FULL_RESULT_LIMIT, 'fullResultLimit')

const compactResultLimit = (value: unknown) => positiveLimit(value, MAX_COMPACT_RESULT_LIMIT, 'compactResultLimit')

const readFreshDatabase = <Result>(root: string, location: CacheLocation, read: (database: DatabaseSync) => Result) => {
  const database = openReaderDatabase(location)
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
  let location: CacheLocation | undefined
  try {
    location = inspectCacheLocation(root)
    prepareResolved(root, true, location)
    return readFreshDatabase(root, location, read)
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    if (isRecoverableCacheFailure(error) && location !== undefined) {
      withOperationLock(root, captured => rebuildCache(root, captured), {}, location)
      try {
        return readFreshDatabase(root, location, read)
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

type FullResponseBudget = {
  bytes: number
}

const recordRowBytes = (row: RecordRow) => {
  if (typeof row.record_bytes === 'number' && Number.isFinite(row.record_bytes) && row.record_bytes >= 0) {
    return row.record_bytes
  }
  if (typeof row.record_json === 'string') {
    return byteLength(row.record_json)
  }
  return 0
}

const parseRecordRowWithinBudget = (row: RecordRow, budget: FullResponseBudget) => {
  budget.bytes += recordRowBytes(row)
  if (budget.bytes > MAX_FULL_RESPONSE_BYTES) {
    return budgetFailure(
      'response',
      'fullResponseBytes',
      MAX_FULL_RESPONSE_BYTES,
      `full-record responses may contain at most ${MAX_FULL_RESPONSE_BYTES} UTF-8 bytes.`,
    )
  }
  return parseRecordRow(row)
}

const parseRecordRowsWithinBudget = (rows: Iterable<RecordRow>) => {
  const budget = { bytes: 0 }
  return Array.from(rows, row => parseRecordRowWithinBudget(row, budget))
}

export const listRecords = (input: ListRecordsInput = {}): BrainRecord[] => {
  const parsed = parseListRecordsInput(input)
  const limit = fullResultLimit(parsed.limit)
  return withPreparedDatabase(parsed, database => {
    const conditions = [
      parsed.includeSuperseded === true ? undefined : 'active = 1',
      parsed.kind === undefined ? undefined : 'kind = ?',
      parsed.subject === undefined ? undefined : 'subject = ?',
    ].filter((value): value is string => value !== undefined)
    const parameters = [
      ...(parsed.kind === undefined ? [] : [parsed.kind]),
      ...(parsed.subject === undefined ? [] : [parsed.subject]),
      limit,
    ]
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const rows = database
      .prepare(
        `SELECT record_json, length(cast(record_json AS BLOB)) AS record_bytes FROM records ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .iterate(...parameters) as Iterable<RecordRow>
    return parseRecordRowsWithinBudget(rows)
  })
}

export const showRecord = (input: ShowRecordInput): BrainRecord | null => {
  const parsed = parseShowRecordInput(input)
  return withPreparedDatabase(parsed, database => {
    const activeClause = parsed.activeOnly === true ? ' AND active = 1' : ''
    const row = database
      .prepare(
        `SELECT record_json, length(cast(record_json AS BLOB)) AS record_bytes FROM records WHERE id = ?${activeClause}`,
      )
      .get(parsed.id) as RecordRow | undefined
    return row === undefined ? null : parseRecordRowWithinBudget(row, { bytes: 0 })
  })
}

const literalMatchQuery = (query: unknown) => {
  if (typeof query !== 'string') {
    return fail('INVALID_ARGUMENT', 'query must be a string.', {
      field: 'query',
    })
  }
  if (byteLength(query) > MAX_QUERY_BYTES) {
    return budgetFailure(
      'query',
      'queryBytes',
      MAX_QUERY_BYTES,
      `query must contain at most ${MAX_QUERY_BYTES} UTF-8 bytes.`,
    )
  }
  const terms = query.split(/[^A-Za-z0-9_]+/u).filter(term => term.length > 0)
  if (terms.length > MAX_QUERY_TERMS) {
    return budgetFailure(
      'query',
      'queryTerms',
      MAX_QUERY_TERMS,
      `query may contain at most ${MAX_QUERY_TERMS} literal terms.`,
    )
  }
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
}

const searchRows = (database: DatabaseSync, input: SearchRecordsInput, match: string, limit: number) => {
  if (match.length === 0) {
    return []
  }
  const conditions = [
    'record_search MATCH ?',
    input.includeSuperseded === true ? undefined : 'records.active = 1',
    input.kind === undefined ? undefined : 'records.kind = ?',
  ].filter((value): value is string => value !== undefined)
  const parameters = [match, ...(input.kind === undefined ? [] : [input.kind]), limit]
  return database
    .prepare(`
    SELECT
      records.record_json,
      length(cast(records.record_json AS BLOB)) AS record_bytes
    FROM record_search
    JOIN records ON records.id = record_search.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY bm25(record_search) ASC, records.created_at DESC, records.id DESC
    LIMIT ?
  `)
    .iterate(...parameters) as Iterable<RecordRow>
}

const compactText = (value: unknown, field: string) => {
  if (typeof value === 'string') {
    return value
  }
  throw new CacheSchemaMismatch(`Cached compact ${field} must be text.`)
}

const compactSummary = (value: unknown) => {
  if (value === null || typeof value === 'string') {
    return value
  }
  throw new CacheSchemaMismatch('Cached compact summary must be text or null.')
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

const compactRecordFromRow = (row: CompactRow): CompactBrainRecord => ({
  id: compactText(row.id, 'id'),
  kind: compactText(row.kind, 'kind'),
  path: compactText(row.path, 'path'),
  rank: compactRank(row.rank),
  snippet: compactSnippet(row.snippet),
  subject: compactText(row.subject, 'subject'),
  summary: compactSummary(row.summary),
})

const createCompactSearchReader = (database: DatabaseSync, input: SearchStatementInput) => {
  const conditions = [
    'record_search MATCH ?',
    input.includeSuperseded === true ? undefined : 'records.active = 1',
    input.kind === undefined ? undefined : 'records.kind = ?',
  ].filter((value): value is string => value !== undefined)
  const kindParameters = input.kind === undefined ? [] : [input.kind]
  const limit = compactResultLimit(input.limit)
  const source = `
    SELECT
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
  `
  cacheReadTestHooks.onCompactSearchPrepare?.(source)
  const statement = database.prepare(source)
  return (query: string) => {
    const match = literalMatchQuery(query)
    if (match.length === 0) {
      return []
    }
    const records = (statement.all(match, ...kindParameters, limit) as CompactRow[]).map(compactRecordFromRow)
    cacheReadTestHooks.afterCompactSearchRead?.(query)
    return records
  }
}

export const searchRecords = (input: SearchRecordsInput): BrainRecord[] => {
  const parsed = parseSearchRecordsInput(input)
  const match = literalMatchQuery(parsed.query)
  const limit = fullResultLimit(parsed.limit)
  return withPreparedDatabase(parsed, database =>
    parseRecordRowsWithinBudget(searchRows(database, parsed, match, limit)),
  )
}

export const searchCompactRecords = (input: SearchRecordsInput): CompactBrainRecord[] => {
  const parsed = parseSearchRecordsInput(input)
  literalMatchQuery(parsed.query)
  compactResultLimit(parsed.limit)
  return withPreparedDatabase(parsed, database => createCompactSearchReader(database, parsed)(parsed.query))
}

const createShowReader = (database: DatabaseSync, includeSuperseded: boolean | undefined) => {
  const activeClause = includeSuperseded === true ? '' : ' AND active = 1'
  const source = `SELECT record_json, length(cast(record_json AS BLOB)) AS record_bytes FROM records WHERE id = ?${activeClause}`
  cacheReadTestHooks.onShowPrepare?.(source)
  const statement = database.prepare(source)
  const budget = { bytes: 0 }
  return (id: string) => {
    const row = statement.get(id) as RecordRow | undefined
    cacheReadTestHooks.afterShowRead?.(id)
    return row === undefined ? null : parseRecordRowWithinBudget(row, budget)
  }
}

const assertGatherBudgets = (input: GatherInput) => {
  const searches = input.searches ?? []
  const shows = input.shows ?? []
  if (searches.length > MAX_GATHER_SEARCHES) {
    return budgetFailure(
      'searches',
      'gatherSearches',
      MAX_GATHER_SEARCHES,
      `gather may contain at most ${MAX_GATHER_SEARCHES} searches.`,
    )
  }
  if (shows.length > MAX_GATHER_SHOWS) {
    return budgetFailure(
      'shows',
      'gatherShows',
      MAX_GATHER_SHOWS,
      `gather may contain at most ${MAX_GATHER_SHOWS} shows.`,
    )
  }
  searches.forEach(literalMatchQuery)
}

const readFreshTransaction = <Result>(
  root: string,
  location: CacheLocation,
  read: (database: DatabaseSync) => Result,
) => {
  const database = openReaderDatabase(location)
  try {
    database.exec('BEGIN')
    const metadata = readMetadata(database)
    if (!metadataIsFresh(root, database, metadata)) {
      throw new CacheSchemaMismatch('The cache is stale before read.')
    }
    const result = read(database)
    database.exec('ROLLBACK')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // The original read failure is more useful than a secondary rollback failure.
    }
    throw error
  } finally {
    database.close()
  }
}

const readGatherFromDatabase = (
  database: DatabaseSync,
  input: GatherInput,
  hydrated: HydrateResult | null,
): GatherResult => {
  const searches = input.searches ?? []
  const shows = input.shows ?? []
  const showRecordForId = shows.length === 0 ? () => null : createShowReader(database, input.includeSuperseded)
  const searchCompactRecordsForQuery = searches.length === 0 ? () => [] : createCompactSearchReader(database, input)
  return {
    hydrated,
    records: shows.map(id => ({ id, record: showRecordForId(id) })),
    searches: searches.map(query => ({
      kind: input.kind ?? null,
      query,
      results: searchCompactRecordsForQuery(query),
    })),
  }
}

export const gatherRecords = (input: GatherInput): GatherResult => {
  const parsed = parseGatherInput(input)
  assertGatherBudgets(parsed)
  compactResultLimit(parsed.limit)
  const root = resolveRepository(parsed)
  let location: CacheLocation | undefined
  try {
    location = inspectCacheLocation(root)
    let hydrated: HydrateResult | null = null
    if (parsed.hydrate === true) {
      hydrated = {
        recordsIndexed: hydrateResolvedRepository(root, true, location).recordsIndexed,
      }
    } else {
      prepareResolved(root, true, location)
    }
    return readFreshTransaction(root, location, database => readGatherFromDatabase(database, parsed, hydrated))
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    if (isRecoverableCacheFailure(error) && location !== undefined) {
      const recovered = withOperationLock(root, captured => rebuildCache(root, captured), {}, location)
      try {
        return readFreshTransaction(root, location, database =>
          readGatherFromDatabase(
            database,
            parsed,
            parsed.hydrate === true ? { recordsIndexed: recovered.recordsIndexed } : null,
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
