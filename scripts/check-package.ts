import { spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { spawnNpmCommand } from './npm-command.ts'
import { assertPackageVersionSource, readPackageVersionSource } from './package-version.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const retainedTarballUsage = () =>
  new Error('Usage: check-package.ts [--retain-tarball <repository-relative-directory>]')

const parseRetainedTarballDirectory = (arguments_: string[]) => {
  if (arguments_.length === 0) {
    return
  }
  const [option, directoryName] = arguments_
  const directory = directoryName === undefined ? root : resolve(root, directoryName)
  const repositoryRelativeDirectory = relative(root, directory)
  if (
    arguments_.length === 2 &&
    option === '--retain-tarball' &&
    directoryName !== undefined &&
    !isAbsolute(directoryName) &&
    repositoryRelativeDirectory !== '' &&
    repositoryRelativeDirectory !== '..' &&
    !repositoryRelativeDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelativeDirectory)
  ) {
    return directory
  }
  throw retainedTarballUsage()
}

const preflightRetainedTarballDirectory = (retainedDirectory: string) => {
  relative(root, retainedDirectory)
    .split(sep)
    .reduce(
      (state, segment, index, segments) => {
        const directory = resolve(state.parent, segment)
        const entry = state.ancestorMissing ? undefined : lstatSync(directory, { throwIfNoEntry: false })
        const isDestination = index === segments.length - 1
        if (entry !== undefined && (isDestination || !(entry.isDirectory() && !entry.isSymbolicLink()))) {
          throw retainedTarballUsage()
        }
        return { ancestorMissing: state.ancestorMissing || entry === undefined, parent: directory }
      },
      { ancestorMissing: false, parent: root },
    )
}

const retainedTarballDirectory = parseRetainedTarballDirectory(process.argv.slice(2))
if (retainedTarballDirectory !== undefined) {
  preflightRetainedTarballDirectory(retainedTarballDirectory)
}
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'encephalon-package-check-'))

const execute = (command: readonly string[], cwd = root) => {
  const [requestedExecutable, ...arguments_] = command
  if (requestedExecutable !== undefined) {
    const result = spawnSync(requestedExecutable, arguments_, {
      cwd,
      encoding: 'utf8',
    })
    if (result.error !== undefined) {
      throw result.error
    }
    return {
      exitCode: result.status ?? 1,
      stderr: result.stderr ?? '',
      stdout: result.stdout ?? '',
    }
  }
  throw new Error('Package check command must not be empty.')
}

const run = (command: string[], cwd = root) => {
  const result = execute(command, cwd)
  if (result.exitCode === 0) {
    return result.stdout
  }
  process.stderr.write(result.stdout)
  process.stderr.write(result.stderr)
  throw new Error(`${command[0]} failed with exit code ${result.exitCode}.`)
}

const runExpectedFailure = (command: string[], cwd = root) => {
  const result = execute(command, cwd)
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

const runNpm = (arguments_: readonly string[], cwd = root) => {
  const result = spawnNpmCommand(arguments_, { cwd })
  if (result.error !== undefined) {
    throw result.error
  }
  if (result.status === 0) {
    return result.stdout ?? ''
  }
  process.stderr.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  throw new Error(`npm failed with exit code ${result.status ?? 1}.`)
}

const createRetainedTarballParents = (parentDirectory: string) =>
  relative(root, parentDirectory)
    .split(sep)
    .filter(segment => segment.length > 0)
    .reduce((parent, segment) => {
      const directory = resolve(parent, segment)
      const entry = lstatSync(directory, { throwIfNoEntry: false })
      if (entry === undefined) {
        mkdirSync(directory, { mode: 0o700 })
      } else if (!(entry.isDirectory() && !entry.isSymbolicLink())) {
        throw retainedTarballUsage()
      }
      return directory
    }, root)

const retainTarball = (tarball: string, filename: string) => {
  if (retainedTarballDirectory !== undefined) {
    const parentDirectory = dirname(retainedTarballDirectory)
    createRetainedTarballParents(parentDirectory)
    mkdirSync(retainedTarballDirectory, { mode: 0o700 })
    const retainedTarball = resolve(retainedTarballDirectory, filename)
    copyFileSync(tarball, retainedTarball, constants.COPYFILE_EXCL)
    return relative(root, retainedTarball).split(sep).join('/')
  }
}

const collectFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })

