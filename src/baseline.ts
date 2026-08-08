import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { AddRecordInput, JsonValue } from './types.ts'

const MAX_SCANNED_FILES = 100_000
const MAX_SCANNED_DIRECTORIES = 10_000
const MAX_SCAN_DEPTH = 20
const MAX_DIRECTORY_ENTRIES = 512
const MAX_PACKAGE_BYTES = 1024 * 1024
const noFollowFlag = constants.O_NOFOLLOW ?? 0
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
const PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn'])

type PackageFacts = {
  name?: string
  packageManager?: string | undefined
  workspacePatterns: string[]
  scriptKeys: string[]
}

type ScanState = {
  directoriesSeen: number
  filesSeen: number
  languageCounts: Map<string, number>
  truncationReasons: Set<string>
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

const packageManagerFromLock = (files: string[]) => {
  if (files.includes('bun.lock') || files.includes('bun.lockb')) {
    return 'bun'
  }
  if (files.includes('pnpm-lock.yaml')) {
    return 'pnpm'
  }
  if (files.includes('yarn.lock')) {
    return 'yarn'
  }
  if (files.includes('package-lock.json')) {
    return 'npm'
  }
  return 'npm'
}

const safeWorkspacePattern = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 1024 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.split('/').includes('..') &&
  !hasControlCharacters(value)

const readPackageFacts = (root: string): PackageFacts => {
  const path = resolve(root, 'package.json')
  try {
    const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag)
    try {
      const metadata = fstatSync(descriptor)
      if (metadata.isFile() && metadata.size <= MAX_PACKAGE_BYTES) {
        const value = JSON.parse(readFileSync(descriptor, 'utf8')) as {
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
        return {
          ...(typeof value.name === 'string' && safeName(value.name) ? { name: value.name } : {}),
          ...(typeof value.packageManager === 'string' &&
          PACKAGE_MANAGERS.has(value.packageManager.split('@')[0]?.toLowerCase() ?? '')
            ? {
                packageManager: value.packageManager.split('@')[0]?.toLowerCase(),
              }
            : {}),
          scriptKeys:
            value.scripts !== null && typeof value.scripts === 'object' && !Array.isArray(value.scripts)
              ? Object.keys(value.scripts)
                  .filter(safeName)
                  .sort((first, second) => first.localeCompare(second))
              : [],
          workspacePatterns: Array.isArray(workspaceValue)
            ? workspaceValue.filter(safeWorkspacePattern).sort((first, second) => first.localeCompare(second))
            : [],
        }
      }
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return { scriptKeys: [], workspacePatterns: [] }
  }
  return { scriptKeys: [], workspacePatterns: [] }
}

const scanLanguages = (root: string) => {
  const initial: ScanState = {
    directoriesSeen: 0,
    filesSeen: 0,
    languageCounts: new Map(),
    truncationReasons: new Set(),
  }
  const queue = [{ depth: 0, directory: root }]
  for (const { depth, directory } of queue) {
    if (initial.directoriesSeen >= MAX_SCANNED_DIRECTORIES) {
      initial.truncationReasons.add('directory-limit')
      break
    }
    try {
      const metadata = lstatSync(directory)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        initial.directoriesSeen += 1
        try {
          const entries = readdirSync(directory, { withFileTypes: true }).sort((first, second) =>
            first.name.localeCompare(second.name),
          )
          const acceptedEntries = entries.filter(
            entry =>
              safeName(entry.name) &&
              !entry.isSymbolicLink() &&
              !EXCLUDED_FILES.has(entry.name.toLowerCase()) &&
              !(entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())),
          )
          if (acceptedEntries.length > MAX_DIRECTORY_ENTRIES) {
            initial.truncationReasons.add('directory-entry-limit')
          }
          for (const entry of acceptedEntries.slice(0, MAX_DIRECTORY_ENTRIES)) {
            const path = resolve(directory, entry.name)
            if (entry.isDirectory()) {
              if (depth >= MAX_SCAN_DEPTH) {
                initial.truncationReasons.add('max-depth')
                continue
              }
              queue.push({ depth: depth + 1, directory: path })
            } else if (entry.isFile()) {
              if (initial.filesSeen >= MAX_SCANNED_FILES) {
                initial.truncationReasons.add('regular-file-limit')
                continue
              }
              initial.filesSeen += 1
              const language = LANGUAGE_BY_EXTENSION.get(extname(entry.name).toLowerCase())
              if (language !== undefined) {
                initial.languageCounts.set(language, (initial.languageCounts.get(language) ?? 0) + 1)
              }
            }
          }
        } catch {}
      }
    } catch {}
  }
  return initial
}

