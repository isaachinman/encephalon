import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  makePreparedRepositoryStale,
  removeBenchmarkRoots,
  restoreBenchmarkSample,
  runBenchmark,
} from '../scripts/benchmark.ts'
import {
  assertPerformanceBudget,
  type BenchmarkReport,
  collectMeasuredSamples,
  parseBenchmarkArguments,
  summarizeDistribution,
} from '../scripts/benchmark-model.ts'
import { runBenchmarkWorker } from '../scripts/benchmark-process.ts'
import { gatherBenchmarkInput } from '../scripts/benchmark-workload.ts'
import { hydrate, prepare } from '../src/index.ts'
import { OPERATION_BUDGETS } from '../src/operation-budgets.ts'
import { createTestRepository, removeTestRepository } from './helpers.ts'

const fixtureWorker = join(import.meta.dirname, 'fixtures', 'benchmark-worker.ts')
const realWorker = join(import.meta.dirname, '..', 'scripts', 'benchmark-worker.ts')
const realWorkerExitTimeoutMilliseconds = process.platform === 'win32' ? 10_000 : 5000
const benchmarkScript = join(import.meta.dirname, '..', 'scripts', 'benchmark.ts')
const privateRenameGuard = join(import.meta.dirname, 'fixtures', 'require-private-benchmark-rename.ts')

const privateFileModesSupported = (() => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-private-mode-probe-'))
  const path = join(root, 'probe')
  try {
    writeFileSync(path, '', { mode: 0o600 })
    return (statSync(path).mode & 0o777) === 0o600
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})()

const sample = (totalMs: number) => ({
  overheadMs: 0,
  peakRssBytes: 100,
  preparationIntegrityMs: totalMs,
  queryProjectionMs: 0,
  rssDeltaBytes: -1,
  totalMs,
})

const separatedP95Distribution = {
  count: 20,
  maximum: 20,
  median: 10.5,
  p95: 19,
  samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
}

const emptyCache = {
  amplification: null,
  databaseBytes: 1,
  shmBytes: 0,
  totalBytes: 1,
  walBytes: 0,
}

const operations = (
  overrides: Partial<BenchmarkReport['cases'][number]['operations']> = {},
): BenchmarkReport['cases'][number]['operations'] => ({
  coldHydrate: null,
  compactSearch: null,
  fullSearch: null,
  gather: null,
  list: null,
  show: null,
  stalePrepare: null,
  unchangedPrepare: null,
  ...overrides,
})

const reportMetadata = {
  configuration: { repetitions: 3, timeoutMilliseconds: 30_000, warmups: 1 },
  environment: { arch: 'test', cpu: null, node: 'test', platform: 'test' },
  generatedAt: '2026-08-18T00:00:00.000Z',
  memory: { peakRssBytes: 'test', rssDeltaBytes: 'test' },
  profile: 'baseline',
} as const

const waitForBenchmarkActivity = (temporaryParent: string, child: ReturnType<typeof spawn>): Promise<void> => {
  const observe = async (remainingAttempts: number): Promise<void> => {
    if (readdirSync(temporaryParent).length > 0) {
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Benchmark CLI exited before the signal test observed temporary work.')
    }
    if (remainingAttempts > 0) {
      await delay(10)
      return observe(remainingAttempts - 1)
    }
    throw new Error('Benchmark CLI did not begin temporary benchmark work before the signal test timeout.')
  }

  return observe(200)
}

