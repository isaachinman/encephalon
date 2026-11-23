import { type BigIntStats, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  parseCompactSearchRecordsInput,
  parseFullSearchRecordsInput,
  parseGatherInput,
  parseListRecordsInput,
  parseRootInput,
  parseShowRecordInput,
} from './api-input.ts'
import { ArtifactChangedError, type ArtifactObservation } from './artifact-inspection.ts'
import {
  type CacheDatabase,
  CacheDatabaseCreationConflict,
  CacheDatabaseFailure,
  type CacheLocation,
  failCacheDatabase,
  inspectCacheDatabase,
  inspectCacheLocation,
  openVerifiedCacheDatabase,
  quarantineCacheDatabase,
} from './cache-location.ts'
import { CANONICAL_BUDGETS } from './canonical-budgets.ts'
import {
  CanonicalDirectoryChangedError,
  CanonicalDirectoryEntryLimitError,
  captureCanonicalDirectory,
  isCanonicalKindDirectoryEntry,
  isCanonicalReservedDirectory,
  MAX_CANONICAL_BRAIN_ROOT_ENTRIES,
  MAX_CANONICAL_KIND_DIRECTORIES,
  MAX_CANONICAL_KIND_ENTRIES,
  revalidateCanonicalDirectory,
} from './canonical-layout.ts'
import { EncephalonError, fail, failBudget, failWithCause, wrapIo } from './errors.ts'
import { manifestEntryMetadataFrom } from './filesystem-entry.ts'
import { PACKAGE_VERSION } from './generated/version.ts'
import { withOperationLock } from './lock.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import { ordinalStringCompare } from './order.ts'
import { recordCorpusFingerprint } from './record-corpus-fingerprint.ts'
import {
  MAX_SEARCH_PREVIEW_BYTES,
  recordProjection,
  searchDocumentForRecord,
  searchPreviewForRecord,
  summaryForRecord,
} from './record-projection.ts'
import {
  canonicalCacheManifest,
  MAX_ARTIFACT_REFERENCES,
  MAX_CANONICAL_RECORD_BYTES,
  MAX_CANONICAL_RECORDS,
  MAX_SUPERSESSION_EDGES,
  type RecordReadHooks,
  readDigestVerifiedRecord,
  readValidatedRecordSnapshotResolved,
  type VerifiedCorpus,
} from './records.ts'
import { resolveRepository } from './repository.ts'
import { createResponseByteBudget, logicalResponseBytes, type ResponseByteBudget } from './response-budget.ts'
import { validateArtifactPath, validateId, validateKind } from './schema.ts'
import { literalMatchQuery, MAX_NFC_UTF8_EXPANSION_FACTOR } from './search-text.ts'
import { classifySQLiteError } from './sqlite-error.ts'
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

const SCHEMA_VERSION = '5'
const CACHE_APPLICATION_ID = 0x45_4e_43_50
const MAX_REPOSITORY_CHANGE_RETRIES = 3
const MAX_GATHER_SEARCHES = OPERATION_BUDGETS.gatherSearches.maximum
const MAX_GATHER_SHOWS = OPERATION_BUDGETS.gatherShows.maximum
const SQLITE_BUSY_TIMEOUT_MILLISECONDS = 1000
const MAX_CACHE_METADATA_BYTES = 1024 * 1024
// The artifact path list is one JSON array: each path is at most 1 KiB, every byte may need a six-byte escape,
// and each entry adds quotes and a separator.
const MAX_CACHE_ARTIFACT_PATHS_BYTES = Math.max(
  MAX_CACHE_METADATA_BYTES,
  CANONICAL_BUDGETS.artifactReferences * (1024 * 6 + 3) + 2,
)
const MAX_CACHE_SCHEMA_BYTES = 4 * 1024
// Search text contains canonical fields and the flattened payload, with NFC expansion.
const MAX_CACHE_SEARCH_SOURCE_BYTES = CANONICAL_BUDGETS.recordBytes + 4096
const MAX_CACHE_SEARCH_SOURCE_AGGREGATE_BYTES = CANONICAL_BUDGETS.recordJsonBytes + CANONICAL_BUDGETS.records * 4096
const MAX_CACHE_SEARCH_DOCUMENT_DUPLICATION_FACTOR = 2
const MAX_CACHE_SEARCH_DOCUMENT_BYTES =
  MAX_CACHE_SEARCH_SOURCE_BYTES * MAX_CACHE_SEARCH_DOCUMENT_DUPLICATION_FACTOR * MAX_NFC_UTF8_EXPANSION_FACTOR
const MAX_CACHE_SEARCH_DOCUMENT_AGGREGATE_BYTES =
  MAX_CACHE_SEARCH_SOURCE_AGGREGATE_BYTES * MAX_CACHE_SEARCH_DOCUMENT_DUPLICATION_FACTOR * MAX_NFC_UTF8_EXPANSION_FACTOR

const MAX_CACHE_SEARCH_PREVIEW_BYTES = MAX_SEARCH_PREVIEW_BYTES
const MAX_CACHE_SEARCH_PREVIEW_AGGREGATE_BYTES = CANONICAL_BUDGETS.records * MAX_CACHE_SEARCH_PREVIEW_BYTES
const MAX_CACHE_SEARCH_INDEX_BYTES = MAX_CACHE_SEARCH_DOCUMENT_AGGREGATE_BYTES * 2
// The writer uses FTS5's default ~4 KiB pages. Allow 1 KiB packing plus per-record tails.
const MAX_CACHE_SEARCH_INDEX_ROWS = Math.ceil(MAX_CACHE_SEARCH_INDEX_BYTES / 1024) + CANONICAL_BUDGETS.records
const METADATA_KEYS = [
  'artifactPaths',
  'manifest',
  'packageVersion',
  'recordFingerprint',
  'recordsIndexed',
  'repositoryRealpath',
  'schemaVersion',
] as const
const MAX_CACHE_METADATA_AGGREGATE_BYTES =
  (METADATA_KEYS.length - 1) * MAX_CACHE_METADATA_BYTES + MAX_CACHE_ARTIFACT_PATHS_BYTES

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
  artifactPaths: readonly string[]
  recordFingerprint?: string
  recordsIndexed: number
}

type CurrentMetadata = Metadata & { recordFingerprint: string }

type ManifestEntry = {
  path: string
  type: 'directory' | 'file' | 'missing' | 'other' | 'symlink'
  size?: string
  mtimeNanoseconds?: string
  ctimeNanoseconds?: string
}

type RecordRow = { id?: unknown }

type CompactRow = RecordRow & {
  rank?: unknown
  snippet?: unknown
}

type SearchStatementInput = Pick<SearchRecordsInput, 'includeSuperseded' | 'kind' | 'limit'>

type CacheIntegrityProbeName = 'metadata' | 'records' | 'record-search' | 'schema'

type CacheIntegrityProbe = {
  exceeds_aggregate_bytes?: unknown
  has_invalid_type?: unknown
  has_oversized_value?: unknown
  row_count?: unknown
}

type CacheIntegrityObservation = {
  exceedsAggregateBytes: 0 | 1
  hasInvalidType: 0 | 1
  hasOversizedValue: 0 | 1
  name: CacheIntegrityProbeName
  rows: number
}

