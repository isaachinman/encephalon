import { isUtf8 } from 'node:buffer'
import { type BigIntStats, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  parseCompactSearchRecordsInput,
  parseFullSearchRecordsInput,
  parseGatherInput,
  parseListRecordsInput,
  parseRootInput,
  parseShowRecordInput,
} from './api-input.ts'
import { ArtifactChangedError, type ArtifactObservation, inspectArtifactFiles } from './artifact-inspection.ts'
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
import { manifestEntryMetadataFrom, sameStableEntryMetadata } from './filesystem-entry.ts'
import { PACKAGE_VERSION } from './generated/version.ts'
import { withOperationLock } from './lock.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import { recordCorpusFingerprint } from './record-corpus-fingerprint.ts'
import { MAX_SEARCH_PREVIEW_BYTES, searchDocumentForRecord, searchPreviewForRecord } from './record-projection.ts'
import {
  canonicalCacheManifest,
  canonicalRecordPath,
  type RecordReadHooks,
  readValidatedRecordSnapshotResolved,
  type VerifiedCorpus,
} from './records.ts'
import { resolveRepository } from './repository.ts'
import { createResponseByteBudget, type ResponseByteBudget } from './response-budget.ts'
import { parseRecordFile, validateArtifactPath } from './schema.ts'
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

const SCHEMA_VERSION = '3'
const MAX_REPOSITORY_CHANGE_RETRIES = 3
const MAX_GATHER_SEARCHES = OPERATION_BUDGETS.gatherSearches.maximum
const MAX_GATHER_SHOWS = OPERATION_BUDGETS.gatherShows.maximum
const SQLITE_BUSY_TIMEOUT_MILLISECONDS = 1000
const MAX_CACHE_METADATA_BYTES = 1024 * 1024
const MAX_CACHE_SCHEMA_BYTES = 4 * 1024
const MAX_CACHE_RECORD_OVERHEAD_BYTES = 4096
const MAX_CACHE_RECORD_BYTES = CANONICAL_BUDGETS.recordBytes + MAX_CACHE_RECORD_OVERHEAD_BYTES
const MAX_CACHE_RECORD_JSON_BYTES =
  CANONICAL_BUDGETS.recordJsonBytes + CANONICAL_BUDGETS.records * MAX_CACHE_RECORD_OVERHEAD_BYTES
const MAX_CACHE_RECORD_TEXT_BYTES = MAX_CACHE_RECORD_JSON_BYTES * 2
const MAX_CACHE_SEARCH_DOCUMENT_DUPLICATION_FACTOR = 2
const MAX_CACHE_SEARCH_DOCUMENT_BYTES =
  MAX_CACHE_RECORD_BYTES * MAX_CACHE_SEARCH_DOCUMENT_DUPLICATION_FACTOR * MAX_NFC_UTF8_EXPANSION_FACTOR
const MAX_CACHE_SEARCH_DOCUMENT_AGGREGATE_BYTES =
  MAX_CACHE_RECORD_JSON_BYTES * MAX_CACHE_SEARCH_DOCUMENT_DUPLICATION_FACTOR * MAX_NFC_UTF8_EXPANSION_FACTOR
const MAX_CACHE_FTS_ID_BYTES = CANONICAL_BUDGETS.records * 255
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
const MAX_CACHE_METADATA_AGGREGATE_BYTES = METADATA_KEYS.length * MAX_CACHE_METADATA_BYTES

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

type CacheIntegrityProbeName =
  | 'metadata'
  | 'metadata-columns'
  | 'metadata-schema'
  | 'records'
  | 'records-active-order-index'
  | 'records-columns'
  | 'records-indexes'
  | 'records-kind-subject-index'
  | 'records-schema'
  | 'record-search'
  | 'record-search-columns'
  | 'record-search-schema'

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

type ExpectedOrdinaryColumn = Readonly<{
  constraint?: string
  name: string
  notNull: 0 | 1
  primaryKeyPosition: 0 | 1
  type: 'INTEGER' | 'TEXT'
}>

type ExpectedIndexColumn = Readonly<{
  collation: 'BINARY'
  descending: 0 | 1
  name: string
}>

const METADATA_COLUMNS = [
  { name: 'key', notNull: 0, primaryKeyPosition: 1, type: 'TEXT' },
  { name: 'value', notNull: 1, primaryKeyPosition: 0, type: 'TEXT' },
] as const satisfies readonly ExpectedOrdinaryColumn[]

