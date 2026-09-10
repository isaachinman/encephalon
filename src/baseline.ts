import { lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CanonicalDirectoryChangedError,
  captureCanonicalDirectory,
  collectBoundedDirectoryEntries,
  revalidateCanonicalDirectory,
} from './canonical-layout.ts'
import {
  captureDirectoryWitness,
  type DirectoryWitness,
  DirectoryWitnessError,
  revalidateDirectoryWitness,
} from './directory-witness.ts'
import { fail, isRecognizedFilesystemError } from './errors.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import { ordinalStringCompare } from './order.ts'
import type { AddRecordInput, JsonValue } from './types.ts'
import {
  decodeVerifiedUtf8,
  readObservedVerifiedRegularFile,
  revalidateObservedVerifiedRegularFile,
  VerifiedFileError,
  type VerifiedRegularFileEvidence,
  type VerifiedRegularFileObservation,
} from './verified-file.ts'

const MAX_TOP_LEVEL_ENTRIES = 512
const MAX_WORKFLOW_ENTRIES = 512
const MAX_PACKAGE_BYTES = 1024 * 1024
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.turbo',
  '.yarn',
  'bower_components',
  'build',
  'coverage',
  'deps',
  'dist',
  'encephalon',
  'generated',
  'node_modules',
  'out',
  'target',
  'vendor',
])
const RECOGNISED_FILES = new Set([
  'biome.json',
  'biome.jsonc',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'cargo.lock',
  'cargo.toml',
  'composer.json',
  'composer.lock',
  'deno.json',
  'deno.jsonc',
  'docker-compose.yml',
  'docker-compose.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'go.mod',
  'go.sum',
  'jsconfig.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'poetry.lock',
  'pyproject.toml',
  'requirements.txt',
  'tsconfig.json',
  'turbo.json',
  'vite.config.js',
  'vite.config.ts',
  'yarn.lock',
])
const PACKAGE_MANAGER_NAMES = ['bun', 'npm', 'pnpm', 'yarn']
const PACKAGE_MANAGERS = new Set(PACKAGE_MANAGER_NAMES)
const LOCKFILE_MANAGERS = [
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
] as const

type PackageFacts = {
  name?: string
  packageManager?: string
  workspacePatterns: string[]
  scriptKeys: string[]
}

type PackageManagerLockfile = {
  file: string
  manager: string
}

type PackageManagerEvidence =
  | {
      status: 'conflicted'
      candidates: string[]
      declared?: string
      lockfiles: PackageManagerLockfile[]
    }
  | {
      status: 'declared'
      declared: string
      manager: string
    }
  | {
      status: 'declared-and-lockfile'
      declared: string
      lockfiles: PackageManagerLockfile[]
      manager: string
    }
  | {
      status: 'lockfile-derived'
      lockfiles: PackageManagerLockfile[]
      manager: string
    }
  | {
      status: 'unknown'
    }

type BaselineScanHooks = {
  afterBaselineSources?: (() => void) | undefined
  afterOptionalDirectoryLstat?: ((path: string) => void) | undefined
  afterPackageMetadataLstat?: (() => void) | undefined
  afterWorkflowEnumeration?: (() => void) | undefined
  beforePackageMetadataRead?: (() => void) | undefined
  beforeTopLevelRevalidation?: (() => void) | undefined
  beforeWorkflowDirectoryCapture?: (() => void) | undefined
  now?: (() => number) | undefined
}

type BaselineReason =
  | 'package-metadata-error'
  | 'top-level-entry-limit'
  | 'unreadable-directory'
  | 'workflow-entry-limit'
  | 'workflow-enumeration-error'

type BaselineExpectedFailureClassification = 'directory-witness' | `filesystem:${string}` | 'verified-file'

class BaselineGenerationChanged extends Error {
  constructor() {
    super('The baseline source generation changed during observation.')
    this.name = 'BaselineGenerationChanged'
  }
}

class PackageMetadataValidationError extends Error {
  constructor() {
    super('Package metadata must contain a JSON object.')
    this.name = 'PackageMetadataValidationError'
  }
}

class BaselineHookError extends Error {}

const baselineGenerationChanged = (): never => {
  throw new BaselineGenerationChanged()
}

const isObservedSourceReplacement = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code
  return (
    error instanceof CanonicalDirectoryChangedError ||
    error instanceof DirectoryWitnessError ||
    code === 'ELOOP' ||
    code === 'ENOENT' ||
    code === 'ENOTDIR'
  )
}

