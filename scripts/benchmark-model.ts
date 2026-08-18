import { MAX_CANONICAL_RECORDS } from '../src/records.ts'

export const benchmarkOperations = [
  'coldHydrate',
  'unchangedPrepare',
  'stalePrepare',
  'list',
  'show',
  'compactSearch',
  'fullSearch',
  'gather',
] as const

export type BenchmarkOperation = (typeof benchmarkOperations)[number]
export type BenchmarkProfile = 'baseline' | 'ci' | 'custom' | 'full'
export type DistributionStatistic = 'maximum' | 'median' | 'p95'

export type BenchmarkSample = {
  overheadMs: number
  peakRssBytes: number
  preparationIntegrityMs: number
  queryProjectionMs: number
  rssDeltaBytes: number
  totalMs: number
}

export type BenchmarkWorkerResult = {
  nonce: string
  processId: number
  sample: BenchmarkSample
}

export type Distribution = {
  count: number
  maximum: number
  median: number
  p95: number
  samples: number[]
}

export type OperationDistributions = {
  overheadMs: Distribution
  peakRssBytes: Distribution
  preparationIntegrityMs: Distribution
  queryProjectionMs: Distribution
  rssDeltaBytes: Distribution
  totalMs: Distribution
}

export type CacheMetric = {
  amplification: number | null
  databaseBytes: number
  shmBytes: number
  totalBytes: number
  walBytes: number
}

export type BenchmarkCase = {
  artifacts: number
  cache: CacheMetric
  canonicalJsonBytes: number
  largePayloads: number
  operations: Record<BenchmarkOperation, OperationDistributions | null>
  records: number
  supersessionDepth: number
}

export type BenchmarkReport = {
  cases: BenchmarkCase[]
  configuration: {
    repetitions: number
    timeoutMilliseconds: number
    warmups: number
  }
  environment: {
    arch: string
    cpu: string | null
    node: string
    platform: string
  }
  generatedAt: string
  memory: {
    peakRssBytes: string
    rssDeltaBytes: string
  }
  profile: BenchmarkProfile
  schemaVersion: 2
}

type OperationBudget = Partial<Record<keyof BenchmarkSample, Partial<Record<DistributionStatistic, number>>>>

type CacheBudget = Partial<Record<keyof CacheMetric, { maximum: number }>>

export type PerformanceBudget = {
  cases: Array<{
    cache?: CacheBudget
    operations?: Partial<Record<BenchmarkOperation, OperationBudget>>
    records: number
  }>
  schemaVersion: 2
}

export type BenchmarkArguments = {
  budget: string | undefined
  output: string | undefined
  profile: BenchmarkProfile
  records: number[]
  repetitions: number
  timeoutMilliseconds: number
  warmups: number
}

const summaryPrecision = 3
const defaultTimeoutMilliseconds = 30_000
const distributionStatistics = ['maximum', 'median', 'p95'] as const
const sampleMetrics = [
  'overheadMs',
  'peakRssBytes',
  'preparationIntegrityMs',
  'queryProjectionMs',
  'rssDeltaBytes',
  'totalMs',
] as const
const cacheMetrics = ['amplification', 'databaseBytes', 'shmBytes', 'totalBytes', 'walBytes'] as const

const profileDefaults = {
  baseline: { records: [0, 100], repetitions: 3, warmups: 1 },
  ci: { records: [0, 100], repetitions: 1, warmups: 0 },
  full: { records: [0, 100, MAX_CANONICAL_RECORDS], repetitions: 5, warmups: 2 },
} as const

const roundSummary = (value: number) => Number(value.toFixed(summaryPrecision))

