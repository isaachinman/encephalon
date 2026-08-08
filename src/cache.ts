import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { EncephalonError, fail, failWithCause, wrapIo } from './errors.ts'
import { cacheDirectory, withOperationLock } from './lock.ts'
import { readRecords } from './records.ts'
import { resolveRepository } from './repository.ts'
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
export const MAX_QUERY_BYTES = 1024
export const MAX_QUERY_TERMS = 32
export const MAX_GATHER_SEARCHES = 16
export const MAX_GATHER_SHOWS = 64
export const MAX_FULL_RESULT_LIMIT = 50
export const MAX_COMPACT_RESULT_LIMIT = 100
export const MAX_FULL_RESPONSE_BYTES = 4 * 1024 * 1024

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
  record_json: string
  record_bytes?: number
}

type CompactRow = {
  id: string
  kind: string
  subject: string
  path: string
  summary: string | null
  rank: number
  snippet: string
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
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
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

const readMetadata = (database: DatabaseSync): Metadata | undefined => {
  const rows = database.prepare('SELECT key, value FROM metadata').all() as Array<{
    key: string
    value: string
  }>
  const values = new Map(rows.map(row => [row.key, row.value]))
  const artifactPathsValue = values.get('artifactPaths')
  const recordsIndexedValue = values.get('recordsIndexed')
  if (
    values.get('schemaVersion') !== undefined &&
    values.get('packageVersion') !== undefined &&
    values.get('repositoryRealpath') !== undefined &&
    values.get('manifest') !== undefined &&
    artifactPathsValue !== undefined &&
    recordsIndexedValue !== undefined
  ) {
    try {
      const artifactPaths = JSON.parse(artifactPathsValue) as unknown
      const recordsIndexed = Number(recordsIndexedValue)
      if (
        Array.isArray(artifactPaths) &&
        artifactPaths.every(path => typeof path === 'string') &&
        Number.isInteger(recordsIndexed)
      ) {
        return {
          artifactPaths,
          manifest: values.get('manifest') ?? '',
          packageVersion: values.get('packageVersion') ?? '',
          recordsIndexed,
          repositoryRealpath: values.get('repositoryRealpath') ?? '',
          schemaVersion: values.get('schemaVersion') ?? '',
        }
      }
    } catch {}
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

const metadataIsFresh = (root: string, metadata: Metadata | undefined): metadata is Metadata => {
  assertCacheScope(root, metadata)
  return (
    metadata !== undefined &&
    metadata.schemaVersion === SCHEMA_VERSION &&
    metadata.packageVersion === PACKAGE_VERSION &&
    metadata.manifest === repositoryManifest(root, metadata.artifactPaths)
  )
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
      assertCacheScope(root, readMetadata(database))
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
          if (metadataIsFresh(root, metadata)) {
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
    if (metadataIsFresh(root, metadata)) {
      return { hydrated: false, recordsIndexed: metadata.recordsIndexed }
    }
  } finally {
    database.close()
  }
  return withOperationLock(root, () => {
    const recheck = openDatabase(root)
    try {
      const metadata = readMetadata(recheck)
      if (metadataIsFresh(root, metadata)) {
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

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')

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

const withPreparedDatabase = <Result>(input: RootInput, read: (database: DatabaseSync) => Result) => {
  const root = resolveRepository(input)
  try {
    prepareResolved(root)
    const database = openDatabase(root)
    try {
      return read(database)
    } finally {
      database.close()
    }
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to read the Encephalon cache.', error)
  }
}

const parseRecordRow = (row: RecordRow) => JSON.parse(row.record_json) as BrainRecord

type FullResponseBudget = {
  bytes: number
}

const recordRowBytes = (row: RecordRow) => {
  if (typeof row.record_bytes === 'number' && Number.isFinite(row.record_bytes) && row.record_bytes >= 0) {
    return row.record_bytes
  }
  return byteLength(row.record_json)
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

const parseRecordRowsWithinBudget = (rows: RecordRow[]) => {
  const budget = { bytes: 0 }
  return rows.map(row => parseRecordRowWithinBudget(row, budget))
}

export const listRecords = (input: ListRecordsInput = {}): BrainRecord[] => {
  const limit = fullResultLimit(input.limit)
  return withPreparedDatabase(input, database => {
    const conditions = [
      input.includeSuperseded === true ? undefined : 'active = 1',
      input.kind === undefined ? undefined : 'kind = ?',
      input.subject === undefined ? undefined : 'subject = ?',
    ].filter((value): value is string => value !== undefined)
    const parameters = [
      ...(input.kind === undefined ? [] : [input.kind]),
      ...(input.subject === undefined ? [] : [input.subject]),
      limit,
    ]
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const rows = database
      .prepare(
        `SELECT record_json, length(cast(record_json AS BLOB)) AS record_bytes FROM records ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters) as RecordRow[]
    return parseRecordRowsWithinBudget(rows)
  })
}

export const showRecord = (input: ShowRecordInput): BrainRecord | null =>
  withPreparedDatabase(input, database => {
    if (typeof input.id !== 'string' || input.id.length === 0) {
      return fail('INVALID_ARGUMENT', 'id must be a non-empty string.', {
        field: 'id',
      })
    }
    const activeClause = input.activeOnly === true ? ' AND active = 1' : ''
    const row = database
      .prepare(
        `SELECT record_json, length(cast(record_json AS BLOB)) AS record_bytes FROM records WHERE id = ?${activeClause}`,
      )
      .get(input.id) as RecordRow | undefined
    return row === undefined ? null : parseRecordRowWithinBudget(row, { bytes: 0 })
  })

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
      length(cast(records.record_json AS BLOB)) AS record_bytes,
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

export const searchRecords = (input: SearchRecordsInput): BrainRecord[] => {
  const match = literalMatchQuery(input.query)
  const limit = fullResultLimit(input.limit)
  return withPreparedDatabase(input, database => parseRecordRowsWithinBudget(searchRows(database, input, match, limit)))
}

export const searchCompactRecords = (input: SearchRecordsInput): CompactBrainRecord[] => {
  const match = literalMatchQuery(input.query)
  const limit = compactResultLimit(input.limit)
  return withPreparedDatabase(input, database =>
    searchRows(database, input, match, limit).map(row => ({
      id: row.id,
      kind: row.kind,
      path: row.path,
      rank: row.rank,
      snippet: row.snippet,
      subject: row.subject,
      summary: row.summary,
    })),
  )
}

const gatherSearches = (value: unknown) => {
  const searches = value ?? []
  if (!(Array.isArray(searches) && searches.every(query => typeof query === 'string'))) {
    return fail('INVALID_ARGUMENT', 'searches must be an array of strings.', {
      field: 'searches',
    })
  }
  if (searches.length > MAX_GATHER_SEARCHES) {
    return budgetFailure(
      'searches',
      'gatherSearches',
      MAX_GATHER_SEARCHES,
      `gather may contain at most ${MAX_GATHER_SEARCHES} searches.`,
    )
  }
  return searches.map(query => ({
    match: literalMatchQuery(query),
    query,
  }))
}

const gatherShows = (value: unknown) => {
  const shows = value ?? []
  if (!(Array.isArray(shows) && shows.every(id => typeof id === 'string'))) {
    return fail('INVALID_ARGUMENT', 'shows must be an array of strings.', {
      field: 'shows',
    })
  }
  if (shows.length > MAX_GATHER_SHOWS) {
    return budgetFailure(
      'shows',
      'gatherShows',
      MAX_GATHER_SHOWS,
      `gather may contain at most ${MAX_GATHER_SHOWS} shows.`,
    )
  }
  return shows
}

export const gatherRecords = (input: GatherInput): GatherResult => {
  const searches = gatherSearches(input.searches)
  const shows = gatherShows(input.shows)
  const limit = compactResultLimit(input.limit)
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
    const database = openDatabase(root)
    try {
      const showBudget = { bytes: 0 }
      return {
        hydrated,
        records: shows.map(id => {
          const activeClause = input.includeSuperseded === true ? '' : ' AND active = 1'
          const row = database
            .prepare(
              `SELECT record_json, length(cast(record_json AS BLOB)) AS record_bytes FROM records WHERE id = ?${activeClause}`,
            )
            .get(id) as RecordRow | undefined
          return { id, record: row === undefined ? null : parseRecordRowWithinBudget(row, showBudget) }
        }),
        searches: searches.map(({ match, query }) => ({
          kind: input.kind ?? null,
          query,
          results: searchRows(database, { ...input, query }, match, limit).map(row => ({
            id: row.id,
            kind: row.kind,
            path: row.path,
            rank: row.rank,
            snippet: row.snippet,
            subject: row.subject,
            summary: row.summary,
          })),
        })),
      }
    } finally {
      database.close()
    }
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to gather Encephalon records.', error)
  }
}