const expectedFailureClassification = (error: unknown): BaselineExpectedFailureClassification | undefined => {
  if (error instanceof DirectoryWitnessError) {
    return 'directory-witness'
  }
  if (error instanceof VerifiedFileError) {
    return 'verified-file'
  }
  if (isRecognizedFilesystemError(error)) {
    return `filesystem:${(error as NodeJS.ErrnoException).code as string}`
  }
}

const invokeBaselineHook = (hook: (() => void) | undefined) => {
  if (hook !== undefined) {
    try {
      hook()
    } catch (error) {
      throw new BaselineHookError('An internal baseline hook failed.', { cause: error })
    }
  }
}

const invokeBaselinePathHook = (hook: ((path: string) => void) | undefined, path: string) => {
  if (hook !== undefined) {
    try {
      hook(path)
    } catch (error) {
      throw new BaselineHookError('An internal baseline hook failed.', { cause: error })
    }
  }
}

const rethrowBaselineHookError = (error: unknown) => {
  if (error instanceof BaselineHookError) {
    throw error.cause
  }
}

type BaselineExpectedFailureObservation = Readonly<{
  classification: BaselineExpectedFailureClassification
  probe: () => void
}>

class BaselineObservationAuthority {
  private readonly directories: DirectoryWitness[] = []
  private readonly expectedFailures: BaselineExpectedFailureObservation[] = []
  private packageObservation: VerifiedRegularFileEvidence | undefined

  readonly observeDirectory = (witness: DirectoryWitness) => {
    this.directories.push(witness)
  }

  readonly observePackage = (observation: VerifiedRegularFileObservation) => {
    this.packageObservation = Object.freeze({
      digest: observation.digest,
      metadata: observation.metadata,
      path: observation.path,
    })
  }

  readonly observeExpectedFailure = (error: unknown, probe: () => void) => {
    const classification = expectedFailureClassification(error)
    if (classification === undefined) {
      throw error
    }
    this.expectedFailures.push(Object.freeze({ classification, probe }))
  }

  readonly proveCurrent = () => {
    for (const witness of this.directories) {
      try {
        revalidateDirectoryWitness(witness)
      } catch (error) {
        if (isObservedSourceReplacement(error) || isRecognizedFilesystemError(error)) {
          baselineGenerationChanged()
        }
        throw error
      }
    }
    if (this.packageObservation !== undefined) {
      try {
        revalidateObservedVerifiedRegularFile(this.packageObservation)
      } catch (error) {
        if (
          error instanceof VerifiedFileError ||
          isObservedSourceReplacement(error) ||
          isRecognizedFilesystemError(error)
        ) {
          return baselineGenerationChanged()
        }
        throw error
      }
    }
    for (const observation of this.expectedFailures) {
      let failed = false
      let currentFailure: unknown
      try {
        observation.probe()
      } catch (error) {
        failed = true
        currentFailure = error
      }
      if (failed) {
        if (
          currentFailure instanceof BaselineGenerationChanged ||
          currentFailure instanceof CanonicalDirectoryChangedError
        ) {
          baselineGenerationChanged()
        }
        const currentClassification = expectedFailureClassification(currentFailure)
        if (currentClassification === undefined) {
          throw currentFailure
        }
        if (currentClassification !== observation.classification) {
          baselineGenerationChanged()
        }
      } else {
        baselineGenerationChanged()
      }
    }
  }
}

type SourceResult<Value> = {
  reasons: readonly BaselineReason[]
  value: Value
}

type PackageSource = {
  facts: PackageFacts
  manifestSource?: string
  source?: string
}

const hasControlCharacters = (value: string) =>
  [...value].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })

const safeName = (value: string) =>
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 1024 &&
  !hasControlCharacters(value) &&
  !/(?:^|[._-])(secret|credential|password|token|private)(?:$|[._-])/i.test(value)

const declaredPackageManager = (value: unknown) => {
  if (typeof value === 'string') {
    const manager = value.split('@')[0]?.toLowerCase()
    if (manager !== undefined && PACKAGE_MANAGERS.has(manager)) {
      return manager
    }
  }
}

const lockfileEvidence = (files: string[]): PackageManagerLockfile[] =>
  LOCKFILE_MANAGERS.filter(lockfile => files.includes(lockfile.file))

