import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { captureIsolatedRoot, disposeIsolatedRoot } from './isolated-root.ts'
import { npmCommand } from './npm-command.ts'
import {
  type PackageTarballDigests,
  packageTarballDigests,
  readPackageTarEntries,
  snapshotPackageTarball,
} from './package-tarball.ts'
import {
  assertDurableSnapshotsEqual,
  assertDurableSnapshotsEqualExcept,
  captureDurableSnapshot,
  captureImportSnapshot,
  type DurableSnapshot,
} from './release-compatibility-filesystem.ts'
import {
  API_PROBE_SOURCE,
  BUDGET_PROBE_SOURCE,
  DECLARATION_CONSUMER_SOURCE,
  IMPORT_PROBE_SOURCE,
} from './release-compatibility-probes.ts'
import { normalisePublicValue, RESULT_LIMIT_CASES, RESULT_LIMIT_OPERATIONS } from './release-contracts.ts'

export {
  assertDurableSnapshotsEqual,
  captureDurableSnapshot,
  DurableSnapshotMismatch,
} from './release-compatibility-filesystem.ts'

export const ORACLE = Object.freeze({
  integrity: 'sha512-dgGi7fL43v9KQJ7Rb42fRAT+Z+h6WIOKhbPz9JzNBtnpqSyf4HyN6zBmIy6ftkTazZO6SyGU4MUi1FTVJyBvEw==',
  shasum: '1db80715ac2028cb8f12ae029577aed3428d52ef',
  specifier: 'encephalon@0.2.0',
})

export const MAX_COMPATIBILITY_DIAGNOSTIC_BYTES = 8192
const MAX_COMPATIBILITY_SUBPROCESS_OUTPUT_BYTES = 16 * 1024 * 1024
const compatibilityScriptsDirectory = dirname(fileURLToPath(import.meta.url))
const boundedProcessSupervisor = resolve(compatibilityScriptsDirectory, 'bounded-process-supervisor.mjs')
const projectRoot = resolve(compatibilityScriptsDirectory, '..')

const compatibilityEnvironmentKeys = new Set(
  [
    'APPDATA',
    'CI',
    'COMSPEC',
    'FORCE_COLOR',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'NO_COLOR',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'TZ',
    'USERPROFILE',
    'WINDIR',
    'npm_config_cache',
  ].map(key => key.toLowerCase()),
)

export const sanitizedCompatibilityEnvironment = (environment: NodeJS.ProcessEnv = process.env) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && compatibilityEnvironmentKeys.has(entry[0].toLowerCase()),
    ),
  )

export type OracleIdentity = Readonly<{
  integrity: string
  shasum: string
  specifier: string
}>

type CompatibilityCommandOptions = Readonly<{
  cwd: string
  environment?: NodeJS.ProcessEnv
  label: string
  redactions?: readonly Buffer[]
  timeoutMilliseconds?: number
  windowsVerbatimArguments?: boolean
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

const redactDiagnostic = (value: string, redactions: readonly Buffer[]) =>
  redactions.reduce((diagnostic, bytes) => {
    const secret = bytes.toString('utf8')
    return secret.length === 0 ? diagnostic : diagnostic.replaceAll(secret, '[redacted]')
  }, value)

const boundDiagnostic = (value: string) => {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= MAX_COMPATIBILITY_DIAGNOSTIC_BYTES) {
    return value
  }
  let bounded = ''
  let encodedBytes = 0
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8')
    if (encodedBytes + codePointBytes <= MAX_COMPATIBILITY_DIAGNOSTIC_BYTES) {
      bounded += codePoint
      encodedBytes += codePointBytes
    } else {
      break
    }
  }
  return bounded
}

