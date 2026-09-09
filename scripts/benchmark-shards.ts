import { type BenchmarkOperation, benchmarkOperations } from './benchmark-model.ts'

export type BenchmarkScope = { records: number; operations: readonly BenchmarkOperation[] }[]

export const completeBenchmarkScope: BenchmarkScope = [0, 1, 100, 1000].map(records => ({
  operations: benchmarkOperations,
  records,
}))

const expensive = ['gather', 'largePayloadSearch', 'maximumPayloadSearch'] as const
const remaining = benchmarkOperations.filter(operation => !expensive.some(value => value === operation))
const withoutColdHydrate = benchmarkOperations.filter(operation => operation !== 'coldHydrate')

// Each expensive workload retains all samples on one runner, alongside its exact base.
export const benchmarkShards: Record<string, BenchmarkScope> = {
  empty: [{ operations: withoutColdHydrate, records: 0 }],
  'empty-cold': [{ operations: ['coldHydrate'], records: 0 }],
  'large-gather': [{ operations: ['gather'], records: 1000 }],
  'large-maximum': [{ operations: ['maximumPayloadSearch'], records: 1000 }],
  'large-payload': [{ operations: ['largePayloadSearch'], records: 1000 }],
  'large-preparation': [{ operations: remaining.slice(0, 3), records: 1000 }],
  'large-reads': [{ operations: remaining.slice(3, 6), records: 1000 }],
  'large-validation': [{ operations: remaining.slice(6), records: 1000 }],
  medium: [{ operations: benchmarkOperations.filter(operation => operation !== 'maximumPayloadSearch'), records: 100 }],
  'medium-maximum': [{ operations: ['maximumPayloadSearch'], records: 100 }],
  small: [{ operations: withoutColdHydrate, records: 1 }],
  'small-cold': [{ operations: ['coldHydrate'], records: 1 }],
}

export const benchmarkRepetitions = (shard: string): number =>
  shard === 'empty-cold' || shard === 'small-cold' ? 100 : 20

// Package evidence remains with the ordinary empty-corpus operations, not the isolated cold-hydration lane.
export const includesPackedBenchmarks = (scope: BenchmarkScope): boolean =>
  scope.some(entry => entry.records === 0 && entry.operations.some(operation => operation !== 'coldHydrate'))

export const benchmarkScope = (shard?: string): BenchmarkScope => {
  const scope = shard === undefined ? completeBenchmarkScope : benchmarkShards[shard]
  if (scope) {
    return scope
  }
  throw new Error('Unknown benchmark shard.')
}
