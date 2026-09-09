import { type BenchmarkReport, summarizeDistribution } from './benchmark-model.ts'

import { type BenchmarkScope, completeBenchmarkScope } from './benchmark-shards.ts'

export type ComparableRun = {
  schemaVersion: 1
  commit: string
  fixtureVersion: number
  harnessSha256: string
  runner: string
  benchmark: BenchmarkReport
  package: { javascriptBytes: number; declarationBytes: number; tarballBytes: number } | null
  startup: { help: number[]; version: number[] } | null
}

const requireEvidence: (condition: unknown) => asserts condition = condition => {
  if (!condition) {
    throw new Error('Benchmark comparison requires complete, finite, compatible evidence.')
  }
}

const object = (value: unknown): Record<string, unknown> => {
  requireEvidence(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as Record<string, unknown>
}

const finite = (value: unknown, signed = false): value is number =>
  typeof value === 'number' && Number.isFinite(value) && (signed || value >= 0)

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  requireEvidence(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)))

const validateDistribution = (value: unknown, count: number, signed: boolean) => {
  const distribution = object(value)
  requireEvidence(Array.isArray(distribution.samples) && distribution.samples.length === count)
  requireEvidence(distribution.samples.every(sample => finite(sample, signed)))
  const expected = summarizeDistribution(distribution.samples as number[])
  requireEvidence(distribution.count === count)
  for (const statistic of ['median', 'p95', 'maximum'] as const) {
    requireEvidence(distribution[statistic] === expected[statistic])
  }
}

const metrics = [
  'totalMs',
  'preparationIntegrityMs',
  'queryProjectionMs',
  'overheadMs',
  'peakRssBytes',
  'rssDeltaBytes',
] as const

export const parseComparableRun = (value: unknown, scope: BenchmarkScope = completeBenchmarkScope): ComparableRun => {
  const run = object(value)
  requireEvidence(run.schemaVersion === 1 && run.fixtureVersion === 1)
  requireEvidence(typeof run.commit === 'string' && /^[a-f0-9]{40}$/.test(run.commit))
  requireEvidence(typeof run.harnessSha256 === 'string' && /^[a-f0-9]{64}$/.test(run.harnessSha256))
  requireEvidence(typeof run.runner === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(run.runner))
  const benchmark = object(run.benchmark)
  requireEvidence(benchmark.schemaVersion === 2)
  const configuration = object(benchmark.configuration)
  exactKeys(configuration, ['repetitions', 'warmups', 'timeoutMilliseconds'])
  requireEvidence(Number.isSafeInteger(configuration.repetitions) && (configuration.repetitions as number) >= 3)
  requireEvidence(Number.isSafeInteger(configuration.warmups) && (configuration.warmups as number) >= 0)
  requireEvidence(
    Number.isSafeInteger(configuration.timeoutMilliseconds) && (configuration.timeoutMilliseconds as number) > 0,
  )
  const count = configuration.repetitions as number
  const environment = object(benchmark.environment)
  exactKeys(environment, ['arch', 'cpu', 'node', 'platform'])
  requireEvidence(
    ['arch', 'node', 'platform'].every(
      key => typeof environment[key] === 'string' && /^[a-zA-Z0-9.+-]{1,64}$/.test(environment[key] as string),
    ),
  )
  requireEvidence(
    environment.cpu === null ||
      (typeof environment.cpu === 'string' && environment.cpu.length <= 256 && !/[/\\\n\r]/.test(environment.cpu)),
  )
  requireEvidence(Array.isArray(benchmark.cases) && benchmark.cases.length > 0)
  const seen = new Set<number>()
  for (const value_ of benchmark.cases) {
    const entry = object(value_)
    for (const key of ['fixtureSha256', 'maximumFixtureSha256']) {
      requireEvidence(typeof entry[key] === 'string' && /^[a-f0-9]{64}$/.test(entry[key] as string))
    }
    requireEvidence(
      Number.isSafeInteger(entry.records) &&
        (entry.records as number) >= 0 &&
        (entry.records as number) <= 1000 &&
        !seen.has(entry.records as number),
    )
    seen.add(entry.records as number)
    for (const key of ['artifacts', 'canonicalJsonBytes', 'largePayloads', 'supersessionDepth']) {
      requireEvidence(Number.isSafeInteger(entry[key]) && (entry[key] as number) >= 0)
    }
    const cache = object(entry.cache)
    exactKeys(cache, ['amplification', 'databaseBytes', 'shmBytes', 'totalBytes', 'walBytes'])
    requireEvidence(
      Object.entries(cache).every(([key, metric]) =>
        key === 'amplification' && entry.records === 0 ? metric === null : finite(metric),
      ),
    )
    requireEvidence(
      cache.totalBytes === (cache.databaseBytes as number) + (cache.shmBytes as number) + (cache.walBytes as number),
    )
    const operations = object(entry.operations)
    const expected = scope.find(item => item.records === entry.records)
    requireEvidence(expected)
    exactKeys(operations, expected.operations)
    for (const operation of expected.operations) {
      if (entry.records === 0 && operation === 'stalePrepare') {
        requireEvidence(operations[operation] === null)
      } else {
        const distributions = object(operations[operation])
        exactKeys(distributions, metrics)
        for (const metric of metrics) {
          validateDistribution(distributions[metric], count, metric === 'rssDeltaBytes')
        }
      }
    }
  }
  requireEvidence(seen.size === scope.length && scope.every(entry => seen.has(entry.records)))
  if (scope.some(entry => entry.records === 0)) {
    const package_ = object(run.package)
    exactKeys(package_, ['javascriptBytes', 'declarationBytes', 'tarballBytes'])
    requireEvidence(Object.values(package_).every(metric => Number.isSafeInteger(metric) && (metric as number) > 0))
    const startup = object(run.startup)
    exactKeys(startup, ['help', 'version'])
    requireEvidence(
      Object.values(startup).every(
        samples => Array.isArray(samples) && samples.length === count && samples.every(sample => finite(sample)),
      ),
    )
  } else {
    requireEvidence(run.package === null && run.startup === null)
  }
  return value as ComparableRun
}