export const summarizeDistribution = (samples: number[]): Distribution => {
  if (samples.length === 0 || samples.some(value => !Number.isFinite(value))) {
    throw new Error('A benchmark distribution requires finite measured samples.')
  }
  const sorted = samples.toSorted((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : (sorted[middle] as number)
  const p95Index = Math.ceil(0.95 * sorted.length) - 1
  return {
    count: samples.length,
    maximum: roundSummary(sorted.at(-1) as number),
    median: roundSummary(median),
    p95: roundSummary(sorted[p95Index] as number),
    samples: [...samples],
  }
}

export const summarizeSamples = (samples: BenchmarkSample[]): OperationDistributions => ({
  overheadMs: summarizeDistribution(samples.map(sample => sample.overheadMs)),
  peakRssBytes: summarizeDistribution(samples.map(sample => sample.peakRssBytes)),
  preparationIntegrityMs: summarizeDistribution(samples.map(sample => sample.preparationIntegrityMs)),
  queryProjectionMs: summarizeDistribution(samples.map(sample => sample.queryProjectionMs)),
  rssDeltaBytes: summarizeDistribution(samples.map(sample => sample.rssDeltaBytes)),
  totalMs: summarizeDistribution(samples.map(sample => sample.totalMs)),
})

export const collectMeasuredSamples = async (
  warmups: number,
  repetitions: number,
  run: (index: number) => BenchmarkSample | Promise<BenchmarkSample>,
): Promise<BenchmarkSample[]> => {
  const samples: BenchmarkSample[] = []
  for (const index of Array.from({ length: warmups + repetitions }, (_, value) => value)) {
    // biome-ignore lint/performance/noAwaitInLoops: benchmark samples must execute sequentially to avoid contention.
    const sample = await run(index)
    if (index >= warmups) {
      samples.push(sample)
    }
  }
  return samples
}

const parseProfile = (value: string): Exclude<BenchmarkProfile, 'custom'> => {
  if (value === 'baseline' || value === 'ci' || value === 'full') {
    return value
  }
  throw new Error(`Unknown benchmark profile: ${value}.`)
}

const parseInteger = (option: string, value: string, allowZero: boolean): number => {
  const parsed = Number(value)
  const valid = Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0)
  if (!valid) {
    throw new Error(`Invalid ${option} value: ${value}.`)
  }
  return parsed
}

const readOptionValue = (arguments_: string[], index: number, option: string): string => {
  const value = arguments_[index + 1]
  if (value !== undefined) {
    return value
  }
  throw new Error(`Missing value for ${option}.`)
}

const splitLongOption = (argument: string): { name: string; value?: string } => {
  const separator = argument.startsWith('--') ? argument.indexOf('=') : -1
  if (separator > 2) {
    return { name: argument.slice(0, separator), value: argument.slice(separator + 1) }
  }
  return { name: argument }
}

export const parseBenchmarkArguments = (arguments_: string[]): BenchmarkArguments => {
  let budget: string | undefined
  let output: string | undefined
  let selectedProfile: Exclude<BenchmarkProfile, 'custom'> = 'baseline'
  let repetitions: number | undefined
  let timeoutMilliseconds: number | undefined
  let warmups: number | undefined
  const records: number[] = []

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] as string
    const { name: option, value: inlineValue } = splitLongOption(argument)
    const optionValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue
      }
      const value = readOptionValue(arguments_, index, option)
      index += 1
      return value
    }
    if (option === '--budget') {
      budget = optionValue()
    } else if (option === '--output' || option === '-o') {
      output = optionValue()
    } else if (option === '--profile') {
      selectedProfile = parseProfile(optionValue())
    } else if (option === '--records') {
      const value = optionValue()
      const parsed = parseInteger(option, value, true)
      if (records.includes(parsed)) {
        throw new Error(`Duplicate --records value: ${parsed}.`)
      }
      records.push(parsed)
    } else if (option === '--repetitions') {
      repetitions = parseInteger(option, optionValue(), false)
    } else if (option === '--timeout-ms') {
      timeoutMilliseconds = parseInteger(option, optionValue(), false)
    } else if (option === '--warmups') {
      warmups = parseInteger(option, optionValue(), true)
    } else {
      throw new Error(`Unknown benchmark option: ${option}.`)
    }
  }

  const defaults = profileDefaults[selectedProfile]
  return {
    budget,
    output,
    profile: records.length > 0 ? 'custom' : selectedProfile,
    records: records.length > 0 ? records : [...defaults.records],
    repetitions: repetitions ?? defaults.repetitions,
    timeoutMilliseconds: timeoutMilliseconds ?? defaultTimeoutMilliseconds,
    warmups: warmups ?? defaults.warmups,
  }
}

const objectValue = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error(`${context} must be an object.`)
}

const assertKnownKeys = (value: Record<string, unknown>, keys: readonly string[], context: string): void => {
  const unknown = Object.keys(value).find(key => !keys.includes(key))
  if (unknown !== undefined) {
    throw new Error(`Unknown ${context}: ${unknown}.`)
  }
}

