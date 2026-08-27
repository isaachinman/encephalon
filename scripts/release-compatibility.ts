import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { spawnNpmCommand } from './npm-command.ts'
import { type PackageTarballDigests, packageTarballDigests, snapshotPackageTarball } from './package-tarball.ts'

export const ORACLE = Object.freeze({
  integrity: 'sha512-dgGi7fL43v9KQJ7Rb42fRAT+Z+h6WIOKhbPz9JzNBtnpqSyf4HyN6zBmIy6ftkTazZO6SyGU4MUi1FTVJyBvEw==',
  shasum: '1db80715ac2028cb8f12ae029577aed3428d52ef',
  specifier: 'encephalon@0.2.0',
})

export const MAX_COMPATIBILITY_DIAGNOSTIC_BYTES = 8192
const MAX_COMPATIBILITY_SUBPROCESS_OUTPUT_BYTES = 16 * 1024 * 1024

export const sanitizedCompatibilityEnvironment = (environment: NodeJS.ProcessEnv = process.env) =>
  Object.fromEntries(
    Object.entries(environment).filter(([key]) => {
      const normalized = key.toLowerCase()
      return normalized !== 'node_options' && normalized !== 'node_path'
    }),
  )

export type OracleIdentity = Readonly<{
  integrity: string
  shasum: string
  specifier: string
}>

export type DurableSnapshotEntry = Readonly<{
  bytes?: Buffer
  mode: number
  path: string
  type: 'directory' | 'file'
}>

export type DurableSnapshot = readonly DurableSnapshotEntry[]

export type DurableSnapshotChange = Readonly<{
  kind: 'added' | 'bytes' | 'mode' | 'removed' | 'type'
  path: string
}>

export class DurableSnapshotMismatch extends Error {
  readonly changes: readonly DurableSnapshotChange[]

  constructor(changes: readonly DurableSnapshotChange[]) {
    super(`Durable compatibility state changed (${changes.map(change => `${change.kind}:${change.path}`).join(', ')}).`)
    this.name = 'DurableSnapshotMismatch'
    this.changes = Object.freeze([...changes])
  }
}

type CompatibilityCommandOptions = Readonly<{
  cwd: string
  environment?: NodeJS.ProcessEnv
  label: string
  redactions?: readonly Buffer[]
}>

export type CompatibilityCommandResult = Readonly<{
  stderr: string
  stdout: string
}>

export class CompatibilityCommandError extends Error {
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly stdout: string

  constructor(
    label: string,
    result: { exitCode: number; signal: NodeJS.Signals | null; stderr: string; stdout: string },
    options?: ErrorOptions,
  ) {
    super(
      `${label} failed with exit code ${result.exitCode}${result.signal === null ? '' : ` and signal ${result.signal}`}.`,
      options,
    )
    this.name = 'CompatibilityCommandError'
    this.exitCode = result.exitCode
    this.signal = result.signal
    this.stderr = result.stderr
    this.stdout = result.stdout
  }
}

const publicSurfaceDifferencePaths = (expected: unknown, actual: unknown, path = '$'): string[] => {
  if (isDeepStrictEqual(expected, actual)) {
    return []
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length)
    return Array.from({ length }, (_, index) => index).flatMap(index =>
      publicSurfaceDifferencePaths(expected[index], actual[index], `${path}[${index}]`),
    )
  }
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(ordinalCompare)
    return keys.flatMap(key =>
      publicSurfaceDifferencePaths(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        `${path}.${key}`,
      ),
    )
  }
  return [path]
}

export const assertStablePublicSurface = (expected: unknown, actual: unknown, label: string) => {
  if (!isDeepStrictEqual(expected, actual)) {
    const differences = publicSurfaceDifferencePaths(expected, actual).slice(0, 32)
    throw new Error(
      `${label} does not exactly preserve the published public surface. Differences: ${differences.join(', ')}.`,
    )
  }
}

export const expectedCandidateCliHelp = (oracleHelp: string) =>
  oracleHelp
    .replace(/^(.*\[--artifact <path> \.\.\.\])$/mu, '$1\n      Accepts at most 1,000 supersession targets.')
    .replace(/^ {2}search \[--compact\] (.+)$/mu, '  search $1\n  search --compact $1')
    .replace(/^( {9}.*\[--limit <1\.\.1000>\])$/mu, '$1\n         Accepts at most 16 searches and 64 shows.')

const publicSurfaceWithHelp = (value: unknown, label: string) => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const { help, ...surface } = value as Record<string, unknown>
    if (typeof help === 'string') {
      return { help, surface }
    }
  }
  throw new Error(`${label} did not capture one CLI help surface.`)
}

const assertCandidateCliSurface = (oracle: unknown, candidate: unknown) => {
  const expected = publicSurfaceWithHelp(oracle, 'The published oracle')
  const actual = publicSurfaceWithHelp(candidate, 'The candidate')
  assertStablePublicSurface(expected.surface, actual.surface, 'The candidate CLI')
  if (actual.help !== expectedCandidateCliHelp(expected.help)) {
    throw new Error('The candidate CLI does not exactly preserve the published public surface. Differences: $.help.')
  }
}

const ordinalCompare = (left: string, right: string) => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

const durableEntry = (path: string, relativePath: string): DurableSnapshotEntry => {
  const metadata = lstatSync(path)
  const mode = metadata.mode & 0o7777
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    return Object.freeze({ mode, path: relativePath, type: 'directory' })
  }
  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    return Object.freeze({ bytes: readFileSync(path), mode, path: relativePath, type: 'file' })
  }
  throw new Error(`Durable compatibility entry is neither a regular file nor a directory: ${relativePath}`)
}

const captureDurableTree = (root: string, relativePath: string): DurableSnapshotEntry[] => {
  const path = resolve(root, relativePath)
  const entry = durableEntry(path, relativePath)
  if (entry.type === 'file') {
    return [entry]
  }
  const children = readdirSync(path, { withFileTypes: true })
    .map(child => child.name)
    .sort(ordinalCompare)
  return children.reduce<DurableSnapshotEntry[]>(
    (entries, child) => [...entries, ...captureDurableTree(root, `${relativePath}/${child}`)],
    [entry],
  )
}

export const captureDurableSnapshot = (root: string): DurableSnapshot => {
  const roots = ['AGENTS.md', 'CLAUDE.md', 'encephalon'].filter(
    relativePath => lstatSync(resolve(root, relativePath), { throwIfNoEntry: false }) !== undefined,
  )
  return Object.freeze(roots.flatMap(relativePath => captureDurableTree(root, relativePath)))
}

const snapshotEntryChanges = (
  expected: DurableSnapshotEntry,
  actual: DurableSnapshotEntry,
): DurableSnapshotChange[] => {
  const typeChanges: DurableSnapshotChange[] =
    expected.type === actual.type ? [] : [{ kind: 'type', path: expected.path }]
  const modeChanges: DurableSnapshotChange[] =
    expected.mode === actual.mode ? [] : [{ kind: 'mode', path: expected.path }]
  const byteChanges: DurableSnapshotChange[] =
    expected.type === 'file' &&
    actual.type === 'file' &&
    expected.bytes !== undefined &&
    actual.bytes !== undefined &&
    Buffer.compare(expected.bytes, actual.bytes) !== 0
      ? [{ kind: 'bytes', path: expected.path }]
      : []
  return [...typeChanges, ...modeChanges, ...byteChanges]
}

export const assertDurableSnapshotsEqual = (expected: DurableSnapshot, actual: DurableSnapshot) => {
  const expectedByPath = new Map(expected.map(entry => [entry.path, entry]))
  const actualByPath = new Map(actual.map(entry => [entry.path, entry]))
  const removed = expected
    .filter(entry => !actualByPath.has(entry.path))
    .map(entry => ({ kind: 'removed' as const, path: entry.path }))
  const added = actual
    .filter(entry => !expectedByPath.has(entry.path))
    .map(entry => ({ kind: 'added' as const, path: entry.path }))
  const changed = expected.flatMap(entry =>
    actual.filter(current => current.path === entry.path).flatMap(current => snapshotEntryChanges(entry, current)),
  )
  const changes = [...removed, ...added, ...changed].sort((left, right) =>
    ordinalCompare(`${left.path}:${left.kind}`, `${right.path}:${right.kind}`),
  )
  if (changes.length > 0) {
    throw new DurableSnapshotMismatch(changes)
  }
}

const redactDiagnostic = (value: string, redactions: readonly Buffer[]) =>
  redactions.reduce((diagnostic, bytes) => {
    const secret = bytes.toString('utf8')
    return secret.length === 0 ? diagnostic : diagnostic.replaceAll(secret, '[redacted]')
  }, value)

const boundDiagnostic = (value: string) => {
  const bytes = Buffer.from(value, 'utf8')
  return bytes.length <= MAX_COMPATIBILITY_DIAGNOSTIC_BYTES
    ? value
    : bytes.subarray(0, MAX_COMPATIBILITY_DIAGNOSTIC_BYTES).toString('utf8')
}

export const runCompatibilityCommand = (
  executable: string,
  arguments_: readonly string[],
  options: CompatibilityCommandOptions,
): CompatibilityCommandResult => {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.environment ?? sanitizedCompatibilityEnvironment(),
    maxBuffer: MAX_COMPATIBILITY_SUBPROCESS_OUTPUT_BYTES,
    shell: false,
  })
  if (result.error === undefined && result.status === 0) {
    return Object.freeze({ stderr: result.stderr ?? '', stdout: result.stdout ?? '' })
  }
  const redactions = options.redactions ?? []
  const stdout = boundDiagnostic(redactDiagnostic(result.stdout ?? '', redactions))
  const stderr = boundDiagnostic(redactDiagnostic(result.stderr ?? '', redactions))
  throw new CompatibilityCommandError(
    options.label,
    {
      exitCode: result.status ?? 1,
      signal: result.signal,
      stderr,
      stdout,
    },
    result.error === undefined ? undefined : { cause: result.error },
  )
}