export type ComparisonMetric = {
  operation: string
  metric: string
  base: number
  candidate: number
  absoluteDifference: number
  percentageDifference: number | null
  allowedPercent: number
  passed: boolean
}

const zeroBasePercentage = (candidate: number) => (candidate === 0 ? 0 : null)

const rawStatistic = (samples: number[], statistic: 'median' | 'p95' | 'maximum'): number => {
  const sorted = samples.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (statistic === 'maximum') {
    return sorted.at(-1) as number
  }
  if (statistic === 'p95') {
    return sorted[Math.ceil(sorted.length * 0.95) - 1] as number
  }
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number)
}

const compareMetric = (
  operation: string,
  metric: string,
  base: number,
  candidate: number,
  allowedPercent: number,
): ComparisonMetric => ({
  absoluteDifference: candidate - base,
  allowedPercent,
  base,
  candidate,
  metric,
  operation,
  passed: candidate - base <= (base * allowedPercent) / 100,
  percentageDifference:
    base === 0 ? zeroBasePercentage(candidate) : Number((((candidate - base) / base) * 100).toFixed(6)),
})

const fixtureIdentity = (run: ComparableRun) =>
  run.benchmark.cases.map(entry => ({
    artifacts: entry.artifacts,
    canonicalJsonBytes: entry.canonicalJsonBytes,
    fixtureSha256: entry.fixtureSha256,
    largePayloads: entry.largePayloads,
    maximumFixtureSha256: entry.maximumFixtureSha256,
    records: entry.records,
    supersessionDepth: entry.supersessionDepth,
  }))

const spread = (samples: number[]) => {
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  return {
    range: Math.max(...samples) - Math.min(...samples),
    variance: samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length,
  }
}