const packageManagerEvidence = (
  declared: string | undefined,
  lockfiles: PackageManagerLockfile[],
): PackageManagerEvidence => {
  const lockfileManagers = [...new Set(lockfiles.map(lockfile => lockfile.manager))]
  if (declared === undefined && lockfileManagers.length === 0) {
    return { status: 'unknown' }
  }
  if (declared !== undefined && lockfileManagers.length === 0) {
    return { declared, manager: declared, status: 'declared' }
  }
  if (declared === undefined && lockfileManagers.length === 1) {
    const [manager] = lockfileManagers
    if (manager !== undefined) {
      return { lockfiles, manager, status: 'lockfile-derived' }
    }
  }
  if (declared !== undefined && lockfileManagers.length === 1 && lockfileManagers[0] === declared) {
    return { declared, lockfiles, manager: declared, status: 'declared-and-lockfile' }
  }
  const evidencedManagers = new Set([...(declared === undefined ? [] : [declared]), ...lockfileManagers])
  return {
    ...(declared === undefined ? {} : { declared }),
    candidates: PACKAGE_MANAGER_NAMES.filter(manager => evidencedManagers.has(manager)),
    lockfiles,
    status: 'conflicted',
  }
}

const safeWorkspacePattern = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 1024 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.split('/').includes('..') &&
  !hasControlCharacters(value)

const emptyPackageFacts = (): PackageFacts => ({ scriptKeys: [], workspacePatterns: [] })

const packageMetadataError = (sourceName: string, manifestObserved: boolean): SourceResult<PackageSource> => ({
  reasons: ['package-metadata-error'],
  value: {
    facts: emptyPackageFacts(),
    ...(manifestObserved ? { manifestSource: sourceName } : {}),
  },
})

const parsePackageMetadata = (bytes: Buffer) => {
  const parsed: unknown = JSON.parse(decodeVerifiedUtf8(bytes))
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as {
      name?: unknown
      packageManager?: unknown
      scripts?: unknown
      workspaces?: unknown
    }
  }
  throw new PackageMetadataValidationError()
}

const readPackageFacts = (
  root: string,
  hooks: BaselineScanHooks,
  sourceName: string,
  expected: boolean,
  authority: BaselineObservationAuthority,
): SourceResult<PackageSource> => {
  const path = resolve(root, 'package.json')
  let manifestObserved = false
  let observation: VerifiedRegularFileObservation | undefined
  try {
    invokeBaselineHook(hooks.beforePackageMetadataRead)
    observation = readObservedVerifiedRegularFile(path, MAX_PACKAGE_BYTES, {
      fault: point => {
        if (point === 'after-lstat') {
          manifestObserved = true
          invokeBaselineHook(hooks.afterPackageMetadataLstat)
        }
      },
    })
  } catch (error) {
    rethrowBaselineHookError(error)
    if (error instanceof VerifiedFileError || isRecognizedFilesystemError(error)) {
      authority.observeExpectedFailure(error, () => {
        readObservedVerifiedRegularFile(path, MAX_PACKAGE_BYTES)
      })
      return packageMetadataError(sourceName, expected || manifestObserved)
    }
    throw error
  }
  if (observation === undefined) {
    if (expected) {
      return baselineGenerationChanged()
    }
    return {
      reasons: [],
      value: { facts: emptyPackageFacts() },
    }
  }
  authority.observePackage(observation)

  let value: ReturnType<typeof parsePackageMetadata>
  try {
    value = parsePackageMetadata(observation.bytes)
  } catch (error) {
    if (
      error instanceof PackageMetadataValidationError ||
      error instanceof SyntaxError ||
      error instanceof VerifiedFileError
    ) {
      return packageMetadataError(sourceName, true)
    }
    throw error
  }

  let workspaceValue: unknown = []
  if (Array.isArray(value.workspaces)) {
    workspaceValue = value.workspaces
  } else if (value.workspaces !== null && typeof value.workspaces === 'object' && 'packages' in value.workspaces) {
    workspaceValue = (value.workspaces as { packages?: unknown }).packages
  }
  const packageManager = declaredPackageManager(value.packageManager)
  return {
    reasons: [],
    value: {
      facts: {
        ...(typeof value.name === 'string' && safeName(value.name) ? { name: value.name } : {}),
        ...(packageManager === undefined ? {} : { packageManager }),
        scriptKeys:
          value.scripts !== null && typeof value.scripts === 'object' && !Array.isArray(value.scripts)
            ? Object.keys(value.scripts).filter(safeName).sort(ordinalStringCompare)
            : [],
        workspacePatterns: Array.isArray(workspaceValue)
          ? workspaceValue.filter(safeWorkspacePattern).sort(ordinalStringCompare)
          : [],
      },
      manifestSource: sourceName,
      source: sourceName,
    },
  }
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

const captureOptionalDirectory = (path: string, hooks: BaselineScanHooks, expected = false) => {
  let metadata: ReturnType<typeof lstatSync>
  try {
    metadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) {
      if (expected) {
        return baselineGenerationChanged()
      }
      return { kind: 'absent' as const }
    }
    throw error
  }
  if (!(metadata.isDirectory() && !metadata.isSymbolicLink())) {
    if (expected) {
      return baselineGenerationChanged()
    }
    return { kind: 'invalid' as const }
  }
  invokeBaselinePathHook(hooks.afterOptionalDirectoryLstat, path)
  return { kind: 'observed' as const, witness: captureDirectoryWitness(path, { allowLink: false }) }
}