const RECORD_COLUMNS = [
  { name: 'id', notNull: 0, primaryKeyPosition: 1, type: 'TEXT' },
  { name: 'kind', notNull: 1, primaryKeyPosition: 0, type: 'TEXT' },
  { name: 'subject', notNull: 1, primaryKeyPosition: 0, type: 'TEXT' },
  { name: 'source', notNull: 1, primaryKeyPosition: 0, type: 'TEXT' },
  { name: 'created_at', notNull: 1, primaryKeyPosition: 0, type: 'TEXT' },
  { name: 'path', notNull: 1, primaryKeyPosition: 0, type: 'TEXT' },
  {
    constraint: 'CHECK (active IN (0, 1))',
    name: 'active',
    notNull: 1,
    primaryKeyPosition: 0,
    type: 'INTEGER',
  },
  { name: 'summary', notNull: 0, primaryKeyPosition: 0, type: 'TEXT' },
  { name: 'record_json', notNull: 1, primaryKeyPosition: 0, type: 'TEXT' },
] as const satisfies readonly ExpectedOrdinaryColumn[]

const ordinaryTableDefinition = (columns: readonly ExpectedOrdinaryColumn[]) => `(
${columns
  .map(
    column =>
      `  ${[
        column.name,
        column.type,
        column.primaryKeyPosition === 1 ? 'PRIMARY KEY' : undefined,
        column.notNull === 1 ? 'NOT NULL' : undefined,
        column.constraint,
      ]
        .filter(part => part !== undefined)
        .join(' ')}`,
  )
  .join(',\n')}
)`

const METADATA_TABLE_DEFINITION = ordinaryTableDefinition(METADATA_COLUMNS)
const RECORDS_TABLE_DEFINITION = ordinaryTableDefinition(RECORD_COLUMNS)

const RECORDS_INDEXES = [
  {
    columns: [
      { collation: 'BINARY', descending: 0, name: 'active' },
      { collation: 'BINARY', descending: 1, name: 'created_at' },
      { collation: 'BINARY', descending: 1, name: 'id' },
    ],
    name: 'records_active_order',
    probeName: 'records-active-order-index',
  },
  {
    columns: [
      { collation: 'BINARY', descending: 0, name: 'kind' },
      { collation: 'BINARY', descending: 0, name: 'subject' },
    ],
    name: 'records_kind_subject',
    probeName: 'records-kind-subject-index',
  },
] as const satisfies readonly {
  columns: readonly ExpectedIndexColumn[]
  name: string
  probeName: CacheIntegrityProbeName
}[]

const RECORDS_INDEX_DEFINITIONS = RECORDS_INDEXES.map(
  index =>
    `CREATE INDEX ${index.name} ON records(${index.columns
      .map(column => `${column.name}${column.descending === 1 ? ' DESC' : ''}`)
      .join(', ')})`,
).join(';\n')

const RECORD_SEARCH_DEFINITION = 'fts5(id UNINDEXED, text, preview)'

const schemaTokenPattern =
  /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|[A-Za-z_][A-Za-z0-9_]*|\d+|[(),]|\S/g

const schemaToken = (token: string) => {
  if (/^\s+$|^--|^\/\*/.test(token)) {
    return []
  }
  if (token.startsWith('"')) {
    return [token.slice(1, -1).replaceAll('""', '"').toLowerCase()]
  }
  if (token.startsWith('`')) {
    return [token.slice(1, -1).replaceAll('``', '`').toLowerCase()]
  }
  if (token.startsWith('[')) {
    return [token.slice(1, -1).replaceAll(']]', ']').toLowerCase()]
  }
  return [token.toLowerCase()]
}

const ownedSchemaTokens = (sql: string) => {
  const tokens = [...sql.matchAll(schemaTokenPattern)].flatMap(match => schemaToken(match[0]))
  const tableIndex = tokens.indexOf('table')
  const optionalClause = tokens.slice(tableIndex + 1, tableIndex + 4).join(' ')
  return optionalClause === 'if not exists'
    ? [...tokens.slice(0, tableIndex + 1), ...tokens.slice(tableIndex + 4)]
    : tokens
}

const sameOwnedSchema = (actual: string, expected: string) =>
  JSON.stringify(ownedSchemaTokens(actual)) === JSON.stringify(ownedSchemaTokens(expected))

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