export const verifyOracleTarball = (path: string, identity: OracleIdentity = ORACLE): PackageTarballDigests => {
  const digests = packageTarballDigests(path)
  if (digests.sha1 === identity.shasum && digests.integrity === identity.integrity) {
    return digests
  }
  throw new Error('The published compatibility oracle does not match its pinned SHA-1 and SHA-512 identities.')
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resultLimitCases = Object.freeze([50, 100, 101, 999, 1000, 1001] as const)
const resultLimitOperations = Object.freeze(['list', 'search', 'searchCompact', 'gather'] as const)
const candidateResultLimitMaximums = Object.freeze({ compact: 1000, full: 1000 })
const oracleResultLimitMaximums = Object.freeze({ compact: 100, full: 50 })

type SuppliedOracle = Readonly<{
  identity: OracleIdentity
  tarball: string
}>

export type ReleaseCompatibilityOptions = Readonly<{
  candidateTarball: string
  fixtureRoot?: string
  oracle?: SuppliedOracle
}>

type ResultLimitOutcome = Readonly<{
  accepted: readonly number[]
  rejected: readonly number[]
}>

type ResultLimitReport = Readonly<Record<(typeof resultLimitOperations)[number], ResultLimitOutcome>>

type ResultLimitMaximums = Readonly<{
  compact: number
  full: number
}>

type PhaseReport = Readonly<{
  durableState: 'identical'
  independentBudgets: IndependentBudgetReport
  publicSurface: Readonly<{
    apiSha256: string
    cliSha256: string
  }>
  resultLimits: Readonly<{
    api: ResultLimitReport
    cli: ResultLimitReport
  }>
  schemas: Readonly<{
    after: string
    before: string
  }>
}>

export type ReleaseCompatibilityReport = Readonly<{
  candidate: Readonly<{
    digests: PackageTarballDigests
    version: string
  }>
  downgrade: PhaseReport
  oracle: Readonly<{
    digests: PackageTarballDigests
    independentBudgets: IndependentBudgetReport
    publicSurface: Readonly<{
      apiSha256: string
      cliSha256: string
    }>
    resultLimits: Readonly<{
      api: ResultLimitReport
      cli: ResultLimitReport
    }>
    specifier: string
    version: string
  }>
  status: 'ok'
  upgrade: PhaseReport
}>

const publicSurfaceDigests = (api: unknown, cli: unknown) =>
  Object.freeze({
    apiSha256: createHash('sha256').update(JSON.stringify(api)).digest('hex'),
    cliSha256: createHash('sha256').update(JSON.stringify(cli)).digest('hex'),
  })

const API_PROBE_SOURCE = `
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [phase, root] = process.argv.slice(2)
const api = await import('encephalon')
const manifest = JSON.parse(readFileSync(resolve(root, 'node_modules', 'encephalon', 'package.json'), 'utf8'))
const fail = stage => { throw Object.assign(new Error(stage), { stage }) }
const assert = (condition, stage) => { if (!condition) fail(stage) }
const at = (stage, action) => {
  try {
    return action()
  } catch (error) {
    if (typeof error?.stage === 'string') {
      throw error
    }
    throw Object.assign(new Error(stage), { code: error?.code, stage })
  }
}
const cacheSchema = () => {
  const database = new DatabaseSync(resolve(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'), { readOnly: true })
  try {
    const row = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get()
    return row?.value
  } finally {
    database.close()
  }
}
const assertRecord = (record, id, stage) => assert(record?.id === id, stage)
const normalisePublicValue = (value, key) => {
  if (key === 'createdAt' && typeof value === 'string') return '<timestamp>'
  if (typeof value === 'string') return value.replaceAll(root, '<fixture-root>')
  if (Array.isArray(value)) return value.map(item => normalisePublicValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalisePublicValue(item, name)]))
  }
  return value
}
const errorShape = (error, stage) => {
  assert(error instanceof api.EncephalonError, stage + '-type')
  return normalisePublicValue({
    code: error.code,
    details: error.details,
    message: error.message,
    name: error.name,
    ownKeys: Reflect.ownKeys(error).filter(key => typeof key === 'string').sort(),
  })
}
const captureError = (action, stage) => {
  let failure
  try {
    action()
  } catch (error) {
    failure = error
  }
  assert(failure !== undefined, stage + '-missing')
  return errorShape(failure, stage)
}
const limits = [50, 100, 101, 999, 1000, 1001]
const operationNames = ['list', 'search', 'searchCompact', 'gather']
const operations = {
  gather: limit => api.gatherRecords({ includeSuperseded: true, limit, root, searches: ['compatibility-marker'] }),
  list: limit => api.listRecords({ includeSuperseded: true, limit, root }),
  search: limit => api.searchRecords({ includeSuperseded: true, limit, query: 'compatibility-marker', root }),
  searchCompact: limit => api.searchCompactRecords({ includeSuperseded: true, limit, query: 'compatibility-marker', root }),
}
const resultLimits = () => {
  const maximums = phase === 'upgrade'
    ? { gather: 1000, list: 1000, search: 1000, searchCompact: 1000 }
    : { gather: 100, list: 50, search: 50, searchCompact: 100 }
  return Object.fromEntries(operationNames.map(name => [name, limits.reduce((outcome, limit) => {
    const budget = name === 'list' || name === 'search' ? 'fullResultLimit' : 'compactResultLimit'
    if (limit <= maximums[name]) {
      at('api-limit-accepted-' + name + '-' + limit, () => operations[name](limit))
      return { ...outcome, accepted: [...outcome.accepted, limit] }
    }
    let failure
    try {
      operations[name](limit)
    } catch (error) {
      failure = error
    }
    assert(failure instanceof api.EncephalonError, 'api-limit-error-type-' + name + '-' + limit)
    assert(failure.code === 'INVALID_ARGUMENT', 'api-limit-error-code-' + name + '-' + limit)
    if (phase !== 'upgrade' && limit === 1001) {
      assert(failure.details?.field === 'limit', 'api-limit-parser-field-' + name + '-' + limit)
    } else {
      assert(failure.details?.budget === budget, 'api-limit-error-budget-' + name + '-' + limit)
      assert(failure.details?.field === 'limit', 'api-limit-error-field-' + name + '-' + limit)
      assert(failure.details?.maximum === maximums[name], 'api-limit-error-maximum-' + name + '-' + limit)
    }
    return { ...outcome, rejected: [...outcome.rejected, limit] }
  }, { accepted: [], rejected: [] })]))
}
const readCompatibilityState = () => {
  const validation = api.validateRecords({ root })
  assert(validation.valid === true, 'api-validate')
  const listed = api.listRecords({ includeSuperseded: true, limit: phase === 'upgrade' ? 1000 : 50, root })
  assert(listed.some(record => record.id === 'compatibility-base'), 'api-list-base')
  assertRecord(api.showRecord({ id: 'compatibility-base', root }), 'compatibility-base', 'api-show-base')
  assert(api.searchRecords({ includeSuperseded: true, query: 'compatibility-marker', root }).length > 0, 'api-search')
  assert(api.searchCompactRecords({ includeSuperseded: true, query: 'compatibility-marker', root }).length > 0, 'api-search-compact')
  const gathered = api.gatherRecords({ includeSuperseded: true, root, searches: ['compatibility-marker'], shows: ['compatibility-base'] })
  assert(gathered.records?.[0]?.record?.id === 'compatibility-base', 'api-gather-show')
  assert(gathered.searches?.[0]?.results?.length > 0, 'api-gather-search')
}
const publicSurface = () => {
  const initialised = at('surface-init', () => api.initEncephalon({ root }))
  const added = at('surface-add', () => api.addRecord({
    id: 'compatibility-api-surface-add',
    kind: 'decision',
    payload: { summary: 'Compatibility API surface add' },
    root,
    searchText: 'compatibility-marker api-surface-add',
    source: 'release-compatibility',
    subject: 'release.compatibility.api-surface-add',
  }))
  rmSync(resolve(root, added.path))
  const duplicate = captureError(() => api.addRecord({
    id: 'compatibility-base',
    kind: 'decision',
    payload: {},
    root,
    source: 'release-compatibility',
    subject: 'release.compatibility.base',
  }), 'surface-add-error')
  const prepared = at('surface-prepare', () => api.prepare({ root }))
  const hydrated = at('surface-hydrate', () => api.hydrate({ root }))
  return normalisePublicValue({
    add: added,
    addError: duplicate,
    gather: at('surface-gather', () => api.gatherRecords({
      includeSuperseded: true,
      root,
      searches: ['compatibility-marker'],
      shows: ['compatibility-base'],
    })),
    hydrate: hydrated,
    init: initialised,
    list: at('surface-list', () => api.listRecords({ includeSuperseded: true, kind: 'decision', root })),
    prepare: prepared,
    search: at('surface-search', () => api.searchRecords({
      includeSuperseded: true,
      query: 'compatibility-marker',
      root,
    })),
    searchCompact: at('surface-search-compact', () => api.searchCompactRecords({
      includeSuperseded: true,
      query: 'compatibility-marker',
      root,
    })),
    show: at('surface-show', () => api.showRecord({ id: 'compatibility-base', root })),
    validate: at('surface-validate', () => api.validateRecords({ root })),
  })
}
const initialise = () => {
  at('initialise-init', () => api.initEncephalon({ root }))
  const artifact = resolve(root, 'encephalon', '_artifacts', 'decision', 'compatibility-base', 'evidence.txt')
  mkdirSync(resolve(artifact, '..'), { recursive: true })
  writeFileSync(artifact, 'oracle artifact evidence\\n')
  at('initialise-add-base', () => api.addRecord({
    artifacts: ['_artifacts/decision/compatibility-base/evidence.txt'],
    id: 'compatibility-base',
    kind: 'decision',
    payload: { summary: 'Oracle compatibility base' },
    root,
    searchText: 'compatibility-marker oracle-base',
    source: 'release-compatibility',
    subject: 'release.compatibility.base',
  }))
  at('initialise-add-successor', () => api.addRecord({
    id: 'compatibility-successor',
    kind: 'decision',
    payload: { summary: 'Oracle compatibility successor' },
    root,
    searchText: 'compatibility-marker oracle-successor',
    source: 'release-compatibility',
    subject: 'release.compatibility.base',
    supersedes: ['compatibility-base'],
  }))
  at('initialise-prepare', () => api.prepare({ root }))
  return { limits: at('initialise-result-limits', resultLimits), schemaAfter: cacheSchema(), surface: publicSurface() }
}
const upgrade = () => {
  const schemaBefore = cacheSchema()
  api.initEncephalon({ root })
  readCompatibilityState()
  let duplicate
  try {
    api.addRecord({ id: 'compatibility-base', kind: 'decision', payload: {}, root, source: 'release-compatibility', subject: 'release.compatibility.base' })
  } catch (error) {
    duplicate = error
  }
  assert(duplicate instanceof api.EncephalonError && duplicate.code === 'RECORD_EXISTS', 'api-add-duplicate')
  const prepared = api.prepare({ root })
  assert(typeof prepared?.recordsIndexed === 'number', 'api-prepare')
  const schemaAfter = cacheSchema()
  const hydrated = api.hydrate({ root })
  assert(typeof hydrated?.recordsIndexed === 'number', 'api-hydrate')
  return { limits: resultLimits(), schemaAfter, schemaBefore, surface: publicSurface() }
}
const downgrade = () => {
  const schemaBefore = cacheSchema()
  readCompatibilityState()
  const prepared = api.prepare({ root })
  assert(typeof prepared?.recordsIndexed === 'number', 'api-downgrade-prepare')
  return { limits: resultLimits(), schemaAfter: cacheSchema(), schemaBefore, surface: publicSurface() }
}

try {
  const result = phase === 'initialise' ? initialise() : phase === 'upgrade' ? upgrade() : phase === 'downgrade' ? downgrade() : fail('unknown-phase')
  process.stdout.write(JSON.stringify({ ...result, version: manifest.version }) + '\\n')
} catch (error) {
  process.stderr.write(JSON.stringify({ code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR', stage: typeof error?.stage === 'string' ? error.stage : 'api-probe' }) + '\\n')
  process.exitCode = 1
}
`

const IMPORT_PROBE_SOURCE = `
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const [root] = process.argv.slice(2)
const selected = ['AGENTS.md', 'CLAUDE.md', 'encephalon', 'node_modules/.cache/encephalon']
const inspect = relativePath => {
  const path = resolve(root, relativePath)
  if (!existsSync(path)) return [{ path: relativePath, type: 'missing' }]
  const metadata = lstatSync(path)
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    return [{ mode: metadata.mode & 0o7777, path: relativePath, type: 'directory' }, ...readdirSync(path).sort().flatMap(name => inspect(relativePath + '/' + name))]
  }
  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    return [{ digest: createHash('sha256').update(readFileSync(path)).digest('hex'), mode: metadata.mode & 0o7777, path: relativePath, type: 'file' }]
  }
  return [{ path: relativePath, type: 'unsafe' }]
}
const before = selected.flatMap(inspect)
const api = await import('encephalon')
const after = selected.flatMap(inspect)
const required = ['EncephalonError', 'addRecord', 'gatherRecords', 'hydrate', 'initEncephalon', 'listRecords', 'prepare', 'searchCompactRecords', 'searchRecords', 'showRecord', 'validateRecords']
const manifest = JSON.parse(readFileSync(resolve(root, 'node_modules', 'encephalon', 'package.json'), 'utf8'))
if (JSON.stringify(before) !== JSON.stringify(after) || required.some(name => typeof api[name] !== 'function')) {
  process.stderr.write('{"stage":"import-contract"}\\n')
  process.exitCode = 1
} else {
  process.stdout.write(JSON.stringify({ exports: required, version: manifest.version }) + '\\n')
}
`

const BUDGET_PROBE_SOURCE = `
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [root, packagePhase] = process.argv.slice(2)
const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const retainedDescriptorMaps = []
let descriptorMapCalls = 0
const observedGetOwnPropertyDescriptors = value => {
  descriptorMapCalls += 1
  const descriptors = originalGetOwnPropertyDescriptors(value)
  retainedDescriptorMaps.push(descriptors)
  return descriptors
}
if (packagePhase === 'candidate') Object.getOwnPropertyDescriptors = observedGetOwnPropertyDescriptors
const api = await import('encephalon')
if (packagePhase === 'candidate') Object.getOwnPropertyDescriptors = observedGetOwnPropertyDescriptors
const cli = resolve(root, 'node_modules', 'encephalon', 'dist', 'cli.mjs')
const sanitizedChildEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => {
    const normalized = key.toLowerCase()
    return normalized !== 'node_options' && normalized !== 'node_path'
  }),
)
const MAX_CANONICAL_BYTES = 8 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const fail = stage => { throw Object.assign(new Error(stage), { stage }) }
const errorValue = error => {
  if (!(error instanceof api.EncephalonError)) fail('budget-api-error-type')
  return { code: error.code, details: error.details, message: error.message }
}
const apiObservation = action => {
  try {
    action()
    return { status: 'accepted' }
  } catch (error) {
    return { error: errorValue(error), status: 'rejected' }
  }
}
const cliResult = arguments_ =>
  spawnSync(process.execPath, [cli, '--root', root, ...arguments_], {
    cwd: root,
    encoding: 'utf8',
    env: sanitizedChildEnvironment,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  })
const cliObservation = arguments_ => {
  const result = cliResult(arguments_)
  if (result.error === undefined && result.status === 0) {
    try {
      JSON.parse(result.stdout)
    } catch {
      fail('budget-cli-success-json')
    }
    return { status: 'accepted' }
  }
  if (result.error === undefined && result.status === 2 && result.stdout === '') {
    try {
      const body = JSON.parse(result.stderr)
      if (body?.error?.code !== undefined && body?.error?.details !== undefined && body?.error?.message !== undefined) {
        return { error: body.error, status: 'rejected' }
      }
    } catch {
      fail('budget-cli-error-json')
    }
  }
  fail('budget-cli-process')
}
const boundary = (withinLimit, overLimit) => ({
  overLimit: overLimit(),
  withinLimit: withinLimit(),
})
const validationObservation = value => {
  if (!Array.isArray(value?.errors) || typeof value?.truncated !== 'boolean' || typeof value?.valid !== 'boolean') {
    fail('budget-validation-shape')
  }
  const validation = {
    errors: value.errors.map(error => ({ code: error?.code, message: error?.message })),
    truncated: value.truncated,
    valid: value.valid,
  }
  return validation.valid && validation.errors.length === 0 && !validation.truncated
    ? { status: 'accepted' }
    : { status: 'rejected', validation }
}
const apiValidationObservation = () => validationObservation(api.validateRecords({ root }))
const cliValidationObservation = () => {
  const result = cliResult(['validate'])
  if (result.error !== undefined || result.stderr !== '') fail('budget-cli-validation-process')
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    fail('budget-cli-validation-json')
  }
  if (result.status !== (value?.valid === true ? 0 : 2)) fail('budget-cli-validation-status')
  return validationObservation(value)
}
const canonicalFiles = () => {
  const brain = resolve(root, 'encephalon')
  return readdirSync(brain, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('_'))
    .flatMap(entry => readdirSync(resolve(brain, entry.name)).filter(name => name.endsWith('.json')).map(name => resolve(brain, entry.name, name)))
}
const canonicalRecords = () => canonicalFiles().map(path => JSON.parse(readFileSync(path, 'utf8')))
const recordValue = (kind, id, index, payload = {}, searchText) => ({
  createdAt: new Date(Date.UTC(2000, 0, 1) + index).toISOString(),
  id,
  kind,
  payload,
  source: 'release-compatibility',
  subject: 'release.compatibility.' + id,
  ...(searchText === undefined ? {} : { searchText }),
})
const formatted = record => JSON.stringify(record, null, 2) + '\\n'
const withRecords = (kind, records, action) => {
  const directory = resolve(root, 'encephalon', kind)
  mkdirSync(directory)
  try {
    records.map(record => writeFileSync(resolve(directory, record.id + '.json'), formatted(record)))
    return action()
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}
const exactByteRecord = (kind, id, index, targetBytes) => {
  const empty = recordValue(kind, id, index, { text: '' })
  const overhead = Buffer.byteLength(formatted(empty))
  if (targetBytes < overhead || targetBytes > MAX_RECORD_BYTES) fail('budget-byte-fixture')
  const record = recordValue(kind, id, index, { text: 'x'.repeat(targetBytes - overhead) })
  if (Buffer.byteLength(formatted(record)) !== targetBytes) fail('budget-byte-fixture-size')
  return record
}
const temporaryApiAdd = (id, payload, extra = {}) => () => {
  const path = resolve(root, 'encephalon', 'decision', id + '.json')
  try {
    api.addRecord({ id, kind: 'decision', payload, root, source: 'release-compatibility', subject: 'release.compatibility.' + id, ...extra })
  } finally {
    rmSync(path, { force: true })
  }
}
const temporaryCliAdd = (id, payload, extraArguments = []) => () => {
  const path = resolve(root, 'encephalon', 'decision', id + '.json')
  try {
    return cliObservation(['add', '--id', id, '--kind', 'decision', '--subject', 'release.compatibility.' + id, '--source', 'release-compatibility', '--data', JSON.stringify(payload), ...extraArguments])
  } finally {
    rmSync(path, { force: true })
  }
}
const nestedPayload = levels => Array.from({ length: levels }).reduce(value => [value], null)
const queryBytesWithin = 'q'.repeat(1024)
const queryBytesOver = queryBytesWithin + 'q'
const queryTermsWithin = Array.from({ length: 32 }, (_, index) => 'term' + index).join(' ')
const queryTermsOver = queryTermsWithin + ' term32'
const searchesWithin = Array.from({ length: 16 }, () => '!')
const searchesOver = [...searchesWithin, '!']
const showsWithin = Array.from({ length: 64 }, () => 'compatibility-missing')
const showsOver = [...showsWithin, 'compatibility-missing']
const supersedesWithin = Array.from({ length: 1000 }, () => 'compatibility-base')
const supersedesOver = [...supersedesWithin, 'compatibility-base']
const payloadNodesWithin = Array.from({ length: 9999 }, () => 0)
const payloadNodesOver = [...payloadNodesWithin, 0]

const apiReport = {
  queryBytes: boundary(
    () => apiObservation(() => api.searchRecords({ query: queryBytesWithin, root })),
    () => apiObservation(() => api.searchRecords({ query: queryBytesOver, root })),
  ),
  compactQueryBytes: boundary(
    () => apiObservation(() => api.searchCompactRecords({ query: queryBytesWithin, root })),
    () => apiObservation(() => api.searchCompactRecords({ query: queryBytesOver, root })),
  ),
  gatherQueryBytes: boundary(
    () => apiObservation(() => api.gatherRecords({ root, searches: [queryBytesWithin] })),
    () => apiObservation(() => api.gatherRecords({ root, searches: [queryBytesOver] })),
  ),
  queryTerms: boundary(
    () => apiObservation(() => api.searchRecords({ query: queryTermsWithin, root })),
    () => apiObservation(() => api.searchRecords({ query: queryTermsOver, root })),
  ),
  compactQueryTerms: boundary(
    () => apiObservation(() => api.searchCompactRecords({ query: queryTermsWithin, root })),
    () => apiObservation(() => api.searchCompactRecords({ query: queryTermsOver, root })),
  ),
  gatherQueryTerms: boundary(
    () => apiObservation(() => api.gatherRecords({ root, searches: [queryTermsWithin] })),
    () => apiObservation(() => api.gatherRecords({ root, searches: [queryTermsOver] })),
  ),
  gatherSearches: boundary(
    () => apiObservation(() => api.gatherRecords({ root, searches: searchesWithin })),
    () => apiObservation(() => api.gatherRecords({ root, searches: searchesOver })),
  ),
  gatherShows: boundary(
    () => apiObservation(() => api.gatherRecords({ root, shows: showsWithin })),
    () => apiObservation(() => api.gatherRecords({ root, shows: showsOver })),
  ),
  supersessionEdges: boundary(
    () => apiObservation(temporaryApiAdd('compatibility-supersedes-within', {}, { supersedes: supersedesWithin })),
    () => apiObservation(temporaryApiAdd('compatibility-supersedes-over', {}, { supersedes: supersedesOver })),
  ),
  payloadNodes: boundary(
    () => apiObservation(temporaryApiAdd('compatibility-payload-nodes-within', payloadNodesWithin)),
    () => apiObservation(temporaryApiAdd('compatibility-payload-nodes-over', payloadNodesOver)),
  ),
  payloadDepth: boundary(
    () => apiObservation(temporaryApiAdd('compatibility-payload-depth-within', nestedPayload(64))),
    () => apiObservation(temporaryApiAdd('compatibility-payload-depth-over', nestedPayload(65))),
  ),
}

const cliReport = {
  queryBytes: boundary(
    () => cliObservation(['search', '--', queryBytesWithin]),
    () => cliObservation(['search', '--', queryBytesOver]),
  ),
  compactQueryBytes: boundary(
    () => cliObservation(['search', '--compact', '--', queryBytesWithin]),
    () => cliObservation(['search', '--compact', '--', queryBytesOver]),
  ),
  gatherQueryBytes: boundary(
    () => cliObservation(['gather', '--search', queryBytesWithin]),
    () => cliObservation(['gather', '--search', queryBytesOver]),
  ),
  queryTerms: boundary(
    () => cliObservation(['search', '--', queryTermsWithin]),
    () => cliObservation(['search', '--', queryTermsOver]),
  ),
  compactQueryTerms: boundary(
    () => cliObservation(['search', '--compact', '--', queryTermsWithin]),
    () => cliObservation(['search', '--compact', '--', queryTermsOver]),
  ),
  gatherQueryTerms: boundary(
    () => cliObservation(['gather', '--search', queryTermsWithin]),
    () => cliObservation(['gather', '--search', queryTermsOver]),
  ),
  gatherSearches: boundary(
    () => cliObservation(['gather', ...searchesWithin.flatMap(query => ['--search', query])]),
    () => cliObservation(['gather', ...searchesOver.flatMap(query => ['--search', query])]),
  ),
  gatherShows: boundary(
    () => cliObservation(['gather', ...showsWithin.flatMap(id => ['--show', id])]),
    () => cliObservation(['gather', ...showsOver.flatMap(id => ['--show', id])]),
  ),
  supersessionEdges: boundary(
    temporaryCliAdd('compatibility-cli-supersedes-within', {}, supersedesWithin.map(id => '--supersedes=' + id)),
    temporaryCliAdd('compatibility-cli-supersedes-over', {}, supersedesOver.map(id => '--supersedes=' + id)),
  ),
  payloadNodes: boundary(
    temporaryCliAdd('compatibility-cli-payload-nodes-within', payloadNodesWithin),
    temporaryCliAdd('compatibility-cli-payload-nodes-over', payloadNodesOver),
  ),
  payloadDepth: boundary(
    temporaryCliAdd('compatibility-cli-payload-depth-within', nestedPayload(64)),
    temporaryCliAdd('compatibility-cli-payload-depth-over', nestedPayload(65)),
  ),
}

const captureApiError = action => {
  let failure
  try {
    action()
  } catch (error) {
    failure = error
  }
  if (failure === undefined) fail('allocation-api-error-missing')
  return errorValue(failure)
}
const captureAllocationWork = () => {
  descriptorMapCalls = 0
  retainedDescriptorMaps.length = 0
  Object.getOwnPropertyDescriptors = observedGetOwnPropertyDescriptors
  const propertyCount = 100000
  const target = {}
  for (let index = 0; index < propertyCount; index += 1) {
    target['key-' + index] = index
  }
  const work = { descriptors: 0, ownKeys: 0 }
  const payload = new Proxy(target, {
    getOwnPropertyDescriptor: (object, key) => {
      work.descriptors += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
    ownKeys: object => {
      work.ownKeys += 1
      return Reflect.ownKeys(object)
    },
  })
  const oversizedArrayWork = { descriptors: [], ownKeys: 0 }
  const oversizedArray = new Proxy(new Array(2 ** 32 - 1), {
    getOwnPropertyDescriptor: (array, key) => {
      oversizedArrayWork.descriptors.push(String(key))
      return Reflect.getOwnPropertyDescriptor(array, key)
    },
    ownKeys: array => {
      oversizedArrayWork.ownKeys += 1
      return Reflect.ownKeys(array)
    },
  })
  const addPayload = value => api.addRecord({
    id: 'compatibility-allocation-work',
    kind: 'decision',
    payload: value,
    root: resolve(root, '.release-compatibility', 'unused-allocation-root'),
    source: 'release-compatibility',
    subject: 'release.compatibility.allocation-work',
  })
  let wideObjectError
  let oversizedArrayError
  try {
    wideObjectError = captureApiError(() => addPayload(payload))
    oversizedArrayError = captureApiError(() => addPayload(oversizedArray))
  } finally {
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors
  }
  return {
    descriptorMapCalls,
    oversizedArray: { error: oversizedArrayError, work: oversizedArrayWork },
    retainedDescriptorCount: retainedDescriptorMaps.reduce(
      (count, descriptors) => count + Reflect.ownKeys(descriptors).length,
      0,
    ),
    wideObject: { error: wideObjectError, propertyCount, work },
  }
}
if (packagePhase === 'candidate') {
  apiReport.allocationWork = captureAllocationWork()
} else {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors
}

const existingCount = canonicalFiles().length
const countKind = 'compatibilitybudgetcount'
const countRecords = Array.from({ length: 1000 - existingCount }, (_, index) =>
  recordValue(countKind, 'compatibility-count-' + String(index).padStart(4, '0'), index),
)
const countEvidence = withRecords(countKind, countRecords, () => ({
  api: boundary(
    () => apiObservation(() => api.validateRecords({ root })),
    () => apiObservation(temporaryApiAdd('compatibility-count-over', {})),
  ),
  cli: boundary(
    () => cliObservation(['validate']),
    temporaryCliAdd('compatibility-cli-count-over', {}),
  ),
}))
apiReport.corpusRecords = countEvidence.api
cliReport.corpusRecords = countEvidence.cli

const existingBytes = canonicalFiles().reduce((bytes, path) => bytes + statSync(path).size, 0)
const remainingBytes = MAX_CANONICAL_BYTES - existingBytes
const byteKind = 'compatibilitybudgetbytes'
const byteRecordCount = Math.ceil(remainingBytes / (MAX_RECORD_BYTES - 1024))
const baseByteTarget = Math.floor(remainingBytes / byteRecordCount)
const extraByteTargets = remainingBytes % byteRecordCount
const byteRecords = Array.from({ length: byteRecordCount }, (_, index) =>
  exactByteRecord(
    byteKind,
    'compatibility-bytes-' + String(index).padStart(2, '0'),
    index,
    baseByteTarget + (index < extraByteTargets ? 1 : 0),
  ),
)
const byteEvidence = withRecords(byteKind, byteRecords, () => ({
  api: boundary(
    () => apiObservation(() => api.validateRecords({ root })),
    () => apiObservation(temporaryApiAdd('compatibility-bytes-over', {})),
  ),
  cli: boundary(
    () => cliObservation(['validate']),
    temporaryCliAdd('compatibility-cli-bytes-over', {}),
  ),
}))
apiReport.corpusBytes = byteEvidence.api
cliReport.corpusBytes = byteEvidence.cli

const aggregateSupersessionEvidence = (() => {
  const existingRecords = canonicalRecords()
  const remainingEdges = 1000 - existingRecords.reduce(
    (count, record) => count + (record.supersedes?.length ?? 0),
    0,
  )
  const kind = 'compatibilitybudgetsupersession'
  const recordCount = Math.ceil((remainingEdges + 4) / 2)
  if (remainingEdges < 1 || recordCount > 1000 - existingRecords.length) {
    fail('budget-corpus-supersession-fixture')
  }
  const records = Array.from({ length: recordCount }, (_, index) => ({
    ...recordValue(kind, 'compatibility-supersession-' + String(index).padStart(4, '0'), index),
    subject: 'release.compatibility.aggregate-supersession',
    ...(index === 0 ? {} : { supersedes: ['compatibility-supersession-' + String(index - 1).padStart(4, '0')] }),
  }))
  const last = records.at(-1)
  if (last === undefined) fail('budget-corpus-supersession-last')
  const chainEdges = records.length - 1
  const additionalEdges = remainingEdges - chainEdges
  if (additionalEdges < 0 || additionalEdges > records.length - 3) {
    fail('budget-corpus-supersession-capacity')
  }
  const withinLast = {
    ...last,
    supersedes: [
      ...(last.supersedes ?? []),
      ...records.slice(0, additionalEdges).map(record => record.id),
    ],
  }
  const withinRecords = [...records.slice(0, -1), withinLast]
  const overTarget = records[additionalEdges]
  if (overTarget === undefined || withinLast.supersedes.includes(overTarget.id)) {
    fail('budget-corpus-supersession-over-target')
  }
  return withRecords(kind, withinRecords, () => {
    const apiWithin = apiValidationObservation()
    const cliWithin = cliValidationObservation()
    writeFileSync(
      resolve(root, 'encephalon', kind, withinLast.id + '.json'),
      formatted({ ...withinLast, supersedes: [...withinLast.supersedes, overTarget.id] }),
    )
    return {
      api: { overLimit: apiValidationObservation(), withinLimit: apiWithin },
      cli: { overLimit: cliValidationObservation(), withinLimit: cliWithin },
    }
  })
})()
apiReport.corpusSupersessionEdges = aggregateSupersessionEvidence.api
cliReport.corpusSupersessionEdges = aggregateSupersessionEvidence.cli

const aggregateArtifactEvidence = (() => {
  const existingArtifactCount = canonicalRecords().reduce(
    (count, record) => count + (record.artifacts?.length ?? 0),
    0,
  )
  const remainingArtifacts = 1000 - existingArtifactCount
  const kind = 'compatibilitybudgetartifacts'
  const artifactsPerRecord = 250
  const recordCount = Math.ceil(remainingArtifacts / artifactsPerRecord)
  if (remainingArtifacts < 1 || recordCount < 1) fail('budget-corpus-artifact-fixture')
  const records = Array.from({ length: recordCount }, (_, recordIndex) => {
    const id = 'compatibility-artifacts-' + String(recordIndex).padStart(2, '0')
    const count = Math.min(artifactsPerRecord, remainingArtifacts - recordIndex * artifactsPerRecord)
    return {
      ...recordValue(kind, id, recordIndex),
      artifacts: Array.from(
        { length: count },
        (_, artifactIndex) =>
          '_artifacts/' + kind + '/' + id + '/evidence-' + String(artifactIndex).padStart(3, '0') + '.txt',
      ),
    }
  })
  const recordDirectory = resolve(root, 'encephalon', kind)
  const artifactDirectory = resolve(root, 'encephalon', '_artifacts', kind)
  mkdirSync(recordDirectory)
  mkdirSync(artifactDirectory, { recursive: true })
  try {
    records.map(record => {
      writeFileSync(resolve(recordDirectory, record.id + '.json'), formatted(record))
      record.artifacts.map(path => {
        const directory = resolve(root, 'encephalon', '_artifacts', kind, record.id)
        mkdirSync(directory, { recursive: true })
        writeFileSync(resolve(root, 'encephalon', path), '')
      })
    })
    const apiWithin = apiValidationObservation()
    const cliWithin = cliValidationObservation()
    const last = records.at(-1)
    if (last === undefined) fail('budget-corpus-artifact-last')
    const overPath = '_artifacts/' + kind + '/' + last.id + '/over-limit.txt'
    writeFileSync(
      resolve(recordDirectory, last.id + '.json'),
      formatted({ ...last, artifacts: [...last.artifacts, overPath] }),
    )
    return {
      api: { overLimit: apiValidationObservation(), withinLimit: apiWithin },
      cli: { overLimit: cliValidationObservation(), withinLimit: cliWithin },
    }
  } finally {
    rmSync(recordDirectory, { force: true, recursive: true })
    rmSync(artifactDirectory, { force: true, recursive: true })
  }
})()
apiReport.corpusArtifactReferences = aggregateArtifactEvidence.api
cliReport.corpusArtifactReferences = aggregateArtifactEvidence.cli

const responseKind = 'compatibilitybudgetresponse'
const responseRecords = Array.from({ length: 5 }, (_, index) =>
  recordValue(
    responseKind,
    'compatibility-response-' + index,
    index,
    { summary: 'x '.repeat(450000) },
    'compatibility-response-marker',
  ),
)
const responseEvidence = withRecords(responseKind, responseRecords, () => ({
  api: {
    fullResponseBytes: boundary(
      () => apiObservation(() => api.searchRecords({ includeSuperseded: true, limit: 4, query: 'compatibility-response-marker', root })),
      () => apiObservation(() => api.searchRecords({ includeSuperseded: true, limit: 5, query: 'compatibility-response-marker', root })),
    ),
    compactResponseBytes: boundary(
      () => apiObservation(() => api.searchCompactRecords({ includeSuperseded: true, limit: 4, query: 'compatibility-response-marker', root })),
      () => apiObservation(() => api.searchCompactRecords({ includeSuperseded: true, limit: 5, query: 'compatibility-response-marker', root })),
    ),
    gatherResponseBytes: boundary(
      () => apiObservation(() => api.gatherRecords({ root, shows: Array.from({ length: 4 }, () => 'compatibility-response-0') })),
      () => apiObservation(() => api.gatherRecords({ root, shows: Array.from({ length: 5 }, () => 'compatibility-response-0') })),
    ),
  },
  cli: {
    fullResponseBytes: boundary(
      () => cliObservation(['search', '--include-superseded', '--limit=4', '--', 'compatibility-response-marker']),
      () => cliObservation(['search', '--include-superseded', '--limit=5', '--', 'compatibility-response-marker']),
    ),
    compactResponseBytes: boundary(
      () => cliObservation(['search', '--compact', '--include-superseded', '--limit=4', '--', 'compatibility-response-marker']),
      () => cliObservation(['search', '--compact', '--include-superseded', '--limit=5', '--', 'compatibility-response-marker']),
    ),
    gatherResponseBytes: boundary(
      () => cliObservation(['gather', ...Array.from({ length: 4 }, () => ['--show', 'compatibility-response-0']).flat()]),
      () => cliObservation(['gather', ...Array.from({ length: 5 }, () => ['--show', 'compatibility-response-0']).flat()]),
    ),
  },
}))
Object.assign(apiReport, responseEvidence.api)
Object.assign(cliReport, responseEvidence.cli)

process.stdout.write(JSON.stringify({ api: apiReport, cli: cliReport }) + '\\n')
`

const DECLARATION_CONSUMER_SOURCE = `
import {
  addRecord,
  EncephalonError,
  gatherRecords,
  hydrate,
  initEncephalon,
  listRecords,
  prepare,
  searchCompactRecords,
  searchRecords,
  showRecord,
  validateRecords,
} from 'encephalon'
import type {
  AddRecordInput,
  BrainRecord,
  BrainRecordFile,
  CompactBrainRecord,
  EncephalonErrorCode,
  GatherInput,
  GatherResult,
  HydrateResult,
  InitEncephalonInput,
  InitEncephalonResult,
  JsonPrimitive,
  JsonValue,
  ListRecordsInput,
  PrepareResult,
  RootInput,
  SearchRecordsInput,
  ShowRecordInput,
  ValidateResult,
  ValidationIssue,
} from 'encephalon'

export const values = [addRecord, EncephalonError, gatherRecords, hydrate, initEncephalon, listRecords, prepare, searchCompactRecords, searchRecords, showRecord, validateRecords]
export type Contract = [AddRecordInput, BrainRecord, BrainRecordFile, CompactBrainRecord, EncephalonErrorCode, GatherInput, GatherResult, HydrateResult, InitEncephalonInput, InitEncephalonResult, JsonPrimitive, JsonValue, ListRecordsInput, PrepareResult, RootInput, SearchRecordsInput, ShowRecordInput, ValidateResult, ValidationIssue]
`

const resultLimitOutcome = (maximum: number): ResultLimitOutcome =>
  Object.freeze({
    accepted: Object.freeze(resultLimitCases.filter(limit => limit <= maximum)),
    rejected: Object.freeze(resultLimitCases.filter(limit => limit > maximum)),
  })

const resultLimitReport = (maximums: ResultLimitMaximums): ResultLimitReport =>
  Object.freeze({
    gather: resultLimitOutcome(maximums.compact),
    list: resultLimitOutcome(maximums.full),
    search: resultLimitOutcome(maximums.full),
    searchCompact: resultLimitOutcome(maximums.compact),
  })

const safeNpmResult = (
  arguments_: readonly string[],
  cwd: string,
  label: string,
  redactions: readonly Buffer[] = [],
) => {
  const result = spawnNpmCommand(arguments_, {
    cwd,
    environment: sanitizedCompatibilityEnvironment(),
    maxBuffer: MAX_COMPATIBILITY_SUBPROCESS_OUTPUT_BYTES,
  })
  if (result.error === undefined && result.status === 0) {
    return { stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
  }
  const stdout = boundDiagnostic(redactDiagnostic(result.stdout ?? '', redactions))
  const stderr = boundDiagnostic(redactDiagnostic(result.stderr ?? '', redactions))
  throw new CompatibilityCommandError(
    label,
    { exitCode: result.status ?? 1, signal: result.signal, stderr, stdout },
    result.error === undefined ? undefined : { cause: result.error },
  )
}

const parseJson = <Value>(value: string, label: string): Value => {
  try {
    return JSON.parse(value) as Value
  } catch (error) {
    throw new Error(`${label} did not return one JSON value.`, { cause: error })
  }
}

const safeDownloadedTarball = (directory: string, stdout: string) => {
  const output = parseJson<Array<{ filename?: unknown }>>(stdout, 'The published oracle download')
  const filename = output.length === 1 ? output[0]?.filename : undefined
  const path = typeof filename === 'string' ? resolve(directory, filename) : directory
  const relativePath = relative(directory, path)
  if (
    typeof filename === 'string' &&
    filename === basename(filename) &&
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath) &&
    filename.endsWith('.tgz')
  ) {
    return path
  }
  throw new Error('npm did not return one safe published compatibility oracle tarball.')
}

const acquireOracle = (temporaryDirectory: string, supplied?: SuppliedOracle) => {
  const identity = supplied === undefined ? ORACLE : supplied.identity
  const sourcePath = (() => {
    if (supplied !== undefined) {
      return supplied.tarball
    }
    const downloadDirectory = resolve(temporaryDirectory, 'oracle-download')
    mkdirSync(downloadDirectory)
    const packed = safeNpmResult(
      ['pack', ORACLE.specifier, '--ignore-scripts', '--json', '--pack-destination', downloadDirectory],
      projectRoot,
      'The published compatibility oracle download',
    )
    return safeDownloadedTarball(downloadDirectory, packed.stdout)
  })()
  const snapshotDirectory = resolve(temporaryDirectory, 'oracle-snapshot')
  mkdirSync(snapshotDirectory)
  const snapshot = snapshotPackageTarball(sourcePath, snapshotDirectory)
  const digests = verifyOracleTarball(snapshot.path, identity)
  return { digests, identity, path: snapshot.path }
}

const acquireCandidate = (temporaryDirectory: string, sourcePath: string) => {
  const snapshotDirectory = resolve(temporaryDirectory, 'candidate-snapshot')
  mkdirSync(snapshotDirectory)
  return snapshotPackageTarball(sourcePath, snapshotDirectory)
}

const initialiseFixtureRepository = (fixtureRoot: string) => {
  const metadata = lstatSync(fixtureRoot, { throwIfNoEntry: false })
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    readdirSync(fixtureRoot).length > 0
  ) {
    throw new Error('The supplied release compatibility fixture root must be one empty ordinary directory.')
  }
  writeFileSync(
    resolve(fixtureRoot, 'package.json'),
    '{"name":"encephalon-release-compatibility-fixture","private":true,"type":"module"}\n',
  )
  writeFileSync(resolve(fixtureRoot, 'AGENTS.md'), 'oracle agents predecessor\n')
  writeFileSync(resolve(fixtureRoot, 'CLAUDE.md'), 'oracle claude predecessor\n')
  runCompatibilityCommand('git', ['init', '--quiet'], {
    cwd: fixtureRoot,
    label: 'The release compatibility Git fixture initialisation',
  })
}