const runSpread = (run: ComparableRun, scope: BenchmarkScope) => ({
  cases: run.benchmark.cases.map(entry => ({
    operations: Object.fromEntries(
      (scope.find(item => item.records === entry.records)?.operations ?? []).map(operation => [
        operation,
        entry.operations[operation] === null
          ? null
          : Object.fromEntries(
              metrics.map(metric => [metric, spread(entry.operations[operation]?.[metric].samples ?? [])]),
            ),
      ]),
    ),
    records: entry.records,
  })),
  startup: run.startup ? { help: spread(run.startup.help), version: spread(run.startup.version) } : null,
})

export const compareBenchmarkRuns = (
  baseValue: unknown,
  candidateValue: unknown,
  scope: BenchmarkScope = completeBenchmarkScope,
) => {
  const base = parseComparableRun(baseValue, scope)
  const candidate = parseComparableRun(candidateValue, scope)
  requireEvidence(
    base.fixtureVersion === candidate.fixtureVersion &&
      base.harnessSha256 === candidate.harnessSha256 &&
      base.runner === candidate.runner,
  )
  for (const field of ['configuration', 'environment'] as const) {
    requireEvidence(
      Object.entries(base.benchmark[field]).every(([key, value]) => object(candidate.benchmark[field])[key] === value),
    )
  }
  requireEvidence(JSON.stringify(fixtureIdentity(base)) === JSON.stringify(fixtureIdentity(candidate)))
  const results = base.benchmark.cases.flatMap((entry, index) => {
    const next = candidate.benchmark.cases[index]
    requireEvidence(next)
    const operations = (scope.find(item => item.records === entry.records)?.operations ?? []).flatMap(operation => {
      const before = entry.operations[operation]
      const after = next.operations[operation]
      return before && after
        ? [
            compareMetric(
              `${entry.records}:${operation}`,
              'totalMs.median',
              rawStatistic(before.totalMs.samples, 'median'),
              rawStatistic(after.totalMs.samples, 'median'),
              15,
            ),
            compareMetric(
              `${entry.records}:${operation}`,
              'totalMs.p95',
              rawStatistic(before.totalMs.samples, 'p95'),
              rawStatistic(after.totalMs.samples, 'p95'),
              25,
            ),
            compareMetric(
              `${entry.records}:${operation}`,
              'peakRssBytes.maximum',
              before.peakRssBytes.maximum,
              after.peakRssBytes.maximum,
              20,
            ),
          ]
        : []
    })
    return [
      ...operations,
      compareMetric(`${entry.records}:cache`, 'totalBytes', entry.cache.totalBytes, next.cache.totalBytes, 10),
    ]
  })
  const packageResults = (['javascriptBytes', 'declarationBytes', 'tarballBytes'] as const).flatMap(metric =>
    base.package && candidate.package
      ? [compareMetric('package', metric, base.package[metric], candidate.package[metric], 10)]
      : [],
  )
  const startupResults = (['help', 'version'] as const).flatMap(operation => {
    const before = base.startup?.[operation]
    const after = candidate.startup?.[operation]
    return before && after
      ? [
          compareMetric(
            `cli:${operation}`,
            'totalMs.median',
            rawStatistic(before, 'median'),
            rawStatistic(after, 'median'),
            15,
          ),
          compareMetric(`cli:${operation}`, 'totalMs.p95', rawStatistic(before, 'p95'), rawStatistic(after, 'p95'), 25),
        ]
      : []
  })
  const all = [...results, ...packageResults, ...startupResults]
  return {
    baseCommit: base.commit,
    candidateCommit: candidate.commit,
    configuration: base.benchmark.configuration,
    environment: base.benchmark.environment,
    fixtureVersion: base.fixtureVersion,
    harnessSha256: base.harnessSha256,
    metrics: all,
    passed: all.every(metric => metric.passed),
    runner: base.runner,
    schemaVersion: 1,
    spread: { base: runSpread(base, scope), candidate: runSpread(candidate, scope) },
    thresholds: { bytesPercent: 10, medianLatencyPercent: 15, p95LatencyPercent: 25, peakRssPercent: 20 },
  }
}