const assertTableColumns = (database: DatabaseSync, table: 'record_search', expected: readonly string[]) => {
  const maximumRows = expected.length + 1
  const maximumNameBytes = Math.max(...expected.map(name => Buffer.byteLength(name, 'utf8')))
  const probeName = `${table.replace('_', '-')}-columns` as CacheIntegrityProbeName
  const probe = readIntegrityProbe(
    probeName,
    database
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          0 AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(name) = 'text' THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= ? THEN 0 ELSE 1 END AS oversized
          FROM pragma_table_info(?)
          LIMIT ?
        )`,
      )
      .get(maximumNameBytes, table, maximumRows) as CacheIntegrityProbe | undefined,
    maximumRows,
  )
  if (
    probe.rows !== expected.length ||
    probe.exceedsAggregateBytes !== 0 ||
    probe.hasInvalidType !== 0 ||
    probe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch(`The ${table} cache table has an incompatible schema.`)
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.(probeName)
  const columns = database
    .prepare('SELECT name FROM pragma_table_info(?) LIMIT ?')
    .iterate(table, maximumRows) as Iterable<{
    name?: unknown
  }>
  const names = [...columns].map(column => column.name)
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new CacheSchemaMismatch(`The ${table} cache table has an incompatible schema.`)
  }
}

const assertOrdinaryTableSchema = (
  database: DatabaseSync,
  table: 'metadata' | 'records',
  expected: readonly ExpectedOrdinaryColumn[],
) => {
  const maximumRows = expected.length + 1
  const maximumNameBytes = Math.max(...expected.map(column => Buffer.byteLength(column.name, 'utf8')))
  const maximumTypeBytes = Math.max(...expected.map(column => Buffer.byteLength(column.type, 'utf8')))
  const probeName = `${table.replace('_', '-')}-columns` as CacheIntegrityProbeName
  const probe = readIntegrityProbe(
    probeName,
    database
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          0 AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0
                    OR (SELECT COUNT(*) FROM (
                      SELECT 1
                      FROM pragma_table_list
                      WHERE schema = 'main' AND name = ?1 AND type = 'table'
                      LIMIT 2
                    )) != 1
               THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(cid) = 'integer'
                       AND typeof(name) = 'text'
                       AND typeof(type) = 'text'
                       AND typeof("notnull") = 'integer'
                       AND "notnull" IN (0, 1)
                       AND dflt_value IS NULL
                       AND typeof(pk) = 'integer'
                       AND pk IN (0, 1)
                       AND typeof(hidden) = 'integer'
                       AND hidden = 0
                 THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= ?2
                       AND typeof(type) = 'text' AND length(CAST(type AS BLOB)) <= ?3
                 THEN 0 ELSE 1 END AS oversized
          FROM pragma_table_xinfo(?1)
          LIMIT ?4
        )`,
      )
      .get(table, maximumNameBytes, maximumTypeBytes, maximumRows) as CacheIntegrityProbe | undefined,
    maximumRows,
  )
  if (
    probe.rows !== expected.length ||
    probe.exceedsAggregateBytes !== 0 ||
    probe.hasInvalidType !== 0 ||
    probe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch(`The ${table} cache table has an incompatible schema.`)
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.(probeName)
  const columns = database
    .prepare(
      `SELECT
        cid,
        name,
        upper(type) AS type,
        "notnull" AS not_null,
        pk,
        hidden,
        CASE WHEN dflt_value IS NULL THEN 1 ELSE 0 END AS default_absent
      FROM pragma_table_xinfo(?)
      ORDER BY cid
      LIMIT ?`,
    )
    .iterate(table, maximumRows) as Iterable<{
    cid?: unknown
    default_absent?: unknown
    hidden?: unknown
    name?: unknown
    not_null?: unknown
    pk?: unknown
    type?: unknown
  }>
  const descriptors = [...columns].map(column => ({
    defaultAbsent: column.default_absent,
    hidden: column.hidden,
    name: column.name,
    notNull: column.not_null,
    primaryKeyPosition: column.pk,
    type: column.type,
  }))
  const expectedDescriptors = expected.map(column => ({
    defaultAbsent: 1,
    hidden: 0,
    name: column.name,
    notNull: column.notNull,
    primaryKeyPosition: column.primaryKeyPosition,
    type: column.type,
  }))
  if (JSON.stringify(descriptors) !== JSON.stringify(expectedDescriptors)) {
    throw new CacheSchemaMismatch(`The ${table} cache table has an incompatible schema.`)
  }
}

