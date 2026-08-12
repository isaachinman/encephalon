import { lstatSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import {
  type CanonicalDirectorySnapshot,
  captureCanonicalDirectory,
  collectBoundedDirectoryEntries,
  revalidateCanonicalDirectory,
} from './canonical-layout.ts'
import { captureDirectoryWitness, revalidateDirectoryWitness } from './directory-witness.ts'
import { ordinalStringCompare } from './order.ts'
import type { AddRecordInput, JsonValue } from './types.ts'
import { decodeVerifiedUtf8, readVerifiedRegularFile } from './verified-file.ts'

const MAX_SCANNED_FILES = 100_000
const MAX_SCANNED_DIRECTORIES = 10_000
const MAX_SCAN_DEPTH = 20
const MAX_LANGUAGE_DIRECTORY_ENTRIES = 512
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
const EXCLUDED_FILES = new Set(['agents.md', 'claude.md'])
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
const LANGUAGE_BY_EXTENSION = new Map([
  ['.c', 'C'],
  ['.cc', 'C++'],
  ['.cpp', 'C++'],
  ['.cs', 'C#'],
  ['.css', 'CSS'],
  ['.go', 'Go'],
  ['.html', 'HTML'],
  ['.java', 'Java'],
  ['.js', 'JavaScript'],
  ['.jsx', 'JavaScript'],
  ['.kt', 'Kotlin'],
  ['.kts', 'Kotlin'],
  ['.php', 'PHP'],
  ['.py', 'Python'],
  ['.rb', 'Ruby'],
  ['.rs', 'Rust'],
  ['.scss', 'SCSS'],
  ['.sh', 'Shell'],
  ['.sql', 'SQL'],
  ['.swift', 'Swift'],
  ['.ts', 'TypeScript'],
  ['.tsx', 'TypeScript'],
  ['.vue', 'Vue'],
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
  beforeLanguageDirectoryCapture?: ((path: string) => void) | undefined
  beforeTopLevelRevalidation?: (() => void) | undefined
  maximumScannedDirectories?: number | undefined
  onLanguageDirectoryScheduled?: (() => void) | undefined
}

type BaselineReason =
  | 'directory-entry-limit'
  | 'directory-limit'
  | 'max-depth'
  | 'package-metadata-error'
  | 'regular-file-limit'
  | 'top-level-entry-limit'
  | 'unreadable-directory'
  | 'workflow-entry-limit'
  | 'workflow-enumeration-error'

type ScanState = {
  directoriesSeen: number
  filesSeen: number
  languageCounts: Map<string, number>
  truncationReasons: Set<BaselineReason>
}

type SourceResult<Value> = {
  reasons: readonly BaselineReason[]
  value: Value
}

type PackageSource = {
  facts: PackageFacts
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

const readPackageFacts = (root: string, hooks: BaselineScanHooks, sourceName: string): SourceResult<PackageSource> => {
  const path = resolve(root, sourceName)
  let result: SourceResult<PackageSource> = {
    reasons: [],
    value: { facts: emptyPackageFacts() },
  }
  try {
    const bytes = readVerifiedRegularFile(path, MAX_PACKAGE_BYTES, {
      fault: point => {
        if (point === 'after-lstat') {
          hooks.afterPackageMetadataLstat?.()
        }
      },
    })
    if (bytes !== undefined) {
      const parsed: unknown = JSON.parse(decodeVerifiedUtf8(bytes))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as {
          name?: unknown
          packageManager?: unknown
          scripts?: unknown
          workspaces?: unknown
        }
        let workspaceValue: unknown = []
        if (Array.isArray(value.workspaces)) {
          workspaceValue = value.workspaces
        } else if (
          value.workspaces !== null &&
          typeof value.workspaces === 'object' &&
          'packages' in value.workspaces
        ) {
          workspaceValue = (value.workspaces as { packages?: unknown }).packages
        }
        const packageManager = declaredPackageManager(value.packageManager)
        result = {
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
            source: sourceName,
          },
        }
      } else {
        throw new TypeError('Package metadata must be an object.')
      }
    }
  } catch {
    result = {
      reasons: ['package-metadata-error'],
      value: { facts: emptyPackageFacts() },
    }
  }
  return result
}

const readBoundedDirectoryEntries = (
  directory: string,
  hooks: BaselineScanHooks,
  parent?: CanonicalDirectorySnapshot,
) => {
  hooks.beforeLanguageDirectoryCapture?.(directory)
  if (parent !== undefined) {
    revalidateCanonicalDirectory(parent)
  }
  const snapshot = captureCanonicalDirectory(directory, MAX_LANGUAGE_DIRECTORY_ENTRIES)
  if (parent !== undefined) {
    revalidateCanonicalDirectory(parent)
  }
  return {
    entries: snapshot.entries.filter(entry => {
      const excludedDirectory = entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())
      return (
        safeName(entry.name) &&
        !entry.isSymbolicLink() &&
        !EXCLUDED_FILES.has(entry.name.toLowerCase()) &&
        !excludedDirectory
      )
    }),
    snapshot,
  }
}

