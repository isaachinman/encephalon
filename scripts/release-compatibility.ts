import { spawnSync } from 'node:child_process'
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
  const mode = metadata.mode & 0o777
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
    env: options.environment ?? { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    maxBuffer: 16 * 1024 * 1024,
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
    specifier: string
    version: string
  }>
  status: 'ok'
  upgrade: PhaseReport
}>

const API_PROBE_SOURCE = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  return { limits: at('initialise-result-limits', resultLimits), schemaAfter: cacheSchema() }
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
  return { limits: resultLimits(), schemaAfter, schemaBefore }
}
const downgrade = () => {
  const schemaBefore = cacheSchema()
  readCompatibilityState()
  const prepared = api.prepare({ root })
  assert(typeof prepared?.recordsIndexed === 'number', 'api-downgrade-prepare')
  return { limits: resultLimits(), schemaAfter: cacheSchema(), schemaBefore }
}

try {
  const result = phase === 'initialise' ? initialise() : phase === 'upgrade' ? upgrade() : phase === 'downgrade' ? downgrade() : fail('unknown-phase')
  if ('packageWitness' in api) assert(api.packageWitness === manifest.version, 'fresh-package-process')
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
    return [{ mode: metadata.mode & 0o777, path: relativePath, type: 'directory' }, ...readdirSync(path).sort().flatMap(name => inspect(relativePath + '/' + name))]
  }
  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    return [{ digest: createHash('sha256').update(readFileSync(path)).digest('hex'), mode: metadata.mode & 0o777, path: relativePath, type: 'file' }]
  }
  return [{ path: relativePath, type: 'unsafe' }]
}
const before = selected.flatMap(inspect)
const api = await import('encephalon')
const after = selected.flatMap(inspect)
const required = ['EncephalonError', 'addRecord', 'gatherRecords', 'hydrate', 'initEncephalon', 'listRecords', 'prepare', 'searchCompactRecords', 'searchRecords', 'showRecord', 'validateRecords']
const manifest = JSON.parse(readFileSync(resolve(root, 'node_modules', 'encephalon', 'package.json'), 'utf8'))
if (JSON.stringify(before) !== JSON.stringify(after) || required.some(name => typeof api[name] !== 'function') || ('packageWitness' in api && api.packageWitness !== manifest.version)) {
  process.stderr.write('{"stage":"import-contract"}\\n')
  process.exitCode = 1
} else {
  process.stdout.write(JSON.stringify({ exports: required, version: manifest.version }) + '\\n')
}
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
  const result = spawnNpmCommand(arguments_, { cwd })
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
  const importProbe = resolve(probeDirectory, 'import-probe.mjs')
  const declarationConsumer = resolve(probeDirectory, 'consumer.ts')
  const declarationConfiguration = resolve(probeDirectory, 'tsconfig.json')
  writeFileSync(apiProbe, API_PROBE_SOURCE)
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
  return { apiProbe, declarationConfiguration, importProbe }
}

type ApiProbeResult = {
  limits: ResultLimitReport
  schemaAfter: string
  schemaBefore?: string
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
  const help = cliSuccess(fixtureRoot, ['--help'], redactions)
  if (
    !['init', 'add', 'prepare', 'hydrate', 'validate', 'list', 'show', 'search', 'gather'].every(command =>
      help.includes(command),
    ) ||
    cliSuccess(fixtureRoot, ['--version'], redactions) !== `${version}\n`
  ) {
    throw new Error('The candidate CLI help/version surface does not match the published command set.')
  }
  assertCliJson(fixtureRoot, ['init', '--root', fixtureRoot], redactions)
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
  const duplicateBody = parseJson<{ error?: { code?: unknown } }>(duplicate.stderr, 'The duplicate add CLI probe')
  if (duplicate.exitCode !== 2 || duplicate.stdout !== '' || duplicateBody.error?.code !== 'RECORD_EXISTS') {
    throw new Error('The candidate add CLI error framing does not match the published contract.')
  }
  const commands = [
    ['prepare', '--root', fixtureRoot],
    ['hydrate', '--root', fixtureRoot],
    ['validate', '--root', fixtureRoot],
    ['list', '--root', fixtureRoot, '--include-superseded', '--limit=1000'],
    ['show', '--root', fixtureRoot, '--id', 'compatibility-base'],
    ['search', '--root', fixtureRoot, '--include-superseded', '--', 'compatibility-marker'],
    ['search', '--root', fixtureRoot, '--compact', '--include-superseded', '--', 'compatibility-marker'],
    ['gather', '--root', fixtureRoot, '--search', 'compatibility-marker', '--show', 'compatibility-base'],
  ]
  commands.reduce((count, arguments_) => {
    assertCliJson(fixtureRoot, arguments_, redactions)
    return count + 1
  }, 0)
  return assertCliResultLimits(fixtureRoot, candidateResultLimitMaximums, redactions)
}