describe('isolated benchmark authority', () => {
  test('builds the gather workload from authoritative maxima with two repeated exact keys', () => {
    const input = gatherBenchmarkInput(0)
    const frequencies = (values: readonly string[]) =>
      values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())

    assert.equal(input.searches.length, OPERATION_BUDGETS.gatherSearches.maximum)
    assert.equal(input.shows.length, OPERATION_BUDGETS.gatherShows.maximum)
    assert.deepEqual(input.searches.slice(0, 4), [
      'benchmark needle',
      'large payload',
      'benchmark needle',
      'large payload',
    ])
    assert.deepEqual(input.shows.slice(0, 4), ['missing', 'benchmark-missing', 'missing', 'benchmark-missing'])
    assert.deepEqual(
      frequencies(input.searches),
      new Map([
        ['benchmark needle', OPERATION_BUDGETS.gatherSearches.maximum / 2],
        ['large payload', OPERATION_BUDGETS.gatherSearches.maximum / 2],
      ]),
    )
    assert.deepEqual(
      frequencies(input.shows),
      new Map([
        ['missing', OPERATION_BUDGETS.gatherShows.maximum / 2],
        ['benchmark-missing', OPERATION_BUDGETS.gatherShows.maximum / 2],
      ]),
    )
  })

  test('excludes warmups and reports deterministic distributions', async () => {
    const invocations = [999, 998, 40, 10, 30, 20]
    const measured = await collectMeasuredSamples(2, 4, index => sample(invocations[index] ?? -1))

    assert.deepEqual(
      measured.map(value => value.totalMs),
      [40, 10, 30, 20],
    )
    assert.deepEqual(summarizeDistribution(measured.map(value => value.totalMs)), {
      count: 4,
      maximum: 40,
      median: 25,
      p95: 40,
      samples: [40, 10, 30, 20],
    })
    assert.deepEqual(summarizeDistribution(separatedP95Distribution.samples), separatedP95Distribution)
    assert.deepEqual(invocations, [999, 998, 40, 10, 30, 20])
  })

  test('requires schema version 2 and budgets an explicit statistic', () => {
    const report = {
      ...reportMetadata,
      cases: [
        {
          artifacts: 0,
          cache: emptyCache,
          canonicalJsonBytes: 0,
          largePayloads: 0,
          operations: operations({
            coldHydrate: {
              overheadMs: summarizeDistribution([0, 0, 0]),
              peakRssBytes: summarizeDistribution([100, 100, 100]),
              preparationIntegrityMs: summarizeDistribution([1, 2, 100]),
              queryProjectionMs: summarizeDistribution([0, 0, 0]),
              rssDeltaBytes: summarizeDistribution([-1, -1, -1]),
              totalMs: summarizeDistribution([1, 2, 100]),
            },
          }),
          records: 0,
          supersessionDepth: 0,
        },
      ],
      schemaVersion: 2,
    } as BenchmarkReport
    const [reportCase] = report.cases
    assert.ok(reportCase)

    assert.throws(
      () =>
        assertPerformanceBudget(report, {
          cases: [],
          schemaVersion: 1,
        }),
      /Unsupported benchmark budget schemaVersion 1; expected 2\./,
    )
    assert.throws(
      () =>
        assertPerformanceBudget(report, {
          cases: [
            {
              operations: {
                coldHydrate: { totalMs: { median: 50, p95: 50 } },
              },
              records: 0,
            },
          ],
          schemaVersion: 2,
        }),
      /0 records coldHydrate\.totalMs\.p95: actual 100 exceeds budget 50\./,
    )
    assert.doesNotThrow(() =>
      assertPerformanceBudget(
        {
          ...report,
          cases: [
            {
              ...reportCase,
              operations: operations({
                coldHydrate: {
                  overheadMs: summarizeDistribution([0]),
                  peakRssBytes: summarizeDistribution([100]),
                  preparationIntegrityMs: separatedP95Distribution,
                  queryProjectionMs: summarizeDistribution([0]),
                  rssDeltaBytes: summarizeDistribution([-1]),
                  totalMs: separatedP95Distribution,
                },
              }),
            },
          ],
        },
        {
          cases: [{ operations: { coldHydrate: { totalMs: { p95: 19 } } }, records: 0 }],
          schemaVersion: 2,
        },
      ),
    )
    assert.throws(
      () => assertPerformanceBudget(report, { cases: [], schemaVersion: 2 }),
      /Performance budget has no case for 0 records\./,
    )
    assert.throws(
      () => assertPerformanceBudget(report, { cases: [{ records: 0 }], schemaVersion: 2 }),
      /Benchmark budget case for 0 records must configure a limit\./,
    )
    assert.throws(
      () =>
        assertPerformanceBudget(report, {
          cases: [{ operations: {}, records: 0 }],
          schemaVersion: 2,
        }),
      /Benchmark operation budgets must configure an operation\./,
    )
    assert.throws(
      () =>
        assertPerformanceBudget(report, {
          cases: [{ cache: { amplification: { maximum: 1 } }, records: 0 }],
          schemaVersion: 2,
        }),
      /Benchmark budget configures unavailable cache\.amplification for 0 records\./,
    )
    assert.throws(
      () =>
        assertPerformanceBudget(report, {
          cases: [{ operations: { unknown: { totalMs: { p95: 10 } } }, records: 0 }, { records: 0 }],
          schemaVersion: 2,
        }),
      /Unknown benchmark budget operation: unknown\./,
    )
    assert.throws(
      () =>
        assertPerformanceBudget(
          {
            ...reportMetadata,
            cases: [
              {
                artifacts: 0,
                cache: emptyCache,
                canonicalJsonBytes: 0,
                largePayloads: 0,
                operations: operations(),
                records: 0,
                supersessionDepth: 0,
              },
            ],
            schemaVersion: 2,
          } as BenchmarkReport,
          {
            cases: [{ operations: { stalePrepare: { totalMs: { p95: 10 } } }, records: 0 }],
            schemaVersion: 2,
          },
        ),
      /Benchmark budget configures unavailable stalePrepare for 0 records\./,
    )
  })

  test('parses exact profile defaults and command overrides', () => {
    assert.deepEqual(parseBenchmarkArguments([]), {
      budget: undefined,
      output: undefined,
      profile: 'baseline',
      records: [0, 100],
      repetitions: 3,
      timeoutMilliseconds: 30_000,
      warmups: 1,
    })
    assert.deepEqual(
      parseBenchmarkArguments(['--profile', 'full', '--records', '1000', '--warmups', '2', '--repetitions', '5']),
      {
        budget: undefined,
        output: undefined,
        profile: 'custom',
        records: [1000],
        repetitions: 5,
        timeoutMilliseconds: 30_000,
        warmups: 2,
      },
    )
    assert.throws(
      () => parseBenchmarkArguments(['--records', '100', '--records', '100']),
      /Duplicate --records value: 100\./,
    )
    assert.deepEqual(parseBenchmarkArguments(['--profile', 'full']), {
      budget: undefined,
      output: undefined,
      profile: 'full',
      records: [0, 100, 1000],
      repetitions: 5,
      timeoutMilliseconds: 30_000,
      warmups: 2,
    })
    assert.deepEqual(
      parseBenchmarkArguments([
        '--profile=ci',
        '--records=100',
        '--warmups=2',
        '--repetitions=5',
        '--timeout-ms=4000',
        '--budget=budget.json',
        '--output=first.json',
        '--output=second.json',
      ]),
      {
        budget: 'budget.json',
        output: 'second.json',
        profile: 'custom',
        records: [100],
        repetitions: 5,
        timeoutMilliseconds: 4000,
        warmups: 2,
      },
    )
    assert.equal(parseBenchmarkArguments(['-oreport.json']).output, 'report.json')
  })

  test('accepts only one nonce-matched worker result followed by a clean close', async () => {
    const valid = await runBenchmarkWorker({
      operation: 'fullSearch',
      records: 0,
      root: '/unused',
      timeoutMilliseconds: 2000,
      workerPath: fixtureWorker,
    })
    assert.equal(valid.processId > 0, true)

    const failures = [
      ['unchangedPrepare', /returned an invalid worker result/],
      ['stalePrepare', /returned more than one worker result/],
      ['compactSearch', /returned an invalid worker result/],
      ['list', /exited with code 17 after producing a result/],
      ['show', /timed out after 50 ms/],
      ['gather', /timed out after 50 ms/],
    ] as const
    await Promise.all(
      failures.map(([operation, pattern]) =>
        assert.rejects(
          runBenchmarkWorker({
            operation,
            records: 0,
            root: '/unused',
            timeoutMilliseconds: operation === 'show' || operation === 'gather' ? 50 : 2000,
            workerPath: fixtureWorker,
          }),
          pattern,
        ),
      ),
    )

    await assert.rejects(
      runBenchmarkWorker({
        operation: 'fullSearch',
        records: 0,
        root: '/crash',
        timeoutMilliseconds: 2000,
        workerPath: fixtureWorker,
      }),
      /Benchmark fullSearch for 0 records exited with code 23 before producing a result\./,
    )
    await assert.rejects(
      runBenchmarkWorker({
        operation: 'fullSearch',
        records: 0,
        root: '/stdout',
        timeoutMilliseconds: 2000,
        workerPath: fixtureWorker,
      }),
      /Benchmark fullSearch for 0 records wrote unexpected stdout\./,
    )
  })

  test('kills an aborted worker and waits for its close', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 25)
    await assert.rejects(
      runBenchmarkWorker({
        operation: 'gather',
        records: 0,
        root: '/unused',
        signal: controller.signal,
        timeoutMilliseconds: 2000,
        workerPath: fixtureWorker,
      }),
      /Benchmark gather for 0 records was aborted\./,
    )
  })

  test('isolates child memory and reports additive public-read phases', async () => {
    const heavy = await runBenchmarkWorker({
      operation: 'coldHydrate',
      records: 0,
      root: '/unused',
      timeoutMilliseconds: 2000,
      workerPath: fixtureWorker,
    })
    const light = await runBenchmarkWorker({
      operation: 'fullSearch',
      records: 0,
      root: '/unused',
      timeoutMilliseconds: 2000,
      workerPath: fixtureWorker,
    })
    assert.notEqual(heavy.processId, light.processId)
    assert.equal(heavy.sample.peakRssBytes > light.sample.peakRssBytes + 32 * 1024 * 1024, true)

    const root = createTestRepository()
    try {
      mkdirSync(join(root, 'encephalon'))
      const cold = await runBenchmarkWorker({
        operation: 'coldHydrate',
        records: 0,
        root,
        timeoutMilliseconds: realWorkerExitTimeoutMilliseconds,
        workerPath: realWorker,
      })
      const unchanged = await runBenchmarkWorker({
        operation: 'unchangedPrepare',
        records: 0,
        root,
        timeoutMilliseconds: realWorkerExitTimeoutMilliseconds,
        workerPath: realWorker,
      })
      for (const result of [cold, unchanged]) {
        assert.equal(result.sample.queryProjectionMs, 0)
        assert.equal(result.sample.overheadMs, 0)
        assert.equal(result.sample.preparationIntegrityMs, result.sample.totalMs)
      }
      const first = await runBenchmarkWorker({
        operation: 'fullSearch',
        records: 0,
        root,
        timeoutMilliseconds: realWorkerExitTimeoutMilliseconds,
        workerPath: realWorker,
      })
      const second = await runBenchmarkWorker({
        operation: 'fullSearch',
        records: 0,
        root,
        timeoutMilliseconds: realWorkerExitTimeoutMilliseconds,
        workerPath: realWorker,
      })
      assert.notEqual(first.processId, second.processId)
      for (const result of [first, second]) {
        assert.equal(result.sample.preparationIntegrityMs >= 0, true)
        assert.equal(result.sample.queryProjectionMs >= 0, true)
        assert.equal(result.sample.overheadMs >= 0, true)
        assert.equal(
          Math.abs(
            result.sample.totalMs -
              result.sample.preparationIntegrityMs -
              result.sample.queryProjectionMs -
              result.sample.overheadMs,
          ) < 0.01,
          true,
        )
      }
    } finally {
      removeTestRepository(root)
    }
  })

  test('reports raw measured samples and removes templates and successful sample repositories', async () => {
    const temporaryParent = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-controller-test-'))
    try {
      const report = await runBenchmark(['--records', '0', '--warmups', '0', '--repetitions', '1'], { temporaryParent })
      assert.equal(report.schemaVersion, 2)
      assert.equal(report.profile, 'custom')
      assert.deepEqual(report.configuration, {
        repetitions: 1,
        timeoutMilliseconds: 30_000,
        warmups: 0,
      })
      const [result] = report.cases
      assert.ok(result)
      assert.equal(result.operations.stalePrepare, null)
      assert.equal(result.operations.coldHydrate?.totalMs.count, 1)
      assert.equal(result.operations.coldHydrate?.totalMs.samples.length, 1)
      assert.deepEqual(readdirSync(temporaryParent), [])
    } finally {
      rmSync(temporaryParent, { force: true, recursive: true })
    }
  })

  test('removes templates and sample repositories after a worker failure', async () => {
    const temporaryParent = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-controller-failure-test-'))
    try {
      await assert.rejects(
        runBenchmark(['--records', '0', '--warmups', '0', '--repetitions', '1'], {
          temporaryParent,
          workerPath: fixtureWorker,
        }),
        /Benchmark unchangedPrepare for 0 records returned an invalid worker result/,
      )
      assert.deepEqual(readdirSync(temporaryParent), [])
    } finally {
      rmSync(temporaryParent, { force: true, recursive: true })
    }
  })

  test('removes templates and sample repositories after cancellation', async () => {
    const temporaryParent = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-controller-abort-test-'))
    const controller = new AbortController()
    try {
      setTimeout(() => controller.abort(), 25)
      await assert.rejects(
        runBenchmark(['--records', '0', '--warmups', '0', '--repetitions', '1'], {
          signal: controller.signal,
          temporaryParent,
          workerPath: fixtureWorker,
        }),
        /was aborted/,
      )
      assert.deepEqual(readdirSync(temporaryParent), [])
    } finally {
      rmSync(temporaryParent, { force: true, recursive: true })
    }
  })

  test('removes a temporary repository when setup fails before returning its path', async () => {
    await Promise.all(
      (['repository', 'snapshot'] as const).map(async phase => {
        const temporaryParent = mkdtempSync(join(tmpdir(), `encephalon-benchmark-${phase}-setup-test-`))
        const failure = new Error(`${phase} setup failure`)
        try {
          await assert.rejects(
            runBenchmark(['--records', '0', '--warmups', '0', '--repetitions', '1'], {
              afterTemporaryRepositoryAllocation: currentPhase => {
                if (currentPhase === phase) {
                  throw failure
                }
              },
              temporaryParent,
            }),
            candidate => candidate === failure,
          )
          assert.deepEqual(readdirSync(temporaryParent), [])
        } finally {
          rmSync(temporaryParent, { force: true, recursive: true })
        }
      }),
    )
  })

  test('attempts every owned-root cleanup and retains the first failure', () => {
    const firstFailure = new Error('first cleanup failure')
    const secondFailure = new Error('second cleanup failure')
    const attempts: string[] = []

    const result = removeBenchmarkRoots(['first', 'second', 'third'], path => {
      attempts.push(path)
      if (path === 'first') {
        throw firstFailure
      }
      if (path === 'second') {
        throw secondFailure
      }
    })

    assert.deepEqual(attempts, ['first', 'second', 'third'])
    assert.equal(result.kind, 'failure')
    if (result.kind === 'failure') {
      assert.equal(result.error, firstFailure)
    }
  })

  test('preserves setup and worker failures when cleanup also fails', async () => {
    await Promise.all(
      (['repository', 'snapshot'] as const).map(async phase => {
        const temporaryParent = mkdtempSync(join(tmpdir(), `encephalon-benchmark-${phase}-cleanup-priority-test-`))
        const primaryFailure = new Error(`${phase} primary failure`)
        let cleanupAttempts = 0
        try {
          await assert.rejects(
            runBenchmark(['--records', '0', '--warmups', '0', '--repetitions', '1'], {
              afterTemporaryRepositoryAllocation: currentPhase => {
                if (currentPhase === phase) {
                  throw primaryFailure
                }
              },
              removeRoot: () => {
                cleanupAttempts += 1
                throw new Error(`${phase} cleanup failure`)
              },
              temporaryParent,
            }),
            error => error === primaryFailure,
          )
          assert.equal(cleanupAttempts > 0, true)
        } finally {
          rmSync(temporaryParent, { force: true, recursive: true })
        }
      }),
    )

    const temporaryParent = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-worker-cleanup-priority-test-'))
    let cleanupAttempts = 0
    try {
      await assert.rejects(
        runBenchmark(['--records', '0', '--warmups', '0', '--repetitions', '1'], {
          removeRoot: () => {
            cleanupAttempts += 1
            if (cleanupAttempts === 2) {
              throw new Error('worker cleanup failure')
            }
          },
          temporaryParent,
          workerPath: fixtureWorker,
        }),
        /Benchmark unchangedPrepare for 0 records returned an invalid worker result/,
      )
      assert.equal(cleanupAttempts >= 5, true)
    } finally {
      rmSync(temporaryParent, { force: true, recursive: true })
    }
  })

  test('uses a different-length canonical variant to make a prepared repository stale', () => {
    const root = createTestRepository()
    try {
      const path = join(root, 'encephalon', 'decision', 'chain-00000.json')
      mkdirSync(join(root, 'encephalon', 'decision'), { recursive: true })
      writeFileSync(path, '{"searchText":"benchmark needle chain 0"}\n')
      const before = statSync(path).size
      makePreparedRepositoryStale(root)
      assert.notEqual(statSync(path).size, before)
      assert.match(readFileSync(path, 'utf8'), /benchmark stale needle chain 0/)
    } finally {
      removeTestRepository(root)
    }
  })

  test('re-establishes a prepared cache after restoring its template', () => {
    const temporaryParent = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-restore-test-'))
    const root = createTestRepository()
    const template = join(temporaryParent, 'template')
    const wrongPackage = join(temporaryParent, 'wrong-package')
    try {
      mkdirSync(join(root, 'encephalon'))
      hydrate({ root })
      cpSync(root, template, { recursive: true, verbatimSymlinks: true })
      mkdirSync(wrongPackage)
      rmSync(join(template, 'node_modules', 'encephalon'), { force: true, recursive: true })
      symlinkSync(
        wrongPackage,
        join(template, 'node_modules', 'encephalon'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )

      restoreBenchmarkSample(template, root, 'unchangedPrepare')

      assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
    } finally {
      removeTestRepository(root)
      rmSync(temporaryParent, { force: true, recursive: true })
    }
  })

  test('preflights budgets and writes reports atomically with concise CLI output', () => {
    const root = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-cli-test-'))
    try {
      const budgetPath = join(root, 'budget.json')
      const missingTemporaryParent = join(root, 'must-not-be-created')
      writeFileSync(budgetPath, '{"schemaVersion":2,"cases":[]}\n')
      const rejected = spawnSync(process.execPath, [benchmarkScript, '--records', '0', '--budget', budgetPath], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: missingTemporaryParent },
      })
      assert.equal(rejected.status, 1)
      assert.equal(rejected.stdout, '')
      assert.equal(rejected.stderr, 'Performance budget has no case for 0 records.\n')

      const outputPath = join(root, 'report.json')
      writeFileSync(outputPath, 'previous report\n', { mode: 0o640 })
      const expectedMode = statSync(outputPath).mode & 0o777
      const ignoredOutputPath = join(root, 'ignored-report.json')
      const accepted = spawnSync(
        process.execPath,
        [
          benchmarkScript,
          '--records=0',
          '--warmups=0',
          '--repetitions=1',
          '--output',
          ignoredOutputPath,
          `--output=${outputPath}`,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(accepted.status, 0, accepted.stderr)
      assert.equal(accepted.stdout, '')
      assert.equal(accepted.stderr, '')
      const report = JSON.parse(readFileSync(outputPath, 'utf8')) as BenchmarkReport
      assert.equal(report.schemaVersion, 2)
      assert.equal(report.profile, 'custom')
      assert.equal(statSync(outputPath).mode & 0o777, expectedMode)
      assert.deepEqual(readdirSync(root).toSorted(), ['budget.json', 'report.json'])

      const help = spawnSync(process.execPath, [benchmarkScript, '--help'], { encoding: 'utf8' })
      assert.equal(help.status, 0)
      assert.match(help.stdout, /^Usage: node scripts\/benchmark\.ts/)
      assert.equal(help.stderr, '')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test('keeps report bytes private until atomic publication', { skip: !privateFileModesSupported }, () => {
    const root = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-private-output-test-'))
    try {
      chmodSync(root, 0o755)
      const outputPath = join(root, 'report.json')
      writeFileSync(outputPath, 'previous report\n', { mode: 0o640 })
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          privateRenameGuard,
          benchmarkScript,
          '--records=0',
          '--warmups=0',
          '--repetitions=1',
          `--output=${outputPath}`,
        ],
        { encoding: 'utf8' },
      )

      assert.equal(result.status, 0, result.stderr)
      assert.equal(statSync(outputPath).mode & 0o777, 0o640)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test('aborts the active CLI child and cleans repositories on termination', {
    skip: process.platform === 'win32' ? 'Windows does not deliver SIGTERM to Node handlers.' : false,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-signal-test-'))
    const temporaryParent = join(root, 'temporary')
    mkdirSync(temporaryParent)
    try {
      const child = spawn(
        process.execPath,
        [benchmarkScript, '--records', '1000', '--warmups', '0', '--repetitions', '1'],
        { env: { ...process.env, TMPDIR: temporaryParent }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let standardOutput = ''
      let standardError = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        standardOutput += chunk as string
      })
      child.stderr.on('data', chunk => {
        standardError += chunk as string
      })
      const closed = once(child, 'close')
      await waitForBenchmarkActivity(temporaryParent, child)
      assert.equal(child.kill('SIGTERM'), true)
      const [code, signal] = await closed
      const terminatedByHandledSigterm = (code === 143 && signal === null) || (code === null && signal === 'SIGTERM')
      assert.equal(terminatedByHandledSigterm, true)
      assert.equal(standardOutput, '')
      assert.match(standardError, /was aborted\./)
      assert.equal(standardError.includes(root), false)
      assert.deepEqual(readdirSync(temporaryParent), [])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
