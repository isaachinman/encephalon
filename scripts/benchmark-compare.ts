import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBenchmarkCommand } from './benchmark-command.ts'
import { type ComparableRun, compareBenchmarkRuns } from './benchmark-comparison.ts'
import {
  type BenchmarkOperation,
  type BenchmarkReport,
  benchmarkOperations,
  summarizeDistribution,
} from './benchmark-model.ts'
import { benchmarkScope } from './benchmark-shards.ts'
import { npmCommand } from './npm-command.ts'
import { readPackageTarEntries } from './package-tarball.ts'

const root = resolve(import.meta.dirname, '..')
const harnessFiles = [
  'benchmark.ts',
  'benchmark-model.ts',
  'benchmark-workload.ts',
  'benchmark-worker.ts',
  'benchmark-process.ts',
  'benchmark-command.ts',
  'benchmark-comparison.ts',
  'benchmark-aggregate.ts',
  'benchmark-compare.ts',
  'benchmark-shards.ts',
  'benchmark-session.ts',
  'npm-command.ts',
  'package-tarball.ts',
]
const sampleMetrics = [
  'totalMs',
  'preparationIntegrityMs',
  'queryProjectionMs',
  'overheadMs',
  'peakRssBytes',
  'rssDeltaBytes',
] as const

const reportIdentity = (report: BenchmarkReport) =>
  JSON.stringify({
    cases: report.cases.map(({ operations: _operations, cache: _cache, ...fixture }) => fixture),
    configuration: report.configuration,
    environment: report.environment,
    schemaVersion: report.schemaVersion,
  })

const run = async (command: string, arguments_: string[], cwd: string, signal?: AbortSignal) =>
  runBenchmarkCommand(command, arguments_, { cwd, timeoutMilliseconds: 600_000, ...(signal ? { signal } : {}) })