const probeWorkflowSource = (root: string, expectedGithub: boolean) => {
  const github = captureOptionalDirectory(resolve(root, '.github'), {}, expectedGithub)
  if (github.kind === 'observed') {
    const workflows = captureOptionalDirectory(resolve(github.witness.canonicalPath, 'workflows'), {})
    if (workflows.kind === 'observed') {
      collectBoundedDirectoryEntries(workflows.witness.canonicalPath, MAX_WORKFLOW_ENTRIES)
      revalidateDirectoryWitness(workflows.witness)
    }
    revalidateDirectoryWitness(github.witness)
  }
}

const workflowFiles = (
  root: string,
  hooks: BaselineScanHooks,
  expectedGithub: boolean,
  authority: BaselineObservationAuthority,
): SourceResult<string[]> => {
  let result: SourceResult<string[]> = { reasons: [], value: [] }
  try {
    invokeBaselineHook(hooks.beforeWorkflowDirectoryCapture)
    const github = captureOptionalDirectory(resolve(root, '.github'), hooks, expectedGithub)
    if (github.kind === 'invalid') {
      result = { reasons: ['workflow-enumeration-error'], value: [] }
    } else if (github.kind === 'observed') {
      authority.observeDirectory(github.witness)
      const workflowsPath = resolve(github.witness.canonicalPath, 'workflows')
      const workflows = captureOptionalDirectory(workflowsPath, hooks)
      if (workflows.kind === 'absent') {
        revalidateDirectoryWitness(github.witness)
      } else if (workflows.kind === 'invalid') {
        revalidateDirectoryWitness(github.witness)
        result = { reasons: ['workflow-enumeration-error'], value: [] }
      } else {
        authority.observeDirectory(workflows.witness)
        const collected = collectBoundedDirectoryEntries(workflows.witness.canonicalPath, MAX_WORKFLOW_ENTRIES)
        invokeBaselineHook(hooks.afterWorkflowEnumeration)
        revalidateDirectoryWitness(workflows.witness)
        revalidateDirectoryWitness(github.witness)
        if (collected.overflow) {
          result = { reasons: ['workflow-entry-limit'], value: [] }
        } else {
          result = {
            reasons: [],
            value: collected.entries
              .filter(
                entry =>
                  entry.isFile() && !entry.isSymbolicLink() && safeName(entry.name) && /\.ya?ml$/i.test(entry.name),
              )
              .map(entry => `.github/workflows/${entry.name}`),
          }
        }
      }
    }
  } catch (error) {
    rethrowBaselineHookError(error)
    if (error instanceof BaselineGenerationChanged) {
      throw error
    }
    if (isObservedSourceReplacement(error)) {
      return baselineGenerationChanged()
    }
    if (isRecognizedFilesystemError(error)) {
      authority.observeExpectedFailure(error, () => {
        probeWorkflowSource(root, expectedGithub)
      })
      result = { reasons: ['workflow-enumeration-error'], value: [] }
    } else {
      throw error
    }
  }
  return result
}

const emptyTopLevelFacts = () => ({
  directories: [] as string[],
  recognisedFiles: [] as string[],
})

