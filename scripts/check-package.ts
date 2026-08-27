import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { spawnNpmCommand } from './npm-command.ts'
import { PACKAGE_DECLARATION_CONSUMER_SOURCE } from './package-declaration-consumer.ts'
import { assertReviewedManifest, type PackageManifest, validateReviewedPackageSnapshot } from './package-preflight.ts'
import {
  parsePackageCheckArguments,
  retainPackageArtifact,
  snapshotPackageTarball,
  verifyPackageArtifactMetadata,
} from './package-tarball.ts'
import { assertPackageVersionSource, readPackageVersionSource } from './package-version.ts'
import { RESULT_LIMIT_CASES, RESULT_LIMIT_OPERATIONS } from './release-contracts.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = parsePackageCheckArguments(process.argv.slice(2))
const retainedTarballDirectory = options.retainedDirectory
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'encephalon-package-check-'))
const subprocessTimeoutMilliseconds = 60_000
const subprocessMaximumOutputBytes = 1024 * 1024

const execute = (command: readonly string[], cwd = root) => {
  const [requestedExecutable, ...arguments_] = command
  if (requestedExecutable !== undefined) {
    const result = spawnSync(requestedExecutable, arguments_, {
      cwd,
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      maxBuffer: subprocessMaximumOutputBytes,
      timeout: subprocessTimeoutMilliseconds,
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

const runClean = (command: string[], cwd = root) => {
  const result = execute(command, cwd)
  if (result.exitCode === 0 && result.stderr === '') {
    return result.stdout
  }
  process.stderr.write(result.stdout)
  process.stderr.write(result.stderr)
  throw new Error(`${command[0]} failed with exit code ${result.exitCode} or wrote unexpected stderr.`)
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
  const result = spawnNpmCommand(arguments_, {
    cwd,
    maxBuffer: subprocessMaximumOutputBytes,
    timeoutMilliseconds: subprocessTimeoutMilliseconds,
  })
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

const createNpmTarball = () => {
  const packOutput = runNpm([
    'pack',
    '--dry-run=false',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    temporaryDirectory,
  ])
  const [pack] = JSON.parse(packOutput) as Array<{ filename?: unknown }>
  if (
    typeof pack?.filename === 'string' &&
    basename(pack.filename) === pack.filename &&
    pack.filename.endsWith('.tgz')
  ) {
    return { filename: pack.filename, path: resolve(temporaryDirectory, pack.filename) }
  }
  throw new Error('npm pack did not return package metadata.')
}

const collectFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })

try {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageManifest
  if (typeof packageJson.version !== 'string') {
    throw new Error('Package version must be a string.')
  }
  const generatedVersionSource = readPackageVersionSource(resolve(root, 'src', 'generated', 'version.ts'))
  assertPackageVersionSource(packageJson.version, generatedVersionSource)
  const packageVersion = assertReviewedManifest(packageJson)

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
  const createdTarball = options.suppliedTarball === undefined ? createNpmTarball() : undefined
  const sourceTarball = options.suppliedTarball ?? createdTarball?.path
  if (sourceTarball === undefined) {
    throw new Error('Package tarball acquisition failed.')
  }
  const sourceCommit = run(['git', 'rev-parse', 'HEAD']).trim()
  const suppliedMetadata =
    options.suppliedTarball === undefined
      ? undefined
      : verifyPackageArtifactMetadata(options.suppliedTarball, { packageVersion, sourceCommit })
  const snapshot = snapshotPackageTarball(sourceTarball, temporaryDirectory)
  if (
    suppliedMetadata !== undefined &&
    !isDeepStrictEqual(snapshot.digests, {
      bytes: suppliedMetadata.bytes,
      integrity: suppliedMetadata.integrity,
      sha1: suppliedMetadata.sha1,
      sha256: suppliedMetadata.sha256,
      sha512: suppliedMetadata.sha512,
    })
  ) {
    throw new Error('The supplied package bytes changed after metadata verification.')
  }
  const tarball = snapshot.path
  validateReviewedPackageSnapshot(root, snapshot)

  const consumer = resolve(temporaryDirectory, 'consumer')
  mkdirSync(resolve(consumer, '.git'), { recursive: true })
  writeFileSync(resolve(consumer, 'package.json'), '{"name":"encephalon-smoke","private":true,"type":"module"}\n')
  runNpm(['install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', tarball], consumer)
  const packedApiRoot = resolve(temporaryDirectory, 'api-consumer')
  mkdirSync(resolve(packedApiRoot, '.git'), { recursive: true })
  writeFileSync(
    resolve(packedApiRoot, 'package.json'),
    '{"name":"encephalon-api-smoke","private":true,"type":"module"}\n',
  )
  runNpm(
    ['install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', tarball],
    packedApiRoot,
  )
  const packedApiContract = [
    "const api = await import('encephalon')",
    `const apiRoot = ${JSON.stringify(packedApiRoot)}`,
    "if (typeof api.prepare !== 'function' || typeof api.initEncephalon !== 'function') throw new Error('The packed API is incomplete.')",
    'const descriptors = []',
    'let ownKeys = 0',
    'const payload = new Proxy(new Array(10_000), { getOwnPropertyDescriptor: (target, key) => { descriptors.push(String(key)); return Reflect.getOwnPropertyDescriptor(target, key) }, ownKeys: target => { ownKeys += 1; return Reflect.ownKeys(target) } })',
    'let rejected = false',
    "try { api.addRecord({ kind: 'decision', payload, root: 'unused-before-payload-validation', source: 'package-check', subject: 'payload.package-budget' }) } catch (error) { rejected = error instanceof api.EncephalonError && error.name === 'EncephalonError' && error.code === 'INVALID_ARGUMENT' && error.message === 'payload may contain at most 10000 JSON nodes.' && error.details?.field === 'payload' && Reflect.ownKeys(error.details).length === 1 }",
    "if (!rejected || ownKeys !== 0 || JSON.stringify(descriptors) !== '[\"length\"]') throw new Error('The packed Node API payload budget contract failed.')",
    'let getterCalls = 0',
    'const input = {}',
    "Object.defineProperty(input, 'root', { get: () => { getterCalls += 1; throw new Error('hostile input secret') } })",
    'let inputRejected = false',
    "try { api.prepare(input) } catch (error) { inputRejected = error instanceof api.EncephalonError && error.code === 'INVALID_ARGUMENT' }",
    "if (!inputRejected || getterCalls !== 0) throw new Error('The packed Node API input descriptor contract failed.')",
    'api.prepare({ root: apiRoot })',
    "const resultOperations = { list: limit => api.listRecords({ root: apiRoot, limit }), search: limit => api.searchRecords({ root: apiRoot, query: 'x', limit }), searchCompact: limit => api.searchCompactRecords({ root: apiRoot, query: 'x', limit }), gather: limit => api.gatherRecords({ root: apiRoot, limit }) }",
    `const resultCases = ${JSON.stringify(RESULT_LIMIT_OPERATIONS)}.map(operation => ({ ...operation, invoke: resultOperations[operation.name] }))`,
    `const acceptedLimits = ${JSON.stringify(RESULT_LIMIT_CASES.filter(limit => limit <= 1000))}`,
    "for (const resultCase of resultCases) { for (const limit of acceptedLimits) { const result = resultCase.invoke(limit); if (resultCase.name === 'gather' ? !Array.isArray(result.records) : !Array.isArray(result)) throw new Error('The packed API ' + resultCase.name + ' result-limit ' + limit + ' contract failed.') } let exactRejection = false; try { resultCase.invoke(1001) } catch (error) { exactRejection = error instanceof api.EncephalonError && error.code === 'INVALID_ARGUMENT' && error.message === 'limit must be an integer between 1 and 1000.' && JSON.stringify(error.details) === JSON.stringify({ budget: resultCase.budget, field: 'limit', maximum: 1000 }) } if (!exactRejection) throw new Error('The packed API ' + resultCase.name + ' result-limit 1001 contract failed.') }",
  ].join('\n')
  runClean([process.execPath, '--input-type=module', '--eval', packedApiContract], packedApiRoot)
  writeFileSync(resolve(consumer, 'smoke.ts'), PACKAGE_DECLARATION_CONSUMER_SOURCE)
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
  const cli = (arguments_: string[]) => runClean([process.execPath, installedCli, ...arguments_], consumer)
  const cliFailure = (arguments_: string[]) =>
    runExpectedFailure([process.execPath, installedCli, ...arguments_], consumer)
  const cliJson = (arguments_: string[]) => {
    const stdout = cli(arguments_)
    if (stdout.endsWith('\n') && /^[[{]/u.test(stdout)) {
      return JSON.parse(stdout) as unknown
    }
    throw new Error('The packed Node-only CLI JSON stdout framing contract failed.')
  }

  const help = cli(['--help'])
  const helpFragments = [
    'list [--kind <kind>] [--subject <subject>] [--include-superseded] [--limit <1..1000>]',
    'search [--kind <kind>] [--include-superseded] [--limit <1..1000>] [--] <query>',
    'search --compact [--kind <kind>] [--include-superseded] [--limit <1..1000>] [--] <query>',
    'gather [--search <query> ...] [--show <id> ...] [--hydrate] [--include-superseded]\n' +
      '         [--kind <kind>] [--limit <1..1000>]',
    'Accepts at most 16 searches and 64 shows.',
    'Accepts at most 1,000 supersession targets.',
  ]
  if (
    !/^Usage: encephalon/m.test(help) ||
    helpFragments.some(fragment => !help.includes(fragment)) ||
    cli(['--version']) !== `${packageVersion}\n`
  ) {
    throw new Error('The packed Node-only CLI help/version contract failed.')
  }

  const assertPackedBudgetFailure = (
    arguments_: string[],
    expectedDetails: { budget: string; field: string; maximum: number },
  ) => {
    const result = cliFailure(arguments_)
    const body = JSON.parse(result.stderr) as {
      error?: { code?: unknown; details?: unknown; message?: unknown }
    }
    if (
      result.exitCode !== 2 ||
      result.stdout !== '' ||
      !result.stderr.endsWith('\n') ||
      body.error?.code !== 'INVALID_ARGUMENT' ||
      body.error.message !== '--limit must be an integer between 1 and 1000.' ||
      !isDeepStrictEqual(body.error.details, expectedDetails)
    ) {
      throw new Error('The packed Node-only CLI operation budget contract failed.')
    }
  }

  const packedCliLimitArguments = Object.freeze({
    gather: (limit: number) => ['gather', '--root', consumer, `--limit=${limit}`],
    list: (limit: number) => ['list', '--root', consumer, `--limit=${limit}`],
    search: (limit: number) => ['search', '--root', consumer, `--limit=${limit}`, 'x'],
    searchCompact: (limit: number) => ['search', '--root', consumer, '--compact', `--limit=${limit}`, 'x'],
  })
  const rejectedResultLimit = RESULT_LIMIT_CASES.find(limit => limit > 1000)
  if (rejectedResultLimit === undefined) {
    throw new Error('The release result-limit matrix lacks its rejected boundary.')
  }
  const packedResultLimitCases = RESULT_LIMIT_OPERATIONS.map(operation =>
    Object.freeze({
      accepted: packedCliLimitArguments[operation.name],
      budget: operation.budget,
      rejected: packedCliLimitArguments[operation.name](rejectedResultLimit),
    }),
  )

  for (const limitCase of packedResultLimitCases) {
    assertPackedBudgetFailure([...limitCase.rejected], {
      budget: limitCase.budget,
      field: 'limit',
      maximum: 1000,
    })
  }

  const prepared = cliJson(['--root', consumer, 'prepare']) as { hydrated?: unknown; recordsIndexed?: unknown }
  if (prepared.hydrated !== true || prepared.recordsIndexed !== 0) {
    throw new Error('The packed Node-only CLI prepare command returned an unexpected result.')
  }
  const initialised = cliJson(['init', '--root', consumer]) as { recordsCreated?: unknown }
  if (!Array.isArray(initialised.recordsCreated) || initialised.recordsCreated.length !== 3) {
    throw new Error('The packed Node-only CLI init command returned an unexpected result.')
  }
  const acceptedResultLimits = RESULT_LIMIT_CASES.filter(limit => limit <= 1000)
  const acceptedLimitResults = packedResultLimitCases.flatMap(limitCase =>
    acceptedResultLimits.map(limit => cliJson(limitCase.accepted(limit))),
  )
  if (acceptedLimitResults.length !== packedResultLimitCases.length * acceptedResultLimits.length) {
    throw new Error('The packed CLI accepted result-limit matrix did not execute every case.')
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
  process.stderr.write(`${JSON.stringify(snapshot.digests)}\n`)
  if (retainedTarballDirectory !== undefined) {
    const retained = retainPackageArtifact(snapshot, {
      filename: basename(sourceTarball),
      packageVersion,
      retainedDirectory: retainedTarballDirectory,
      sourceCommit,
    })
    process.stdout.write(`${relative(root, retained.path).split(sep).join('/')}\n`)
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