const assertOrdinaryTableDefinition = (database: DatabaseSync, table: 'metadata' | 'records', definition: string) => {
  const probeName = `${table}-schema` as CacheIntegrityProbeName
  const probe = readIntegrityProbe(
    probeName,
    database
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          0 AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(sql) = 'text' THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= ?1
                 THEN 0 ELSE 1 END AS oversized
          FROM sqlite_schema
          WHERE type = 'table' AND name = ?2
          LIMIT 2
        )`,
      )
      .get(MAX_CACHE_SCHEMA_BYTES, table) as CacheIntegrityProbe | undefined,
    2,
  )
  if (
    probe.rows !== 1 ||
    probe.exceedsAggregateBytes !== 0 ||
    probe.hasInvalidType !== 0 ||
    probe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch(`The ${table} cache table has an incompatible schema.`)
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.(probeName)
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 2").get(table) as
    | { sql?: unknown }
    | undefined
  if (typeof row?.sql !== 'string' || !sameOwnedSchema(row.sql, `CREATE TABLE ${table} ${definition}`)) {
    throw new CacheSchemaMismatch(`The ${table} cache table has an incompatible schema.`)
  }
}

const assertRecordsIndex = (
  database: DatabaseSync,
  name: string,
  probeName: CacheIntegrityProbeName,
  expected: readonly ExpectedIndexColumn[],
) => {
  const maximumRows = expected.length + 1
  const maximumNameBytes = Math.max(...expected.map(column => Buffer.byteLength(column.name, 'utf8')))
  const maximumCollationBytes = Buffer.byteLength('BINARY', 'utf8')
  const probe = readIntegrityProbe(
    probeName,
    database
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          0 AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(seqno) = 'integer'
                       AND typeof(cid) = 'integer'
                       AND cid >= 0
                       AND typeof(name) = 'text'
                       AND typeof(desc) = 'integer'
                       AND desc IN (0, 1)
                       AND typeof(coll) = 'text'
                       AND key = 1
                 THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= ?2
                       AND typeof(coll) = 'text' AND length(CAST(coll AS BLOB)) <= ?3
                 THEN 0 ELSE 1 END AS oversized
          FROM pragma_index_xinfo(?1)
          WHERE key = 1
          ORDER BY seqno
          LIMIT ?4
        )`,
      )
      .get(name, maximumNameBytes, maximumCollationBytes, maximumRows) as CacheIntegrityProbe | undefined,
    maximumRows,
  )
  if (
    probe.rows !== expected.length ||
    probe.exceedsAggregateBytes !== 0 ||
    probe.hasInvalidType !== 0 ||
    probe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch(`The ${name} cache index has an incompatible schema.`)
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.(probeName)
  const rows = database
    .prepare(
      `SELECT name, desc AS descending, upper(coll) AS collation
       FROM pragma_index_xinfo(?)
       WHERE key = 1
       ORDER BY seqno
       LIMIT ?`,
    )
    .iterate(name, maximumRows) as Iterable<{
    collation?: unknown
    descending?: unknown
    name?: unknown
  }>
  const observed = [...rows].map(row => ({
    collation: row.collation,
    descending: row.descending,
    name: row.name,
  }))
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new CacheSchemaMismatch(`The ${name} cache index has an incompatible schema.`)
  }
}