const installPackage = (fixtureRoot: string, tarball: string, label: string, redactions: readonly Buffer[] = []) => {
  rmSync(resolve(fixtureRoot, 'node_modules', 'encephalon'), { force: true, recursive: true })
  safeNpmResult(
    ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false'],
    fixtureRoot,
    label,
    redactions,
  )
}

const writeProbeFiles = (fixtureRoot: string) => {
  const probeDirectory = resolve(fixtureRoot, '.release-compatibility')
  mkdirSync(probeDirectory)
  const apiProbe = resolve(probeDirectory, 'api-probe.mjs')
  const budgetProbe = resolve(probeDirectory, 'budget-probe.mjs')
  const importProbe = resolve(probeDirectory, 'import-probe.mjs')
  const declarationConsumer = resolve(probeDirectory, 'consumer.ts')
  const declarationConfiguration = resolve(probeDirectory, 'tsconfig.json')
  writeFileSync(apiProbe, API_PROBE_SOURCE)
  writeFileSync(budgetProbe, BUDGET_PROBE_SOURCE)
  writeFileSync(importProbe, IMPORT_PROBE_SOURCE)
  writeFileSync(declarationConsumer, DECLARATION_CONSUMER_SOURCE)
  writeFileSync(
    declarationConfiguration,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2023',
        },
        files: ['./consumer.ts'],
      },
      null,
      2,
    )}\n`,
  )
  return { apiProbe, budgetProbe, declarationConfiguration, importProbe }
}

type ApiProbeResult = {
  limits: ResultLimitReport
  schemaAfter: string
  schemaBefore?: string
  surface: unknown
  version: string
}

const runApiProbe = (
  probe: string,
  phase: 'downgrade' | 'initialise' | 'upgrade',
  fixtureRoot: string,
  redactions: readonly Buffer[],
) => {
  const result = runCompatibilityCommand(process.execPath, [probe, phase, fixtureRoot], {
    cwd: fixtureRoot,
    label: `The ${phase} API compatibility probe`,
    redactions,
  })
  return parseJson<ApiProbeResult>(result.stdout, `The ${phase} API compatibility probe`)
}

const runImportProbe = (probe: string, fixtureRoot: string, redactions: readonly Buffer[]) => {
  const result = runCompatibilityCommand(process.execPath, [probe, fixtureRoot], {
    cwd: fixtureRoot,
    label: 'The side-effect-free API import probe',
    redactions,
  })
  return parseJson<{ version: string }>(result.stdout, 'The side-effect-free API import probe')
}

type BudgetObservation = Readonly<
  | { status: 'accepted' }
  | {
      error: Readonly<{
        code: string
        details: Readonly<Record<string, unknown>>
        message: string
      }>
      status: 'rejected'
    }
  | {
      status: 'rejected'
      validation: Readonly<{
        errors: readonly Readonly<{ code: string; message: string }>[]
        truncated: boolean
        valid: boolean
      }>
    }
>

type BudgetBoundary = Readonly<{
  overLimit: BudgetObservation
  withinLimit: BudgetObservation
}>

type AllocationWorkEvidence = Readonly<{
  descriptorMapCalls: number
  oversizedArray: Readonly<{
    error: Readonly<{ code: string; details: Readonly<Record<string, unknown>>; message: string }>
    work: Readonly<{ descriptors: readonly string[]; ownKeys: number }>
  }>
  retainedDescriptorCount: number
  wideObject: Readonly<{
    error: Readonly<{ code: string; details: Readonly<Record<string, unknown>>; message: string }>
    propertyCount: number
    work: Readonly<{ descriptors: number; ownKeys: number }>
  }>
}>

type IndependentBudgetChannel = Readonly<Record<string, AllocationWorkEvidence | BudgetBoundary>>

type IndependentBudgetReport = Readonly<{
  api: IndependentBudgetChannel
  cli: IndependentBudgetChannel
}>

const runBudgetProbe = (
  probe: string,
  fixtureRoot: string,
  packagePhase: 'candidate' | 'oracle',
  redactions: readonly Buffer[],
) => {
  const result = runCompatibilityCommand(process.execPath, [probe, fixtureRoot, packagePhase], {
    cwd: fixtureRoot,
    label: 'The independent public budget probe',
    redactions,
  })
  return parseJson<IndependentBudgetReport>(result.stdout, 'The independent public budget probe')
}

const acceptedBudgetObservation = Object.freeze({ status: 'accepted' as const })
const rejectedBudgetObservation = (
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): BudgetObservation =>
  Object.freeze({
    error: Object.freeze({ code, details: Object.freeze({ ...details }), message }),
    status: 'rejected',
  })
const budgetBoundary = (overLimit: BudgetObservation, withinLimit: BudgetObservation = acceptedBudgetObservation) =>
  Object.freeze({ overLimit, withinLimit })
const budgetFailure = (budget: string, field: string, maximum: number, message: string) =>
  rejectedBudgetObservation('INVALID_ARGUMENT', message, { budget, field, maximum })
const fieldFailure = (message: string, field: string) =>
  rejectedBudgetObservation('INVALID_ARGUMENT', message, { field })
const validationFailure = (code: string, message: string) =>
  rejectedBudgetObservation('VALIDATION_FAILED', 'The new record would make canonical records invalid.', {
    errors: [{ code, message }],
  })
const validationBoundaryFailure = (code: string, message: string): BudgetObservation =>
  Object.freeze({
    status: 'rejected',
    validation: Object.freeze({
      errors: Object.freeze([Object.freeze({ code, message })]),
      truncated: false,
      valid: false,
    }),
  })

const commonCandidateBudgetEvidence = Object.freeze({
  compactQueryBytes: budgetBoundary(
    budgetFailure('queryBytes', 'query', 1024, 'query must contain at most 1024 UTF-8 bytes.'),
  ),
  compactQueryTerms: budgetBoundary(
    budgetFailure('queryTerms', 'query', 32, 'query may contain at most 32 literal terms.'),
  ),
  compactResponseBytes: budgetBoundary(
    budgetFailure('compactResponseBytes', 'response', 4 * 1024 * 1024, 'response may contain at most 4194304 bytes.'),
  ),
  corpusBytes: budgetBoundary(
    validationFailure('CORPUS_BYTE_LIMIT', 'Canonical corpus may contain at most 8388608 bytes of record JSON.'),
  ),
  corpusRecords: budgetBoundary(
    validationFailure('CORPUS_RECORD_LIMIT', 'Canonical corpus may contain at most 1000 records.'),
  ),
  fullResponseBytes: budgetBoundary(
    budgetFailure(
      'fullResponseBytes',
      'response',
      4 * 1024 * 1024,
      'full-record responses may contain at most 4194304 UTF-8 bytes.',
    ),
  ),
  gatherQueryBytes: budgetBoundary(
    budgetFailure('queryBytes', 'query', 1024, 'query must contain at most 1024 UTF-8 bytes.'),
  ),
  gatherQueryTerms: budgetBoundary(
    budgetFailure('queryTerms', 'query', 32, 'query may contain at most 32 literal terms.'),
  ),
  gatherResponseBytes: budgetBoundary(
    budgetFailure('gatherResponseBytes', 'response', 4 * 1024 * 1024, 'response may contain at most 4194304 bytes.'),
  ),
  gatherSearches: budgetBoundary(
    budgetFailure('gatherSearches', 'searches', 16, 'gather may contain at most 16 searches.'),
  ),
  gatherShows: budgetBoundary(budgetFailure('gatherShows', 'shows', 64, 'gather may contain at most 64 shows.')),
  payloadDepth: budgetBoundary(
    fieldFailure('payload may be nested at most 64 levels deep.', `payload${'[0]'.repeat(65)}`),
  ),
  payloadNodes: budgetBoundary(fieldFailure('payload may contain at most 10000 JSON nodes.', 'payload')),
  queryBytes: budgetBoundary(
    budgetFailure('queryBytes', 'query', 1024, 'query must contain at most 1024 UTF-8 bytes.'),
  ),
  queryTerms: budgetBoundary(budgetFailure('queryTerms', 'query', 32, 'query may contain at most 32 literal terms.')),
})

const candidateBudgetEvidence = Object.freeze({
  api: Object.freeze({
    ...commonCandidateBudgetEvidence,
    allocationWork: Object.freeze({
      descriptorMapCalls: 0,
      oversizedArray: Object.freeze({
        error: Object.freeze({
          code: 'INVALID_ARGUMENT',
          details: Object.freeze({ field: 'payload' }),
          message: 'payload may contain at most 10000 JSON nodes.',
        }),
        work: Object.freeze({ descriptors: Object.freeze(['length']), ownKeys: 0 }),
      }),
      retainedDescriptorCount: 0,
      wideObject: Object.freeze({
        error: Object.freeze({
          code: 'INVALID_ARGUMENT',
          details: Object.freeze({ field: 'payload' }),
          message: 'payload may contain at most 10000 JSON nodes.',
        }),
        propertyCount: 100_000,
        work: Object.freeze({ descriptors: 100_000, ownKeys: 1 }),
      }),
    }),
    corpusArtifactReferences: budgetBoundary(
      validationBoundaryFailure(
        'CORPUS_ARTIFACT_LIMIT',
        'Canonical corpus may contain at most 1000 artifact references.',
      ),
    ),
    corpusSupersessionEdges: budgetBoundary(
      validationBoundaryFailure(
        'CORPUS_SUPERSEDES_LIMIT',
        'Canonical corpus may contain at most 1000 supersession edges.',
      ),
    ),
    supersessionEdges: budgetBoundary(
      budgetFailure('supersessionEdges', 'supersedes', 1000, 'supersedes may contain at most 1000 record ids.'),
      fieldFailure('supersedes must be a non-empty array of unique strings.', 'supersedes'),
    ),
  }),
  cli: Object.freeze({
    ...commonCandidateBudgetEvidence,
    corpusArtifactReferences: budgetBoundary(
      validationBoundaryFailure(
        'CORPUS_ARTIFACT_LIMIT',
        'Canonical corpus may contain at most 1000 artifact references.',
      ),
    ),
    corpusSupersessionEdges: budgetBoundary(
      validationBoundaryFailure(
        'CORPUS_SUPERSEDES_LIMIT',
        'Canonical corpus may contain at most 1000 supersession edges.',
      ),
    ),
    supersessionEdges: budgetBoundary(
      budgetFailure('supersessionEdges', 'supersedes', 1000, '--supersedes may be supplied at most 1000 times.'),
      fieldFailure('supersedes must be a non-empty array of unique strings.', 'supersedes'),
    ),
  }),
})

const assertCandidateIndependentBudgets = (actual: IndependentBudgetReport) => {
  if (!isDeepStrictEqual(candidateBudgetEvidence, actual)) {
    const differences = (['api', 'cli'] as const).flatMap(channel =>
      Object.entries(candidateBudgetEvidence[channel]).flatMap(([budget, expected]) =>
        isDeepStrictEqual(expected, actual[channel]?.[budget])
          ? []
          : publicSurfaceDifferencePaths(expected, actual[channel]?.[budget], `${channel}.${budget}`),
      ),
    )
    throw new Error(
      `The candidate does not enforce the approved independent public budget boundaries exactly (${differences.join(', ')}).`,
    )
  }
}

const runDeclarationProbe = (configuration: string, fixtureRoot: string, redactions: readonly Buffer[]) => {
  const compiler = resolve(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  runCompatibilityCommand(process.execPath, [compiler, '--project', configuration], {
    cwd: fixtureRoot,
    label: 'The consumer declaration compatibility probe',
    redactions,
  })
}

const installedCli = (fixtureRoot: string) => resolve(fixtureRoot, 'node_modules', 'encephalon', 'dist', 'cli.mjs')

const cliSuccess = (fixtureRoot: string, arguments_: readonly string[], redactions: readonly Buffer[]) =>
  runCompatibilityCommand(process.execPath, [installedCli(fixtureRoot), ...arguments_], {
    cwd: fixtureRoot,
    label: `The ${arguments_[0] ?? 'unknown'} CLI compatibility probe`,
    redactions,
  }).stdout

const cliFailure = (fixtureRoot: string, arguments_: readonly string[], redactions: readonly Buffer[]) => {
  try {
    cliSuccess(fixtureRoot, arguments_, redactions)
  } catch (error) {
    if (error instanceof CompatibilityCommandError) {
      return error
    }
    throw error
  }
  throw new Error(`The ${arguments_[0] ?? 'unknown'} CLI compatibility probe unexpectedly succeeded.`)
}

const assertCliJson = (fixtureRoot: string, arguments_: readonly string[], redactions: readonly Buffer[]) =>
  parseJson<unknown>(cliSuccess(fixtureRoot, arguments_, redactions), `The ${arguments_[0] ?? 'unknown'} CLI probe`)

const normalisePublicValue = (value: unknown, fixtureRoot: string, key?: string): unknown => {
  if (key === 'createdAt' && typeof value === 'string') {
    return '<timestamp>'
  }
  if (typeof value === 'string') {
    return value.replaceAll(fixtureRoot, '<fixture-root>')
  }
  if (Array.isArray(value)) {
    return value.map(item => normalisePublicValue(item, fixtureRoot))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, normalisePublicValue(item, fixtureRoot, name)]),
    )
  }
  return value
}

const captureCliSurface = (fixtureRoot: string, version: string, redactions: readonly Buffer[]) => {
  const help = cliSuccess(fixtureRoot, ['--help'], redactions)
  const versionOutput = cliSuccess(fixtureRoot, ['--version'], redactions)
  if (versionOutput !== `${version}\n`) {
    throw new Error('The installed CLI version output does not match its package manifest.')
  }
  const initialised = assertCliJson(fixtureRoot, ['init', '--root', fixtureRoot], redactions)
  const added = assertCliJson(
    fixtureRoot,
    [
      'add',
      '--root',
      fixtureRoot,
      '--id',
      'compatibility-cli-surface-add',
      '--kind',
      'decision',
      '--subject',
      'release.compatibility.cli-surface-add',
      '--source',
      'release-compatibility',
      '--data',
      '{"summary":"Compatibility CLI surface add"}',
      '--text',
      'compatibility-marker cli-surface-add',
    ],
    redactions,
  )
  rmSync(resolve(fixtureRoot, 'encephalon', 'decision', 'compatibility-cli-surface-add.json'))
  const duplicate = cliFailure(
    fixtureRoot,
    [
      'add',
      '--root',
      fixtureRoot,
      '--id',
      'compatibility-base',
      '--kind',
      'decision',
      '--subject',
      'release.compatibility.base',
      '--source',
      'release-compatibility',
      '--data',
      '{}',
    ],
    redactions,
  )
  const prepared = assertCliJson(fixtureRoot, ['prepare', '--root', fixtureRoot], redactions)
  const hydrated = assertCliJson(fixtureRoot, ['hydrate', '--root', fixtureRoot], redactions)
  return normalisePublicValue(
    {
      add: added,
      addError: {
        body: parseJson<unknown>(duplicate.stderr, 'The duplicate add CLI surface probe'),
        exitCode: duplicate.exitCode,
        stdout: duplicate.stdout,
      },
      gather: assertCliJson(
        fixtureRoot,
        [
          'gather',
          '--root',
          fixtureRoot,
          '--include-superseded',
          '--search',
          'compatibility-marker',
          '--show',
          'compatibility-base',
        ],
        redactions,
      ),
      help,
      hydrate: hydrated,
      init: initialised,
      list: assertCliJson(
        fixtureRoot,
        ['list', '--root', fixtureRoot, '--include-superseded', '--kind', 'decision'],
        redactions,
      ),
      prepare: prepared,
      search: assertCliJson(
        fixtureRoot,
        ['search', '--root', fixtureRoot, '--include-superseded', '--', 'compatibility-marker'],
        redactions,
      ),
      searchCompact: assertCliJson(
        fixtureRoot,
        ['search', '--root', fixtureRoot, '--compact', '--include-superseded', '--', 'compatibility-marker'],
        redactions,
      ),
      show: assertCliJson(fixtureRoot, ['show', '--root', fixtureRoot, '--id', 'compatibility-base'], redactions),
      validate: assertCliJson(fixtureRoot, ['validate', '--root', fixtureRoot], redactions),
      version: '<package-version>\n',
    },
    fixtureRoot,
  )
}

const cliLimitArguments = (operation: (typeof resultLimitOperations)[number], fixtureRoot: string, limit: number) => {
  const prefixes = {
    gather: ['gather', '--root', fixtureRoot, '--search', 'compatibility-marker'],
    list: ['list', '--root', fixtureRoot],
    search: ['search', '--root', fixtureRoot],
    searchCompact: ['search', '--root', fixtureRoot, '--compact'],
  } as const
  const query = operation === 'search' || operation === 'searchCompact' ? ['--', 'compatibility-marker'] : []
  return [...prefixes[operation], `--limit=${limit}`, ...query]
}

const assertCliResultLimits = (fixtureRoot: string, maximums: ResultLimitMaximums, redactions: readonly Buffer[]) => {
  const cases = resultLimitOperations.flatMap(operation => resultLimitCases.map(limit => ({ limit, operation })))
  const executed = cases.reduce((count, { limit, operation }) => {
    const maximum = operation === 'list' || operation === 'search' ? maximums.full : maximums.compact
    if (limit <= maximum) {
      assertCliJson(fixtureRoot, cliLimitArguments(operation, fixtureRoot, limit), redactions)
      return count + 1
    }
    const failure = cliFailure(fixtureRoot, cliLimitArguments(operation, fixtureRoot, limit), redactions)
    const body = parseJson<{ error?: { code?: unknown; details?: Record<string, unknown> } }>(
      failure.stderr,
      'The rejected CLI result-limit probe',
    )
    const budget = operation === 'list' || operation === 'search' ? 'fullResultLimit' : 'compactResultLimit'
    const hasExpectedEnvelope =
      failure.exitCode === 2 && failure.stdout === '' && body.error?.code === 'INVALID_ARGUMENT'
    const isOracleParserRejection = maximums.full === 50 && maximums.compact === 100 && limit === 1001
    const hasExpectedDetails = isOracleParserRejection
      ? true
      : body.error?.details?.budget === budget &&
        body.error.details.field === 'limit' &&
        body.error.details.maximum === maximum
    if (!(hasExpectedEnvelope && hasExpectedDetails)) {
      throw new Error(`The rejected ${operation} CLI result-limit contract did not match the published oracle.`)
    }
    return count + 1
  }, 0)
  if (executed !== cases.length) {
    throw new Error('The CLI result-limit matrix did not execute every case.')
  }
  return resultLimitReport(maximums)
}

const runCandidateCliSurface = (fixtureRoot: string, version: string, redactions: readonly Buffer[]) => {
  const surface = captureCliSurface(fixtureRoot, version, redactions)
  const limits = assertCliResultLimits(fixtureRoot, candidateResultLimitMaximums, redactions)
  return { limits, surface }
}

const runDowngradeCliSurface = (fixtureRoot: string, version: string, redactions: readonly Buffer[]) => {
  const surface = captureCliSurface(fixtureRoot, version, redactions)
  const limits = assertCliResultLimits(fixtureRoot, oracleResultLimitMaximums, redactions)
  return { limits, surface }
}

const assertLimitReport = (actual: ResultLimitReport, maximums: ResultLimitMaximums, label: string) => {
  const expected = resultLimitReport(maximums)
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} did not exercise the complete published result-limit table.`)
  }
}