const topLevelFacts = (root: string, hooks: BaselineScanHooks, authority: BaselineObservationAuthority) => {
  let result: SourceResult<ReturnType<typeof emptyTopLevelFacts>> = {
    reasons: [],
    value: emptyTopLevelFacts(),
  }
  try {
    const snapshot = captureCanonicalDirectory(root, MAX_TOP_LEVEL_ENTRIES)
    authority.observeDirectory(snapshot.witness)
    if (snapshot.overflow) {
      result = { reasons: ['top-level-entry-limit'], value: emptyTopLevelFacts() }
    } else {
      const facts = snapshot.entries
        .filter(candidate => safeName(candidate.name) && !candidate.isSymbolicLink())
        .reduce((candidate, entry) => {
          if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
            candidate.directories.push(entry.name)
          } else if (entry.isFile() && RECOGNISED_FILES.has(entry.name.toLowerCase())) {
            candidate.recognisedFiles.push(entry.name)
          }
          return candidate
        }, emptyTopLevelFacts())
      invokeBaselineHook(hooks.beforeTopLevelRevalidation)
      revalidateCanonicalDirectory(snapshot)
      result = { reasons: [], value: facts }
    }
  } catch (error) {
    rethrowBaselineHookError(error)
    if (error instanceof BaselineGenerationChanged) {
      throw error
    }
    if (isObservedSourceReplacement(error)) {
      return baselineGenerationChanged()
    }
    if (isRecognizedFilesystemError(error)) {
      authority.observeExpectedFailure(error, () => {
        captureCanonicalDirectory(root, MAX_TOP_LEVEL_ENTRIES)
      })
      result = { reasons: ['unreadable-directory'], value: emptyTopLevelFacts() }
    } else {
      throw error
    }
  }
  return result
}

const invocationForScript = (manager: string, scriptKey: string) => {
  if (scriptKey.startsWith('-')) {
    return
  }
  return {
    arguments: ['run', scriptKey],
    executable: manager,
    scriptKey,
  }
}

type CollectedBaselineSources = {
  globalReasons: readonly BaselineReason[]
  layoutResult: SourceResult<ReturnType<typeof emptyTopLevelFacts>>
  packageResult: SourceResult<PackageSource>
  workflowResult: SourceResult<string[]>
}

const emptyCollectedBaselineSources = (globalReasons: readonly BaselineReason[]): CollectedBaselineSources => ({
  globalReasons,
  layoutResult: {
    reasons: [],
    value: emptyTopLevelFacts(),
  },
  packageResult: {
    reasons: [],
    value: { facts: emptyPackageFacts() },
  },
  workflowResult: {
    reasons: [],
    value: [],
  },
})

const collectBaselineSources = (root: string, hooks: BaselineScanHooks, authority: BaselineObservationAuthority) => {
  let rootWitness: DirectoryWitness
  try {
    rootWitness = captureDirectoryWitness(root, { allowLink: false })
  } catch (error) {
    if (error instanceof DirectoryWitnessError || isRecognizedFilesystemError(error)) {
      authority.observeExpectedFailure(error, () => {
        captureDirectoryWitness(root, { allowLink: false })
      })
      return emptyCollectedBaselineSources(['unreadable-directory'])
    }
    throw error
  }
  authority.observeDirectory(rootWitness)

  const layoutResult = topLevelFacts(root, hooks, authority)
  const packageSource =
    layoutResult.value.recognisedFiles.find(file => file === 'package.json') ??
    layoutResult.value.recognisedFiles.find(file => file.toLowerCase() === 'package.json') ??
    'package.json'
  const packageResult = readPackageFacts(
    root,
    hooks,
    packageSource,
    layoutResult.value.recognisedFiles.includes('package.json'),
    authority,
  )
  const workflowResult = workflowFiles(root, hooks, layoutResult.value.directories.includes('.github'), authority)
  return { globalReasons: [], layoutResult, packageResult, workflowResult }
}

