import { createHash } from 'node:crypto'
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
import { PACKAGE_VERSION } from './generated/version.ts'
import { withOperationLock } from './lock.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import { ordinalStringCompare } from './order.ts'
import { canonicalRecordPath, readRecords, readValidatedRecordSnapshotResolved } from './records.ts'
import { resolveRepository } from './repository.ts'
import { parseRecordFile, validateArtifactPath } from './schema.ts'
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

const SCHEMA_VERSION = '1'
const MAX_REPOSITORY_CHANGE_RETRIES = 3
const MAX_QUERY_BYTES = OPERATION_BUDGETS.queryBytes.maximum
const MAX_QUERY_TERMS = OPERATION_BUDGETS.queryTerms.maximum
const MAX_GATHER_SEARCHES = OPERATION_BUDGETS.gatherSearches.maximum
const MAX_GATHER_SHOWS = OPERATION_BUDGETS.gatherShows.maximum
const MAX_FULL_RESPONSE_BYTES = OPERATION_BUDGETS.fullResponseBytes.maximum
const SQLITE_BUSY_TIMEOUT_MILLISECONDS = 1000
const MAX_CACHE_METADATA_BYTES = 1024 * 1024
const MAX_CACHE_METADATA_AGGREGATE_BYTES = 6 * MAX_CACHE_METADATA_BYTES
const MAX_CACHE_SCHEMA_BYTES = 4 * 1024
const MAX_CACHE_RECORD_OVERHEAD_BYTES = 4096
const MAX_CACHE_RECORD_BYTES = CANONICAL_BUDGETS.recordBytes + MAX_CACHE_RECORD_OVERHEAD_BYTES
const MAX_CACHE_RECORD_JSON_BYTES =
  CANONICAL_BUDGETS.recordJsonBytes + CANONICAL_BUDGETS.records * MAX_CACHE_RECORD_OVERHEAD_BYTES
const MAX_CACHE_RECORD_TEXT_BYTES = MAX_CACHE_RECORD_JSON_BYTES * 2
const MAX_CACHE_SEARCH_DOCUMENT_BYTES = MAX_CACHE_RECORD_BYTES * 2
const MAX_CACHE_SEARCH_DOCUMENT_AGGREGATE_BYTES = MAX_CACHE_RECORD_JSON_BYTES * 2
const MAX_CACHE_FTS_ID_BYTES = CANONICAL_BUDGETS.records * 255
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

const RECORD_SEARCH_DEFINITION = 'fts5(id UNINDEXED, text)'

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
  afterCanonicalValidation?: (() => void) | undefined
  afterDisposableCacheRecoveryRebuild?: ((result: PrepareResult) => void) | undefined
  afterIntegrityProbe?: ((observation: CacheIntegrityObservation) => void) | undefined
  afterManifestEntryLstat?: ((path: string) => void) | undefined
  afterManifestKindEnumeration?: ((path: string) => void) | undefined
  afterManifestRootEnumeration?: ((path: string) => void) | undefined
  afterMissingPrimaryRecoveryObservation?: (() => void) | undefined
  afterPrimaryDatabaseObservation?: ((phase: 'prepare-fast-path' | 'reader-missing') => void) | undefined
  afterCompactSearchRead?: ((query: string) => void) | undefined
  afterShowRead?: ((id: string) => void) | undefined
  beforeManifestEntryLstat?: ((path: string) => void) | undefined
  beforeIntegrityTextRead?: ((name: CacheIntegrityProbeName) => void) | undefined
  duringDatabaseInitialisation?: ((mode: 'reader' | 'writer') => void) | undefined
  onCompactSearchPrepare?: ((source: string) => void) | undefined
  onShowPrepare?: ((source: string) => void) | undefined
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
  assertTableColumns(database, 'record_search', ['id', 'text'])
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

const assertCacheSchemaTransaction = (database: DatabaseSync) => {
  database.exec('BEGIN')
  try {
    assertCacheSchema(database)
    database.exec('ROLLBACK')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original schema validation failure.
    }
    throw error
  }
}

type CacheWriterPrimary =
  | { kind: 'create-exclusive' }
  | { kind: 'create-if-missing' }
  | { database: CacheDatabase; kind: 'expected-owned' }