const assertRecordsIndexes = (database: DatabaseSync) => {
  const maximumRows = RECORDS_INDEXES.length + 1
  const maximumNameBytes = Math.max(...RECORDS_INDEXES.map(index => Buffer.byteLength(index.name, 'utf8')))
  const probe = readIntegrityProbe(
    'records-indexes',
    database
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          0 AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(name) = 'text'
                       AND typeof("unique") = 'integer'
                       AND "unique" = 0
                       AND origin = 'c'
                       AND typeof(partial) = 'integer'
                       AND partial = 0
                 THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) <= ?
                 THEN 0 ELSE 1 END AS oversized
          FROM pragma_index_list('records')
          WHERE origin = 'c'
          LIMIT ?
        )`,
      )
      .get(maximumNameBytes, maximumRows) as CacheIntegrityProbe | undefined,
    maximumRows,
  )
  if (
    probe.rows !== RECORDS_INDEXES.length ||
    probe.exceedsAggregateBytes !== 0 ||
    probe.hasInvalidType !== 0 ||
    probe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch('The records cache indexes have an incompatible schema.')
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.('records-indexes')
  const names = [
    ...(database
      .prepare("SELECT name FROM pragma_index_list('records') WHERE origin = 'c' ORDER BY name LIMIT ?")
      .iterate(maximumRows) as Iterable<{ name?: unknown }>),
  ].map(row => row.name)
  const expectedNames = RECORDS_INDEXES.map(index => index.name).toSorted()
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new CacheSchemaMismatch('The records cache indexes have an incompatible schema.')
  }
  for (const index of RECORDS_INDEXES) {
    assertRecordsIndex(database, index.name, index.probeName, index.columns)
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

const assertCacheSchemaUnchecked = (database: DatabaseSync) => {
  assertOrdinaryTableSchema(database, 'metadata', METADATA_COLUMNS)
  assertOrdinaryTableDefinition(database, 'metadata', METADATA_TABLE_DEFINITION)
  assertOrdinaryTableSchema(database, 'records', RECORD_COLUMNS)
  assertOrdinaryTableDefinition(database, 'records', RECORDS_TABLE_DEFINITION)
  assertRecordsIndexes(database)
  const searchSchemaProbe = readIntegrityProbe(
    'record-search-schema',
    database
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          0 AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(sql) = 'text' THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(sql) = 'text' AND length(CAST(sql AS BLOB)) <= ? THEN 0 ELSE 1 END AS oversized
          FROM sqlite_master
          WHERE type = 'table' AND name = 'record_search'
          LIMIT 2
        )`,
      )
      .get(MAX_CACHE_SCHEMA_BYTES) as CacheIntegrityProbe | undefined,
    2,
  )
  if (
    searchSchemaProbe.rows !== 1 ||
    searchSchemaProbe.exceedsAggregateBytes !== 0 ||
    searchSchemaProbe.hasInvalidType !== 0 ||
    searchSchemaProbe.hasOversizedValue !== 0
  ) {
    throw new CacheSchemaMismatch('The record_search cache table is not an FTS5 table.')
  }
  cacheReadTestHooks.beforeIntegrityTextRead?.('record-search-schema')
  const searchSchema = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record_search' LIMIT 2")
    .get() as { sql?: unknown } | undefined
  if (
    typeof searchSchema?.sql !== 'string' ||
    !sameOwnedSchema(searchSchema.sql, `CREATE VIRTUAL TABLE record_search USING ${RECORD_SEARCH_DEFINITION}`)
  ) {
    throw new CacheSchemaMismatch('The record_search cache table is not an FTS5 table.')
  }
  assertTableColumns(database, 'record_search', ['id', 'text', 'preview'])
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
  database.exec(`
    CREATE TABLE metadata ${METADATA_TABLE_DEFINITION};
    CREATE TABLE records ${RECORDS_TABLE_DEFINITION};
    ${RECORDS_INDEX_DEFINITIONS};
    CREATE VIRTUAL TABLE record_search USING ${RECORD_SEARCH_DEFINITION};
  `)
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
          CASE WHEN TOTAL(value_bytes) > ? THEN 1 ELSE 0 END AS exceeds_aggregate_bytes
        FROM (
          SELECT
            CASE WHEN typeof(key) = 'text' AND typeof(value) = 'text' THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(key) = 'text' AND length(CAST(key AS BLOB)) <= ?
                       AND typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ?
                 THEN 0 ELSE 1 END AS oversized,
            CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ?
                 THEN length(CAST(value AS BLOB)) ELSE 0 END AS value_bytes
          FROM metadata
          LIMIT ?
        )`,
      )
      .get(
        MAX_CACHE_METADATA_AGGREGATE_BYTES,
        maximumKeyBytes,
        MAX_CACHE_METADATA_BYTES,
        MAX_CACHE_METADATA_BYTES,
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
    assertCacheValueSize(row.value, MAX_CACHE_METADATA_BYTES)
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
  const artifactPaths = parseCacheJson(artifactPathsValue, MAX_CACHE_METADATA_BYTES)
  const recordsIndexed = /^(?:0|[1-9]\d*)$/.test(recordsIndexedValue) ? Number(recordsIndexedValue) : Number.NaN
  if (
    !Array.isArray(artifactPaths) ||
    artifactPaths.length > CANONICAL_BUDGETS.records ||
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
        row.bytes > MAX_CACHE_RECORD_BYTES ||
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
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          CASE WHEN TOTAL(record_json_bytes) > ?1 OR TOTAL(record_text_bytes) > ?2
            THEN 1 ELSE 0 END AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(id) = 'text'
                       AND typeof(kind) = 'text'
                       AND typeof(subject) = 'text'
                       AND typeof(source) = 'text'
                       AND typeof(created_at) = 'text'
                       AND typeof(path) = 'text'
                       AND typeof(active) = 'integer'
                       AND active IN (0, 1)
                       AND typeof(summary) IN ('null', 'text')
                       AND typeof(record_json) = 'text'
                 THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) <= ?3
                       AND typeof(kind) = 'text' AND length(CAST(kind AS BLOB)) <= ?3
                       AND typeof(subject) = 'text' AND length(CAST(subject AS BLOB)) <= ?3
                       AND typeof(source) = 'text' AND length(CAST(source AS BLOB)) <= ?3
                       AND typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) <= ?3
                       AND typeof(path) = 'text' AND length(CAST(path AS BLOB)) <= ?3
                       AND (typeof(summary) = 'null'
                         OR (typeof(summary) = 'text' AND length(CAST(summary AS BLOB)) <= ?3))
                       AND typeof(record_json) = 'text' AND length(CAST(record_json AS BLOB)) <= ?3
                 THEN 0 ELSE 1 END AS oversized,
            CASE WHEN typeof(record_json) = 'text'
                 THEN length(CAST(record_json AS BLOB)) ELSE 0 END AS record_json_bytes,
            (CASE WHEN typeof(id) = 'text' THEN length(CAST(id AS BLOB)) ELSE 0 END
              + CASE WHEN typeof(kind) = 'text' THEN length(CAST(kind AS BLOB)) ELSE 0 END
              + CASE WHEN typeof(subject) = 'text' THEN length(CAST(subject AS BLOB)) ELSE 0 END
              + CASE WHEN typeof(source) = 'text' THEN length(CAST(source AS BLOB)) ELSE 0 END
              + CASE WHEN typeof(created_at) = 'text' THEN length(CAST(created_at AS BLOB)) ELSE 0 END
              + CASE WHEN typeof(path) = 'text' THEN length(CAST(path AS BLOB)) ELSE 0 END
              + CASE WHEN typeof(summary) = 'text' THEN length(CAST(summary AS BLOB)) ELSE 0 END
            ) AS record_text_bytes
          FROM records
          LIMIT ?4
        )`,
      )
      .get(MAX_CACHE_RECORD_JSON_BYTES, MAX_CACHE_RECORD_TEXT_BYTES, MAX_CACHE_RECORD_BYTES, maximumRows) as
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
  cacheReadTestHooks.beforeIntegrityTextRead?.('records')
  const recordRows = database
    .prepare('SELECT id, active FROM records ORDER BY id COLLATE BINARY LIMIT ?')
    .iterate(maximumRows) as Iterable<{
    active?: unknown
    id?: unknown
  }>
  // One bounded identity/active-bit map also tracks unmatched FTS rows; it never retains documents.
  const members = new Map<string, 0 | 1>()
  const subsetSuperseded = recordsProbe.rows === snapshot.records.length ? undefined : new Set<string>()
  const representation = database.prepare(`SELECT
    CASE WHEN CAST(record_json AS BLOB) = CAST(?1 AS BLOB) THEN NULL
      ELSE CAST(record_json AS BLOB) END AS mismatch_bytes,
    CAST(id AS BLOB) = CAST(?2 AS BLOB) AND CAST(kind AS BLOB) = CAST(?3 AS BLOB)
      AND CAST(subject AS BLOB) = CAST(?4 AS BLOB) AND CAST(source AS BLOB) = CAST(?5 AS BLOB)
      AND CAST(created_at AS BLOB) = CAST(?6 AS BLOB) AND CAST(path AS BLOB) = CAST(?7 AS BLOB)
      AND (CAST(summary AS BLOB) IS CAST(?8 AS BLOB)) AS projection_matches
    FROM records WHERE id = ?2`)
  for (const row of recordRows) {
    const canonical = typeof row.id === 'string' ? snapshot.byId.get(row.id) : undefined
    if (canonical === undefined || members.has(canonical.id)) {
      throw new CacheSchemaMismatch('The cache record table does not match the canonical record corpus.')
    }
    // The writer's exact representation needs no transfer or parse. Preserve structural and
    // normalisation compatibility for other encodings with the existing bounded parser.
    const { summary } = snapshot.recordFacts(canonical).projection
    const encoded = representation.get(
      JSON.stringify(canonical),
      canonical.id,
      canonical.kind,
      canonical.subject,
      canonical.source,
      canonical.createdAt,
      canonical.path,
      summary,
    ) as { mismatch_bytes?: unknown; projection_matches?: unknown } | undefined
    if (
      encoded === undefined ||
      (encoded.mismatch_bytes !== null &&
        !(
          encoded.mismatch_bytes instanceof Uint8Array &&
          isUtf8(encoded.mismatch_bytes) &&
          isDeepStrictEqual(parseCachedRecord(Buffer.from(encoded.mismatch_bytes).toString('utf8')), canonical)
        ))
    ) {
      throw new CacheSchemaMismatch('The cache record table does not match the canonical record corpus.')
    }
    // SQL bindings replace lone surrogates; byte equality must not relax the old scalar string equality.
    if (
      encoded.projection_matches !== 1 ||
      !canonical.source.isWellFormed() ||
      !canonical.subject.isWellFormed() ||
      (summary !== null && !summary.isWellFormed()) ||
      (row.active !== 0 && row.active !== 1)
    ) {
      throw new CacheSchemaMismatch('The cache record table does not match its canonical JSON.')
    }
    members.set(canonical.id, row.active)
    if (subsetSuperseded !== undefined) {
      for (const id of canonical.supersedes ?? []) {
        subsetSuperseded.add(id)
      }
    }
  }
  if (members.size !== recordsProbe.rows) {
    throw new CacheSchemaMismatch('The cache record table does not match the canonical record corpus.')
  }
  const superseded = subsetSuperseded ?? snapshot.supersededIds
  for (const [id, active] of members) {
    if (active !== (superseded.has(id) ? 0 : 1)) {
      throw new CacheSchemaMismatch('The cache record table does not match its canonical JSON.')
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
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          CASE WHEN TOTAL(id_bytes) > ?1 OR TOTAL(text_bytes) > ?2 OR TOTAL(preview_bytes) > ?6
            THEN 1 ELSE 0 END AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(id) = 'text' AND typeof(text) = 'text' AND typeof(preview) = 'text'
                 THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) <= ?3
                       AND typeof(text) = 'text' AND length(CAST(text AS BLOB)) <= ?4
                       AND typeof(preview) = 'text' AND length(CAST(preview AS BLOB)) <= ?7
                 THEN 0 ELSE 1 END AS oversized,
            CASE WHEN typeof(id) = 'text' THEN length(CAST(id AS BLOB)) ELSE 0 END AS id_bytes,
            CASE WHEN typeof(text) = 'text' THEN length(CAST(text AS BLOB)) ELSE 0 END AS text_bytes,
            CASE WHEN typeof(preview) = 'text' THEN length(CAST(preview AS BLOB)) ELSE 0 END AS preview_bytes
          FROM record_search
          LIMIT ?5
        )`,
      )
      .get(
        MAX_CACHE_FTS_ID_BYTES,
        MAX_CACHE_SEARCH_DOCUMENT_AGGREGATE_BYTES,
        255,
        MAX_CACHE_SEARCH_DOCUMENT_BYTES,
        maximumRows,
        MAX_CACHE_SEARCH_PREVIEW_AGGREGATE_BYTES,
        MAX_CACHE_SEARCH_PREVIEW_BYTES,
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
  // Sort keys only: including full FTS documents here would retain them in SQLite's sorter.
  const searchKeys = database.prepare(`SELECT rowid AS search_rowid, CAST(id AS BLOB) AS id_bytes
    FROM record_search ORDER BY CAST(id AS BLOB), rowid LIMIT ?`)
  searchKeys.setReadBigInts(true)
  const searchRows = searchKeys.iterate(maximumRows) as Iterable<{
    id_bytes?: unknown
    search_rowid?: unknown
  }>
  const searchContent = database.prepare(`SELECT
      CAST(id AS BLOB) = CAST(? AS BLOB) AND CAST(text AS BLOB) = CAST(? AS BLOB)
        AND CAST(preview AS BLOB) = CAST(? AS BLOB) AS matches
    FROM record_search WHERE rowid = ?`)
  let searchRowsRead = 0
  for (const row of searchRows) {
    if (!(row.id_bytes instanceof Uint8Array) || typeof row.search_rowid !== 'bigint') {
      throw new CacheSchemaMismatch('The cache record and search tables are inconsistent.')
    }
    const id = Buffer.from(row.id_bytes).toString('utf8')
    const canonical = snapshot.byId.get(id)
    if (canonical === undefined || !members.has(id) || Buffer.compare(row.id_bytes, Buffer.from(id, 'utf8')) !== 0) {
      throw new CacheSchemaMismatch('The cache record and search tables are inconsistent.')
    }
    const { summary } = snapshot.recordFacts(canonical).projection
    const content = searchContent.get(
      id,
      searchDocumentForRecord(canonical, summary),
      searchPreviewForRecord(canonical, summary),
      row.search_rowid,
    ) as { matches?: unknown } | undefined
    if (content?.matches !== 1) {
      throw new CacheSchemaMismatch('The cache record and search tables are inconsistent.')
    }
    members.delete(id)
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

const assertMutationSnapshotCurrent = (
  root: string,
  location: CacheLocation,
  snapshot: ValidatedMutationCacheSnapshot,
) => {
  if (location.repository !== snapshot.repositoryRealpath) {
    return mutationSnapshotChanged()
  }
  try {
    snapshot.assertCurrent()
    const results = inspectArtifactFiles(
      resolve(root, 'encephalon'),
      snapshot.artifacts.map(artifact => artifact.path),
    )
    const current = results.flatMap(result => (result.kind === 'stable' ? [result.observation] : []))
    const sameArtifacts =
      current.length === snapshot.artifacts.length &&
      snapshot.artifacts.every(
        (artifact, index) =>
          artifact.path === current[index]?.path &&
          current[index] !== undefined &&
          sameStableEntryMetadata(artifact.metadata, current[index].metadata),
      )
    if (!sameArtifacts) {
      return mutationSnapshotChanged()
    }
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
      const insertRecord = database.prepare(`
        INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertSearch = database.prepare('INSERT INTO record_search(id, text, preview) VALUES (?, ?, ?)')
      for (const record of snapshot.records) {
        const projected = record
        const { projection } = snapshot.recordFacts(record)
        insertRecord.run(
          projected.id,
          projected.kind,
          projected.subject,
          projected.source,
          projected.createdAt,
          projected.path,
          snapshot.activeIds.has(projected.id) ? 1 : 0,
          projection.summary,
          JSON.stringify(record),
        )
        insertSearch.run(projected.id, projection.text, projection.preview)
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
      assertMutationSnapshotCurrent(root, location, snapshot)
      const manifest = boundedRepositoryManifestFromObservations(root, snapshot.artifacts)
      if (manifest.kind !== 'stable') {
        return mutationSnapshotChanged()
      }
      assertMutationSnapshotCurrent(root, location, snapshot)
      const assertCurrent = () => {
        try {
          assertMutationSnapshotCurrent(root, location, snapshot)
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
  | { kind: 'read'; read: (database: DatabaseSync) => Result; state: CacheReadRecoveryState }

type FreshCacheResult<Result> = { kind: 'fresh'; result: Result } | { kind: 'stale' }

const readFreshCacheResult = <Result>(
  root: string,
  location: CacheLocation,
  completion: CachePreparationCompletion<Result>,
  expectedRebuild?: CompletedCacheRebuild,
): FreshCacheResult<PrepareResult | Result> => {
  try {
    return readVerifiedCacheTransaction(
      location,
      database => {
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
              const read = completion.read(database)
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
    read: (database: DatabaseSync) => Result
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
    read: (database: DatabaseSync) => Result
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
  read: (database: DatabaseSync) => Result,
  state: CacheReadRecoveryState,
) => requireFreshCacheResult(root, location, { kind: 'read', read, state }, state.rebuild)

const withPreparedDatabase = <Result>(input: RootInput, read: (database: DatabaseSync) => Result) => {
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

const parseRecordRow = (row: RecordRow) => parseCachedRecord(row.record_json)

const recordRowBytes = (row: RecordRow) => {
  if (typeof row.record_bytes === 'number' && Number.isFinite(row.record_bytes) && row.record_bytes >= 0) {
    return row.record_bytes
  }
  if (typeof row.record_json === 'string') {
    return byteLength(row.record_json)
  }
  return 0
}

const parseRecordRowWithinBudget = (row: RecordRow, budget: ResponseByteBudget) => {
  budget.chargeBytes(recordRowBytes(row))
  return parseRecordRow(row)
}

const parseRecordRowsWithinBudget = (rows: Iterable<RecordRow>) => {
  const budget = createResponseByteBudget('fullResponseBytes')
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
    return row === undefined ? null : parseRecordRowWithinBudget(row, createResponseByteBudget('fullResponseBytes'))
  })
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

const createCompactSearchReader = (database: DatabaseSync, input: SearchStatementInput, budget: ResponseByteBudget) => {
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
      snippet(record_search, 2, '[', ']', '...', 16) AS snippet
    FROM record_search
    JOIN records ON records.id = record_search.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank ASC, records.created_at DESC, records.id DESC
    LIMIT ?
  `
  cacheReadTestHooks.onCompactSearchPrepare?.(source)
  const statement = database.prepare(source)
  return (query: string, match: string) => {
    if (match.length === 0) {
      return []
    }
    const records = Array.from(statement.iterate(match, ...kindParameters, limit) as Iterable<CompactRow>, row =>
      budget.charge(compactRecordFromRow(row)),
    )
    cacheReadTestHooks.afterCompactSearchRead?.(query)
    return records
  }
}

export const searchRecords = (input: SearchRecordsInput): BrainRecord[] => {
  const parsed = parseFullSearchRecordsInput(input)
  const match = literalMatchQuery(parsed.query)
  const limit = fullResultLimit(parsed.limit)
  if (match.length > 0) {
    return withPreparedDatabase(parsed, database =>
      parseRecordRowsWithinBudget(searchRows(database, parsed, match, limit)),
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
    return withPreparedDatabase(parsed, database => {
      const budget = createResponseByteBudget('compactResponseBytes')
      budget.charge([])
      return createCompactSearchReader(database, parsed, budget)(parsed.query, match)
    })
  }
  resolveRepository(parsed)
  return []
}

const createShowReader = (database: DatabaseSync, includeSuperseded: boolean | undefined) => {
  const activeClause = includeSuperseded === true ? '' : ' AND active = 1'
  const source = `SELECT record_json FROM records WHERE id = ?${activeClause}`
  cacheReadTestHooks.onShowPrepare?.(source)
  const statement = database.prepare(source)
  return (id: string) => {
    const row = statement.get(id) as RecordRow | undefined
    cacheReadTestHooks.afterShowRead?.(id)
    return row === undefined ? null : parseRecordRow(row)
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
  input: GatherInput,
  hydrated: HydrateResult | null,
  searches: readonly LiteralSearch[],
): GatherResult => {
  const shows = input.shows ?? []
  const budget = createResponseByteBudget('gatherResponseBytes')
  budget.charge({ hydrated, records: [], searches: [] })
  const showRecordForId = shows.length === 0 ? () => null : createShowReader(database, input.includeSuperseded)
  const searchCompactRecordsForQuery =
    searches.length === 0 ? () => [] : createCompactSearchReader(database, input, budget)
  const shownRecords = new Map<string, BrainRecord | null>()
  const searchResults = new Map<string, readonly CompactBrainRecord[]>()
  const memoizedShowRecordForId = (id: string) => {
    if (shownRecords.has(id)) {
      const record = shownRecords.get(id) ?? null
      return record === null ? null : structuredClone(record)
    }
    const record = showRecordForId(id)
    shownRecords.set(id, record)
    return record
  }
  const memoizedCompactRecordsForQuery = (search: LiteralSearch) => {
    if (searchResults.has(search.query)) {
      return (searchResults.get(search.query) ?? []).map(record => budget.charge({ ...record }))
    }
    const records = searchCompactRecordsForQuery(search.query, search.match)
    cacheReadTestHooks.afterGatherSearchEvaluation?.(search.query)
    searchResults.set(search.query, records)
    return records
  }
  return {
    hydrated,
    records: shows.map(id => budget.charge({ id, record: memoizedShowRecordForId(id) })),
    searches: searches.map(search => {
      const envelope = budget.charge({
        kind: input.kind ?? null,
        query: search.query,
        results: [],
      })
      return { ...envelope, results: memoizedCompactRecordsForQuery(search) }
    }),
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
          database =>
            readGatherFromDatabase(database, input, { recordsIndexed: rebuild.result.recordsIndexed }, searches),
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
          read: database => readGatherFromDatabase(database, input, null, searches),
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