const resolveCommit = async (revision: string) => {
  const result = await run('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], root)
  const commit = result.stdout.trim()
  if (/^[a-f0-9]{40}$/.test(commit)) {
    return commit
  }
  throw new Error('Benchmark comparison could not resolve a commit.')
}

const packRevision = async (checkout: string, destination: string, signal: AbortSignal) => {
  await run('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], checkout, signal)
  await run('bun', ['run', 'build'], checkout, signal)
  const npm = npmCommand(['pack', '--ignore-scripts', '--json', '--pack-destination', destination])
  const packed = await runBenchmarkCommand(npm.executable, npm.arguments, {
    cwd: checkout,
    signal,
    timeoutMilliseconds: 120_000,
    ...(npm.environment ? { environment: npm.environment } : {}),
    ...(npm.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  const [metadata] = JSON.parse(packed.stdout) as Array<{ filename: string }>
  if (!(metadata && /^encephalon-[a-zA-Z0-9.+-]+\.tgz$/.test(metadata.filename))) {
    throw new Error('Benchmark package setup returned invalid metadata.')
  }
  const archive = join(destination, metadata.filename)
  const entries = readPackageTarEntries(archive)
  const manifestEntry = entries.find(entry => entry.path === 'package/package.json')
  if (!manifestEntry) {
    throw new Error('Benchmark package has no manifest.')
  }
  const manifest = JSON.parse(manifestEntry.content.toString('utf8')) as {
    version: string
    bin: string | Record<string, string>
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.encephalon
  if (
    typeof bin !== 'string' ||
    !entries.some(entry => entry.path === `package/${bin}`) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
  ) {
    throw new Error('Benchmark package has an invalid CLI or version.')
  }
  const unpacked = join(destination, 'unpacked')
  mkdirSync(unpacked)
  for (const entry of entries) {
    const path = join(unpacked, entry.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, entry.content, { mode: entry.mode })
  }
  return {
    cli: join(unpacked, 'package', bin),
    package: {
      declarationBytes: entries
        .filter(entry => /\.d\.(?:ts|mts|cts)$/.test(entry.path))
        .reduce((bytes, entry) => bytes + entry.size, 0),
      javascriptBytes: entries
        .filter(entry => /\.(?:js|mjs|cjs)$/.test(entry.path))
        .reduce((bytes, entry) => bytes + entry.size, 0),
      tarballBytes: readFileSync(archive).length,
    },
    version: manifest.version,
  }
}

export const combineBenchmarkRounds = (
  rounds: BenchmarkReport[],
  warmups: number,
  operations: readonly BenchmarkOperation[] = benchmarkOperations,
): BenchmarkReport => {
  const [first] = rounds
  if (!first || rounds.length < 3) {
    throw new Error('Benchmark comparison requires at least three complete rounds.')
  }
  if (first.configuration.repetitions !== 1 || rounds.some(round => reportIdentity(round) !== reportIdentity(first))) {
    throw new Error('Benchmark comparison rounds have incompatible metadata or fixtures.')
  }
  const cases = first.cases.map((entry, index) => ({
    ...entry,
    cache: rounds
      .map(round => round.cases[index]?.cache)
      .reduce<BenchmarkReport['cases'][number]['cache']>(
        (largest, cache) => (cache && cache.totalBytes > largest.totalBytes ? cache : largest),
        entry.cache,
      ),
    operations: Object.fromEntries(
      operations.map(operation => {
        const values = rounds.map(round => round.cases[index]?.operations[operation])
        if (operation === 'stalePrepare' && entry.records === 0 && values.every(value => value === null)) {
          return [operation, null]
        }
        if (
          values.some(
            value =>
              value === null ||
              value === undefined ||
              sampleMetrics.some(metric => value[metric].count !== 1 || value[metric].samples.length !== 1),
          )
        ) {
          throw new Error('Benchmark comparison is missing an operation sample.')
        }
        return [
          operation,
          Object.fromEntries(
            sampleMetrics.map(metric => [
              metric,
              summarizeDistribution(values.flatMap(value => value?.[metric].samples ?? [])),
            ]),
          ),
        ]
      }),
    ) as BenchmarkReport['cases'][number]['operations'],
  }))
  return { ...first, cases, configuration: { ...first.configuration, repetitions: rounds.length, warmups } }
}

export const combineBenchmarkOperations = (reports: BenchmarkReport[]): BenchmarkReport => {
  const [first] = reports
  if (
    !first?.cases[0] ||
    first.cases.length !== 1 ||
    reports.some(report => reportIdentity(report) !== reportIdentity(first))
  ) {
    throw new Error('Benchmark operations have incompatible metadata or fixtures.')
  }
  const entries = reports.flatMap(report => Object.entries(report.cases[0]?.operations ?? {}))
  if (new Set(entries.map(([operation]) => operation)).size !== entries.length) {
    throw new Error('Benchmark comparison contains duplicate operations.')
  }
  const cache = reports.reduce((largest, report) => {
    const current = report.cases[0]?.cache
    return current && current.totalBytes > largest.totalBytes ? current : largest
  }, first.cases[0].cache)
  return {
    ...first,
    cases: [
      {
        ...first.cases[0],
        cache,
        operations: Object.fromEntries(entries) as BenchmarkReport['cases'][number]['operations'],
      },
    ],
  }
}

export const runComparison = async (
  baseRevision: string,
  candidateRevision: string,
  output: string,
  repetitions = 20,
  warmups = 2,
  shard?: string,
) => {
  const scope = benchmarkScope(shard)
  if (!(Number.isSafeInteger(repetitions) && repetitions >= 3 && Number.isSafeInteger(warmups) && warmups >= 0)) {
    throw new Error('Benchmark comparison requires at least three repetitions and non-negative warmups.')
  }
  const baseCommit = await resolveCommit(baseRevision)
  const candidateCommit = await resolveCommit(candidateRevision)
  await run('git', ['merge-base', '--is-ancestor', baseCommit, candidateCommit], root)
  const harness = harnessFiles.map(name => ({ bytes: readFileSync(join(root, 'scripts', name)), name }))
  const hash = createHash('sha256')
  for (const file of harness) {
    hash.update(file.name).update('\0').update(file.bytes).update('\0')
  }
  const harnessSha256 = hash.digest('hex')
  const runner = randomUUID()
  const outputDirectory = resolve(output)
  mkdirSync(outputDirectory)
  const temporary = mkdtempSync(join(tmpdir(), 'encephalon-comparison-'))
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const sides = [
    { commit: baseCommit, name: 'base' },
    { commit: candidateCommit, name: 'candidate' },
  ].map(side => ({
    ...side,
    checkout: join(temporary, side.name),
    packed: undefined as Awaited<ReturnType<typeof packRevision>> | undefined,
    registered: false,
    rounds: [] as BenchmarkReport[],
    startup: { help: [] as number[], version: [] as number[] },
  }))
  try {
    for (const side of sides) {
      process.stderr.write(`Benchmark setup: ${side.name} ${side.commit}\n`)
      // biome-ignore lint/performance/noAwaitInLoops: builds must not contend with each other.
      await run('git', ['worktree', 'add', '--detach', side.checkout, side.commit], root, controller.signal)
      side.registered = true
      if (scope.some(entry => entry.records === 0)) {
        const artifacts = join(temporary, `${side.name}-package`)
        mkdirSync(artifacts)
        side.packed = await packRevision(side.checkout, artifacts, controller.signal)
      }
      for (const file of harness) {
        writeFileSync(join(side.checkout, 'scripts', file.name), file.bytes)
      }
    }
    for (const { records, operations } of scope) {
      for (const side of sides) {
        // biome-ignore lint/performance/noAwaitInLoops: prepare both revision-specific snapshots before measurement.
        await run(
          process.execPath,
          [
            'scripts/benchmark-session.ts',
            'prepare',
            join(temporary, `${side.name}-${records}-session.json`),
            String(records),
          ],
          side.checkout,
          controller.signal,
        )
      }
      for (const operation of operations) {
        process.stderr.write(`Benchmark ${records}:${operation} (${repetitions} samples per side)\n`)
        for (const round of Array.from({ length: warmups + repetitions }, (_, index) => index)) {
          for (const side of round % 2 === 0 ? sides : sides.toReversed()) {
            const reportPath = join(temporary, `${side.name}-round.json`)
            // biome-ignore lint/performance/noAwaitInLoops: matched operation pairs alternate and never overlap.
            await run(
              process.execPath,
              [
                'scripts/benchmark-session.ts',
                'sample',
                join(temporary, `${side.name}-${records}-session.json`),
                operation,
                reportPath,
              ],
              side.checkout,
              controller.signal,
            )
            const report = JSON.parse(readFileSync(reportPath, 'utf8')) as BenchmarkReport
            if (round >= warmups) {
              side.rounds.push(report)
              copyFileSync(
                reportPath,
                join(outputDirectory, `${side.name}-${records}-${operation}-round-${round - warmups + 1}.json`),
              )
            }
          }
        }
      }
    }
    for (const operation of scope.some(entry => entry.records === 0) ? (['help', 'version'] as const) : []) {
      for (const round of Array.from({ length: warmups + repetitions }, (_, index) => index)) {
        for (const side of round % 2 === 0 ? sides : sides.toReversed()) {
          if (!side.packed) {
            throw new Error('Benchmark package setup is incomplete.')
          }
          // biome-ignore lint/performance/noAwaitInLoops: packed startup samples are paired on the same runner.
          const startup = await runBenchmarkCommand(process.execPath, [side.packed.cli, `--${operation}`], {
            cwd: temporary,
            signal: controller.signal,
            timeoutMilliseconds: 30_000,
          })
          if (
            operation === 'version'
              ? startup.stdout.trim() !== side.packed.version
              : !startup.stdout.startsWith('Usage: encephalon ')
          ) {
            throw new Error('Benchmark packed CLI returned unexpected output.')
          }
          if (round >= warmups) {
            side.startup[operation].push(startup.elapsedMs)
          }
        }
      }
    }
    const evidence = sides.map(side => {
      const caseReports = scope.map(({ records, operations }) => {
        const reports = operations.map(operation =>
          combineBenchmarkRounds(
            side.rounds.filter(
              report =>
                report.cases.length === 1 &&
                report.cases[0]?.records === records &&
                Object.keys(report.cases[0].operations).length === 1 &&
                Object.hasOwn(report.cases[0].operations, operation),
            ),
            warmups,
            [operation],
          ),
        )
        return combineBenchmarkOperations(reports)
      })
      const [firstCase] = caseReports
      if (!firstCase) {
        throw new Error('Benchmark comparison has no cases.')
      }
      const result: ComparableRun = {
        benchmark: { ...firstCase, cases: caseReports.flatMap(report => report.cases) },
        commit: side.commit,
        fixtureVersion: 1,
        harnessSha256,
        package: side.packed?.package ?? null,
        runner,
        schemaVersion: 1,
        startup: side.packed ? side.startup : null,
      }
      writeFileSync(join(outputDirectory, `${side.name}.json`), `${JSON.stringify(result, null, 2)}\n`)
      return result
    })
    const comparison = compareBenchmarkRuns(evidence[0], evidence[1], scope)
    writeFileSync(join(outputDirectory, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`)
    for (const metric of comparison.metrics.filter(result => !result.passed)) {
      process.stderr.write(
        `${metric.operation} ${metric.metric}: ${metric.base} -> ${metric.candidate}; difference ${metric.absoluteDifference}; ${metric.percentageDifference ?? 'zero-base increase'}% (allowed ${metric.allowedPercent}%)\n`,
      )
    }
    return comparison
  } finally {
    for (const side of sides.filter(value => value.registered)) {
      // biome-ignore lint/performance/noAwaitInLoops: release worktree registrations before deleting their temporary parent.
      await run('git', ['worktree', 'remove', '--force', side.checkout], root)
    }
    rmSync(temporary, { force: true, recursive: true })
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, candidate, output, repetitions, shard] = process.argv.slice(2)
  try {
    if (!(base && candidate && output)) {
      throw new Error(
        'Usage: node scripts/benchmark-compare.ts BASE_SHA CANDIDATE_SHA OUTPUT_DIRECTORY [REPETITIONS] [SHARD]',
      )
    }
    const comparison = await runComparison(
      base,
      candidate,
      output,
      repetitions === undefined ? 20 : Number(repetitions),
      2,
      shard,
    )
    process.exitCode = comparison.passed ? 0 : 1
    process.stdout.write(
      `Benchmark comparison ${comparison.passed ? 'passed' : 'failed'} (${comparison.metrics.length} metrics).\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message.replaceAll(root, '<repository>').replaceAll(tmpdir(), '<temporary>') : 'Benchmark comparison failed.'}\n`,
    )
    process.exitCode = 1
  }
}