const openWriterDatabase = (location: CacheLocation, primary: CacheWriterPrimary = { kind: 'create-if-missing' }) => {
  const { DatabaseSync: DatabaseConstructor } = loadSQLite()
  verifySQLiteFeatures(DatabaseConstructor)
  return openVerifiedCacheDatabase({
    afterVerifiedOpen: (database, { primaryCreated }) => {
      if (primaryCreated) {
        database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
        createCacheSchema(database)
      } else {
        assertCacheSchemaTransaction(database)
        database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
      }
      assertCacheSchemaTransaction(database)
      cacheReadTestHooks.duringDatabaseInitialisation?.('writer')
    },
    DatabaseConstructor,
    location,
    name: 'brain.sqlite',
    openOptions: { timeout: SQLITE_BUSY_TIMEOUT_MILLISECONDS },
    primary,
  })
}

const NO_VERIFIED_CACHE_RESULT = Symbol('no-verified-cache-result')

const readVerifiedCacheTransaction = <Result>(
  location: CacheLocation,
  read: (database: DatabaseSync) => Result,
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
    primary: { kind: 'existing' },
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
  let type: ManifestEntry['type']
  if (metadata.isSymbolicLink()) {
    type = 'symlink'
  } else if (metadata.isDirectory()) {
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

const artifactManifestEntry = (observation: ArtifactObservation): ManifestEntry => ({
  ctimeNanoseconds: observation.metadata.ctimeNs.toString(),
  mtimeNanoseconds: observation.metadata.mtimeNs.toString(),
  path: `encephalon/${observation.path}`,
  size: observation.metadata.size.toString(),
  type: 'file',
})

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

const repositoryManifest = (records: readonly ManifestEntry[], artifacts: readonly ArtifactObservation[]) => {
  const entries = [
    ...records,
    ...[...artifacts].sort((first, second) => ordinalStringCompare(first.path, second.path)).map(artifactManifestEntry),
  ]
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

type RepositoryManifestResult =
  | { kind: 'changed' | 'overflow' }
  | {
      kind: 'stable'
      value: string
    }

const boundedRepositoryManifest = (root: string, artifactPaths: string[]): RepositoryManifestResult => {
  try {
    const records = recordManifestEntries(root)
    const results = artifactPaths.length === 0 ? [] : inspectArtifactFiles(resolve(root, 'encephalon'), artifactPaths)
    if (results.some(result => result.kind === 'invalid')) {
      return { kind: 'changed' }
    }
    const artifacts = results.flatMap(result => (result.kind === 'stable' ? [result.observation] : []))
    return { kind: 'stable', value: repositoryManifest(records, artifacts) }
  } catch (error) {
    if (error instanceof ArtifactChangedError || error instanceof CanonicalDirectoryChangedError) {
      return { kind: 'changed' }
    }
    if (error instanceof CanonicalDirectoryEntryLimitError) {
      return { kind: 'overflow' }
    }
    throw error
  }
}

const boundedRepositoryManifestFromObservations = (
  root: string,
  artifacts: readonly ArtifactObservation[],
): RepositoryManifestResult => {
  try {
    return { kind: 'stable', value: repositoryManifest(recordManifestEntries(root), artifacts) }
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
  if (values.size !== METADATA_KEYS.length || METADATA_KEYS.some(key => values.get(key) === undefined)) {
    throw new CacheSchemaMismatch('The cache metadata key set is incomplete.')
  }
  const artifactPathsValue = values.get('artifactPaths')
  const recordsIndexedValue = values.get('recordsIndexed')
  if (artifactPathsValue === undefined || recordsIndexedValue === undefined) {
    throw new CacheSchemaMismatch('The cache metadata key set is incomplete.')
  }
  const artifactPaths = parseCacheJson(artifactPathsValue, MAX_CACHE_METADATA_BYTES)
  const recordsIndexed = /^(?:0|[1-9]\d*)$/.test(recordsIndexedValue) ? Number(recordsIndexedValue) : Number.NaN
  if (
    !Array.isArray(artifactPaths) ||
    artifactPaths.length > CANONICAL_BUDGETS.records ||
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
    .prepare('SELECT id, kind, subject, source, created_at, path, active, summary, record_json FROM records LIMIT ?')
    .iterate(maximumRows) as Iterable<
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
  const records = Array.from(recordRows, row => ({ record: parseCachedRecord(row.record_json), row }))
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
  const searchProbe = readIntegrityProbe(
    'record-search',
    database
      .prepare(
        `SELECT
          COUNT(*) AS row_count,
          CASE WHEN TOTAL(id_bytes) > ?1 OR TOTAL(text_bytes) > ?2
            THEN 1 ELSE 0 END AS exceeds_aggregate_bytes,
          CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
          CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value
        FROM (
          SELECT
            CASE WHEN typeof(id) = 'text' AND typeof(text) = 'text'
                 THEN 0 ELSE 1 END AS invalid_type,
            CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) <= ?3
                       AND typeof(text) = 'text' AND length(CAST(text AS BLOB)) <= ?4
                 THEN 0 ELSE 1 END AS oversized,
            CASE WHEN typeof(id) = 'text' THEN length(CAST(id AS BLOB)) ELSE 0 END AS id_bytes,
            CASE WHEN typeof(text) = 'text' THEN length(CAST(text AS BLOB)) ELSE 0 END AS text_bytes
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
  cacheReadTestHooks.beforeIntegrityTextRead?.('record-search')
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
    (() => {
      const manifest = boundedRepositoryManifest(root, metadata.artifactPaths)
      return manifest.kind === 'stable' && metadata.manifest === manifest.value
    })()
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

const readFreshMetadata = (root: string, location: CacheLocation): Metadata | undefined =>
  readVerifiedCacheTransaction(location, database => {
    const metadata = readMetadata(database)
    return metadataIsFresh(root, database, metadata) ? metadata : undefined
  })

const rebuildCache = (
  root: string,
  location: CacheLocation = inspectCacheLocation(root),
  primary: CacheWriterPrimary = { kind: 'create-if-missing' },
): PrepareResult => {
  const attempts = Array.from({ length: MAX_REPOSITORY_CHANGE_RETRIES }, (_, index) => index)
  let repositoryChangeObserved = false
  let nextWriterPrimary = primary
  for (const attempt of attempts) {
    const recordManifestBefore = boundedRepositoryManifest(root, [])
    if (recordManifestBefore.kind !== 'stable') {
      if (recordManifestBefore.kind === 'overflow' && !repositoryChangeObserved) {
        readRecords({ root })
      }
      repositoryChangeObserved = true
      if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
        return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
      }
      continue
    }
    let records: BrainRecord[]
    let artifacts: readonly ArtifactObservation[]
    try {
      const validated = readValidatedRecordSnapshotResolved(root)
      ;({ artifacts, records } = validated)
    } catch (error) {
      if (
        error instanceof ArtifactChangedError ||
        (error instanceof EncephalonError && error.code === 'REPOSITORY_CHANGED')
      ) {
        repositoryChangeObserved = true
        if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
          return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
        }
        continue
      }
      const recordManifestAfter = boundedRepositoryManifest(root, [])
      if (recordManifestAfter.kind !== 'stable' || recordManifestAfter.value !== recordManifestBefore.value) {
        repositoryChangeObserved = true
        if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
          return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
        }
        continue
      }
      throw error
    }
    cacheReadTestHooks.afterCanonicalValidation?.()
    const artifactPaths = artifacts.map(artifact => artifact.path)
    const manifestBefore = boundedRepositoryManifestFromObservations(root, artifacts)
    const recordsAfterValidation = boundedRepositoryManifest(root, [])
    if (
      manifestBefore.kind !== 'stable' ||
      recordsAfterValidation.kind !== 'stable' ||
      recordsAfterValidation.value !== recordManifestBefore.value
    ) {
      repositoryChangeObserved = true
      if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
        return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
      }
      continue
    }
    const superseded = new Set(records.flatMap(record => record.supersedes ?? []))
    const opened = openWriterDatabase(location, nextWriterPrimary)
    const { database, identity } = opened
    nextWriterPrimary =
      nextWriterPrimary.kind === 'create-if-missing'
        ? { kind: 'create-if-missing' }
        : { database: identity, kind: 'expected-owned' }
    let rebuildResult: PrepareResult | undefined
    let writerFailure: unknown
    let writerFailed = false
    try {
      database.exec('BEGIN IMMEDIATE')
      try {
        assertCacheSchema(database)
        const existingMetadata = readMetadata(database)
        assertCacheScope(root, existingMetadata)
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
          manifest: manifestBefore.value,
          packageVersion: PACKAGE_VERSION,
          recordsIndexed: records.length,
          repositoryRealpath: realpathSync.native(root),
          schemaVersion: SCHEMA_VERSION,
        })
        const manifestAfter = boundedRepositoryManifest(root, artifactPaths)
        if (manifestAfter.kind === 'stable' && manifestAfter.value === manifestBefore.value) {
          database.exec('COMMIT')
          rebuildResult = { hydrated: true, recordsIndexed: records.length }
        } else {
          repositoryChangeObserved = true
          database.exec('ROLLBACK')
        }
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
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
      if (!writerFailed) {
        writerFailure = error
        writerFailed = true
      }
    }
    if (writerFailed) {
      if (writerFailure instanceof EncephalonError || writerFailure instanceof CacheDatabaseFailure) {
        throw writerFailure
      }
      if (isRecoverableCacheFailure(writerFailure)) {
        return failCacheDatabase(writerFailure, identity)
      }
      throw writerFailure
    }
    if (rebuildResult !== undefined) {
      return rebuildResult
    }
    if (attempt === MAX_REPOSITORY_CHANGE_RETRIES - 1) {
      return fail('REPOSITORY_CHANGED', 'The repository changed repeatedly while rebuilding the Encephalon cache.')
    }
  }
  return fail('INTERNAL_ERROR', 'The Encephalon cache rebuild ended unexpectedly.')
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

type DisposableCacheRecovery = { kind: 'rebuilt'; result: PrepareResult } | { kind: 'retry' }
type CacheRecoveryLockMode = 'acquire' | 'held'
type DisposableCacheRecoveryCompletion<Result> =
  | { kind: 'complete-from-rebuild'; complete: (result: PrepareResult) => Result }
  | { kind: 'retry-operation' }

type DisposableCacheRecoveryOptions<Result> = {
  completion: DisposableCacheRecoveryCompletion<Result>
  lockMode: CacheRecoveryLockMode
}

const completedRecoveryRebuild = (result: PrepareResult): DisposableCacheRecovery => {
  cacheReadTestHooks.afterDisposableCacheRecoveryRebuild?.(result)
  return { kind: 'rebuilt', result }
}

const recoverDisposableCacheUnderLock = (
  root: string,
  location: CacheLocation,
  failure: unknown,
): DisposableCacheRecovery => {
  if (failure instanceof CacheDatabaseFailure) {
    quarantineCacheDatabase(location, failure.database)
    return completedRecoveryRebuild(rebuildCache(root, location))
  }
  if (failure instanceof CacheDatabaseObservedMissing) {
    if (inspectCacheDatabase(location, 'brain.sqlite') === undefined) {
      cacheReadTestHooks.afterMissingPrimaryRecoveryObservation?.()
      try {
        return completedRecoveryRebuild(rebuildCache(root, location, { kind: 'create-exclusive' }))
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
): DisposableCacheRecovery => {
  if (isRecoverableCacheFailure(failure)) {
    return lockMode === 'acquire'
      ? withCacheOperationLock(root, location, captured => recoverDisposableCacheUnderLock(root, captured, failure))
      : recoverDisposableCacheUnderLock(root, location, failure)
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
      const recovery = recoverDisposableCacheOnce(root, location, failure, options.lockMode)
      if (recovery.kind === 'rebuilt' && options.completion.kind === 'complete-from-rebuild') {
        return options.completion.complete(recovery.result)
      }
      return operation()
    }
    throw failure
  }
}

const prepareResolvedWithoutCorruptionRecovery = (
  root: string,
  location: CacheLocation,
  lockMode: CacheRecoveryLockMode = 'acquire',
): PrepareResult => {
  const serialize = <Result>(operation: (captured: CacheLocation) => Result) => {
    if (lockMode === 'acquire') {
      return withCacheOperationLock(root, location, operation)
    }
    return operation(location)
  }
  const existingDatabase = inspectCacheDatabase(location, 'brain.sqlite')
  if (existingDatabase === undefined) {
    return serialize(captured => {
      if (inspectCacheDatabase(captured, 'brain.sqlite') !== undefined) {
        const metadata = readFreshMetadata(root, captured)
        if (metadata !== undefined) {
          return { hydrated: false, recordsIndexed: metadata.recordsIndexed }
        }
      }
      return rebuildCache(root, captured)
    })
  }
  cacheReadTestHooks.afterPrimaryDatabaseObservation?.('prepare-fast-path')
  const cachedMetadata = readFreshMetadata(root, location)
  if (cachedMetadata !== undefined) {
    return { hydrated: false, recordsIndexed: cachedMetadata.recordsIndexed }
  }
  return serialize(captured => {
    const metadata = readFreshMetadata(root, captured)
    if (metadata !== undefined) {
      return { hydrated: false, recordsIndexed: metadata.recordsIndexed }
    }
    return rebuildCache(root, captured)
  })
}

const prepareResolved = (
  root: string,
  lockMode: CacheRecoveryLockMode = 'acquire',
  capturedLocation: CacheLocation = inspectCacheLocation(root),
): PrepareResult => {
  const operation = () => prepareResolvedWithoutCorruptionRecovery(root, capturedLocation, lockMode)
  return runWithDisposableCacheRecovery(root, capturedLocation, operation, {
    completion: { complete: result => result, kind: 'complete-from-rebuild' },
    lockMode,
  })
}

export const prepareResolvedRepository = (
  root: string,
  lockMode: CacheRecoveryLockMode = 'acquire',
  location?: CacheLocation,
): PrepareResult => prepareResolved(root, lockMode, location)

export const hydrateResolvedRepository = (
  root: string,
  lockMode: CacheRecoveryLockMode = 'acquire',
  location?: CacheLocation,
): PrepareResult => {
  const captured = location ?? inspectCacheLocation(root)
  const hydrateUnderLock = (heldLocation: CacheLocation) =>
    runWithDisposableCacheRecovery(root, heldLocation, () => rebuildCache(root, heldLocation), {
      completion: { complete: result => result, kind: 'complete-from-rebuild' },
      lockMode: 'held',
    })
  return lockMode === 'acquire' ? withCacheOperationLock(root, captured, hydrateUnderLock) : hydrateUnderLock(captured)
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

const readFreshCache = <Result>(root: string, location: CacheLocation, read: (database: DatabaseSync) => Result) =>
  readVerifiedCacheTransaction(location, database => {
    const metadata = readMetadata(database)
    if (!metadataIsFresh(root, database, metadata)) {
      throw new CacheSchemaMismatch('The cache is stale before read.')
    }
    return read(database)
  })

const withPreparedDatabase = <Result>(input: RootInput, read: (database: DatabaseSync) => Result) => {
  const root = resolveRepository(input)
  try {
    const location = inspectCacheLocation(root)
    return runWithDisposableCacheRecovery(
      root,
      location,
      () => {
        prepareResolvedWithoutCorruptionRecovery(root, location)
        return readFreshCache(root, location, read)
      },
      { completion: { kind: 'retry-operation' }, lockMode: 'acquire' },
    )
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
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
    return failBudget(
      'fullResponseBytes',
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
    return failBudget('queryBytes', `query must contain at most ${MAX_QUERY_BYTES} UTF-8 bytes.`)
  }
  const terms = query.split(/[^A-Za-z0-9_]+/u).filter(term => term.length > 0)
  if (terms.length > MAX_QUERY_TERMS) {
    return failBudget('queryTerms', `query may contain at most ${MAX_QUERY_TERMS} literal terms.`)
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
  const parsed = parseFullSearchRecordsInput(input)
  const match = literalMatchQuery(parsed.query)
  const limit = fullResultLimit(parsed.limit)
  return withPreparedDatabase(parsed, database =>
    parseRecordRowsWithinBudget(searchRows(database, parsed, match, limit)),
  )
}

export const searchCompactRecords = (input: SearchRecordsInput): CompactBrainRecord[] => {
  const parsed = parseCompactSearchRecordsInput(input)
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
    return failBudget('gatherSearches', `gather may contain at most ${MAX_GATHER_SEARCHES} searches.`)
  }
  if (shows.length > MAX_GATHER_SHOWS) {
    return failBudget('gatherShows', `gather may contain at most ${MAX_GATHER_SHOWS} shows.`)
  }
  searches.forEach(literalMatchQuery)
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
  try {
    const location = inspectCacheLocation(root)
    if (parsed.hydrate === true) {
      const readAfterHydration = (heldLocation: CacheLocation, hydration: PrepareResult) =>
        readFreshCache(root, heldLocation, database =>
          readGatherFromDatabase(database, parsed, { recordsIndexed: hydration.recordsIndexed }),
        )
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
          },
        ),
      )
    }
    return runWithDisposableCacheRecovery(
      root,
      location,
      () => {
        prepareResolvedWithoutCorruptionRecovery(root, location)
        return readFreshCache(root, location, database => readGatherFromDatabase(database, parsed, null))
      },
      { completion: { kind: 'retry-operation' }, lockMode: 'acquire' },
    )
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to gather Encephalon records.', error)
  }
}