export const runCompatibilityCommand = (
  executable: string,
  arguments_: readonly string[],
  options: CompatibilityCommandOptions,
): CompatibilityCommandResult => {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 120_000
  const request = Buffer.from(
    JSON.stringify({
      arguments: arguments_,
      cwd: options.cwd,
      environment: sanitizedCompatibilityEnvironment(options.environment ?? process.env),
      executable,
      maximumOutputBytes: MAX_COMPATIBILITY_SUBPROCESS_OUTPUT_BYTES,
      timeoutMilliseconds,
      windowsVerbatimArguments: options.windowsVerbatimArguments === true,
    }),
  ).toString('base64url')
  const supervised = spawnSync(process.execPath, [boundedProcessSupervisor, request], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: sanitizedCompatibilityEnvironment(),
    killSignal: 'SIGKILL',
    maxBuffer: MAX_COMPATIBILITY_SUBPROCESS_OUTPUT_BYTES * 3,
    shell: false,
    timeout: timeoutMilliseconds + 10_000,
  })
  type SupervisedResult = Readonly<{
    error?: Readonly<{ code?: string; message?: string }>
    overflow: boolean
    signal: NodeJS.Signals | null
    status: number | null
    stderr: string
    stdout: string
    timedOut: boolean
  }>
  let result: SupervisedResult | undefined
  if (supervised.error === undefined && supervised.status === 0 && supervised.stderr === '') {
    try {
      result = JSON.parse(supervised.stdout) as SupervisedResult
    } catch {}
  }
  if (
    result !== undefined &&
    result.error === undefined &&
    !result.overflow &&
    !result.timedOut &&
    result.status === 0
  ) {
    return Object.freeze({
      stderr: Buffer.from(result.stderr, 'base64').toString('utf8'),
      stdout: Buffer.from(result.stdout, 'base64').toString('utf8'),
    })
  }
  const redactions = options.redactions ?? []
  const stdout = boundDiagnostic(
    redactDiagnostic(
      result === undefined ? (supervised.stdout ?? '') : Buffer.from(result.stdout, 'base64').toString('utf8'),
      redactions,
    ),
  )
  const stderr = boundDiagnostic(
    redactDiagnostic(
      result === undefined ? (supervised.stderr ?? '') : Buffer.from(result.stderr, 'base64').toString('utf8'),
      redactions,
    ),
  )
  throw new CompatibilityCommandError(
    options.label,
    {
      exitCode: result?.status ?? supervised.status ?? 1,
      signal: result?.signal ?? supervised.signal,
      stderr,
      stdout,
    },
    supervised.error === undefined && result?.error === undefined
      ? undefined
      : { cause: supervised.error ?? result?.error },
  )
}

export const verifyOracleTarball = (path: string, identity: OracleIdentity = ORACLE): PackageTarballDigests => {
  const digests = packageTarballDigests(path)
  if (digests.sha1 === identity.shasum && digests.integrity === identity.integrity) {
    return digests
  }
  throw new Error('The published compatibility oracle does not match its pinned SHA-1 and SHA-512 identities.')
}

const candidateResultLimitMaximums = Object.freeze({ compact: 1000, full: 1000 })
const oracleResultLimitMaximums = Object.freeze({ compact: 100, full: 50 })

type SuppliedOracle = Readonly<{
  identity: OracleIdentity
  tarball: string
}>

export type ReleaseCompatibilityOptions = Readonly<{
  candidateTarball: string
  fixtureRoot?: string
  hooks?: Readonly<{ beforeOracleDowngrade?: (oracleSnapshot: string) => void }>
  oracle?: SuppliedOracle
}>

type ResultLimitOutcome = Readonly<{
  accepted: readonly number[]
  rejected: readonly number[]
}>

type ResultLimitReport = Readonly<Record<(typeof RESULT_LIMIT_OPERATIONS)[number]['name'], ResultLimitOutcome>>

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