const durableRedactions = (snapshot: DurableSnapshot) =>
  snapshot.flatMap(entry => (entry.bytes === undefined ? [] : [entry.bytes]))

export const runReleaseCompatibility = (options: ReleaseCompatibilityOptions): ReleaseCompatibilityReport => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-compatibility-'))
  try {
    const candidate = acquireCandidate(temporaryDirectory, options.candidateTarball)
    const oracle = acquireOracle(temporaryDirectory, options.oracle)
    const fixtureRoot = options.fixtureRoot ?? resolve(temporaryDirectory, 'repository')
    if (options.fixtureRoot === undefined) {
      mkdirSync(fixtureRoot)
    }
    initialiseFixtureRepository(fixtureRoot)
    const probes = writeProbeFiles(fixtureRoot)
    const predecessorRedactions = [
      Buffer.from('oracle agents predecessor\n'),
      Buffer.from('oracle claude predecessor\n'),
    ]

    installPackage(fixtureRoot, oracle.path, 'The verified published oracle installation', predecessorRedactions)
    const initialImport = runImportProbe(probes.importProbe, fixtureRoot, predecessorRedactions)
    runDeclarationProbe(probes.declarationConfiguration, fixtureRoot, predecessorRedactions)
    const initial = runApiProbe(probes.apiProbe, 'initialise', fixtureRoot, predecessorRedactions)
    assertLimitReport(initial.limits, oracleResultLimitMaximums, 'The published oracle API phase')
    if (initial.schemaAfter !== '1') {
      throw new Error('The published compatibility oracle did not prepare cache schema 1.')
    }
    const oracleCliSurface = captureCliSurface(fixtureRoot, initial.version, predecessorRedactions)
    const oracleCliLimits = assertCliResultLimits(fixtureRoot, oracleResultLimitMaximums, predecessorRedactions)
    const oracleIndependentBudgets = runBudgetProbe(probes.budgetProbe, fixtureRoot, 'oracle', predecessorRedactions)
    const oraclePublicSurface = publicSurfaceDigests(initial.surface, oracleCliSurface)
    const durable = captureDurableSnapshot(fixtureRoot)
    const redactions = durableRedactions(durable)

    installPackage(fixtureRoot, candidate.path, 'The exact candidate package installation', redactions)
    const candidateImport = runImportProbe(probes.importProbe, fixtureRoot, redactions)
    runDeclarationProbe(probes.declarationConfiguration, fixtureRoot, redactions)
    const upgradeApi = runApiProbe(probes.apiProbe, 'upgrade', fixtureRoot, redactions)
    assertLimitReport(upgradeApi.limits, candidateResultLimitMaximums, 'The candidate API phase')
    const upgradeCli = runCandidateCliSurface(fixtureRoot, candidateImport.version, redactions)
    const upgradeIndependentBudgets = runBudgetProbe(probes.budgetProbe, fixtureRoot, 'candidate', redactions)
    assertStablePublicSurface(initial.surface, upgradeApi.surface, 'The candidate API')
    assertCandidateCliSurface(oracleCliSurface, upgradeCli.surface)
    assertCandidateIndependentBudgets(upgradeIndependentBudgets)
    assertDurableSnapshotsEqual(durable, captureDurableSnapshot(fixtureRoot))
    if (upgradeApi.schemaBefore !== '1' || upgradeApi.schemaAfter !== '2') {
      throw new Error('The candidate package did not rebuild cache schema 1 as schema 2.')
    }

    installPackage(fixtureRoot, oracle.path, 'The verified published oracle reinstallation', redactions)
    const downgradeImport = runImportProbe(probes.importProbe, fixtureRoot, redactions)
    const downgradeApi = runApiProbe(probes.apiProbe, 'downgrade', fixtureRoot, redactions)
    assertLimitReport(downgradeApi.limits, oracleResultLimitMaximums, 'The downgraded oracle API phase')
    const downgradeCli = runDowngradeCliSurface(fixtureRoot, downgradeImport.version, redactions)
    const downgradeIndependentBudgets = runBudgetProbe(probes.budgetProbe, fixtureRoot, 'oracle', redactions)
    assertStablePublicSurface(initial.surface, downgradeApi.surface, 'The downgraded oracle API')
    assertStablePublicSurface(oracleCliSurface, downgradeCli.surface, 'The downgraded oracle CLI')
    assertStablePublicSurface(
      oracleIndependentBudgets,
      downgradeIndependentBudgets,
      'The downgraded oracle independent budget evidence',
    )
    assertDurableSnapshotsEqual(durable, captureDurableSnapshot(fixtureRoot))
    if (downgradeApi.schemaBefore !== '2' || downgradeApi.schemaAfter !== '1') {
      throw new Error('The published oracle did not rebuild cache schema 2 as schema 1 after downgrade.')
    }
    if (initialImport.version !== initial.version || downgradeImport.version !== initial.version) {
      throw new Error('The published oracle process did not execute the installed oracle package version.')
    }

    return Object.freeze({
      candidate: Object.freeze({ digests: candidate.digests, version: candidateImport.version }),
      downgrade: Object.freeze({
        durableState: 'identical',
        independentBudgets: downgradeIndependentBudgets,
        publicSurface: publicSurfaceDigests(downgradeApi.surface, downgradeCli.surface),
        resultLimits: Object.freeze({ api: downgradeApi.limits, cli: downgradeCli.limits }),
        schemas: Object.freeze({
          after: downgradeApi.schemaAfter,
          before: downgradeApi.schemaBefore,
        }),
      }),
      oracle: Object.freeze({
        digests: oracle.digests,
        independentBudgets: oracleIndependentBudgets,
        publicSurface: oraclePublicSurface,
        resultLimits: Object.freeze({ api: initial.limits, cli: oracleCliLimits }),
        specifier: oracle.identity.specifier,
        version: initial.version,
      }),
      status: 'ok',
      upgrade: Object.freeze({
        durableState: 'identical',
        independentBudgets: upgradeIndependentBudgets,
        publicSurface: publicSurfaceDigests(upgradeApi.surface, upgradeCli.surface),
        resultLimits: Object.freeze({ api: upgradeApi.limits, cli: upgradeCli.limits }),
        schemas: Object.freeze({ after: upgradeApi.schemaAfter, before: upgradeApi.schemaBefore }),
      }),
    })
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}
