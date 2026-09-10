import { type BenchmarkOperation, benchmarkOperations } from './benchmark-model.ts'

export type BenchmarkScope = { records: number; operations: readonly BenchmarkOperation[] }[]

export const completeBenchmarkScope: BenchmarkScope = [{ operations: benchmarkOperations, records: 1000 }]

const expensive = ['gather', 'largePayloadSearch', 'maximumPayloadSearch'] as const
const remaining = benchmarkOperations.filter(operation => !expensive.some(value => value === operation))

// Each expensive workload retains all samples on one runner, alongside its exact base.
export const benchmarkShards: Record<string, BenchmarkScope> = {
  'large-gather': [{ operations: ['gather'], records: 1000 }],
  'large-maximum': [{ operations: ['maximumPayloadSearch'], records: 1000 }],
  'large-payload': [{ operations: ['largePayloadSearch'], records: 1000 }],
  'large-preparation': [{ operations: remaining.slice(0, 3), records: 1000 }],
  'large-reads': [{ operations: remaining.slice(3, 6), records: 1000 }],
  'large-validation': [{ operations: remaining.slice(6), records: 1000 }],
}

export const benchmarkRepetitions = 20

// The reads shard (or a complete local comparison) owns package evidence exactly once.
export const includesPackedBenchmarks = (scope: BenchmarkScope): boolean =>
  scope.some(entry => entry.records === 1000 && entry.operations.includes('list'))

export const benchmarkScope = (shard?: string): BenchmarkScope => {
  const scope = shard === undefined ? completeBenchmarkScope : benchmarkShards[shard]
  if (scope) {
    return scope
  }
  throw new Error('Unknown benchmark shard.')
}
