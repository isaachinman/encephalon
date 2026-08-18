import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { makePreparedRepositoryStale, runBenchmark } from '../scripts/benchmark.ts'
import {
  assertPerformanceBudget,
  type BenchmarkReport,
  collectMeasuredSamples,
  parseBenchmarkArguments,
  summarizeDistribution,
} from '../scripts/benchmark-model.ts'
import { runBenchmarkWorker } from '../scripts/benchmark-process.ts'
import { hydrate } from '../src/index.ts'
import { createTestRepository, removeTestRepository } from './helpers.ts'

const fixtureWorker = join(import.meta.dirname, 'fixtures', 'benchmark-worker.ts')
const realWorker = join(import.meta.dirname, '..', 'scripts', 'benchmark-worker.ts')
const benchmarkScript = join(import.meta.dirname, '..', 'scripts', 'benchmark.ts')

const sample = (totalMs: number) => ({
  overheadMs: 0,
  peakRssBytes: 100,
  preparationIntegrityMs: totalMs,
  queryProjectionMs: 0,
  rssDeltaBytes: -1,
  totalMs,
})

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

describe('isolated benchmark authority', () => {
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
    assert.throws(
      () => assertPerformanceBudget(report, { cases: [], schemaVersion: 2 }),
      /Performance budget has no case for 0 records\./,
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
      hydrate({ root })
      const first = await runBenchmarkWorker({
        operation: 'fullSearch',
        records: 0,
        root,
        timeoutMilliseconds: 5000,
        workerPath: realWorker,
      })
      const second = await runBenchmarkWorker({
        operation: 'fullSearch',
        records: 0,
        root,
        timeoutMilliseconds: 5000,
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
      const accepted = spawnSync(
        process.execPath,
        [benchmarkScript, '--records', '0', '--warmups', '0', '--repetitions', '1', '--output', outputPath],
        { encoding: 'utf8' },
      )
      assert.equal(accepted.status, 0, accepted.stderr)
      assert.equal(accepted.stdout, '')
      assert.equal(accepted.stderr, '')
      const report = JSON.parse(readFileSync(outputPath, 'utf8')) as BenchmarkReport
      assert.equal(report.schemaVersion, 2)
      assert.equal(report.profile, 'custom')
      assert.deepEqual(readdirSync(root).toSorted(), ['budget.json', 'report.json'])

      const help = spawnSync(process.execPath, [benchmarkScript, '--help'], { encoding: 'utf8' })
      assert.equal(help.status, 0)
      assert.match(help.stdout, /^Usage: node scripts\/benchmark\.ts/)
      assert.equal(help.stderr, '')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test('aborts the active CLI child and cleans repositories on termination', async () => {
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
      await delay(150)
      assert.equal(child.kill('SIGTERM'), true)
      const [code, signal] = await closed
      assert.equal(code, 143)
      assert.equal(signal, null)
      assert.equal(standardOutput, '')
      assert.match(standardError, /was aborted\./)
      assert.equal(standardError.includes(root), false)
      assert.deepEqual(readdirSync(temporaryParent), [])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
