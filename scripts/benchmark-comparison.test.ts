import assert from 'node:assert/strict'
import { test } from 'node:test'
import { combineBenchmarkRounds } from './benchmark-compare.ts'
import { type ComparableRun, compareBenchmarkRuns } from './benchmark-comparison.ts'
import { benchmarkOperations, summarizeDistribution, summarizeSamples } from './benchmark-model.ts'

const run = (): ComparableRun => ({
  benchmark: {
    cases: [0, 1, 100, 1000].map(records => ({
      artifacts: 0,
      cache: {
        amplification: records === 0 ? null : 1,
        databaseBytes: 1000,
        shmBytes: 0,
        totalBytes: 1000,
        walBytes: 0,
      },
      canonicalJsonBytes: 0,
      fixtureSha256: 'e'.repeat(64),
      largePayloads: 0,
      maximumFixtureSha256: 'f'.repeat(64),
      operations: Object.fromEntries(
        benchmarkOperations.map(operation => [
          operation,
          operation === 'stalePrepare' && records === 0
            ? null
            : summarizeSamples(
                Array.from({ length: 3 }, () => ({
                  overheadMs: 5,
                  peakRssBytes: 1000,
                  preparationIntegrityMs: 80,
                  queryProjectionMs: 15,
                  rssDeltaBytes: 0,
                  totalMs: 100,
                })),
              ),
        ]),
      ) as ComparableRun['benchmark']['cases'][number]['operations'],
      records,
      supersessionDepth: 0,
    })),
    configuration: { repetitions: 3, timeoutMilliseconds: 30_000, warmups: 1 },
    environment: { arch: 'arm64', cpu: 'test', node: 'v24.15.0', platform: 'darwin' },
    generatedAt: '2026-09-07T00:00:00.000Z',
    memory: { peakRssBytes: 'isolated', rssDeltaBytes: 'isolated' },
    profile: 'custom',
    schemaVersion: 2,
  },
  commit: 'a'.repeat(40),
  fixtureVersion: 1,
  harnessSha256: 'b'.repeat(64),
  package: { declarationBytes: 1000, javascriptBytes: 1000, tarballBytes: 1000 },
  runner: 'same-job',
  schemaVersion: 1,
  startup: { help: [100, 100, 100], version: [100, 100, 100] },
})

test('relative gate detects latency, tail, memory and byte regressions with actionable values', () => {
  const base = run()
  assert.equal(compareBenchmarkRuns(base, run()).passed, true)
  const candidate = run()
  candidate.commit = 'c'.repeat(40)
  const [first] = candidate.benchmark.cases
  assert.ok(first)
  const { list } = first.operations
  assert.ok(list)
  list.totalMs = { count: 3, maximum: 130, median: 116, p95: 130, samples: [116, 116, 130] }
  list.peakRssBytes = { count: 3, maximum: 1210, median: 1210, p95: 1210, samples: [1210, 1210, 1210] }
  candidate.package.javascriptBytes = 1101
  const report = compareBenchmarkRuns(base, candidate)
  assert.equal(report.passed, false)
  assert.deepEqual(
    report.metrics
      .filter(metric => !metric.passed)
      .map(metric => [metric.operation, metric.metric, metric.percentageDifference, metric.allowedPercent]),
    [
      ['0:list', 'totalMs.median', 16, 15],
      ['0:list', 'totalMs.p95', 30, 25],
      ['0:list', 'peakRssBytes.maximum', 21, 20],
      ['package', 'javascriptBytes', 10.1, 10],
    ],
  )
  assert.equal(report.baseCommit, base.commit)
  assert.equal(report.candidateCommit, candidate.commit)
})