const scanLanguages = (root: string, hooks: BaselineScanHooks) => {
  const state: ScanState = {
    directoriesSeen: 0,
    filesSeen: 0,
    languageCounts: new Map(),
    truncationReasons: new Set(),
  }
  const maximumDirectories = hooks.maximumScannedDirectories ?? MAX_SCANNED_DIRECTORIES
  const queue: { depth: number; directory: string; parent?: CanonicalDirectorySnapshot }[] = [
    { depth: 0, directory: root },
  ]
  let directoriesScheduled = 1
  hooks.onLanguageDirectoryScheduled?.()
  scanDirectories: for (const { depth, directory, parent } of queue) {
    state.directoriesSeen += 1
    try {
      const { entries, snapshot } = readBoundedDirectoryEntries(directory, hooks, parent)
      if (snapshot.overflow) {
        state.truncationReasons.add('directory-entry-limit')
      } else {
        revalidateCanonicalDirectory(snapshot)
        for (const entry of entries) {
          const path = resolve(directory, entry.name)
          if (entry.isDirectory()) {
            if (depth >= MAX_SCAN_DEPTH) {
              state.truncationReasons.add('max-depth')
            } else if (directoriesScheduled >= maximumDirectories) {
              state.truncationReasons.add('directory-limit')
            } else {
              queue.push({ depth: depth + 1, directory: path, parent: snapshot })
              directoriesScheduled += 1
              hooks.onLanguageDirectoryScheduled?.()
            }
          } else if (entry.isFile()) {
            if (state.filesSeen >= MAX_SCANNED_FILES) {
              state.truncationReasons.add('regular-file-limit')
              break scanDirectories
            }
            state.filesSeen += 1
            const language = LANGUAGE_BY_EXTENSION.get(extname(entry.name).toLowerCase())
            if (language !== undefined) {
              state.languageCounts.set(language, (state.languageCounts.get(language) ?? 0) + 1)
            }
          }
        }
      }
    } catch {
      state.truncationReasons.add('unreadable-directory')
    }
  }
  return state
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

const captureOptionalDirectory = (path: string, hooks: BaselineScanHooks) => {
  try {
    lstatSync(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) {
      return
    }
    throw error
  }
  hooks.afterOptionalDirectoryLstat?.(path)
  return captureDirectoryWitness(path, { allowLink: false })
}

const workflowFiles = (root: string, hooks: BaselineScanHooks): SourceResult<string[]> => {
  let result: SourceResult<string[]> = { reasons: [], value: [] }
  try {
    const githubWitness = captureOptionalDirectory(resolve(root, '.github'), hooks)
    if (githubWitness !== undefined) {
      const workflowsPath = resolve(githubWitness.canonicalPath, 'workflows')
      const workflowsWitness = captureOptionalDirectory(workflowsPath, hooks)
      if (workflowsWitness === undefined) {
        revalidateDirectoryWitness(githubWitness)
      } else {
        const collected = collectBoundedDirectoryEntries(workflowsWitness.canonicalPath, MAX_WORKFLOW_ENTRIES)
        hooks.afterWorkflowEnumeration?.()
        revalidateDirectoryWitness(workflowsWitness)
        revalidateDirectoryWitness(githubWitness)
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
  } catch {
    result = { reasons: ['workflow-enumeration-error'], value: [] }
  }
  return result
}

const emptyTopLevelFacts = () => ({
  directories: [] as string[],
  recognisedFiles: [] as string[],
})

const topLevelFacts = (root: string, hooks: BaselineScanHooks) => {
  let result: SourceResult<ReturnType<typeof emptyTopLevelFacts>> = {
    reasons: [],
    value: emptyTopLevelFacts(),
  }
  try {
    const snapshot = captureCanonicalDirectory(root, MAX_TOP_LEVEL_ENTRIES)
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
      hooks.beforeTopLevelRevalidation?.()
      revalidateCanonicalDirectory(snapshot)
      result = { reasons: [], value: facts }
    }
  } catch {
    result = { reasons: ['unreadable-directory'], value: emptyTopLevelFacts() }
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

const emptyScanState = (): ScanState => ({
  directoriesSeen: 0,
  filesSeen: 0,
  languageCounts: new Map(),
  truncationReasons: new Set(),
})

const collectBaselineSources = (root: string, hooks: BaselineScanHooks) => {
  let observedReasons: BaselineReason[] = []
  try {
    const rootWitness = captureDirectoryWitness(root, { allowLink: false })
    const layoutResult = topLevelFacts(root, hooks)
    const packageName =
      layoutResult.value.recognisedFiles.find(file => file.toLowerCase() === 'package.json') ?? 'package.json'
    const packageResult = readPackageFacts(root, hooks, packageName)
    const scan = scanLanguages(root, hooks)
    const workflowResult = workflowFiles(root, hooks)
    observedReasons = [
      ...layoutResult.reasons,
      ...packageResult.reasons,
      ...scan.truncationReasons,
      ...workflowResult.reasons,
    ]
    hooks.afterBaselineSources?.()
    revalidateDirectoryWitness(rootWitness)
    return { layoutResult, packageResult, scan, workflowResult }
  } catch {
    return {
      layoutResult: {
        reasons: [...new Set([...observedReasons, 'unreadable-directory' as const])].sort(ordinalStringCompare),
        value: emptyTopLevelFacts(),
      },
      packageResult: {
        reasons: [],
        value: { facts: emptyPackageFacts() },
      } satisfies SourceResult<PackageSource>,
      scan: emptyScanState(),
      workflowResult: { reasons: [], value: [] } satisfies SourceResult<string[]>,
    }
  }
}

export const scanBaseline = (root: string, hooks: BaselineScanHooks = {}): AddRecordInput[] => {
  const { layoutResult, packageResult, scan, workflowResult } = collectBaselineSources(root, hooks)
  const layout = layoutResult.value
  const packageFacts = packageResult.value.facts
  const packageEvidence = packageManagerEvidence(packageFacts.packageManager, lockfileEvidence(layout.recognisedFiles))
  const packageManager =
    packageEvidence.status === 'unknown' || packageEvidence.status === 'conflicted'
      ? undefined
      : packageEvidence.manager
  const languages = [...scan.languageCounts.entries()]
    .sort(([first], [second]) => ordinalStringCompare(first, second))
    .map(([language, files]) => ({ files, language }))
  const workflows = workflowResult.value
  const truncationReasons = new Set([
    ...layoutResult.reasons,
    ...packageResult.reasons,
    ...scan.truncationReasons,
    ...workflowResult.reasons,
  ])
  const packageSource = packageResult.value.source === undefined ? [] : [packageResult.value.source]
  const layoutSources = [
    ...layout.recognisedFiles.filter(file => file.toLowerCase() !== 'package.json'),
    ...packageSource,
  ].sort(ordinalStringCompare)
  const safeSources = [...new Set([...layoutSources, ...(workflows.length === 0 ? [] : ['.github/workflows'])])].sort(
    ordinalStringCompare,
  )

  return [
    {
      kind: 'context',
      payload: {
        languageCounts: languages,
        recognisedTopLevelFiles: layout.recognisedFiles,
        scannedRegularFiles: scan.filesSeen,
        scanTruncated: truncationReasons.size > 0,
        scanTruncationReasons: [...truncationReasons].sort(ordinalStringCompare),
        sources: safeSources,
        summary: 'Derived repository overview captured during Encephalon initialisation.',
        topLevelDirectories: layout.directories,
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
        recognisedFiles: layout.recognisedFiles,
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
