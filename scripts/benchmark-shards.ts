import { type BenchmarkOperation, benchmarkOperations } from './benchmark-model.ts'

export type BenchmarkScope = { records: number; operations: readonly BenchmarkOperation[] }[]

export const completeBenchmarkScope: BenchmarkScope = [0, 1, 100, 1000].map(records => ({
  operations: benchmarkOperations,
  records,
}))

const expensive = ['gather', 'largePayloadSearch', 'maximumPayloadSearch'] as const
const remaining = benchmarkOperations.filter(operation => !expensive.some(value => value === operation))

// Each expensive workload retains all samples on one runner, alongside its exact base.
export const benchmarkShards: Record<string, BenchmarkScope> = {
  'large-gather': [{ operations: ['gather'], records: 1000 }],
  'large-maximum': [{ operations: ['maximumPayloadSearch'], records: 1000 }],
  'large-payload': [{ operations: ['largePayloadSearch'], records: 1000 }],
  'large-reads': [{ operations: remaining.slice(0, 6), records: 1000 }],
  'large-validation': [{ operations: remaining.slice(6), records: 1000 }],
  medium: [{ operations: benchmarkOperations.filter(operation => operation !== 'maximumPayloadSearch'), records: 100 }],
  'medium-maximum': [{ operations: ['maximumPayloadSearch'], records: 100 }],
  small: completeBenchmarkScope.filter(entry => entry.records < 100),
}

export const benchmarkScope = (shard?: string): BenchmarkScope => {
  const scope = shard === undefined ? completeBenchmarkScope : benchmarkShards[shard]
  if (scope) {
    return scope
  }
  throw new Error('Unknown benchmark shard.')
}