const readmeReferences = (content: string) => {
  const pattern = /(?:!?\[[^\]]*]\(([^)]+)\)|<img\b[^>]*\bsrc=["']([^"']+)["'])/gi
  return [...content.matchAll(pattern)]
    .map(match => match[1] ?? match[2] ?? '')
    .map(reference => reference.trim())
    .filter(
      reference =>
        reference.length > 0 &&
        !reference.startsWith('#') &&
        !reference.startsWith('/') &&
        !/^[a-z][a-z0-9+.-]*:/i.test(reference),
    )
    .map(reference => {
      const [path = ''] = reference.split(/[?#]/u, 1)
      return path.startsWith('./') ? path.slice(2) : path
    })
}

const packedMode = (tarball: string, expectedPath: string) => {
  const archive = gunzipSync(readFileSync(tarball))
  const field = (fieldOffset: number, fieldLength: number) =>
    archive
      .subarray(fieldOffset, fieldOffset + fieldLength)
      .toString('utf8')
      .split('\0', 1)[0] ?? ''
  const octal = (fieldOffset: number, fieldLength: number) =>
    Number.parseInt(field(fieldOffset, fieldLength).trim() || '0', 8)
  let offset = 0
  while (offset + 512 <= archive.length) {
    const name = field(offset, 100)
    if (name.length === 0) {
      return
    }
    const prefix = field(offset + 345, 155)
    const path = prefix.length > 0 ? `${prefix}/${name}` : name
    const mode = octal(offset + 100, 8)
    const size = octal(offset + 124, 12)
    if (path === expectedPath) {
      return mode
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
}

try {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
    license?: unknown
    type?: unknown
    engines?: unknown
    bin?: unknown
    exports?: unknown
    files?: unknown
    bundleDependencies?: unknown
    bundledDependencies?: unknown
    dependencies?: unknown
    optionalDependencies?: unknown
    peerDependencies?: unknown
    peerDependenciesMeta?: unknown
    scripts?: Record<string, unknown>
  }
  if (typeof packageJson.version !== 'string') {
    throw new Error('Package version must be a string.')
  }
  const generatedVersionSource = readPackageVersionSource(resolve(root, 'src', 'generated', 'version.ts'))
  assertPackageVersionSource(packageJson.version, generatedVersionSource)
  if (
    packageJson.name !== 'encephalon' ||
    packageJson.license !== 'MIT' ||
    packageJson.type !== 'module' ||
    JSON.stringify(packageJson.engines) !== JSON.stringify({ node: '>=24.15.0' }) ||
    JSON.stringify(packageJson.bin) !== JSON.stringify({ encephalon: 'dist/cli.mjs' }) ||
    JSON.stringify(packageJson.exports) !==
      JSON.stringify({
        '.': { import: './dist/index.mjs', types: './dist/index.d.ts' },
      }) ||
    JSON.stringify(packageJson.files) !==
      JSON.stringify([
        'dist',
        'skills',
        'assets/encephalon.png',
        'docs/performance.md',
        'docs/performance-baseline.json',
        'docs/performance-budgets.json',
        'README.md',
        'LICENSE',
      ]) ||
    packageJson.bundleDependencies !== undefined ||
    packageJson.bundledDependencies !== undefined ||
    packageJson.dependencies !== undefined ||
    packageJson.optionalDependencies !== undefined ||
    packageJson.peerDependencies !== undefined ||
    packageJson.peerDependenciesMeta !== undefined
  ) {
    throw new Error('Package identity, exports, engine, files, or zero-runtime-dependency contract is invalid.')
  }
  const forbiddenLifecycleScripts = ['install', 'preinstall', 'postinstall', 'prepare']
  if (forbiddenLifecycleScripts.some(name => packageJson.scripts?.[name] !== undefined)) {
    throw new Error('The package contains a forbidden installation lifecycle script.')
  }

  const requiredFiles = [
    'dist/cli.mjs',
    'dist/index.mjs',
    'dist/index.d.ts',
    'skills/encephalon/SKILL.md',
    'assets/encephalon.png',
    'docs/performance.md',
    'docs/performance-baseline.json',
    'docs/performance-budgets.json',
    'README.md',
    'LICENSE',
  ]
  for (const path of requiredFiles) {
    if (!existsSync(resolve(root, path))) {
      throw new Error(`Required package file ${path} is missing.`)
    }
  }
  const cliPath = resolve(root, 'dist', 'cli.mjs')
  const lacksNodeShebang = !readFileSync(cliPath, 'utf8').startsWith('#!/usr/bin/env node\n')
  const lacksExecutableMode = process.platform !== 'win32' && (lstatSync(cliPath).mode & 0o111) === 0
  if (lacksNodeShebang || lacksExecutableMode) {
    throw new Error('The CLI must have a Node shebang and executable mode.')
  }
  const bundledSource = collectFiles(resolve(root, 'dist'))
    .filter(path => /\.mjs$/.test(path))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n')
  if (/\bbun:|\bBun\.|from\s+["']typescript["']/.test(bundledSource)) {
    throw new Error('The Node distribution contains an unresolved development-runtime import.')
  }
  const declarations = collectFiles(resolve(root, 'dist'))
    .filter(path => path.endsWith('.d.ts'))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n')
  if (/from\s+["'][^"']+\.ts["']/.test(declarations)) {
    throw new Error('The declarations contain unresolved TypeScript source imports.')
  }
  const cliVersion = run([process.execPath, resolve(root, 'dist', 'cli.mjs'), '--version'])
  if (cliVersion !== `${packageJson.version}\n`) {
    throw new Error('The built CLI reports a stale package version.')
  }

  const packOutput = runNpm([
    'pack',
    '--dry-run=false',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    temporaryDirectory,
  ])
  const [pack] = JSON.parse(packOutput) as Array<{
    filename: string
    files: Array<{ path: string; mode?: number }>
  }>
  if (pack === undefined || basename(pack.filename) !== pack.filename || !pack.filename.endsWith('.tgz')) {
    throw new Error('npm pack did not return package metadata.')
  }
  const allowedFiles = new Set([
    'LICENSE',
    'README.md',
    'assets/encephalon.png',
    'docs/performance.md',
    'docs/performance-baseline.json',
    'docs/performance-budgets.json',
    'package.json',
  ])
  const reviewedInputs = run(['git', 'ls-files', '--cached', '-z', '--'])
    .split('\0')
    .filter(path => path.length > 0)
  const expectedPackagePaths = new Set([
    ...reviewedInputs.filter(path => allowedFiles.has(path) || path.startsWith('skills/')),
    ...reviewedInputs
      .filter(path => path.startsWith('src/') && path.endsWith('.ts') && !path.endsWith('.d.ts'))
      .map(path => `dist/${path.slice('src/'.length, -'.ts'.length)}.d.ts`),
    'dist/cli.mjs',
    'dist/index.mjs',
  ])
  const packedPaths = new Set(pack.files.map(file => file.path))
  const differsFromReviewedManifest =
    pack.files.some(file => !expectedPackagePaths.has(file.path)) ||
    [...expectedPackagePaths].some(path => !packedPaths.has(path))
  if (differsFromReviewedManifest) {
    throw new Error('The tarball differs from the reviewed package file manifest.')
  }
  const missingReadmeReferences = readmeReferences(readFileSync(resolve(root, 'README.md'), 'utf8')).filter(
    path => !packedPaths.has(path),
  )
  if (missingReadmeReferences.length > 0) {
    throw new Error(`The packed README references missing files: ${missingReadmeReferences.join(', ')}`)
  }
  const tarball = resolve(temporaryDirectory, pack.filename)
  const packedCli = pack.files.find(file => file.path === 'dist/cli.mjs')
  const packedCliMode = packedMode(tarball, 'package/dist/cli.mjs')
  const lacksPackedExecutableMode =
    process.platform !== 'win32' && (packedCliMode === undefined || (packedCliMode & 0o111) === 0)
  if (packedCli === undefined || lacksPackedExecutableMode) {
    throw new Error('The packed CLI is missing or not executable.')
  }

  const consumer = resolve(temporaryDirectory, 'consumer')
  mkdirSync(resolve(consumer, '.git'), { recursive: true })
  writeFileSync(resolve(consumer, 'package.json'), '{"name":"encephalon-smoke","private":true,"type":"module"}\n')
  runNpm(['install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', tarball], consumer)
  run(
    [
      process.execPath,
      '--input-type=module',
      '--eval',
      "const api = await import('encephalon'); if (typeof api.prepare !== 'function' || typeof api.initEncephalon !== 'function') process.exitCode = 1",
    ],
    consumer,
  )
  writeFileSync(
    resolve(consumer, 'smoke.ts'),
    [
      "import { EncephalonError, type BrainRecordFile, type SearchRecordsInput } from 'encephalon'",
      "const record: BrainRecordFile = { id: 'x', kind: 'context', subject: 'x', source: 'test', createdAt: '2026-08-06T00:00:00.000Z', payload: {} }",
      'const search: SearchRecordsInput = { query: record.subject }',
      "const error: EncephalonError = new EncephalonError('INVALID_ARGUMENT', search.query)",
      "if (error.code !== 'INVALID_ARGUMENT') throw error",
      '',
    ].join('\n'),
  )
  writeFileSync(
    resolve(consumer, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          target: 'ES2024',
        },
        files: ['smoke.ts'],
      },
      null,
      2,
    )}\n`,
  )
  run(
    [
      process.execPath,
      resolve(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      resolve(consumer, 'tsconfig.json'),
    ],
    consumer,
  )
  const installedCli = resolve(consumer, 'node_modules', 'encephalon', 'dist', 'cli.mjs')
  const cli = (arguments_: string[]) => run([process.execPath, installedCli, ...arguments_], consumer)
  const cliFailure = (arguments_: string[]) =>
    runExpectedFailure([process.execPath, installedCli, ...arguments_], consumer)
  const cliJson = (arguments_: string[]) => JSON.parse(cli(arguments_)) as unknown

  const help = cli(['--help'])
  const helpFragments = [
    'list [--kind <kind>] [--subject <subject>] [--include-superseded] [--limit <1..50>]',
    'search [--kind <kind>] [--include-superseded] [--limit <1..50>] [--] <query>',
    'search --compact [--kind <kind>] [--include-superseded] [--limit <1..100>] [--] <query>',
    'gather [--search <query> ...] [--show <id> ...] [--hydrate] [--include-superseded]\n' +
      '         [--kind <kind>] [--limit <1..100>]',
    'Accepts at most 16 searches and 64 shows.',
    'Accepts at most 1,000 supersession targets.',
  ]
  if (
    !/^Usage: encephalon/m.test(help) ||
    helpFragments.some(fragment => !help.includes(fragment)) ||
    cli(['--version']) !== `${packageJson.version}\n`
  ) {
    throw new Error('The packed Node-only CLI help/version contract failed.')
  }

  const assertPackedBudgetFailure = (
    arguments_: string[],
    expectedDetails: { budget: string; field: string; maximum: number },
  ) => {
    const result = cliFailure(arguments_)
    const body = JSON.parse(result.stderr) as {
      error?: { code?: unknown; details?: unknown }
    }
    if (
      result.exitCode !== 2 ||
      result.stdout !== '' ||
      body.error?.code !== 'INVALID_ARGUMENT' ||
      !isDeepStrictEqual(body.error.details, expectedDetails)
    ) {
      throw new Error('The packed Node-only CLI operation budget contract failed.')
    }
  }

  assertPackedBudgetFailure(['list', '--root', consumer, '--limit=51'], {
    budget: 'fullResultLimit',
    field: 'limit',
    maximum: 50,
  })
  assertPackedBudgetFailure(['search', '--root', consumer, '--compact', '--limit=101', 'x'], {
    budget: 'compactResultLimit',
    field: 'limit',
    maximum: 100,
  })

  const prepared = cliJson(['--root', consumer, 'prepare']) as { hydrated?: unknown; recordsIndexed?: unknown }
  if (prepared.hydrated !== true || prepared.recordsIndexed !== 0) {
    throw new Error('The packed Node-only CLI prepare command returned an unexpected result.')
  }
  const initialised = cliJson(['init', '--root', consumer]) as { recordsCreated?: unknown }
  if (!Array.isArray(initialised.recordsCreated) || initialised.recordsCreated.length !== 3) {
    throw new Error('The packed Node-only CLI init command returned an unexpected result.')
  }
  const added = cliJson([
    'add',
    '--root',
    consumer,
    '--id',
    'packed-cli-record',
    '--kind',
    'decision',
    '--subject',
    'packed.cli',
    '--source',
    'package-contract',
    '--data',
    '{"summary":"Packed CLI record"}',
    '--text',
    'packed-contract-marker Ελληνικά'.normalize('NFD'),
  ]) as { id?: unknown }
  if (added.id !== 'packed-cli-record') {
    throw new Error('The packed Node-only CLI add command returned an unexpected result.')
  }
  const hydrated = cliJson(['hydrate', '--root', consumer]) as { recordsIndexed?: unknown }
  if (hydrated.recordsIndexed !== 4) {
    throw new Error('The packed Node-only CLI hydrate command returned an unexpected result.')
  }
  const validated = cliJson(['validate', '--root', consumer]) as { valid?: unknown }
  if (validated.valid !== true) {
    throw new Error('The packed Node-only CLI validate command returned an unexpected result.')
  }
  const listed = cliJson(['list', '--root', consumer, '--include-superseded', '--limit=10']) as unknown[]
  if (!listed.some(record => (record as { id?: unknown }).id === 'packed-cli-record')) {
    throw new Error('The packed Node-only CLI list command returned an unexpected result.')
  }
  const shown = cliJson(['show', '--root', consumer, '--id', 'packed-cli-record']) as { id?: unknown }
  if (shown.id !== 'packed-cli-record') {
    throw new Error('The packed Node-only CLI show command returned an unexpected result.')
  }
  const searched = cliJson(['search', '--root', consumer, '--compact', '--', 'packed-contract-marker']) as unknown[]
  if (!searched.some(record => (record as { id?: unknown }).id === 'packed-cli-record')) {
    throw new Error('The packed Node-only CLI search command returned an unexpected result.')
  }
  const unicodeSearched = cliJson(['search', '--root', consumer, '--compact', '--', 'Ελληνικά']) as unknown[]
  if (!unicodeSearched.some(record => (record as { id?: unknown }).id === 'packed-cli-record')) {
    throw new Error('The packed Node-only CLI Unicode search command returned an unexpected result.')
  }
  const gathered = cliJson([
    'gather',
    '--root',
    consumer,
    '--search',
    'packed-contract-marker',
    '--show',
    'packed-cli-record',
  ]) as { records?: unknown; searches?: unknown }
  if (!(Array.isArray(gathered.records) && Array.isArray(gathered.searches))) {
    throw new Error('The packed Node-only CLI gather command returned an unexpected result.')
  }
  const retainedTarball = retainTarball(tarball, pack.filename)
  if (retainedTarball !== undefined) {
    process.stdout.write(`${retainedTarball}\n`)
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