const runDowngradeCliSurface = (fixtureRoot: string, redactions: readonly Buffer[]) => {
  const commands = [
    ['validate', '--root', fixtureRoot],
    ['list', '--root', fixtureRoot, '--include-superseded', '--limit=50'],
    ['show', '--root', fixtureRoot, '--id', 'compatibility-base'],
    ['search', '--root', fixtureRoot, '--include-superseded', '--', 'compatibility-marker'],
    ['search', '--root', fixtureRoot, '--compact', '--include-superseded', '--', 'compatibility-marker'],
    ['gather', '--root', fixtureRoot, '--search', 'compatibility-marker', '--show', 'compatibility-base'],
    ['prepare', '--root', fixtureRoot],
  ]
  commands.reduce((count, arguments_) => {
    assertCliJson(fixtureRoot, arguments_, redactions)
    return count + 1
  }, 0)
  return assertCliResultLimits(fixtureRoot, oracleResultLimitMaximums, redactions)
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
    const durable = captureDurableSnapshot(fixtureRoot)
    const redactions = durableRedactions(durable)

    installPackage(fixtureRoot, candidate.path, 'The exact candidate package installation', redactions)
    const candidateImport = runImportProbe(probes.importProbe, fixtureRoot, redactions)
    runDeclarationProbe(probes.declarationConfiguration, fixtureRoot, redactions)
    const upgradeApi = runApiProbe(probes.apiProbe, 'upgrade', fixtureRoot, redactions)
    assertLimitReport(upgradeApi.limits, candidateResultLimitMaximums, 'The candidate API phase')
    const upgradeCli = runCandidateCliSurface(fixtureRoot, candidateImport.version, redactions)
    assertDurableSnapshotsEqual(durable, captureDurableSnapshot(fixtureRoot))
    if (upgradeApi.schemaBefore !== '1' || upgradeApi.schemaAfter !== '2') {
      throw new Error('The candidate package did not rebuild cache schema 1 as schema 2.')
    }

    installPackage(fixtureRoot, oracle.path, 'The verified published oracle reinstallation', redactions)
    const downgradeImport = runImportProbe(probes.importProbe, fixtureRoot, redactions)
    const downgradeApi = runApiProbe(probes.apiProbe, 'downgrade', fixtureRoot, redactions)
    assertLimitReport(downgradeApi.limits, oracleResultLimitMaximums, 'The downgraded oracle API phase')
    const downgradeCli = runDowngradeCliSurface(fixtureRoot, redactions)
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
        resultLimits: Object.freeze({ api: downgradeApi.limits, cli: downgradeCli }),
        schemas: Object.freeze({
          after: downgradeApi.schemaAfter,
          before: downgradeApi.schemaBefore,
        }),
      }),
      oracle: Object.freeze({
        digests: oracle.digests,
        specifier: oracle.identity.specifier,
        version: initial.version,
      }),
      status: 'ok',
      upgrade: Object.freeze({
        durableState: 'identical',
        resultLimits: Object.freeze({ api: upgradeApi.limits, cli: upgradeCli }),
        schemas: Object.freeze({ after: upgradeApi.schemaAfter, before: upgradeApi.schemaBefore }),
      }),
    })
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}