const resultLimitOutcome = (maximum: number): ResultLimitOutcome =>
  Object.freeze({
    accepted: Object.freeze(RESULT_LIMIT_CASES.filter(limit => limit <= maximum)),
    rejected: Object.freeze(RESULT_LIMIT_CASES.filter(limit => limit > maximum)),
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
  requestedEnvironment: NodeJS.ProcessEnv = sanitizedCompatibilityEnvironment(),
) => {
  const environment = sanitizedCompatibilityEnvironment(requestedEnvironment)
  const command = npmCommand(arguments_, { environment })
  return runCompatibilityCommand(command.executable, command.arguments, {
    cwd,
    environment: command.environment ?? environment,
    label,
    redactions,
    timeoutMilliseconds: 120_000,
    ...(command.windowsVerbatimArguments === undefined
      ? {}
      : { windowsVerbatimArguments: command.windowsVerbatimArguments }),
  })
}

const parseJson = <Value>(value: string, label: string): Value => {
  try {
    return JSON.parse(value) as Value
  } catch (error) {
    throw new Error(`${label} did not return one JSON value.`, { cause: error })
  }
}

const runFixturePhase = <Value>(fixtureRoot: string, action: () => Value, allowedPrefixes: readonly string[] = []) => {
  const before = captureImportSnapshot(fixtureRoot)
  try {
    return action()
  } finally {
    const after = captureImportSnapshot(fixtureRoot)
    const cachePrefixes = ['node_modules/.cache']
    const allowed = [...cachePrefixes, ...allowedPrefixes]
    assertDurableSnapshotsEqualExcept(
      before,
      after,
      change =>
        (change.path === 'node_modules' && change.kind === 'links') ||
        (allowedPrefixes.length > 0 &&
          change.kind === 'links' &&
          (change.path === '.' || change.path === '@witness:.')) ||
        allowed.some(prefix => change.path === prefix || change.path.startsWith(`${prefix}/`)),
    )
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

const acquireOracle = (
  downloadDirectory: string,
  snapshotDirectory: string,
  environment: NodeJS.ProcessEnv,
  supplied?: SuppliedOracle,
) => {
  const identity = supplied === undefined ? ORACLE : supplied.identity
  const sourcePath = (() => {
    if (supplied !== undefined) {
      return supplied.tarball
    }
    const packed = safeNpmResult(
      ['pack', ORACLE.specifier, '--ignore-scripts', '--json', '--pack-destination', downloadDirectory],
      projectRoot,
      'The published compatibility oracle download',
      [],
      environment,
    )
    return safeDownloadedTarball(downloadDirectory, packed.stdout)
  })()
  const snapshot = snapshotPackageTarball(sourcePath, snapshotDirectory)
  const digests = verifyOracleTarball(snapshot.path, identity)
  const witness = captureImportSnapshot(snapshotDirectory)
  return { digests, identity, path: snapshot.path, witness }
}

const acquireCandidate = (snapshotDirectory: string, sourcePath: string) => {
  const snapshot = snapshotPackageTarball(sourcePath, snapshotDirectory)
  const manifestEntry = readPackageTarEntries(snapshot.path).find(entry => entry.path === 'package/package.json')
  const manifest =
    manifestEntry === undefined
      ? undefined
      : (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestEntry.content)) as { version?: unknown })
  const sourceManifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as { version?: unknown }
  if (
    typeof manifest?.version === 'string' &&
    typeof sourceManifest.version === 'string' &&
    manifest.version === sourceManifest.version
  ) {
    return Object.freeze({
      ...snapshot,
      version: manifest.version,
      witness: captureImportSnapshot(snapshotDirectory),
    })
  }
  throw new Error('The candidate package version does not equal the reviewed source release version.')
}

const initialiseFixtureRepository = (fixtureRoot: string) => {
  const metadata = lstatSync(fixtureRoot, { throwIfNoEntry: false })
  const isEmpty = (() => {
    if (metadata?.isDirectory() && !metadata.isSymbolicLink()) {
      const directory = opendirSync(fixtureRoot)
      try {
        return directory.readSync() === null
      } finally {
        directory.closeSync()
      }
    }
    return false
  })()
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink() || !isEmpty) {
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

type VerifiedPackageArtifact = Readonly<{
  digests: PackageTarballDigests
  path: string
  witness: DurableSnapshot
}>

const assertPackageArtifact = (artifact: VerifiedPackageArtifact) => {
  assertDurableSnapshotsEqual(artifact.witness, captureImportSnapshot(dirname(artifact.path)))
  if (!isDeepStrictEqual(artifact.digests, packageTarballDigests(artifact.path))) {
    throw new Error('A verified compatibility package artifact changed between phases.')
  }
}

const installedPackageWitnesses = new Map<string, DurableSnapshot>()

export const installedPackageEntryMatches = (
  expected: Readonly<{ content: Buffer; mode: number; path: string }>,
  actual: Readonly<{ bytes?: Buffer; canonicalPath: string; mode: number }> | undefined,
  installedPackageCanonicalPath: string,
  platform: NodeJS.Platform = process.platform,
) =>
  actual?.bytes !== undefined &&
  (platform === 'win32' || actual.mode === expected.mode) &&
  actual.bytes.equals(expected.content) &&
  actual.canonicalPath === resolve(installedPackageCanonicalPath, expected.path)

const assertInstalledTreeMatchesArtifact = (
  artifact: VerifiedPackageArtifact,
  installedPackage: string,
  snapshot: DurableSnapshot,
) => {
  const expectedFiles = readPackageTarEntries(artifact.path).map(entry =>
    Object.freeze({ ...entry, path: entry.path.replace(/^package\//u, '') }),
  )
  const actualFiles = snapshot.filter(entry => entry.type === 'file')
  const actualByPath = new Map(actualFiles.map(entry => [entry.path, entry]))
  const installedPackageCanonicalPath = realpathSync.native(installedPackage)
  const differs =
    actualFiles.length !== expectedFiles.length ||
    expectedFiles.some(expected => {
      const actual = actualByPath.get(expected.path)
      return !installedPackageEntryMatches(expected, actual, installedPackageCanonicalPath)
    })
  if (differs) {
    throw new Error('The fresh installed compatibility package tree differs from its verified tarball.')
  }
}

const assertInstalledPackage = (fixtureRoot: string) => {
  const witness = installedPackageWitnesses.get(fixtureRoot)
  if (witness !== undefined) {
    assertDurableSnapshotsEqualExcept(
      witness,
      captureImportSnapshot(resolve(fixtureRoot, 'node_modules', 'encephalon')),
      change => change.kind === 'links' && change.path === '@witness:..',
    )
    return witness
  }
  throw new Error('The installed compatibility package has no immutable witness.')
}

const installPackage = (
  fixtureRoot: string,
  artifact: VerifiedPackageArtifact,
  installRoot: string,
  sequence: number,
  label: string,
  redactions: readonly Buffer[] = [],
  environment: NodeJS.ProcessEnv = sanitizedCompatibilityEnvironment(),
) => {
  assertPackageArtifact(artifact)
  writeFileSync(
    resolve(installRoot, 'package.json'),
    '{"name":"encephalon-release-install-stage","private":true,"type":"module"}\n',
  )
  safeNpmResult(
    ['install', artifact.path, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--package-lock=false'],
    installRoot,
    label,
    redactions,
    environment,
  )
  assertPackageArtifact(artifact)
  const stagedPackage = resolve(installRoot, 'node_modules', 'encephalon')
  const stagedWitness = captureImportSnapshot(stagedPackage)
  const fixtureModules = resolve(fixtureRoot, 'node_modules')
  const fixtureModulesEntry = lstatSync(fixtureModules, { throwIfNoEntry: false })
  if (fixtureModulesEntry === undefined) {
    mkdirSync(fixtureModules, { mode: 0o700 })
  } else if (!fixtureModulesEntry.isDirectory() || fixtureModulesEntry.isSymbolicLink()) {
    throw new Error('The compatibility fixture node_modules path is not one ordinary directory.')
  }
  const installedPackage = resolve(fixtureModules, 'encephalon')
  const existingPackage = lstatSync(installedPackage, { throwIfNoEntry: false })
  if (existingPackage !== undefined) {
    assertInstalledPackage(fixtureRoot)
    const retiredPackage = resolve(fixtureModules, `.encephalon-retired-${sequence}`)
    if (lstatSync(retiredPackage, { throwIfNoEntry: false }) !== undefined) {
      throw new Error('A fixed retired compatibility package path already exists.')
    }
    renameSync(installedPackage, retiredPackage)
  }
  assertDurableSnapshotsEqual(stagedWitness, captureImportSnapshot(stagedPackage))
  const stagedRootEntry = lstatSync(stagedPackage, { bigint: true })
  renameSync(stagedPackage, installedPackage)
  const installedRootEntry = lstatSync(installedPackage, { bigint: true })
  if (stagedRootEntry.dev !== installedRootEntry.dev || stagedRootEntry.ino !== installedRootEntry.ino) {
    throw new Error('The fresh installed compatibility package identity changed during atomic placement.')
  }
  const installedWitness = captureImportSnapshot(installedPackage)
  assertInstalledTreeMatchesArtifact(artifact, installedPackage, installedWitness)
  installedPackageWitnesses.set(fixtureRoot, installedWitness)
}

type TrustedProbeWitness = Readonly<{
  directory: string
  identities: readonly Readonly<{
    birthtimeNanoseconds: bigint
    canonicalPath: string
    changeTimeNanoseconds: bigint
    device: bigint
    inode: bigint
    links: bigint
    mode: bigint
    modificationTimeNanoseconds: bigint
    path: string
    size: bigint
  }>[]
  snapshot: DurableSnapshot
}>

const trustedProbeWitnesses = new Map<string, TrustedProbeWitness>()

const trustedProbeIdentities = (directory: string, snapshot: DurableSnapshot) =>
  Object.freeze(
    snapshot.map(entry => {
      const path = entry.path === '.' ? directory : resolve(directory, entry.path)
      const metadata = lstatSync(path, { bigint: true })
      return Object.freeze({
        birthtimeNanoseconds: metadata.birthtimeNs,
        canonicalPath: realpathSync.native(path),
        changeTimeNanoseconds: metadata.ctimeNs,
        device: metadata.dev,
        inode: metadata.ino,
        links: metadata.nlink,
        mode: metadata.mode,
        modificationTimeNanoseconds: metadata.mtimeNs,
        path: entry.path,
        size: metadata.size,
      })
    }),
  )

const captureTrustedProbeWitness = (directory: string): TrustedProbeWitness => {
  const snapshot = captureImportSnapshot(directory)
  const identities = trustedProbeIdentities(directory, snapshot)
  assertDurableSnapshotsEqual(snapshot, captureImportSnapshot(directory))
  return Object.freeze({ directory, identities, snapshot })
}

const writeProbeFiles = (probeDirectory: string, fixtureRoot: string) => {
  const probeEntry = lstatSync(probeDirectory, { throwIfNoEntry: false })
  if (probeEntry === undefined) {
    mkdirSync(probeDirectory, { mode: 0o700 })
  } else if (!probeEntry.isDirectory() || probeEntry.isSymbolicLink()) {
    throw new Error('The trusted compatibility probe root must be one ordinary directory.')
  }
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
          paths: {
            encephalon: [resolve(fixtureRoot, 'node_modules', 'encephalon', 'dist', 'index.d.ts')],
          },
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
  const witness = captureTrustedProbeWitness(probeDirectory)
  for (const path of [apiProbe, budgetProbe, importProbe, declarationConsumer, declarationConfiguration]) {
    trustedProbeWitnesses.set(path, witness)
  }
  return { apiProbe, budgetProbe, declarationConfiguration, importProbe }
}

const assertTrustedProbe = (path: string) => {
  const witness = trustedProbeWitnesses.get(path)
  if (witness !== undefined) {
    const actualSnapshot = captureImportSnapshot(witness.directory)
    const actualIdentities = trustedProbeIdentities(witness.directory, actualSnapshot)
    assertDurableSnapshotsEqual(witness.snapshot, actualSnapshot)
    if (isDeepStrictEqual(witness.identities, actualIdentities)) {
      return witness
    }
    throw new Error('The trusted compatibility probe identity changed between invocations.')
  }
  throw new Error('The compatibility probe has no trusted immutable witness.')
}

const runTrustedProbe = (probe: string, arguments_: readonly string[], options: CompatibilityCommandOptions) => {
  assertTrustedProbe(probe)
  assertInstalledPackage(options.cwd)
  try {
    return runCompatibilityCommand(process.execPath, [probe, ...arguments_], options)
  } finally {
    assertInstalledPackage(options.cwd)
    assertTrustedProbe(probe)
  }
}

const installedPackageEntry = (fixtureRoot: string) =>
  pathToFileURL(resolve(fixtureRoot, 'node_modules', 'encephalon', 'dist', 'index.mjs')).href

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
  const allowed = phase === 'initialise' ? ['AGENTS.md', 'CLAUDE.md', 'encephalon'] : []
  const result = runFixturePhase(
    fixtureRoot,
    () =>
      runTrustedProbe(probe, [phase, fixtureRoot, installedPackageEntry(fixtureRoot)], {
        cwd: fixtureRoot,
        label: `The ${phase} API compatibility probe`,
        redactions,
      }),
    allowed,
  )
  if (result.stderr !== '') {
    throw new Error(`The ${phase} API compatibility probe wrote unexpected stderr.`)
  }
  return parseJson<ApiProbeResult>(result.stdout, `The ${phase} API compatibility probe`)
}

const runImportProbe = (probe: string, fixtureRoot: string, redactions: readonly Buffer[]) => {
  const before = captureImportSnapshot(fixtureRoot)
  const result = runTrustedProbe(probe, [fixtureRoot, installedPackageEntry(fixtureRoot)], {
    cwd: fixtureRoot,
    label: 'The side-effect-free API import probe',
    redactions,
  })
  const after = captureImportSnapshot(fixtureRoot)
  assertDurableSnapshotsEqual(before, after)
  if (result.stderr !== '') {
    throw new Error('The side-effect-free API import probe wrote unexpected stderr.')
  }
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
  const result = runFixturePhase(fixtureRoot, () =>
    runTrustedProbe(probe, [fixtureRoot, packagePhase, installedPackageEntry(fixtureRoot)], {
      cwd: fixtureRoot,
      label: 'The independent public budget probe',
      redactions,
    }),
  )
  if (result.stderr !== '') {
    throw new Error('The independent public budget probe wrote unexpected stderr.')
  }
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
  assertTrustedProbe(configuration)
  assertInstalledPackage(fixtureRoot)
  try {
    const result = runFixturePhase(fixtureRoot, () =>
      runCompatibilityCommand(process.execPath, [compiler, '--project', configuration], {
        cwd: fixtureRoot,
        label: 'The consumer declaration compatibility probe',
        redactions,
      }),
    )
    if (result.stderr !== '') {
      throw new Error('The consumer declaration compatibility probe wrote unexpected stderr.')
    }
  } finally {
    assertInstalledPackage(fixtureRoot)
    assertTrustedProbe(configuration)
  }
}

const installedCli = (fixtureRoot: string) => resolve(fixtureRoot, 'node_modules', 'encephalon', 'dist', 'cli.mjs')

const cliSuccess = (fixtureRoot: string, arguments_: readonly string[], redactions: readonly Buffer[]) => {
  assertInstalledPackage(fixtureRoot)
  try {
    const result = runCompatibilityCommand(process.execPath, [installedCli(fixtureRoot), ...arguments_], {
      cwd: fixtureRoot,
      label: `The ${arguments_[0] ?? 'unknown'} CLI compatibility probe`,
      redactions,
    })
    if (result.stderr === '') {
      return result.stdout
    }
    throw new Error(`The ${arguments_[0] ?? 'unknown'} CLI compatibility probe wrote unexpected stderr.`)
  } finally {
    assertInstalledPackage(fixtureRoot)
  }
}

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

const cliLimitArguments = (
  operation: (typeof RESULT_LIMIT_OPERATIONS)[number]['name'],
  fixtureRoot: string,
  limit: number,
) => {
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
  const cases = RESULT_LIMIT_OPERATIONS.flatMap(operation => RESULT_LIMIT_CASES.map(limit => ({ limit, operation })))
  const executed = cases.reduce((count, { limit, operation }) => {
    const maximum = maximums[operation.kind]
    if (limit <= maximum) {
      assertCliJson(fixtureRoot, cliLimitArguments(operation.name, fixtureRoot, limit), redactions)
      return count + 1
    }
    const failure = cliFailure(fixtureRoot, cliLimitArguments(operation.name, fixtureRoot, limit), redactions)
    const body = parseJson<{ error?: { code?: unknown; details?: Record<string, unknown> } }>(
      failure.stderr,
      'The rejected CLI result-limit probe',
    )
    const hasExpectedEnvelope =
      failure.exitCode === 2 && failure.stdout === '' && body.error?.code === 'INVALID_ARGUMENT'
    const isOracleParserRejection = maximums.full === 50 && maximums.compact === 100 && limit === 1001
    const hasExpectedDetails = isOracleParserRejection
      ? true
      : body.error?.details?.budget === operation.budget &&
        body.error.details.field === 'limit' &&
        body.error.details.maximum === maximum
    if (!(hasExpectedEnvelope && hasExpectedDetails)) {
      throw new Error(`The rejected ${operation.name} CLI result-limit contract did not match the published oracle.`)
    }
    return count + 1
  }, 0)
  if (executed !== cases.length) {
    throw new Error('The CLI result-limit matrix did not execute every case.')
  }
  return resultLimitReport(maximums)
}

const runCandidateCliSurface = (fixtureRoot: string, version: string, redactions: readonly Buffer[]) =>
  runFixturePhase(fixtureRoot, () => {
    const surface = captureCliSurface(fixtureRoot, version, redactions)
    const limits = assertCliResultLimits(fixtureRoot, candidateResultLimitMaximums, redactions)
    return { limits, surface }
  })

const runDowngradeCliSurface = (fixtureRoot: string, version: string, redactions: readonly Buffer[]) =>
  runFixturePhase(fixtureRoot, () => {
    const surface = captureCliSurface(fixtureRoot, version, redactions)
    const limits = assertCliResultLimits(fixtureRoot, oracleResultLimitMaximums, redactions)
    return { limits, surface }
  })

const assertLimitReport = (actual: ResultLimitReport, maximums: ResultLimitMaximums, label: string) => {
  const expected = resultLimitReport(maximums)
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} did not exercise the complete published result-limit table.`)
  }
}

const durableRedactions = (snapshot: DurableSnapshot) =>
  snapshot.flatMap(entry => (entry.bytes === undefined ? [] : [entry.bytes]))

export const runReleaseCompatibility = (options: ReleaseCompatibilityOptions): ReleaseCompatibilityReport => {
  const trustedRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-trusted-'))
  const trustedDirectories = Object.freeze({
    candidate: resolve(trustedRoot, 'candidate'),
    installCandidate: resolve(trustedRoot, 'install-candidate'),
    installDowngrade: resolve(trustedRoot, 'install-downgrade'),
    installOracle: resolve(trustedRoot, 'install-oracle'),
    npmCache: resolve(trustedRoot, 'npm-cache'),
    oracleDownload: resolve(trustedRoot, 'oracle-download'),
    oracleSnapshot: resolve(trustedRoot, 'oracle-snapshot'),
    probes: resolve(trustedRoot, 'probes'),
  })
  for (const path of Object.values(trustedDirectories)) {
    mkdirSync(path, { mode: 0o700 })
  }
  const trustedRootWitness = captureIsolatedRoot(trustedRoot)
  const fixtureRoot = options.fixtureRoot ?? mkdtempSync(resolve(tmpdir(), 'encephalon-release-fixture-'))
  const fixtureWitness = options.fixtureRoot === undefined ? captureIsolatedRoot(fixtureRoot) : undefined
  const environment = Object.freeze({
    ...sanitizedCompatibilityEnvironment(),
    npm_config_cache: trustedDirectories.npmCache,
  })
  try {
    const candidate = acquireCandidate(trustedDirectories.candidate, options.candidateTarball)
    const oracle = acquireOracle(
      trustedDirectories.oracleDownload,
      trustedDirectories.oracleSnapshot,
      environment,
      options.oracle,
    )
    initialiseFixtureRepository(fixtureRoot)
    const probes = writeProbeFiles(trustedDirectories.probes, fixtureRoot)
    const predecessorRedactions = [
      Buffer.from('oracle agents predecessor\n'),
      Buffer.from('oracle claude predecessor\n'),
    ]

    installPackage(
      fixtureRoot,
      oracle,
      trustedDirectories.installOracle,
      1,
      'The verified published oracle installation',
      predecessorRedactions,
      environment,
    )
    const initialImport = runImportProbe(probes.importProbe, fixtureRoot, predecessorRedactions)
    runDeclarationProbe(probes.declarationConfiguration, fixtureRoot, predecessorRedactions)
    const initial = runApiProbe(probes.apiProbe, 'initialise', fixtureRoot, predecessorRedactions)
    assertLimitReport(initial.limits, oracleResultLimitMaximums, 'The published oracle API phase')
    if (initial.schemaAfter !== '1') {
      throw new Error('The published compatibility oracle did not prepare cache schema 1.')
    }
    const initialCli = runFixturePhase(fixtureRoot, () => ({
      limits: assertCliResultLimits(fixtureRoot, oracleResultLimitMaximums, predecessorRedactions),
      surface: captureCliSurface(fixtureRoot, initial.version, predecessorRedactions),
    }))
    const oracleCliSurface = initialCli.surface
    const oracleCliLimits = initialCli.limits
    const oracleIndependentBudgets = runBudgetProbe(probes.budgetProbe, fixtureRoot, 'oracle', predecessorRedactions)
    const oraclePublicSurface = publicSurfaceDigests(initial.surface, oracleCliSurface)
    const durable = captureDurableSnapshot(fixtureRoot)
    const redactions = durableRedactions(durable)

    installPackage(
      fixtureRoot,
      candidate,
      trustedDirectories.installCandidate,
      2,
      'The exact candidate package installation',
      redactions,
      environment,
    )
    const candidateImport = runImportProbe(probes.importProbe, fixtureRoot, redactions)
    if (candidateImport.version !== candidate.version) {
      throw new Error('The installed candidate process version does not match the reviewed candidate manifest.')
    }
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

    options.hooks?.beforeOracleDowngrade?.(oracle.path)
    installPackage(
      fixtureRoot,
      oracle,
      trustedDirectories.installDowngrade,
      3,
      'The verified published oracle reinstallation',
      redactions,
      environment,
    )
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
    installedPackageWitnesses.delete(fixtureRoot)
    if (fixtureWitness !== undefined) {
      disposeIsolatedRoot(fixtureWitness)
    }
    disposeIsolatedRoot(trustedRootWitness)
  }
}