const safeDirectory = (root: string, segments: string[]) =>
  segments.every((_, index) => {
    try {
      const metadata = lstatSync(resolve(root, ...segments.slice(0, index + 1)))
      return metadata.isDirectory() && !metadata.isSymbolicLink()
    } catch {
      return false
    }
  })

const workflowFiles = (root: string) => {
  const directory = resolve(root, '.github', 'workflows')
  if (!safeDirectory(root, ['.github', 'workflows'])) {
    return []
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && safeName(entry.name) && /\.ya?ml$/i.test(entry.name))
    .map(entry => `.github/workflows/${entry.name}`)
    .sort((first, second) => first.localeCompare(second))
}

const topLevelFacts = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter(entry => safeName(entry.name) && !entry.isSymbolicLink())
    .sort((first, second) => first.name.localeCompare(second.name))
    .reduce<{ directories: string[]; recognisedFiles: string[] }>(
      (facts, entry) => {
        if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) {
          return { ...facts, directories: [...facts.directories, entry.name] }
        }
        if (entry.isFile() && RECOGNISED_FILES.has(entry.name.toLowerCase())) {
          return {
            ...facts,
            recognisedFiles: [...facts.recognisedFiles, entry.name],
          }
        }
        return facts
      },
      { directories: [], recognisedFiles: [] },
    )

const commandForScript = (manager: string, script: string) =>
  manager === 'yarn' ? `yarn ${script}` : `${manager} run ${script}`

export const scanBaseline = (root: string): AddRecordInput[] => {
  const layout = topLevelFacts(root)
  const packageFacts = readPackageFacts(root)
  const packageManager = packageFacts.packageManager ?? packageManagerFromLock(layout.recognisedFiles)
  const scan = scanLanguages(root)
  const languages = [...scan.languageCounts.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([language, files]) => ({ files, language }))
  const workflows = workflowFiles(root)
  const safeSources = [
    ...new Set([...layout.recognisedFiles, ...(workflows.length === 0 ? [] : ['.github/workflows'])]),
  ].sort((first, second) => first.localeCompare(second))

  return [
    {
      kind: 'context',
      payload: {
        languageCounts: languages,
        recognisedTopLevelFiles: layout.recognisedFiles,
        scannedRegularFiles: scan.filesSeen,
        scanTruncated: scan.truncationReasons.size > 0,
        scanTruncationReasons: [...scan.truncationReasons].sort((first, second) => first.localeCompare(second)),
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
        packageManager,
        recognisedFiles: layout.recognisedFiles,
        sources: layout.recognisedFiles,
        workspaceConfigured: packageFacts.workspacePatterns.length > 0,
        workspacePatterns: packageFacts.workspacePatterns,
      },
      source: 'encephalon:init',
      subject: 'encephalon:init/tooling-layout',
    },
    {
      kind: 'workflow',
      payload: {
        commands: packageFacts.scriptKeys.map(script => commandForScript(packageManager, script)),
        scriptKeys: packageFacts.scriptKeys,
        sources: [...(layout.recognisedFiles.includes('package.json') ? ['package.json'] : []), ...workflows],
        summary: 'Derived package-script entry points and CI workflow filenames.',
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
        .sort((first, second) => first.localeCompare(second))
        .map(key => [key, sortJson(value[key] as JsonValue)]),
    )
  }
  return value
}

export const canonicalPayload = (value: JsonValue) => JSON.stringify(sortJson(value))