const buildBaselineRecords = ({
  globalReasons,
  layoutResult,
  packageResult,
  workflowResult,
}: CollectedBaselineSources): AddRecordInput[] => {
  const layout = layoutResult.value
  const packageFacts = packageResult.value.facts
  const packageEvidence = packageManagerEvidence(packageFacts.packageManager, lockfileEvidence(layout.recognisedFiles))
  const packageManager =
    packageEvidence.status === 'unknown' || packageEvidence.status === 'conflicted'
      ? undefined
      : packageEvidence.manager
  const workflows = workflowResult.value
  const truncationReasons = new Set([
    ...globalReasons,
    ...layoutResult.reasons,
    ...packageResult.reasons,
    ...workflowResult.reasons,
  ])
  const packageSource = packageResult.value.source === undefined ? [] : [packageResult.value.source]
  const layoutSources = [
    ...layout.recognisedFiles.filter(file => file !== packageResult.value.manifestSource),
    ...packageSource,
  ].sort(ordinalStringCompare)
  const safeSources = [...new Set([...layoutSources, ...(workflows.length === 0 ? [] : ['.github/workflows'])])].sort(
    ordinalStringCompare,
  )

  return [
    {
      kind: 'context',
      payload: {
        recognisedTopLevelFiles: [...layout.recognisedFiles],
        scanTruncated: truncationReasons.size > 0,
        scanTruncationReasons: [...truncationReasons].sort(ordinalStringCompare),
        sources: safeSources,
        summary: 'Derived shallow repository overview captured during Encephalon initialisation.',
        topLevelDirectories: [...layout.directories],
      },
      source: 'encephalon:init',
      subject: 'encephalon:init/repository-overview',
    },
    {
      kind: 'architecture',
      payload: {
        summary: 'Derived package and tooling layout captured during Encephalon initialisation.',
        ...(packageFacts.name === undefined ? {} : { packageName: packageFacts.name }),
        ...(packageManager === undefined ? {} : { packageManager }),
        packageManagerEvidence: packageEvidence,
        recognisedFiles: [...layout.recognisedFiles],
        sources: layoutSources,
        workspaceConfigured: packageFacts.workspacePatterns.length > 0,
        workspacePatterns: packageFacts.workspacePatterns,
      },
      source: 'encephalon:init',
      subject: 'encephalon:init/tooling-layout',
    },
    {
      kind: 'workflow',
      payload: {
        scriptInvocations:
          packageManager === undefined
            ? []
            : packageFacts.scriptKeys
                .map(script => invocationForScript(packageManager, script))
                .filter(invocation => invocation !== undefined),
        scriptKeys: packageFacts.scriptKeys,
        sources: [...packageSource, ...workflows],
        summary:
          'Derived package-script entry points and CI workflow filenames; use scriptInvocations as argv and treat scriptKeys as discovery-only.',
        workflowFiles: workflows,
      },
      source: 'encephalon:init',
      subject: 'encephalon:init/commands-ci',
    },
  ]
}

type BaselineObservationRetryLedger = {
  attempt: number
  deadline: number
  maximumAttempts: number
  now: () => number
}

const baselineObservationRetryExhausted = (): never =>
  fail('REPOSITORY_CHANGED', 'The canonical repository changed repeatedly during the operation.')

const createBaselineObservationRetryLedger = (now: () => number = Date.now): BaselineObservationRetryLedger => ({
  attempt: 0,
  deadline: now() + OPERATION_BUDGETS.baselineObservationRetryMilliseconds.maximum,
  maximumAttempts: OPERATION_BUDGETS.baselineObservationAttempts.maximum,
  now,
})

const withBaselineObservationRetry = <Result>(
  operation: () => Result,
  ledger: BaselineObservationRetryLedger = createBaselineObservationRetryLedger(),
): Result => {
  if (ledger.attempt >= ledger.maximumAttempts || (ledger.attempt > 0 && ledger.now() >= ledger.deadline)) {
    return baselineObservationRetryExhausted()
  }
  ledger.attempt += 1
  try {
    return operation()
  } catch (error) {
    rethrowBaselineHookError(error)
    if (error instanceof BaselineGenerationChanged) {
      if (ledger.attempt < ledger.maximumAttempts) {
        return withBaselineObservationRetry(operation, ledger)
      }
      return baselineObservationRetryExhausted()
    }
    throw error
  }
}

const scanBaselineAttempt = (root: string, hooks: BaselineScanHooks) => {
  const authority = new BaselineObservationAuthority()
  const collected = collectBaselineSources(root, hooks, authority)
  const provisional = buildBaselineRecords(collected)
  invokeBaselineHook(hooks.afterBaselineSources)
  authority.proveCurrent()
  return provisional
}

/** @internal */
export const scanBaselineWithHooks = (root: string, hooks: BaselineScanHooks): AddRecordInput[] =>
  withBaselineObservationRetry(() => scanBaselineAttempt(root, hooks), createBaselineObservationRetryLedger(hooks.now))

export const scanBaseline = (root: string): AddRecordInput[] => scanBaselineWithHooks(root, {})

const sortJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(ordinalStringCompare)
        .map(key => [key, sortJson(value[key] as JsonValue)]),
    )
  }
  return value
}

export const canonicalPayload = (value: JsonValue) => JSON.stringify(sortJson(value))