// These columns support identity joins, filtering, deterministic ordering and the corpus budgets
// that a trusted add checks (`bytes`, supersession `edges`, `artifacts` references). Full values
// are read from canonical files and accepted only when their bytes still hash to `digest`. `racy`
// marks files whose unchanged metadata cannot prove unchanged content, so trusted reads rehash them.
const CACHE_SCHEMA = [
  'CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE records (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)), digest TEXT NOT NULL,
    racy INTEGER NOT NULL CHECK (racy IN (0, 1)), bytes INTEGER NOT NULL,
    edges INTEGER NOT NULL, artifacts INTEGER NOT NULL)`,
  'CREATE INDEX records_active_order ON records(active, created_at DESC, id DESC)',
  'CREATE INDEX records_kind_subject ON records(kind, subject)',
  'CREATE INDEX records_racy ON records(racy) WHERE racy = 1',
  'CREATE VIRTUAL TABLE record_search USING fts5(text, preview)',
] as const

type CacheReadTestHooks = {
  afterCanonicalCacheEqualityValidation?: (() => void) | undefined
  afterCanonicalValidation?: (() => void) | undefined
  afterDisposableCacheRecoveryRebuild?: ((result: PrepareResult) => void) | undefined
  afterIntegrityProbe?: ((observation: CacheIntegrityObservation) => void) | undefined
  afterGatherSearchEvaluation?: ((query: string) => void) | undefined
  afterManifestEntryLstat?: ((path: string) => void) | undefined
  afterManifestKindEnumeration?: ((path: string) => void) | undefined
  afterManifestRootEnumeration?: ((path: string) => void) | undefined
  afterMissingPrimaryRecoveryObservation?: (() => void) | undefined
  afterPrimaryDatabaseObservation?: ((phase: 'prepare-fast-path' | 'reader-missing') => void) | undefined
  afterCompactSearchRead?: ((query: string) => void) | undefined
  afterShowRead?: ((id: string) => void) | undefined
  beforeManifestEntryLstat?: ((path: string) => void) | undefined
  beforeCacheSnapshotCommit?: (() => 'repository-changed' | undefined) | undefined
  beforeIntegrityTextRead?: ((name: CacheIntegrityProbeName) => void) | undefined
  duringDatabaseInitialisation?: ((mode: 'reader' | 'writer') => void) | undefined
  onCompactSearchPrepare?: ((source: string) => void) | undefined
  onShowPrepare?: ((source: string) => void) | undefined
  recordReadHooks?: RecordReadHooks | undefined
  /** Sends reads through full canonical validation, as `prepare` and stale reads do, to test forged caches. */
  requireCanonicalCacheEquality?: boolean | undefined
}

type CacheReadInstrumentation = {
  afterIntegrityValidation?: (() => void) | undefined
  afterResultRead?: (() => void) | undefined
  beforeResultRead?: (() => void) | undefined
}

class CacheSchemaMismatch extends Error {}

class NormalizedCacheSchemaFailure extends Error {
  readonly code: 'SQLITE_CORRUPT' | 'SQLITE_SCHEMA'

  constructor(category: 'corrupt' | 'schema') {
    super('The SQLite cache schema could not be verified.')
    this.name = 'NormalizedCacheSchemaFailure'
    this.code = category === 'corrupt' ? 'SQLITE_CORRUPT' : 'SQLITE_SCHEMA'
  }
}

class CacheDatabaseObservedMissing extends Error {}

const isIntegrityFlag = (value: unknown): value is 0 | 1 => value === 0 || value === 1

let sqliteModule: SQLiteModule | undefined
let sqliteFeaturesVerified = false

/** @internal */
export const cacheReadTestHooks: CacheReadTestHooks = {}

/** @internal */
export const cacheReadInstrumentation: CacheReadInstrumentation = {}

const loadSQLite = () => {
  if (sqliteModule === undefined) {
    const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number)
    if (major < 24 || (major === 24 && (minor < 22 || (minor === 22 && patch < 1)))) {
      return fail('UNSUPPORTED_RUNTIME', 'Encephalon requires Node.js 24.22.1 or newer.', {
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
  const category = classifySQLiteError(failure)
  return (
    failure instanceof CacheSchemaMismatch ||
    failure instanceof CacheDatabaseObservedMissing ||
    category === 'cantopen' ||
    category === 'corrupt' ||
    category === 'notadb' ||
    category === 'readonly' ||
    category === 'schema'
  )
}

const readIntegrityProbe = (
  name: CacheIntegrityProbeName,
  row: CacheIntegrityProbe | undefined,
  maximumRows: number,
): CacheIntegrityObservation => {
  const rows = row?.row_count
  const exceedsAggregateBytes = row?.exceeds_aggregate_bytes
  const hasInvalidType = row?.has_invalid_type
  const hasOversizedValue = row?.has_oversized_value
  if (
    typeof rows !== 'number' ||
    !Number.isSafeInteger(rows) ||
    rows < 0 ||
    rows > maximumRows ||
    !isIntegrityFlag(exceedsAggregateBytes) ||
    !isIntegrityFlag(hasInvalidType) ||
    !isIntegrityFlag(hasOversizedValue)
  ) {
    throw new CacheSchemaMismatch('The cache integrity probe returned an invalid result.')
  }
  const observation = {
    exceedsAggregateBytes,
    hasInvalidType,
    hasOversizedValue,
    name,
    rows,
  }
  cacheReadTestHooks.afterIntegrityProbe?.(observation)
  return observation
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

const assertCacheSchemaUnchecked = (database: DatabaseSync) => {
  const version = database.prepare('SELECT * FROM pragma_application_id(), pragma_user_version()').get()
  if (version?.application_id !== CACHE_APPLICATION_ID || version?.user_version !== Number(SCHEMA_VERSION)) {
    throw new CacheSchemaMismatch('The cache schema version is incompatible.')
  }
  // Ask this SQLite runtime for its trusted normalised DDL, including implicit indexes
  // and FTS shadow objects. Never interpret or transfer the cache's untrusted schema SQL.
  const reference = new (loadSQLite().DatabaseSync)(':memory:')
  const expected = (() => {
    try {
      createCacheSchema(reference)
      return Array.from(reference.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema').iterate()) as Array<{
        type: string
        name: string
        tbl_name: string
        sql: string | null
      }>
    } finally {
      reference.close()
    }
  })()
  const maximumRows = expected.length + 1
  const probe = readIntegrityProbe(
    'schema',
    database
      .prepare(`SELECT COUNT(*) AS row_count,
      0 AS exceeds_aggregate_bytes, 0 AS has_invalid_type,
      CASE WHEN MAX(octet_length(sql)) > ? THEN 1 ELSE 0 END AS has_oversized_value
      FROM (SELECT sql FROM sqlite_schema LIMIT ?)`)
      .get(MAX_CACHE_SCHEMA_BYTES, maximumRows) as CacheIntegrityProbe | undefined,
    maximumRows,
  )
  if (probe.rows !== expected.length || probe.hasOversizedValue !== 0) {
    throw new CacheSchemaMismatch('The cache has an incompatible owned schema.')
  }
  const match = database.prepare(`SELECT COUNT(*) AS matches FROM sqlite_schema
    WHERE type = ? AND name = ? AND tbl_name = ? AND sql IS ?`)
  for (const object of expected) {
    if (match.get(object.type, object.name, object.tbl_name, object.sql)?.matches !== 1) {
      throw new CacheSchemaMismatch('The cache has an incompatible owned schema.')
    }
  }
}

const assertCacheSchema = (database: DatabaseSync) => {
  try {
    assertCacheSchemaUnchecked(database)
  } catch (error) {
    if (error instanceof CacheSchemaMismatch || error instanceof NormalizedCacheSchemaFailure) {
      throw error
    }
    const category = classifySQLiteError(error)
    if (category === 'corrupt' || category === 'schema') {
      // biome-ignore lint/style/useErrorCause: SQLite schema messages can contain private untrusted object names.
      throw new NormalizedCacheSchemaFailure(category)
    }
    throw error
  }
}

const createCacheSchema = (database: DatabaseSync) => {
  database.exec(`PRAGMA application_id = ${CACHE_APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};
    ${CACHE_SCHEMA.join(';')};`)
}

const assertCacheTransaction = (database: DatabaseSync, validate: (opened: DatabaseSync) => void): void => {
  database.exec('BEGIN')
  try {
    validate(database)
    database.exec('ROLLBACK')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original cache validation failure.
    }
    throw error
  }
}

const assertCacheSchemaTransaction = (database: DatabaseSync): void => {
  assertCacheTransaction(database, assertCacheSchema)
}

type CacheWriterPrimary =
  | { kind: 'create-exclusive' }
  | { kind: 'create-if-missing' }
  | { database: CacheDatabase; kind: 'expected-new' }
  | { database: CacheDatabase; kind: 'expected-owned' }

const openWriterDatabase = (
  location: CacheLocation,
  primary: CacheWriterPrimary,
  validateExisting: (database: DatabaseSync) => void,
) => {
  const { DatabaseSync: DatabaseConstructor } = loadSQLite()
  verifySQLiteFeatures(DatabaseConstructor)
  const verifiedPrimary =
    primary.kind === 'expected-new' ? { database: primary.database, kind: 'expected-owned' as const } : primary
  let openedPrimaryCreated = false
  const opened = openVerifiedCacheDatabase({
    afterVerifiedOpen: (database, { primaryCreated }) => {
      openedPrimaryCreated = primaryCreated
      if (primaryCreated) {
        database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
        createCacheSchema(database)
      } else if (primary.kind === 'expected-new') {
        assertEmptyCacheContentTransaction(database)
        database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
      } else {
        validateExisting(database)
        database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
      }
      assertCacheSchemaTransaction(database)
      cacheReadTestHooks.duringDatabaseInitialisation?.('writer')
    },
    DatabaseConstructor,
    location,
    name: 'brain.sqlite',
    openOptions: { timeout: SQLITE_BUSY_TIMEOUT_MILLISECONDS },
    primary: verifiedPrimary,
  })
  return {
    ...opened,
    acceptsEmptyContent: openedPrimaryCreated || primary.kind === 'expected-new',
  }
}

const NO_VERIFIED_CACHE_RESULT = Symbol('no-verified-cache-result')

const readVerifiedCacheTransaction = <Result>(
  location: CacheLocation,
  read: (database: DatabaseSync) => Result,
  expectedDatabase?: CacheDatabase,
): Result => {
  const { DatabaseSync: DatabaseConstructor } = loadSQLite()
  verifySQLiteFeatures(DatabaseConstructor)
  let result: Result | typeof NO_VERIFIED_CACHE_RESULT = NO_VERIFIED_CACHE_RESULT
  const { database } = openVerifiedCacheDatabase({
    afterVerifiedOpen: opened => {
      opened.exec('BEGIN')
      try {
        assertCacheSchema(opened)
        cacheReadTestHooks.duringDatabaseInitialisation?.('reader')
        result = read(opened)
        opened.exec('ROLLBACK')
      } catch (error) {
        try {
          opened.exec('ROLLBACK')
        } catch {
          // Preserve the original validation/read error.
        }
        throw error
      }
    },
    DatabaseConstructor,
    location,
    missing: () => {
      cacheReadTestHooks.afterPrimaryDatabaseObservation?.('reader-missing')
      throw new CacheDatabaseObservedMissing('The cache database disappeared before it was opened.')
    },
    name: 'brain.sqlite',
    openOptions: {
      readOnly: true,
      timeout: SQLITE_BUSY_TIMEOUT_MILLISECONDS,
    },
    primary:
      expectedDatabase === undefined ? { kind: 'existing' } : { database: expectedDatabase, kind: 'expected-owned' },
  })
  database.close()
  if (result === NO_VERIFIED_CACHE_RESULT) {
    return fail('INTERNAL_ERROR', 'The verified cache read returned no result.')
  }
  return result
}

const posixRelative = (root: string, path: string) =>
  path
    .slice(root.length)
    .replace(/^[/\\]+/, '')
    .replaceAll('\\', '/')

const statEntry = (root: string, path: string, missingAllowed = false): ManifestEntry => {
  let metadata: BigIntStats
  try {
    cacheReadTestHooks.beforeManifestEntryLstat?.(path)
    metadata = lstatSync(path, { bigint: true })
    cacheReadTestHooks.afterManifestEntryLstat?.(path)
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (missingAllowed) {
        return { path: posixRelative(root, path), type: 'missing' }
      }
      throw new CanonicalDirectoryChangedError(path, { cause: error })
    }
    throw error
  }
  const { ctimeNanoseconds, mtimeNanoseconds, size, type } = manifestEntryMetadataFrom(metadata)
  return {
    ctimeNanoseconds,
    mtimeNanoseconds,
    path: posixRelative(root, path),
    size,
    type,
  }
}

const recordManifestEntries = (root: string) => {
  const brainDirectory = resolve(root, 'encephalon')
  const brainEntry = statEntry(root, brainDirectory, true)
  if (brainEntry.type !== 'directory') {
    return [brainEntry]
  }
  const rootEntries = captureCanonicalDirectory(
    brainDirectory,
    MAX_CANONICAL_BRAIN_ROOT_ENTRIES,
    cacheReadTestHooks.afterManifestRootEnumeration,
  )
  if (rootEntries.overflow) {
    throw new CanonicalDirectoryEntryLimitError()
  }
  const kindDirectoryCount = rootEntries.entries.filter(isCanonicalKindDirectoryEntry).length
  if (kindDirectoryCount > MAX_CANONICAL_KIND_DIRECTORIES) {
    throw new CanonicalDirectoryEntryLimitError()
  }
  const children = rootEntries.entries
    .filter(entry => !isCanonicalReservedDirectory(entry.name))
    .flatMap(entry => {
      const kindPath = resolve(brainDirectory, entry.name)
      const kindEntry = statEntry(root, kindPath)
      revalidateCanonicalDirectory(rootEntries)
      if (!isCanonicalKindDirectoryEntry(entry) || kindEntry.type !== 'directory') {
        return [kindEntry]
      }
      const recordEntries = captureCanonicalDirectory(
        kindPath,
        MAX_CANONICAL_KIND_ENTRIES,
        cacheReadTestHooks.afterManifestKindEnumeration,
      )
      if (recordEntries.overflow) {
        throw new CanonicalDirectoryEntryLimitError()
      }
      const entries = [
        kindEntry,
        ...recordEntries.entries.map(recordEntry => statEntry(root, resolve(kindPath, recordEntry.name))),
      ]
      revalidateCanonicalDirectory(recordEntries)
      revalidateCanonicalDirectory(rootEntries)
      return entries
    })
  revalidateCanonicalDirectory(rootEntries)
  return [brainEntry, ...children]
}

type RepositoryManifestResult =
  | { kind: 'changed' | 'overflow' }
  | {
      kind: 'stable'
      value: string
    }

const boundedRepositoryManifestFromObservations = (
  root: string,
  artifacts: readonly ArtifactObservation[],
): RepositoryManifestResult => {
  try {
    return {
      kind: 'stable',
      value: canonicalCacheManifest(recordManifestEntries(root), artifacts),
    }
  } catch (error) {
    if (error instanceof CanonicalDirectoryChangedError) {
      return { kind: 'changed' }
    }
    if (error instanceof CanonicalDirectoryEntryLimitError) {
      return { kind: 'overflow' }
    }
    throw error
  }
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
  } catch {
    // biome-ignore lint/style/useErrorCause: V8 parser errors can retain private untrusted cache source text.
    throw new CacheSchemaMismatch('The cache contains malformed JSON.')
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
    throw new CacheSchemaMismatch('Cached artifact metadata contains an invalid path.', {
      cause: error,
    })
  }
}

const readMetadata = (database: DatabaseSync): Metadata | undefined => {
  const maximumRows = METADATA_KEYS.length + 1
  const maximumKeyBytes = Math.max(...METADATA_KEYS.map(key => Buffer.byteLength(key, 'utf8')))
  const probe = readIntegrityProbe(
    'metadata',
    database
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value,
          CASE WHEN TOTAL(value_bytes) > ?1 THEN 1 ELSE 0 END AS exceeds_aggregate_bytes
        FROM (
          SELECT
            CASE WHEN typeof(key) = 'text' AND typeof(value) = 'text' THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(key) = 'text' AND length(CAST(key AS BLOB)) <= ?2
                       AND typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= maximum_value_bytes
                 THEN 0 ELSE 1 END AS oversized,
            CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= maximum_value_bytes
                 THEN length(CAST(value AS BLOB)) ELSE 0 END AS value_bytes
          FROM (
            SELECT key, value, CASE WHEN key = 'artifactPaths' THEN ?4 ELSE ?3 END AS maximum_value_bytes
            FROM metadata
            LIMIT ?5
          )
        )`,
      )
      .get(
        MAX_CACHE_METADATA_AGGREGATE_BYTES,
        maximumKeyBytes,
        MAX_CACHE_METADATA_BYTES,
        MAX_CACHE_ARTIFACT_PATHS_BYTES,
        maximumRows,
      ) as CacheIntegrityProbe | undefined,
    maximumRows,
  )
  if (probe.rows === 0) {
    return
  }
  if (
    probe.rows >= maximumRows ||
    probe.exceedsAggregateBytes !== 0 ||
    probe.hasInvalidType !== 0 ||
    probe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch('The cache metadata contains invalid keys or values.')
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.('metadata')
  const rows = database.prepare('SELECT key, value FROM metadata LIMIT ?').iterate(maximumRows) as Iterable<{
    key?: unknown
    value?: unknown
  }>
  const values = new Map<string, string>()
  for (const row of rows) {
    if (
      typeof row.key !== 'string' ||
      typeof row.value !== 'string' ||
      !(METADATA_KEYS as readonly string[]).includes(row.key) ||
      values.has(row.key)
    ) {
      throw new CacheSchemaMismatch('The cache metadata contains invalid keys or values.')
    }
    assertCacheValueSize(
      row.value,
      row.key === 'artifactPaths' ? MAX_CACHE_ARTIFACT_PATHS_BYTES : MAX_CACHE_METADATA_BYTES,
    )
    values.set(row.key, row.value)
  }
  const schemaVersion = values.get('schemaVersion')
  if (values.size !== METADATA_KEYS.length || METADATA_KEYS.some(key => values.get(key) === undefined)) {
    throw new CacheSchemaMismatch('The cache metadata key set is incomplete.')
  }
  const artifactPathsValue = values.get('artifactPaths')
  const recordFingerprint = values.get('recordFingerprint')
  const recordsIndexedValue = values.get('recordsIndexed')
  if (artifactPathsValue === undefined || recordsIndexedValue === undefined) {
    throw new CacheSchemaMismatch('The cache metadata key set is incomplete.')
  }
  const artifactPaths = parseCacheJson(artifactPathsValue, MAX_CACHE_ARTIFACT_PATHS_BYTES)
  const recordsIndexed = /^(?:0|[1-9]\d*)$/.test(recordsIndexedValue) ? Number(recordsIndexedValue) : Number.NaN
  if (
    schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(artifactPaths) ||
    artifactPaths.length > CANONICAL_BUDGETS.artifactReferences ||
    (recordFingerprint !== undefined && !/^[0-9a-f]{64}$/u.test(recordFingerprint)) ||
    !Number.isSafeInteger(recordsIndexed) ||
    recordsIndexed < 0 ||
    recordsIndexed > CANONICAL_BUDGETS.records
  ) {
    throw new CacheSchemaMismatch('The cache metadata contains invalid values.')
  }
  const validatedArtifactPaths = artifactPaths.map(validateCachedArtifactPath)
  return {
    artifactPaths: validatedArtifactPaths,
    manifest: values.get('manifest') ?? '',
    packageVersion: values.get('packageVersion') ?? '',
    ...(recordFingerprint === undefined ? {} : { recordFingerprint }),
    recordsIndexed,
    repositoryRealpath: values.get('repositoryRealpath') ?? '',
    schemaVersion: schemaVersion ?? '',
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

function* cachedRecordWitnesses(snapshot: VerifiedCorpus, members: ReadonlyMap<string, 0 | 1>) {
  for (const record of snapshot.recordsByPath) {
    if (members.has(record.id)) {
      yield snapshot.recordFacts(record)
    }
  }
}

const assertSearchIndexBounded = (database: DatabaseSync) => {
  const tables = [
    {
      maximumRows: MAX_CACHE_SEARCH_INDEX_ROWS,
      sql: `SELECT typeof(id) = 'integer' AND typeof(block) = 'blob' AS valid,
        octet_length(block) AS bytes FROM record_search_data LIMIT ?`,
    },
    {
      maximumRows: MAX_CACHE_SEARCH_INDEX_ROWS,
      sql: `SELECT typeof(segid) = 'integer' AND typeof(pgno) = 'integer'
          AND typeof(term) = 'blob' AS valid,
        octet_length(term) AS bytes FROM record_search_idx LIMIT ?`,
    },
    {
      maximumRows: CANONICAL_BUDGETS.records,
      sql: `SELECT typeof(id) = 'integer' AND typeof(sz) = 'blob' AS valid,
        octet_length(sz) AS bytes FROM record_search_docsize LIMIT ?`,
    },
    {
      maximumRows: CANONICAL_BUDGETS.records,
      sql: `SELECT typeof(k) = 'text' AND typeof(v) IN ('integer', 'text') AS valid,
        octet_length(k) + octet_length(v) AS bytes FROM record_search_config LIMIT ?`,
    },
  ]
  let totalBytes = 0
  for (const { sql, maximumRows } of tables) {
    let rows = 0
    const sizes = database.prepare(sql).iterate(maximumRows + 1) as Iterable<{ bytes?: unknown; valid?: unknown }>
    for (const row of sizes) {
      rows += 1
      if (
        rows > maximumRows ||
        row.valid !== 1 ||
        typeof row.bytes !== 'number' ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 0 ||
        row.bytes > MAX_CACHE_SEARCH_SOURCE_BYTES ||
        row.bytes > MAX_CACHE_SEARCH_INDEX_BYTES - totalBytes
      ) {
        throw new CacheSchemaMismatch('The cache search index exceeds its storage bounds.')
      }
      totalBytes += row.bytes
    }
  }
}

const assertCacheContentConsistent = (database: DatabaseSync, metadata: Metadata, snapshot: VerifiedCorpus) => {
  const maximumRows = CANONICAL_BUDGETS.records + 1
  const recordsProbe = readIntegrityProbe(
    'records',
    database
      .prepare(`SELECT COUNT(*) AS row_count,
      CASE WHEN TOTAL(text_bytes) > ?1 THEN 1 ELSE 0 END AS exceeds_aggregate_bytes,
      CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
      CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
      FROM (SELECT
        CASE WHEN typeof(id) = 'text' AND typeof(kind) = 'text' AND typeof(subject) = 'text'
          AND typeof(created_at) = 'text' AND typeof(active) = 'integer' AND active IN (0, 1)
          AND typeof(digest) = 'text' AND octet_length(digest) = 64
          AND typeof(racy) = 'integer' AND racy IN (0, 1) AND typeof(bytes) = 'integer'
          AND typeof(edges) = 'integer' AND typeof(artifacts) = 'integer'
          THEN 0 ELSE 1 END AS invalid_type,
        CASE WHEN octet_length(id) <= 255 AND octet_length(kind) <= 255
          AND octet_length(subject) <= ?2 AND octet_length(created_at) <= ?2
          THEN 0 ELSE 1 END AS oversized,
        octet_length(id) + octet_length(kind) + octet_length(subject) + octet_length(created_at) AS text_bytes
        FROM records LIMIT ?3)`)
      .get(CANONICAL_BUDGETS.recordJsonBytes, CANONICAL_BUDGETS.recordBytes, maximumRows) as
      | CacheIntegrityProbe
      | undefined,
    maximumRows,
  )
  if (
    recordsProbe.rows !== metadata.recordsIndexed ||
    recordsProbe.rows >= maximumRows ||
    recordsProbe.exceedsAggregateBytes !== 0 ||
    recordsProbe.hasInvalidType !== 0 ||
    recordsProbe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch('The cache record table does not match its metadata.')
  }
  const recordsIntegrity = database
    .prepare("SELECT integrity_check = 'ok' AS valid FROM pragma_integrity_check('records') LIMIT 1")
    .get()
  if (recordsIntegrity?.valid !== 1) {
    throw new CacheSchemaMismatch('The cache record indexes are inconsistent.')
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.('records')
  const recordKeys = database.prepare(
    'SELECT rowid, CAST(id AS BLOB) AS id_bytes, active FROM records ORDER BY id LIMIT ?',
  )
  recordKeys.setReadBigInts(true)
  const recordRows = recordKeys.iterate(maximumRows) as Iterable<{
    rowid?: unknown
    id_bytes?: unknown
    active?: unknown
  }>
  // Only identities/active bits survive each streamed comparison, including for writer subsets.
  const members = new Map<string, 0 | 1>()
  const subsetSuperseded = recordsProbe.rows === snapshot.records.length ? undefined : new Set<string>()
  const representation = database.prepare(`SELECT
    CAST(id AS BLOB) = CAST(?1 AS BLOB) AND CAST(kind AS BLOB) = CAST(?2 AS BLOB)
      AND CAST(subject AS BLOB) = CAST(?3 AS BLOB) AND CAST(created_at AS BLOB) = CAST(?4 AS BLOB)
      AND CAST(digest AS BLOB) = CAST(?6 AS BLOB) AND bytes = ?7 AND edges = ?8 AND artifacts = ?9 AS matches
    FROM records WHERE rowid = ?5`)
  for (const row of recordRows) {
    const id = row.id_bytes instanceof Uint8Array ? Buffer.from(row.id_bytes).toString('utf8') : undefined
    const canonical = id === undefined ? undefined : snapshot.byId.get(id)
    if (canonical === undefined || members.has(canonical.id) || typeof row.rowid !== 'bigint') {
      throw new CacheSchemaMismatch('The cache record table does not match the canonical record corpus.')
    }
    const facts = snapshot.recordFacts(canonical)
    const { summary } = facts.projection
    if (
      representation.get(
        canonical.id,
        canonical.kind,
        canonical.subject,
        canonical.createdAt,
        row.rowid,
        facts.digest,
        facts.bytes,
        canonical.supersedes?.length ?? 0,
        canonical.artifacts?.length ?? 0,
      )?.matches !== 1 ||
      !canonical.subject.isWellFormed() ||
      !canonical.source.isWellFormed() ||
      (summary !== null && !summary.isWellFormed()) ||
      (row.active !== 0n && row.active !== 1n)
    ) {
      throw new CacheSchemaMismatch('The cache record projection does not match the canonical record corpus.')
    }
    members.set(canonical.id, row.active === 1n ? 1 : 0)
    if (subsetSuperseded !== undefined) {
      for (const supersededId of canonical.supersedes ?? []) {
        subsetSuperseded.add(supersededId)
      }
    }
  }

  if (members.size !== recordsProbe.rows) {
    throw new CacheSchemaMismatch('The cache record table does not match the canonical record corpus.')
  }
  const superseded = subsetSuperseded ?? snapshot.supersededIds
  for (const [id, active] of members) {
    if (active !== (superseded.has(id) ? 0 : 1)) {
      throw new CacheSchemaMismatch('The cache record projection does not match the canonical record corpus.')
    }
  }
  // A writer can replace a proper predecessor subset, but its active bits and raw witnesses
  // must describe that subset. Full reads separately require complete snapshot metadata.
  const fingerprint =
    subsetSuperseded === undefined
      ? snapshot.recordFingerprint
      : recordCorpusFingerprint(cachedRecordWitnesses(snapshot, members))
  if (metadata.recordFingerprint !== fingerprint) {
    throw new CacheSchemaMismatch('The cache record table does not match the canonical record corpus.')
  }
  const searchProbe = readIntegrityProbe(
    'record-search',
    database
      .prepare(`SELECT COUNT(*) AS row_count,
      CASE WHEN TOTAL(text_bytes) > ?1 OR TOTAL(preview_bytes) > ?2 THEN 1 ELSE 0 END AS exceeds_aggregate_bytes,
      CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
      CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
      FROM (SELECT
        CASE WHEN typeof(text) = 'text' AND typeof(preview) = 'text' THEN 0 ELSE 1 END AS invalid_type,
        CASE WHEN octet_length(text) <= ?3 AND octet_length(preview) <= ?4 THEN 0 ELSE 1 END AS oversized,
        octet_length(text) AS text_bytes, octet_length(preview) AS preview_bytes
        FROM record_search LIMIT ?5)`)
      .get(
        MAX_CACHE_SEARCH_DOCUMENT_AGGREGATE_BYTES,
        MAX_CACHE_SEARCH_PREVIEW_AGGREGATE_BYTES,
        MAX_CACHE_SEARCH_DOCUMENT_BYTES,
        MAX_CACHE_SEARCH_PREVIEW_BYTES,
        maximumRows,
      ) as CacheIntegrityProbe | undefined,
    maximumRows,
  )

  if (
    searchProbe.rows !== metadata.recordsIndexed ||
    searchProbe.rows >= maximumRows ||
    searchProbe.exceedsAggregateBytes !== 0 ||
    searchProbe.hasInvalidType !== 0 ||
    searchProbe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch('The cache record and search tables are inconsistent.')
  }
  assertSearchIndexBounded(database)
  const integrity = database
    .prepare("SELECT integrity_check = 'ok' AS valid FROM pragma_integrity_check('record_search') LIMIT 1")
    .get() as { valid?: unknown } | undefined
  if (integrity?.valid !== 1) {
    throw new CacheSchemaMismatch('The cache search index is inconsistent.')
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.('record-search')
  // LEFT JOIN keeps orphans visible; only keys cross into JavaScript. Each records rowid is
  // unique, so equal counts plus one consumed canonical member per FTS row prove a bijection.
  const searchKeys = database.prepare(`SELECT record_search.rowid AS search_rowid, CAST(records.id AS BLOB) AS id_bytes
    FROM record_search LEFT JOIN records ON records.rowid = record_search.rowid LIMIT ?`)
  searchKeys.setReadBigInts(true)
  const searchRows = searchKeys.iterate(maximumRows) as Iterable<{ id_bytes?: unknown; search_rowid?: unknown }>
  const searchContent = database.prepare(`SELECT CAST(text AS BLOB) = CAST(? AS BLOB)
    AND CAST(preview AS BLOB) = CAST(? AS BLOB) AS matches FROM record_search WHERE rowid = ?`)
  let searchRowsRead = 0
  for (const row of searchRows) {
    const id = row.id_bytes instanceof Uint8Array ? Buffer.from(row.id_bytes).toString('utf8') : undefined
    const canonical = id === undefined ? undefined : snapshot.byId.get(id)
    if (canonical === undefined || !members.has(canonical.id) || typeof row.search_rowid !== 'bigint') {
      throw new CacheSchemaMismatch('The cache record and search tables are inconsistent.')
    }
    const { summary } = snapshot.recordFacts(canonical).projection
    if (
      searchContent.get(
        searchDocumentForRecord(canonical, summary),
        searchPreviewForRecord(canonical, summary),
        row.search_rowid,
      )?.matches !== 1
    ) {
      throw new CacheSchemaMismatch('The cache record and search tables are inconsistent.')
    }
    members.delete(canonical.id)
    searchRowsRead += 1
  }
  if (searchRowsRead !== searchProbe.rows || members.size !== 0) {
    throw new CacheSchemaMismatch('The cache record and search tables are inconsistent.')
  }
}

const assertExistingCacheContentConsistent = (root: string, database: DatabaseSync, snapshot: VerifiedCorpus): void => {
  assertCacheSchema(database)
  const metadata = readMetadata(database)
  if (metadata === undefined) {
    throw new CacheSchemaMismatch('The cache metadata is incomplete.')
  }
  assertCacheScope(root, metadata)
  assertCacheContentConsistent(database, metadata, snapshot)
}

const assertEmptyCacheContent = (database: DatabaseSync): void => {
  assertCacheSchema(database)
  const rows = database
    .prepare(
      `SELECT
        EXISTS(SELECT 1 FROM metadata LIMIT 1) AS metadata_rows,
        EXISTS(SELECT 1 FROM records LIMIT 1) AS record_rows,
        EXISTS(SELECT 1 FROM record_search LIMIT 1) AS search_rows`,
    )
    .get() as { metadata_rows?: unknown; record_rows?: unknown; search_rows?: unknown }
  if (rows.metadata_rows !== 0 || rows.record_rows !== 0 || rows.search_rows !== 0) {
    throw new CacheSchemaMismatch('The newly created cache is not empty.')
  }
}

const assertExistingCacheContentTransaction = (
  root: string,
  database: DatabaseSync,
  snapshot: VerifiedCorpus,
): void => {
  assertCacheTransaction(database, opened => {
    assertExistingCacheContentConsistent(root, opened, snapshot)
  })
}

const assertEmptyCacheContentTransaction = (database: DatabaseSync): void => {
  assertCacheTransaction(database, assertEmptyCacheContent)
}

type ValidatedRecordCacheSnapshot = VerifiedCorpus

const metadataMatchesSnapshot = (
  root: string,
  database: DatabaseSync,
  metadata: Metadata | undefined,
  snapshot: ValidatedRecordCacheSnapshot,
): metadata is Metadata => {
  assertCacheScope(root, metadata)
  const { artifactPaths } = snapshot
  if (metadata?.schemaVersion === SCHEMA_VERSION && metadata.recordFingerprint !== snapshot.recordFingerprint) {
    throw new CacheSchemaMismatch('The cache metadata does not match the canonical record corpus.')
  }
  const fresh =
    metadata !== undefined &&
    metadata.schemaVersion === SCHEMA_VERSION &&
    metadata.manifest === snapshot.manifest &&
    metadata.recordsIndexed === snapshot.records.length &&
    JSON.stringify(metadata.artifactPaths) === JSON.stringify(artifactPaths)
  if (fresh) {
    assertCacheContentConsistent(database, metadata, snapshot)
  }
  return fresh
}

const writeMetadata = (database: DatabaseSync, metadata: CurrentMetadata) => {
  const statement = database.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)')
  const values = {
    artifactPaths: JSON.stringify(metadata.artifactPaths),
    manifest: metadata.manifest,
    packageVersion: metadata.packageVersion,
    recordFingerprint: metadata.recordFingerprint,
    recordsIndexed: String(metadata.recordsIndexed),
    repositoryRealpath: metadata.repositoryRealpath,
    schemaVersion: metadata.schemaVersion,
  }
  for (const [key, value] of Object.entries(values)) {
    statement.run(key, value)
  }
}

type CompletedCacheRebuild = {
  database: CacheDatabase
  result: PrepareResult
  snapshot: CacheWriteSnapshot
}

/** @internal */
export type ValidatedMutationCacheSnapshot = VerifiedCorpus & Readonly<{ repositoryRealpath: string }>

type CacheWriteSnapshot = ValidatedMutationCacheSnapshot

type CacheSnapshotWrite =
  | { kind: 'committed'; rebuild: CompletedCacheRebuild }
  | { kind: 'repository-changed'; retryPrimary: CacheWriterPrimary }

class MutationCacheSnapshotChanged extends Error {}

const mutationSnapshotChanged = (): never => {
  throw new MutationCacheSnapshotChanged()
}

const assertCacheWriteSnapshotCurrent = (snapshot: CacheWriteSnapshot) => {
  try {
    snapshot.assertCurrent()
  } catch (error) {
    if (
      error instanceof MutationCacheSnapshotChanged ||
      (error instanceof EncephalonError && error.code === 'REPOSITORY_CHANGED')
    ) {
      return mutationSnapshotChanged()
    }
    throw error
  }
}

const assertMutationSnapshotCurrent = (location: CacheLocation, snapshot: ValidatedMutationCacheSnapshot) => {
  if (location.repository !== snapshot.repositoryRealpath) {
    return mutationSnapshotChanged()
  }
  try {
    snapshot.assertCurrent()
  } catch (error) {
    if (
      error instanceof MutationCacheSnapshotChanged ||
      error instanceof ArtifactChangedError ||
      (error instanceof EncephalonError && error.code === 'REPOSITORY_CHANGED')
    ) {
      return mutationSnapshotChanged()
    }
    throw error
  }
}

type CachedRecordFacts = Readonly<{
  bytes: number
  digest: string
  projection: Readonly<{ preview: string; text: string }>
  racy: boolean
}>

const prepareRecordInsert = (database: DatabaseSync) => {
  const insertRecord = database.prepare(`INSERT INTO records(id, kind, subject, created_at, active, digest, racy,
    bytes, edges, artifacts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertSearch = database.prepare('INSERT INTO record_search(rowid, text, preview) VALUES (?, ?, ?)')
  return (record: BrainRecord, facts: CachedRecordFacts, active: boolean) => {
    const { lastInsertRowid } = insertRecord.run(
      record.id,
      record.kind,
      record.subject,
      record.createdAt,
      active ? 1 : 0,
      facts.digest,
      facts.racy ? 1 : 0,
      facts.bytes,
      (record.supersedes ?? []).length,
      (record.artifacts ?? []).length,
    )
    insertSearch.run(lastInsertRowid, facts.projection.text, facts.projection.preview)
  }
}

const writeCacheSnapshot = (
  root: string,
  location: CacheLocation,
  primary: CacheWriterPrimary,
  snapshot: CacheWriteSnapshot,
): CacheSnapshotWrite => {
  const { artifactPaths } = snapshot
  try {
    assertCacheWriteSnapshotCurrent(snapshot)
  } catch (error) {
    if (error instanceof MutationCacheSnapshotChanged) {
      return { kind: 'repository-changed', retryPrimary: primary }
    }
    throw error
  }
  const opened = openWriterDatabase(location, primary, openedDatabase => {
    assertExistingCacheContentTransaction(root, openedDatabase, snapshot)
  })
  const { acceptsEmptyContent, database, identity } = opened
  const retryPrimary: CacheWriterPrimary = (() => {
    if (acceptsEmptyContent) {
      return { database: identity, kind: 'expected-new' }
    }
    if (primary.kind === 'create-if-missing') {
      return { kind: 'create-if-missing' }
    }
    return { database: identity, kind: 'expected-owned' }
  })()
  let rebuildResult: PrepareResult | undefined
  let writerFailure: unknown
  let writerFailed = false
  try {
    database.exec('BEGIN IMMEDIATE')
    try {
      if (acceptsEmptyContent) {
        assertEmptyCacheContent(database)
      } else {
        assertExistingCacheContentConsistent(root, database, snapshot)
      }
      assertCacheWriteSnapshotCurrent(snapshot)
      database.exec('DELETE FROM record_search; DELETE FROM records; DELETE FROM metadata;')
      const insertRecord = prepareRecordInsert(database)
      for (const record of snapshot.records) {
        const facts = snapshot.recordFacts(record)
        insertRecord(record, facts, snapshot.activeIds.has(record.id))
      }

      writeMetadata(database, {
        artifactPaths,
        manifest: snapshot.manifest,
        packageVersion: PACKAGE_VERSION,
        recordFingerprint: snapshot.recordFingerprint,
        recordsIndexed: snapshot.records.length,
        repositoryRealpath: snapshot.repositoryRealpath,
        schemaVersion: SCHEMA_VERSION,
      })
      if (cacheReadTestHooks.beforeCacheSnapshotCommit?.() === 'repository-changed') {
        return mutationSnapshotChanged()
      }
      assertCacheWriteSnapshotCurrent(snapshot)
      database.exec('COMMIT')
      rebuildResult = { hydrated: true, recordsIndexed: snapshot.records.length }
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch (rollbackError) {
        if (error instanceof MutationCacheSnapshotChanged) {
          throw rollbackError
        }
        // The original transaction failure is more useful than a secondary rollback failure.
      }
      throw error
    }
  } catch (error) {
    writerFailure = error
    writerFailed = true
  }
  try {
    database.close()
  } catch (error) {
    if (!writerFailed || writerFailure instanceof MutationCacheSnapshotChanged) {
      writerFailure = error
      writerFailed = true
    }
  }
  if (writerFailed) {
    if (writerFailure instanceof MutationCacheSnapshotChanged) {
      return { kind: 'repository-changed', retryPrimary }
    }
    if (writerFailure instanceof EncephalonError || writerFailure instanceof CacheDatabaseFailure) {
      throw writerFailure
    }
    if (isRecoverableCacheFailure(writerFailure)) {
      return failCacheDatabase(writerFailure, identity)
    }
    throw writerFailure
  }
  if (rebuildResult !== undefined) {
    return { kind: 'committed', rebuild: { database: identity, result: rebuildResult, snapshot } }
  }
  return fail('INTERNAL_ERROR', 'The Encephalon cache writer ended unexpectedly.')
}

const rebuildCache = (
  root: string,
  location: CacheLocation = inspectCacheLocation(root),
  primary: CacheWriterPrimary = { kind: 'create-if-missing' },
  readCorpus = () => {
    const snapshot = readValidatedRecordSnapshotResolved(root, cacheReadTestHooks.recordReadHooks)
    cacheReadTestHooks.afterCanonicalValidation?.()
    return snapshot
  },
): CompletedCacheRebuild => {
  const attempts = Array.from({ length: MAX_REPOSITORY_CHANGE_RETRIES }, (_, index) => index)
  let nextWriterPrimary = primary
  let repositoryChangeObserved = false
  for (const attempt of attempts) {
    let snapshot: ValidatedRecordCacheSnapshot
    try {
      snapshot = readCorpus()
    } catch (error) {
      const validationIssueCodes =
        error instanceof EncephalonError && error.code === 'VALIDATION_FAILED' && Array.isArray(error.details.errors)
          ? error.details.errors.flatMap(issue =>
              issue !== null && typeof issue === 'object' && !Array.isArray(issue) && typeof issue.code === 'string'
                ? [issue.code]
                : [],
            )
          : []
      const changed =
        error instanceof ArtifactChangedError ||
        (error instanceof EncephalonError && error.code === 'REPOSITORY_CHANGED') ||
        (repositoryChangeObserved &&
          validationIssueCodes.some(
            code => code === 'CORPUS_DIRECTORY_ENTRY_LIMIT' || code === 'INVALID_RECORD_LAYOUT',
          ))
      if (!changed) {
        throw error
      }
      repositoryChangeObserved = true
      if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
        return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
      }
      continue
    }
    const written = (() => {
      try {
        return writeCacheSnapshot(root, location, nextWriterPrimary, {
          ...snapshot,
          repositoryRealpath: location.repository,
        })
      } catch (error) {
        if (error instanceof CacheDatabaseCreationConflict && primary.kind === 'create-if-missing') {
          return fail('REPOSITORY_CHANGED', 'The Encephalon cache layout changed during the operation.', {
            entry: error.relativePath,
            invariant: 'stable-identity',
          })
        }
        throw error
      }
    })()
    if (written.kind === 'committed') {
      return written.rebuild
    }
    repositoryChangeObserved = true
    nextWriterPrimary = written.retryPrimary
    if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
      return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
    }
  }
  return fail('INTERNAL_ERROR', 'The Encephalon cache rebuild ended unexpectedly.')
}

type CacheRebuilder = (root: string, location: CacheLocation, primary?: CacheWriterPrimary) => CompletedCacheRebuild

const mutationCacheRebuilder = (snapshot: ValidatedMutationCacheSnapshot): CacheRebuilder => {
  let discarded = false
  let replacement: VerifiedCorpus | undefined
  const fallback: CacheRebuilder = (root, location, primary) =>
    rebuildCache(root, location, primary, () => {
      if (replacement !== undefined) {
        try {
          replacement.assertCurrent()
        } catch (error) {
          if (error instanceof EncephalonError && error.code === 'REPOSITORY_CHANGED') {
            replacement = undefined
          } else {
            throw error
          }
        }
      }
      if (replacement === undefined) {
        replacement = readValidatedRecordSnapshotResolved(root, cacheReadTestHooks.recordReadHooks)
        cacheReadTestHooks.afterCanonicalValidation?.()
      }
      return replacement
    })
  return (root, location, primary = { kind: 'create-if-missing' }) => {
    if (discarded) {
      return fallback(root, location, primary)
    }
    try {
      assertMutationSnapshotCurrent(location, snapshot)
      const manifest = boundedRepositoryManifestFromObservations(root, snapshot.artifacts)
      if (manifest.kind !== 'stable') {
        return mutationSnapshotChanged()
      }
      assertMutationSnapshotCurrent(location, snapshot)
      const assertCurrent = () => {
        try {
          assertMutationSnapshotCurrent(location, snapshot)
        } catch (error) {
          if (error instanceof MutationCacheSnapshotChanged) {
            return fail('REPOSITORY_CHANGED', 'Canonical records changed after validation.')
          }
          throw error
        }
      }
      const written = writeCacheSnapshot(root, location, primary, {
        ...snapshot,
        assertCurrent,
        manifest: manifest.value,
      })
      if (written.kind === 'committed') {
        return written.rebuild
      }
      discarded = true
      return fallback(root, location, written.retryPrimary)
    } catch (error) {
      if (error instanceof MutationCacheSnapshotChanged) {
        discarded = true
        return fallback(root, location, primary)
      }
      if (error instanceof CacheDatabaseCreationConflict && primary.kind === 'create-if-missing') {
        return fail('REPOSITORY_CHANGED', 'The Encephalon cache layout changed during the operation.', {
          entry: error.relativePath,
          invariant: 'stable-identity',
        })
      }
      throw error
    }
  }
}

const withCacheOperationLock = <Result>(
  root: string,
  location: CacheLocation,
  operation: (captured: CacheLocation) => Result,
): Result => {
  let capturedFailure: unknown
  let hasCapturedFailure = false
  try {
    return withOperationLock(
      root,
      captured => {
        try {
          return operation(captured)
        } catch (failure) {
          if (!(failure instanceof EncephalonError) && isRecoverableCacheFailure(failure)) {
            capturedFailure = failure
            hasCapturedFailure = true
          }
          throw failure
        }
      },
      {},
      location,
    )
  } catch (failure) {
    if (hasCapturedFailure) {
      throw capturedFailure
    }
    throw failure
  }
}

type DisposableCacheRecovery = { kind: 'rebuilt'; rebuild: CompletedCacheRebuild } | { kind: 'retry' }
type CacheRecoveryLockMode = 'acquire' | 'held'
type DisposableCacheRecoveryCompletion<Result> =
  | { kind: 'complete-from-rebuild'; complete: (rebuild: CompletedCacheRebuild) => Result }
  | { kind: 'retry-operation' }

type CacheReadRecoveryState = {
  rebuild?: CompletedCacheRebuild | undefined
}

type DisposableCacheRecoveryOptions<Result> = {
  completion: DisposableCacheRecoveryCompletion<Result>
  lockMode: CacheRecoveryLockMode
  readState?: CacheReadRecoveryState | undefined
  rebuilder?: CacheRebuilder | undefined
}

const completedRecoveryRebuild = (rebuild: CompletedCacheRebuild): DisposableCacheRecovery => {
  cacheReadTestHooks.afterDisposableCacheRecoveryRebuild?.(rebuild.result)
  return { kind: 'rebuilt', rebuild }
}

const recoverDisposableCacheUnderLock = (
  root: string,
  location: CacheLocation,
  failure: unknown,
  rebuilder: CacheRebuilder,
): DisposableCacheRecovery => {
  if (failure instanceof CacheDatabaseFailure) {
    quarantineCacheDatabase(location, failure.database)
    return completedRecoveryRebuild(rebuilder(root, location))
  }
  if (failure instanceof CacheDatabaseObservedMissing) {
    if (inspectCacheDatabase(location, 'brain.sqlite') === undefined) {
      cacheReadTestHooks.afterMissingPrimaryRecoveryObservation?.()
      try {
        return completedRecoveryRebuild(rebuilder(root, location, { kind: 'create-exclusive' }))
      } catch (error) {
        if (error instanceof CacheDatabaseCreationConflict) {
          return { kind: 'retry' }
        }
        throw error
      }
    }
    return { kind: 'retry' }
  }
  throw failure
}

const recoverDisposableCacheOnce = (
  root: string,
  location: CacheLocation,
  failure: unknown,
  lockMode: CacheRecoveryLockMode,
  rebuilder: CacheRebuilder,
): DisposableCacheRecovery => {
  if (isRecoverableCacheFailure(failure)) {
    return lockMode === 'acquire'
      ? withCacheOperationLock(root, location, captured =>
          recoverDisposableCacheUnderLock(root, captured, failure, rebuilder),
        )
      : recoverDisposableCacheUnderLock(root, location, failure, rebuilder)
  }
  throw failure
}

const runWithDisposableCacheRecovery = <Result>(
  root: string,
  location: CacheLocation,
  operation: () => Result,
  options: DisposableCacheRecoveryOptions<Result>,
): Result => {
  try {
    return operation()
  } catch (failure) {
    if (!(failure instanceof EncephalonError) && isRecoverableCacheFailure(failure)) {
      if (options.readState?.rebuild !== undefined) {
        throw failure
      }
      const recovery = recoverDisposableCacheOnce(
        root,
        location,
        failure,
        options.lockMode,
        options.rebuilder ?? rebuildCache,
      )
      if (recovery.kind === 'rebuilt' && options.readState !== undefined) {
        options.readState.rebuild = recovery.rebuild
      }
      if (recovery.kind === 'rebuilt' && options.completion.kind === 'complete-from-rebuild') {
        return options.completion.complete(recovery.rebuild)
      }
      return operation()
    }
    throw failure
  }
}

type CachePreparationCompletion<Result> =
  | { kind: 'prepare' }
  | {
      kind: 'read'
      read: (database: DatabaseSync, recordSource: RecordSource) => Result
      state: CacheReadRecoveryState
    }

type FreshCacheResult<Result> = { kind: 'fresh'; result: Result } | { kind: 'stale' }

/** The records a read may return, resolved by identity from a query's selected rows. */
type RecordSource = Readonly<{
  recordById: (id: string) => BrainRecord | undefined
  summaryOf: (record: BrainRecord) => string | null
}>

const verifiedCorpusRecordSource = (corpus: VerifiedCorpus): RecordSource =>
  Object.freeze({
    recordById: (id: string) => corpus.byId.get(id),
    summaryOf: (record: BrainRecord) => corpus.recordFacts(record).projection.summary,
  })

class TrustedReadUnavailable extends Error {}

type SettledRacyRecord = Readonly<{ digest: string; id: string }>

type TrustedReadSettlement = Readonly<{ manifest: string; records: readonly SettledRacyRecord[] }>

/**
 * Clears racy flags that a trusted read has just proven, so later reads stop rehashing those files. It is only an
 * optimisation and never waits: a busy or failed write leaves the flags set for the next trusted read to verify.
 * The operation lock is unnecessary because the update applies only while the cached manifest is the one the read
 * proved; a concurrent writer either replaces every row afterwards or changes that manifest first.
 */
const settleRacyRecords = (location: CacheLocation, settlement: TrustedReadSettlement) => {
  try {
    const existing = inspectCacheDatabase(location, 'brain.sqlite')
    if (existing === undefined) {
      return
    }
    const { database } = openWriterDatabase(location, { database: existing, kind: 'expected-owned' }, () => {})
    try {
      database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
      const current = readMetadata(database)
      if (current?.manifest === settlement.manifest) {
        const settle = database.prepare('UPDATE records SET racy = 0 WHERE id = ? AND digest = ? AND racy = 1')
        for (const { digest, id } of settlement.records) {
          settle.run(id, digest)
        }
      }
      database.exec('COMMIT')
    } finally {
      if (database.isTransaction) {
        database.exec('ROLLBACK')
      }
      database.close()
    }
  } catch {
    // See the function comment: a failed settlement costs one more verification, never a wrong read.
  }
}

const createDigestVerifiedRecordSource = (root: string, database: DatabaseSync) => {
  const lookup = database.prepare('SELECT kind, digest FROM records WHERE id = ?')
  const accepted = new Map<string, BrainRecord>()
  const load = (id: unknown, kind: unknown, digest: unknown) => {
    if (typeof id !== 'string' || typeof kind !== 'string' || typeof digest !== 'string') {
      throw new CacheSchemaMismatch('The cache contains an invalid record identity.')
    }
    try {
      validateId(id)
      validateKind(kind)
    } catch (error) {
      throw new CacheSchemaMismatch('The cache contains an invalid record identity.', { cause: error })
    }
    const verified = readDigestVerifiedRecord(root, kind, id, digest)
    if (verified === undefined) {
      throw new TrustedReadUnavailable()
    }
    const { record } = verified
    if (record.id !== id || record.kind !== kind) {
      throw new CacheSchemaMismatch('The cache record identity does not match its canonical file.')
    }
    const summary = summaryForRecord(record)
    if (!(record.subject.isWellFormed() && record.source.isWellFormed() && (summary?.isWellFormed() ?? true))) {
      // SQLite cannot store this text faithfully; full validation reports that consistently for every read.
      throw new TrustedReadUnavailable()
    }
    accepted.set(id, record)
    return { digest, id, racy: verified.racy, record }
  }
  return Object.freeze({
    recordById: (id: string) => {
      const known = accepted.get(id)
      if (known !== undefined) {
        return known
      }
      const row = lookup.get(id) as { digest?: unknown; kind?: unknown } | undefined
      return row === undefined ? undefined : load(id, row.kind, row.digest).record
    },
    summaryOf: summaryForRecord,
    /** Rehashes every racy record and returns those whose metadata alone now proves their content. */
    verifyRacyRecords: (): SettledRacyRecord[] => {
      const rows = database.prepare('SELECT id, kind, digest FROM records WHERE racy = 1').iterate() as Iterable<{
        digest?: unknown
        id?: unknown
        kind?: unknown
      }>
      return Array.from(rows, row => load(row.id, row.kind, row.digest))
        .filter(loaded => !loaded.racy)
        .map(({ digest: settledDigest, id: settledId }) => ({ digest: settledDigest, id: settledId }))
    },
  })
}

const currentCanonicalManifest = (root: string, artifactPaths: readonly string[]) => {
  const artifacts: ArtifactObservation[] = []
  for (const path of artifactPaths) {
    try {
      artifacts.push({ metadata: lstatSync(resolve(root, 'encephalon', path), { bigint: true }), path })
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException
      if (code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR') {
        return
      }
      throw error
    }
  }
  const manifest = boundedRepositoryManifestFromObservations(root, artifacts)
  return manifest.kind === 'stable' ? manifest.value : undefined
}

/**
 * Answers a read from a cache whose recorded file metadata still matches every canonical record, directory and
 * artifact, without reading the unselected records. `undefined` sends the read to full canonical validation.
 */
const readTrustedCacheResult = <Result>(
  root: string,
  database: DatabaseSync,
  read: (database: DatabaseSync, recordSource: RecordSource) => Result,
): Readonly<{ result: Result; settled?: TrustedReadSettlement }> | undefined => {
  const metadata = readMetadata(database)
  assertCacheScope(root, metadata)
  if (
    metadata?.recordFingerprint === undefined ||
    currentCanonicalManifest(root, metadata.artifactPaths) !== metadata.manifest
  ) {
    return
  }
  const rows = database.prepare('SELECT COUNT(*) AS row_count FROM records').get() as { row_count?: unknown }
  if (rows.row_count !== metadata.recordsIndexed) {
    throw new CacheSchemaMismatch('The cache record table does not match its metadata.')
  }
  const records = createDigestVerifiedRecordSource(root, database)
  try {
    const settled = records.verifyRacyRecords()
    cacheReadInstrumentation.afterIntegrityValidation?.()
    cacheReadInstrumentation.beforeResultRead?.()
    const result = read(database, records)
    cacheReadInstrumentation.afterResultRead?.()
    return settled.length === 0 ? { result } : { result, settled: { manifest: metadata.manifest, records: settled } }
  } catch (error) {
    if (error instanceof TrustedReadUnavailable) {
      return
    }
    throw error
  }
}

/** Cached evidence for one canonical record file, keyed by its repository-relative path. */
type TrustedRecordEvidence = Readonly<{ digest: string; racy: boolean }>

/** What a trusted add needs from the cache once it has proven the candidate valid against cached facts. */
type TrustedAppendPlan = Readonly<{
  artifactPaths: readonly string[]
  latestCreatedAt: string | undefined
  manifest: string
  records: ReadonlyMap<string, TrustedRecordEvidence>
  settled: readonly SettledRacyRecord[]
}>

const sameCaseInsensitivePath = (first: string, second: string) =>
  first.normalize('NFC').toLowerCase() === second.normalize('NFC').toLowerCase()

/**
 * @internal
 * Proves `candidate` would leave the canonical corpus valid using only a current cache: an unchanged manifest,
 * rehashed racy records and cached graph and budget facts. `undefined` means full canonical planning must decide,
 * which also reports every rejection with its usual error and recovers a corrupt or foreign cache.
 */
export const readTrustedAppendPlan = (
  root: string,
  location: CacheLocation,
  candidate: BrainRecord,
  candidateBytes: number,
): TrustedAppendPlan | undefined => {
  try {
    return inspectCacheDatabase(location, 'brain.sqlite') === undefined
      ? undefined
      : readTrustedAppendPlanFromCache(root, location, candidate, candidateBytes)
  } catch {}
}

const readTrustedAppendPlanFromCache = (
  root: string,
  location: CacheLocation,
  candidate: BrainRecord,
  candidateBytes: number,
): TrustedAppendPlan | undefined =>
  readVerifiedCacheTransaction(location, database => {
    const metadata = readMetadata(database)
    assertCacheScope(root, metadata)
    if (
      metadata?.recordFingerprint === undefined ||
      currentCanonicalManifest(root, metadata.artifactPaths) !== metadata.manifest
    ) {
      return
    }
    let settled: readonly SettledRacyRecord[]
    try {
      settled = createDigestVerifiedRecordSource(root, database).verifyRacyRecords()
    } catch (error) {
      if (error instanceof TrustedReadUnavailable) {
        return
      }
      throw error
    }
    const collision = database
      .prepare('SELECT 1 AS found FROM records WHERE lower(kind) = lower(?) AND lower(id) = lower(?) LIMIT 1')
      .get(candidate.kind, candidate.id)
    if (collision !== undefined) {
      return
    }
    const supersedes = candidate.supersedes ?? []
    const target = database.prepare('SELECT kind, subject FROM records WHERE id = ?')
    const validTargets = supersedes.every(id => {
      const row = target.get(id) as { kind?: unknown; subject?: unknown } | undefined
      return id !== candidate.id && row?.kind === candidate.kind && row.subject === candidate.subject
    })
    const heads = database
      .prepare('SELECT id FROM records WHERE kind = ? AND subject = ? AND active = 1')
      .all(candidate.kind, candidate.subject) as Array<{ id?: unknown }>
    if (!(validTargets && heads.every(head => typeof head.id === 'string' && supersedes.includes(head.id)))) {
      return
    }
    const totals = database
      .prepare(`SELECT COUNT(*) AS records, TOTAL(bytes) AS bytes, TOTAL(edges) AS edges,
        TOTAL(artifacts) AS artifacts, MAX(created_at) AS latest FROM records`)
      .get() as { artifacts?: unknown; bytes?: unknown; edges?: unknown; latest?: unknown; records?: unknown }
    const candidateArtifacts = candidate.artifacts ?? []
    const withinBudgets =
      totals.records === metadata.recordsIndexed &&
      Number(totals.records) + 1 <= MAX_CANONICAL_RECORDS &&
      Number(totals.bytes) + candidateBytes <= MAX_CANONICAL_RECORD_BYTES &&
      Number(totals.edges) + supersedes.length <= MAX_SUPERSESSION_EDGES &&
      Number(totals.artifacts) + candidateArtifacts.length <= MAX_ARTIFACT_REFERENCES
    const artifactCollision = candidateArtifacts.some(artifact =>
      metadata.artifactPaths.some(existing => existing !== artifact && sameCaseInsensitivePath(existing, artifact)),
    )
    if (!withinBudgets || artifactCollision || (totals.latest !== null && typeof totals.latest !== 'string')) {
      return
    }
    const rows = database.prepare('SELECT kind, id, digest, racy FROM records').iterate() as Iterable<{
      digest?: unknown
      id?: unknown
      kind?: unknown
      racy?: unknown
    }>
    const records = new Map<string, TrustedRecordEvidence>()
    for (const row of rows) {
      if (typeof row.kind !== 'string' || typeof row.id !== 'string' || typeof row.digest !== 'string') {
        throw new CacheSchemaMismatch('The cache contains an invalid record identity.')
      }
      records.set(`encephalon/${row.kind}/${row.id}.json`, { digest: row.digest, racy: row.racy !== 0 })
    }
    return Object.freeze({
      artifactPaths: metadata.artifactPaths,
      latestCreatedAt: totals.latest ?? undefined,
      manifest: metadata.manifest,
      records,
      settled,
    })
  })

/**
 * @internal
 * Adds one just-published record to a cache that still describes the corpus before it. `assertCurrent` must prove
 * that nothing else changed, so the manifest written here never vouches for an unindexed edit. `false` means the
 * caller must rebuild the cache instead.
 */
export const appendTrustedCacheRecord = (
  root: string,
  location: CacheLocation,
  input: Readonly<{
    artifactPaths: readonly string[]
    assertCurrent: () => void
    bytes: number
    digest: string
    expectedManifest: string
    record: BrainRecord
    /** Racy records the plan rehashed with settled timestamps; `assertCurrent` proves them unchanged since. */
    settled: readonly SettledRacyRecord[]
  }>,
): boolean => {
  const existing = inspectCacheDatabase(location, 'brain.sqlite')
  if (existing === undefined) {
    return false
  }
  const { database } = openWriterDatabase(location, { database: existing, kind: 'expected-owned' }, () => {})
  try {
    database.exec('BEGIN IMMEDIATE')
    const metadata = readMetadata(database)
    if (metadata?.recordFingerprint === undefined || metadata.manifest !== input.expectedManifest) {
      return false
    }
    const { record } = input
    prepareRecordInsert(database)(
      record,
      { bytes: input.bytes, digest: input.digest, projection: recordProjection(record), racy: true },
      true,
    )
    const supersede = database.prepare('UPDATE records SET active = 0 WHERE id = ?')
    for (const id of record.supersedes ?? []) {
      supersede.run(id)
    }
    const witnesses = (
      database.prepare('SELECT kind, id, digest FROM records').all() as Array<{
        digest: string
        id: string
        kind: string
      }>
    )
      .map(row => ({ digest: row.digest, path: `encephalon/${row.kind}/${row.id}.json` }))
      .sort((first, second) => ordinalStringCompare(first.path, second.path))
    const manifest = currentCanonicalManifest(root, input.artifactPaths)
    if (manifest === undefined) {
      return false
    }
    input.assertCurrent()
    const settle = database.prepare('UPDATE records SET racy = 0 WHERE id = ? AND digest = ? AND racy = 1')
    for (const { digest, id } of input.settled) {
      settle.run(id, digest)
    }
    writeMetadata(database, {
      artifactPaths: input.artifactPaths,
      manifest,
      packageVersion: PACKAGE_VERSION,
      recordFingerprint: recordCorpusFingerprint(witnesses),
      recordsIndexed: witnesses.length,
      repositoryRealpath: metadata.repositoryRealpath,
      schemaVersion: SCHEMA_VERSION,
    })
    database.exec('COMMIT')
    return true
  } finally {
    if (database.isTransaction) {
      database.exec('ROLLBACK')
    }
    database.close()
  }
}

const readFreshCacheResult = <Result>(
  root: string,
  location: CacheLocation,
  completion: CachePreparationCompletion<Result>,
  expectedRebuild?: CompletedCacheRebuild,
): FreshCacheResult<PrepareResult | Result> => {
  let settlement: TrustedReadSettlement | undefined
  try {
    const completed = readVerifiedCacheTransaction(
      location,
      (database): FreshCacheResult<PrepareResult | Result> => {
        if (
          completion.kind === 'read' &&
          expectedRebuild === undefined &&
          cacheReadTestHooks.requireCanonicalCacheEquality !== true
        ) {
          const trusted = readTrustedCacheResult(root, database, completion.read)
          if (trusted !== undefined) {
            settlement = trusted.settled
            return { kind: 'fresh', result: trusted.result }
          }
        }
        const snapshot =
          expectedRebuild === undefined
            ? readValidatedRecordSnapshotResolved(root, cacheReadTestHooks.recordReadHooks)
            : expectedRebuild.snapshot
        if (expectedRebuild !== undefined) {
          snapshot.assertCurrent()
        }
        const metadata = readMetadata(database)
        if (metadataMatchesSnapshot(root, database, metadata, snapshot)) {
          cacheReadInstrumentation.afterIntegrityValidation?.()
          cacheReadTestHooks.afterCanonicalCacheEqualityValidation?.()
          const result = (() => {
            if (completion.kind === 'read') {
              cacheReadInstrumentation.beforeResultRead?.()
              const read = completion.read(database, verifiedCorpusRecordSource(snapshot))
              cacheReadInstrumentation.afterResultRead?.()
              return read
            }
            return { hydrated: false, recordsIndexed: metadata.recordsIndexed }
          })()
          snapshot.assertCurrent()
          return { kind: 'fresh', result }
        }
        return { kind: 'stale' }
      },
      expectedRebuild?.database,
    )
    if (settlement !== undefined) {
      settleRacyRecords(location, settlement)
    }
    return completed
  } catch (error) {
    if (expectedRebuild !== undefined && error instanceof CacheDatabaseCreationConflict) {
      return fail('REPOSITORY_CHANGED', 'The Encephalon cache generation changed after it was rebuilt.')
    }
    throw error
  }
}

function requireFreshCacheResult(
  root: string,
  location: CacheLocation,
  completion: { kind: 'prepare' },
  expectedRebuild?: CompletedCacheRebuild,
): PrepareResult
function requireFreshCacheResult<Result>(
  root: string,
  location: CacheLocation,
  completion: {
    kind: 'read'
    read: (database: DatabaseSync, recordSource: RecordSource) => Result
    state: CacheReadRecoveryState
  },
  expectedRebuild?: CompletedCacheRebuild,
): Result
function requireFreshCacheResult<Result>(
  root: string,
  location: CacheLocation,
  completion: CachePreparationCompletion<Result>,
  expectedRebuild?: CompletedCacheRebuild,
): PrepareResult | Result {
  const completed = readFreshCacheResult(root, location, completion, expectedRebuild)
  if (completed.kind === 'fresh') {
    return completed.result
  }
  if (expectedRebuild !== undefined) {
    return fail('REPOSITORY_CHANGED', 'The Encephalon cache became stale after it was rebuilt.')
  }
  throw new CacheSchemaMismatch('The cache is stale before read.')
}

function resolvePreparedCacheWithoutCorruptionRecovery(
  root: string,
  location: CacheLocation,
  completion: { kind: 'prepare' },
  lockMode?: CacheRecoveryLockMode,
  rebuilder?: CacheRebuilder,
): PrepareResult
function resolvePreparedCacheWithoutCorruptionRecovery<Result>(
  root: string,
  location: CacheLocation,
  completion: {
    kind: 'read'
    read: (database: DatabaseSync, recordSource: RecordSource) => Result
    state: CacheReadRecoveryState
  },
  lockMode?: CacheRecoveryLockMode,
  rebuilder?: CacheRebuilder,
): Result
function resolvePreparedCacheWithoutCorruptionRecovery<Result>(
  root: string,
  location: CacheLocation,
  completion: CachePreparationCompletion<Result>,
  lockMode: CacheRecoveryLockMode = 'acquire',
  rebuilder: CacheRebuilder = rebuildCache,
): PrepareResult | Result {
  if (completion.kind === 'read' && completion.state.rebuild !== undefined) {
    return requireFreshCacheResult(root, location, completion, completion.state.rebuild)
  }
  const serialize = <Serialized>(operation: (captured: CacheLocation) => Serialized) => {
    if (lockMode === 'acquire') {
      return withCacheOperationLock(root, location, operation)
    }
    return operation(location)
  }
  const completeRebuild = (captured: CacheLocation) => {
    const rebuild = rebuilder(root, captured)
    if (completion.kind === 'read') {
      completion.state.rebuild = rebuild
      return requireFreshCacheResult(root, captured, completion, rebuild)
    }
    return rebuild.result
  }
  const completeFresh = (captured: CacheLocation) => readFreshCacheResult(root, captured, completion)
  const existingDatabase = inspectCacheDatabase(location, 'brain.sqlite')
  if (existingDatabase === undefined) {
    return serialize(captured => {
      if (inspectCacheDatabase(captured, 'brain.sqlite') !== undefined) {
        const completed = completeFresh(captured)
        if (completed.kind === 'fresh') {
          return completed.result
        }
      }
      return completeRebuild(captured)
    })
  }
  cacheReadTestHooks.afterPrimaryDatabaseObservation?.('prepare-fast-path')
  const completed = completeFresh(location)
  if (completed.kind === 'fresh') {
    return completed.result
  }
  return serialize(captured => {
    const lockedCompletion = completeFresh(captured)
    if (lockedCompletion.kind === 'fresh') {
      return lockedCompletion.result
    }
    return completeRebuild(captured)
  })
}

const prepareResolvedWithoutCorruptionRecovery = (
  root: string,
  location: CacheLocation,
  lockMode: CacheRecoveryLockMode = 'acquire',
  rebuilder: CacheRebuilder = rebuildCache,
): PrepareResult =>
  resolvePreparedCacheWithoutCorruptionRecovery(root, location, { kind: 'prepare' }, lockMode, rebuilder)

const prepareResolved = (
  root: string,
  lockMode: CacheRecoveryLockMode = 'acquire',
  capturedLocation: CacheLocation = inspectCacheLocation(root),
  rebuilder: CacheRebuilder = rebuildCache,
): PrepareResult => {
  const operation = () => prepareResolvedWithoutCorruptionRecovery(root, capturedLocation, lockMode, rebuilder)
  return runWithDisposableCacheRecovery(root, capturedLocation, operation, {
    completion: { complete: rebuild => rebuild.result, kind: 'complete-from-rebuild' },
    lockMode,
    rebuilder,
  })
}

export const prepareResolvedRepository = (
  root: string,
  lockMode: CacheRecoveryLockMode = 'acquire',
  location?: CacheLocation,
): PrepareResult => prepareResolved(root, lockMode, location)

/** @internal */
export const prepareResolvedMutationSnapshot = (
  root: string,
  snapshot: ValidatedMutationCacheSnapshot,
  lockMode: CacheRecoveryLockMode = 'acquire',
  location?: CacheLocation,
): PrepareResult => prepareResolved(root, lockMode, location, mutationCacheRebuilder(snapshot))

const hydrateResolvedWithRebuilder = (
  root: string,
  lockMode: CacheRecoveryLockMode,
  location: CacheLocation | undefined,
  rebuilder: CacheRebuilder,
): PrepareResult => {
  const captured = location ?? inspectCacheLocation(root)
  const hydrateUnderLock = (heldLocation: CacheLocation) =>
    runWithDisposableCacheRecovery(root, heldLocation, () => rebuilder(root, heldLocation).result, {
      completion: { complete: rebuild => rebuild.result, kind: 'complete-from-rebuild' },
      lockMode: 'held',
      rebuilder,
    })
  return lockMode === 'acquire' ? withCacheOperationLock(root, captured, hydrateUnderLock) : hydrateUnderLock(captured)
}

export const hydrateResolvedRepository = (
  root: string,
  lockMode: CacheRecoveryLockMode = 'acquire',
  location?: CacheLocation,
): PrepareResult => hydrateResolvedWithRebuilder(root, lockMode, location, rebuildCache)

/** @internal */
export const hydrateResolvedMutationSnapshot = (
  root: string,
  snapshot: ValidatedMutationCacheSnapshot,
  lockMode: CacheRecoveryLockMode = 'acquire',
  location?: CacheLocation,
): PrepareResult => hydrateResolvedWithRebuilder(root, lockMode, location, mutationCacheRebuilder(snapshot))

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

type ResultLimitBudgetKey = 'compactResultLimit' | 'fullResultLimit'

const positiveLimit = (value: unknown, budgetKey: ResultLimitBudgetKey) => {
  const budget = OPERATION_BUDGETS[budgetKey]
  const limit = value === undefined ? budget.default : value
  if (typeof limit === 'number' && Number.isInteger(limit) && limit >= budget.minimum && limit <= budget.maximum) {
    return limit
  }
  return failBudget(budgetKey, `limit must be an integer between ${budget.minimum} and ${budget.maximum}.`)
}

const fullResultLimit = (value: unknown) => positiveLimit(value, 'fullResultLimit')

const compactResultLimit = (value: unknown) => positiveLimit(value, 'compactResultLimit')

const readFreshCache = <Result>(
  root: string,
  location: CacheLocation,
  read: (database: DatabaseSync, recordSource: RecordSource) => Result,
  state: CacheReadRecoveryState,
) => requireFreshCacheResult(root, location, { kind: 'read', read, state }, state.rebuild)

const withPreparedDatabase = <Result>(
  input: RootInput,
  read: (database: DatabaseSync, recordSource: RecordSource) => Result,
) => {
  const root = resolveRepository(input)
  const readState: CacheReadRecoveryState = {}
  try {
    const location = inspectCacheLocation(root)
    return runWithDisposableCacheRecovery(
      root,
      location,
      () =>
        resolvePreparedCacheWithoutCorruptionRecovery(root, location, {
          kind: 'read',
          read,
          state: readState,
        }),
      { completion: { kind: 'retry-operation' }, lockMode: 'acquire', readState },
    )
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to read the Encephalon cache.', error)
  }
}

const canonicalRecordFromRow = (row: RecordRow, recordSource: RecordSource): BrainRecord => {
  const record = typeof row.id === 'string' ? recordSource.recordById(row.id) : undefined
  if (record !== undefined) {
    return record
  }
  throw new CacheSchemaMismatch('The cache returned an unknown canonical record identity.')
}

const materializeRecordRow = (row: RecordRow, recordSource: RecordSource, budget: ResponseByteBudget) => {
  const record = canonicalRecordFromRow(row, recordSource)
  budget.chargeBytes(byteLength(JSON.stringify(record)))
  return structuredClone(record)
}

const materializeRecordRows = (rows: Iterable<RecordRow>, recordSource: RecordSource) => {
  const budget = createResponseByteBudget('fullResponseBytes')
  return Array.from(rows, row => materializeRecordRow(row, recordSource, budget))
}

export const listRecords = (input: ListRecordsInput = {}): BrainRecord[] => {
  const parsed = parseListRecordsInput(input)
  const limit = fullResultLimit(parsed.limit)
  return withPreparedDatabase(parsed, (database, corpus) => {
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
      .prepare(`SELECT id FROM records ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .iterate(...parameters) as Iterable<RecordRow>
    return materializeRecordRows(rows, corpus)
  })
}

export const showRecord = (input: ShowRecordInput): BrainRecord | null => {
  const parsed = parseShowRecordInput(input)
  return withPreparedDatabase(parsed, (database, corpus) => {
    const activeClause = parsed.activeOnly === true ? ' AND active = 1' : ''
    const row = database.prepare(`SELECT id FROM records WHERE id = ?${activeClause}`).get(parsed.id) as
      | RecordRow
      | undefined
    return row === undefined ? null : materializeRecordRow(row, corpus, createResponseByteBudget('fullResponseBytes'))
  })
}

// Keep FTS outermost in both search joins; older SQLite otherwise repeats MATCH for every active record.
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
      records.id
    FROM record_search
    CROSS JOIN records ON records.rowid = record_search.rowid
    WHERE ${conditions.join(' AND ')}
    ORDER BY bm25(record_search) ASC, records.created_at DESC, records.id DESC
    LIMIT ?
  `)
    .iterate(...parameters) as Iterable<RecordRow>
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

const compactRecordFromRow = (row: CompactRow, recordSource: RecordSource): CompactBrainRecord => {
  const record = canonicalRecordFromRow(row, recordSource)
  return {
    id: record.id,
    kind: record.kind,
    path: record.path,
    rank: compactRank(row.rank),
    snippet: compactSnippet(row.snippet),
    subject: record.subject,
    summary: recordSource.summaryOf(record),
  }
}

const createCompactSearchReader = (
  database: DatabaseSync,
  recordSource: RecordSource,
  input: SearchStatementInput,
  budget: ResponseByteBudget,
) => {
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
      bm25(record_search) AS rank,
      snippet(record_search, 1, '[', ']', '...', 16) AS snippet
    FROM record_search
    CROSS JOIN records ON records.rowid = record_search.rowid
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank ASC, records.created_at DESC, records.id DESC
    LIMIT ?
  `
  cacheReadTestHooks.onCompactSearchPrepare?.(source)
  const statement = database.prepare(source)
  return (query: string, match: string) => {
    if (match.length > 0) {
      let bytes = 0
      const compact = Array.from(statement.iterate(match, ...kindParameters, limit) as Iterable<CompactRow>, row => {
        const record = compactRecordFromRow(row, recordSource)
        bytes += budget.chargeAndMeasure(record)
        return record
      })
      cacheReadTestHooks.afterCompactSearchRead?.(query)
      return { bytes, records: compact }
    }
    return { bytes: 0, records: [] }
  }
}

export const searchRecords = (input: SearchRecordsInput): BrainRecord[] => {
  const parsed = parseFullSearchRecordsInput(input)
  const match = literalMatchQuery(parsed.query)
  const limit = fullResultLimit(parsed.limit)
  if (match.length > 0) {
    return withPreparedDatabase(parsed, (database, corpus) =>
      materializeRecordRows(searchRows(database, parsed, match, limit), corpus),
    )
  }
  resolveRepository(parsed)
  return []
}

export const searchCompactRecords = (input: SearchRecordsInput): CompactBrainRecord[] => {
  const parsed = parseCompactSearchRecordsInput(input)
  const match = literalMatchQuery(parsed.query)
  compactResultLimit(parsed.limit)
  if (match.length > 0) {
    return withPreparedDatabase(parsed, (database, corpus) => {
      const budget = createResponseByteBudget('compactResponseBytes')
      budget.charge([])
      return createCompactSearchReader(database, corpus, parsed, budget)(parsed.query, match).records
    })
  }
  resolveRepository(parsed)
  return []
}

const createShowReader = (
  database: DatabaseSync,
  recordSource: RecordSource,
  includeSuperseded: boolean | undefined,
) => {
  const activeClause = includeSuperseded === true ? '' : ' AND active = 1'
  const source = `SELECT id FROM records WHERE id = ?${activeClause}`
  cacheReadTestHooks.onShowPrepare?.(source)
  const statement = database.prepare(source)
  return (id: string) => {
    const row = statement.get(id) as RecordRow | undefined
    cacheReadTestHooks.afterShowRead?.(id)
    return row === undefined ? null : canonicalRecordFromRow(row, recordSource)
  }
}

type LiteralSearch = Readonly<{ match: string; query: string }>

const assertGatherBudgets = (input: GatherInput): LiteralSearch[] => {
  const searches = input.searches ?? []
  const shows = input.shows ?? []
  if (searches.length > MAX_GATHER_SEARCHES) {
    return failBudget('gatherSearches', `gather may contain at most ${MAX_GATHER_SEARCHES} searches.`)
  }
  if (shows.length > MAX_GATHER_SHOWS) {
    return failBudget('gatherShows', `gather may contain at most ${MAX_GATHER_SHOWS} shows.`)
  }
  return searches.map(query => ({ match: literalMatchQuery(query), query }))
}

const readGatherFromDatabase = (
  database: DatabaseSync,
  recordSource: RecordSource,
  input: GatherInput,
  hydrated: HydrateResult | null,
  searches: readonly LiteralSearch[],
): GatherResult => {
  const shows = input.shows ?? []
  const budget = createResponseByteBudget('gatherResponseBytes')
  budget.charge({ hydrated, records: [], searches: [] })
  const showRecordForId =
    shows.length === 0 ? () => null : createShowReader(database, recordSource, input.includeSuperseded)
  const searchCompactRecordsForQuery =
    searches.length === 0
      ? () => ({ bytes: 0, records: [] })
      : createCompactSearchReader(database, recordSource, input, budget)
  const shownRecords = new Map<string, Readonly<{ bytes: number; record: BrainRecord | null }>>()
  const searchResults = new Map<string, Readonly<{ bytes: number; result: GatherResult['searches'][number] }>>()
  const memoizedShowRecordForId = (id: string) => {
    const cached = shownRecords.get(id)
    if (cached !== undefined) {
      return cached
    }
    const record = showRecordForId(id)
    const measured = { bytes: logicalResponseBytes({ id, record }), record }
    shownRecords.set(id, measured)
    return measured
  }
  const memoizedSearchForQuery = (search: LiteralSearch) => {
    const cached = searchResults.get(search.query)
    if (cached !== undefined) {
      budget.chargeBytes(cached.bytes)
      return { ...cached.result, results: cached.result.results.map(record => ({ ...record })) }
    }
    const envelope = { kind: input.kind ?? null, query: search.query, results: [] }
    const envelopeBytes = budget.chargeAndMeasure(envelope)
    const { bytes, records } = searchCompactRecordsForQuery(search.query, search.match)
    cacheReadTestHooks.afterGatherSearchEvaluation?.(search.query)
    const result = { ...envelope, results: records }
    searchResults.set(search.query, { bytes: envelopeBytes + bytes, result })
    return result
  }
  return {
    hydrated,
    records: shows.map(id => {
      const { bytes, record } = memoizedShowRecordForId(id)
      budget.chargeBytes(bytes)
      return { id, record: record === null ? null : structuredClone(record) }
    }),
    searches: searches.map(memoizedSearchForQuery),
  }
}

const emptyGatherResult = (input: GatherInput, searches: readonly LiteralSearch[]): GatherResult => {
  const budget = createResponseByteBudget('gatherResponseBytes')
  budget.charge({ hydrated: null, records: [], searches: [] })
  return {
    hydrated: null,
    records: [],
    searches: searches.map(search => budget.charge({ kind: input.kind ?? null, query: search.query, results: [] })),
  }
}

const gatherRecordsFromDatabase = (input: GatherInput, searches: readonly LiteralSearch[]) => {
  const root = resolveRepository(input)
  const readState: CacheReadRecoveryState = {}
  try {
    const location = inspectCacheLocation(root)
    if (input.hydrate === true) {
      const readAfterHydration = (heldLocation: CacheLocation, rebuild: CompletedCacheRebuild) => {
        readState.rebuild = rebuild
        return readFreshCache(
          root,
          heldLocation,
          (database, corpus) =>
            readGatherFromDatabase(
              database,
              corpus,
              input,
              { recordsIndexed: rebuild.result.recordsIndexed },
              searches,
            ),
          readState,
        )
      }
      return withCacheOperationLock(root, location, heldLocation =>
        runWithDisposableCacheRecovery(
          root,
          heldLocation,
          () => readAfterHydration(heldLocation, rebuildCache(root, heldLocation)),
          {
            completion: {
              complete: hydration => readAfterHydration(heldLocation, hydration),
              kind: 'complete-from-rebuild',
            },
            lockMode: 'held',
            readState,
          },
        ),
      )
    }
    return runWithDisposableCacheRecovery(
      root,
      location,
      () =>
        resolvePreparedCacheWithoutCorruptionRecovery(root, location, {
          kind: 'read',
          read: (database, corpus) => readGatherFromDatabase(database, corpus, input, null, searches),
          state: readState,
        }),
      { completion: { kind: 'retry-operation' }, lockMode: 'acquire', readState },
    )
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to gather Encephalon records.', error)
  }
}

export const gatherRecords = (input: GatherInput): GatherResult => {
  const parsed = parseGatherInput(input)
  const searches = assertGatherBudgets(parsed)
  compactResultLimit(parsed.limit)
  const requiresDatabase =
    searches.length === 0 ||
    parsed.hydrate === true ||
    (Array.isArray(parsed.shows) && parsed.shows.length > 0) ||
    searches.some(search => search.match.length > 0)
  if (requiresDatabase) {
    return gatherRecordsFromDatabase(parsed, searches)
  }
  resolveRepository(parsed)
  return emptyGatherResult(parsed, searches)
}