const assertMaximum = (value: unknown, context: string): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a finite non-negative number.`)
  }
}

const assertOperationBudget = (value: unknown, operation: string): void => {
  const metrics = objectValue(value, `Benchmark budget operation ${operation}`)
  assertKnownKeys(metrics, sampleMetrics, 'benchmark budget metric')
  if (Object.keys(metrics).length === 0) {
    throw new Error(`Benchmark budget operation ${operation} must configure a metric.`)
  }
  for (const [metric, statisticsValue] of Object.entries(metrics)) {
    const statistics = objectValue(statisticsValue, `Benchmark budget ${operation}.${metric}`)
    assertKnownKeys(statistics, distributionStatistics, 'benchmark budget statistic')
    if (Object.keys(statistics).length === 0) {
      throw new Error(`Benchmark budget ${operation}.${metric} must configure a statistic.`)
    }
    for (const [statistic, maximum] of Object.entries(statistics)) {
      assertMaximum(maximum, `Benchmark budget ${operation}.${metric}.${statistic}`)
    }
  }
}

const assertCacheBudget = (value: unknown): void => {
  const metrics = objectValue(value, 'Benchmark cache budget')
  assertKnownKeys(metrics, cacheMetrics, 'benchmark cache budget metric')
  if (Object.keys(metrics).length === 0) {
    throw new Error('Benchmark cache budget must configure a metric.')
  }
  for (const [metric, limitValue] of Object.entries(metrics)) {
    const limit = objectValue(limitValue, `Benchmark cache budget ${metric}`)
    assertKnownKeys(limit, ['maximum'], 'benchmark cache budget statistic')
    if (!('maximum' in limit)) {
      throw new Error(`Benchmark cache budget ${metric} must configure maximum.`)
    }
    assertMaximum(limit.maximum, `Benchmark cache budget ${metric}.maximum`)
  }
}

const assertBudgetShape = (budget: unknown): Record<string, unknown> => {
  if (typeof budget !== 'object' || budget === null || !('schemaVersion' in budget)) {
    throw new Error('Benchmark budget must be an object with schemaVersion 2.')
  }
  const { schemaVersion } = budget
  if (schemaVersion !== 2) {
    throw new Error(`Unsupported benchmark budget schemaVersion ${String(schemaVersion)}; expected 2.`)
  }
  if (!('cases' in budget && Array.isArray(budget.cases))) {
    throw new Error('Benchmark budget cases must be an array.')
  }
  const object = budget as Record<string, unknown>
  assertKnownKeys(object, ['cases', 'schemaVersion'], 'benchmark budget field')
  return object
}

export const parsePerformanceBudget = (value: unknown, records: number[]): PerformanceBudget => {
  const budget = assertBudgetShape(value)
  const cases = budget.cases as unknown[]
  const seenRecords = new Set<number>()
  for (const caseValue of cases) {
    const entry = objectValue(caseValue, 'Benchmark budget case')
    assertKnownKeys(entry, ['cache', 'operations', 'records'], 'benchmark budget case field')
    if (!Number.isSafeInteger(entry.records) || (entry.records as number) < 0) {
      throw new Error('Benchmark budget case records must be a non-negative integer.')
    }
    const caseRecords = entry.records as number
    if (seenRecords.has(caseRecords)) {
      throw new Error(`Benchmark budget has duplicate cases for ${caseRecords} records.`)
    }
    seenRecords.add(caseRecords)
    if (entry.cache !== undefined) {
      assertCacheBudget(entry.cache)
    }
    if (entry.operations !== undefined) {
      const operations = objectValue(entry.operations, 'Benchmark operation budgets')
      assertKnownKeys(operations, benchmarkOperations, 'benchmark budget operation')
      if (Object.keys(operations).length === 0) {
        throw new Error('Benchmark operation budgets must configure an operation.')
      }
      for (const [operation, operationBudget] of Object.entries(operations)) {
        if (caseRecords === 0 && operation === 'stalePrepare') {
          throw new Error('Benchmark budget configures unavailable stalePrepare for 0 records.')
        }
        assertOperationBudget(operationBudget, operation)
      }
    }
    if (entry.cache === undefined && entry.operations === undefined) {
      throw new Error(`Benchmark budget case for ${caseRecords} records must configure a limit.`)
    }
  }
  for (const requestedRecords of records) {
    if (!seenRecords.has(requestedRecords)) {
      throw new Error(`Performance budget has no case for ${requestedRecords} records.`)
    }
  }
  return value as PerformanceBudget
}

export const assertPerformanceBudget = (report: BenchmarkReport, budgetValue: unknown): void => {
  const budget = parsePerformanceBudget(
    budgetValue,
    report.cases.map(result => result.records),
  )
  const failures: string[] = []
  for (const result of report.cases) {
    const expected = budget.cases.find(entry => entry.records === result.records)
    if (expected !== undefined) {
      for (const [operation, metrics] of Object.entries(expected.operations ?? {})) {
        const actualOperation = result.operations[operation as BenchmarkOperation]
        if (actualOperation === undefined || actualOperation === null) {
          throw new Error(`Benchmark report has no ${operation} result for ${result.records} records.`)
        }
        if (metrics !== undefined) {
          for (const [metric, statistics] of Object.entries(metrics)) {
            const actualDistribution = actualOperation[metric as keyof BenchmarkSample]
            for (const [statistic, maximum] of Object.entries(statistics ?? {})) {
              const actual = actualDistribution[statistic as DistributionStatistic]
              if (typeof maximum === 'number' && actual > maximum) {
                failures.push(
                  `${result.records} records ${operation}.${metric}.${statistic}: actual ${actual} exceeds budget ${maximum}.`,
                )
              }
            }
          }
        }
      }
      for (const [metric, limit] of Object.entries(expected.cache ?? {})) {
        const actual = result.cache[metric as keyof CacheMetric]
        if (actual === null) {
          throw new Error(`Benchmark report has no cache.${metric} value for ${result.records} records.`)
        }
        if (limit !== undefined && actual > limit.maximum) {
          failures.push(
            `${result.records} records cache.${metric}.maximum: actual ${actual} exceeds budget ${limit.maximum}.`,
          )
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Performance budget exceeded:\n${failures.join('\n')}`)
  }
}