test('comparison refuses incompatible or incomplete evidence instead of approving absent metrics', () => {
  const mutations: Array<(candidate: ComparableRun) => void> = [
    candidate => {
      candidate.fixtureVersion += 1
    },
    candidate => {
      candidate.harnessSha256 = 'd'.repeat(64)
    },
    candidate => {
      candidate.runner = 'different-job'
    },
    candidate => {
      candidate.benchmark.environment.node = 'v26.0.0'
    },
    candidate => {
      candidate.benchmark.configuration.repetitions = 4
    },
    candidate => {
      candidate.benchmark.cases = []
    },
    candidate => {
      candidate.package.javascriptBytes = Number.NaN
    },
    candidate => {
      candidate.startup.help.pop()
    },
    candidate => {
      const list = candidate.benchmark.cases[0]?.operations.list
      assert.ok(list)
      list.totalMs.samples.pop()
    },
    candidate => {
      const list = candidate.benchmark.cases[0]?.operations.list
      assert.ok(list)
      list.totalMs.median = 0
    },
    candidate => {
      const [entry] = candidate.benchmark.cases
      assert.ok(entry)
      entry.operations.list = null
    },
  ]
  for (const mutate of mutations) {
    const candidate = run()
    mutate(candidate)
    assert.throws(() => compareBenchmarkRuns(run(), candidate), /benchmark|comparison/i)
  }
})

test('comparison rejects jointly omitted workloads and does not round away threshold violations', () => {
  const incomplete = run()
  incomplete.benchmark.cases = incomplete.benchmark.cases.slice(0, 1)
  assert.throws(() => compareBenchmarkRuns(incomplete, structuredClone(incomplete)), /benchmark/i)
  const candidate = run()
  const [entry] = candidate.benchmark.cases
  assert.ok(entry)
  assert.ok(entry.operations.list)
  entry.operations.list.totalMs = {
    count: 3,
    maximum: 115,
    median: 115,
    p95: 115,
    samples: [115.000_01, 115.000_01, 115.000_01],
  }
  assert.equal(compareBenchmarkRuns(run(), candidate).passed, false)
})

test('round aggregation retains each observation and rejects changed runtime or fixture provenance', () => {
  const rounds = [10, 30, 20].map(total => {
    const report = run().benchmark
    report.configuration.repetitions = 1
    report.cases = report.cases.map(entry => ({
      ...entry,
      operations: Object.fromEntries(
        benchmarkOperations.map(operation => [
          operation,
          operation === 'stalePrepare' && entry.records === 0
            ? null
            : summarizeSamples([
                {
                  overheadMs: 0,
                  peakRssBytes: 1000,
                  preparationIntegrityMs: total,
                  queryProjectionMs: 0,
                  rssDeltaBytes: 0,
                  totalMs: total,
                },
              ]),
        ]),
      ) as typeof entry.operations,
    }))
    return report
  })
  const combined = combineBenchmarkRounds(rounds, 2)
  const [combinedCase] = combined.cases
  assert.ok(combinedCase)
  assert.ok(combinedCase.operations.list)
  assert.deepEqual(combinedCase.operations.list.totalMs, {
    count: 3,
    maximum: 30,
    median: 20,
    p95: 30,
    samples: [10, 30, 20],
  })
  const [, second] = rounds
  assert.ok(second)
  const incomplete = structuredClone(rounds)
  const firstList = incomplete[0]?.cases[0]?.operations.list
  const secondList = incomplete[1]?.cases[0]?.operations.list
  assert.ok(firstList && secondList)
  firstList.totalMs.samples = []
  secondList.totalMs.samples = [10, 30]
  assert.throws(() => combineBenchmarkRounds(incomplete, 2), /missing an operation sample/)
  second.environment.node = 'v26.0.0'
  assert.throws(() => combineBenchmarkRounds(rounds, 2), /incompatible/)
})

test('zero baselines fail on any positive candidate without inventing a denominator', () => {
  const base = run()
  base.startup.help = [0, 0, 0]
  const candidate = structuredClone(base)
  assert.equal(compareBenchmarkRuns(base, candidate).passed, true)
  candidate.startup.help = [0.001, 0.001, 0.001]
  assert.equal(compareBenchmarkRuns(base, candidate).passed, false)
  const [firstCase] = base.benchmark.cases
  assert.ok(firstCase)
  const { list: first } = firstCase.operations
  assert.ok(first)
  first.totalMs = summarizeDistribution([10, 20, 30])
  const report = compareBenchmarkRuns(base, structuredClone(base))
  assert.deepEqual(report.spread.base.cases[0]?.operations.list?.totalMs, { range: 20, variance: 200 / 3 })
})
