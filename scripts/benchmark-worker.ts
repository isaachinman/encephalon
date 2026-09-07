import { cacheReadInstrumentation } from '../src/cache.ts'
import {
  gatherRecords,
  hydrate,
  listRecords,
  prepare,
  searchCompactRecords,
  searchRecords,
  showRecord,
  validateRecords,
} from '../src/index.ts'
import {
  type BenchmarkOperation,
  type BenchmarkSample,
  type BenchmarkWorkerResult,
  benchmarkOperations,
} from './benchmark-model.ts'
import { gatherBenchmarkInput, shownIdForBenchmarkCase } from './benchmark-workload.ts'

type WorkerRequest = {
  nonce?: unknown
  operation?: unknown
  records?: unknown
  root?: unknown
}

type ReadBoundaryState = 'awaiting-before' | 'complete' | 'not-applicable' | 'reading'

const isOperation = (value: unknown): value is BenchmarkOperation =>
  typeof value === 'string' && benchmarkOperations.some(operation => operation === value)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type OperationRunner = (records: number, root: string) => unknown
type ResultValidator = (records: number, result: unknown) => boolean

const operationRunners: Record<BenchmarkOperation, OperationRunner> = {
  coldHydrate: (_records, root) => hydrate({ root }),
  compactSearch: (_records, root) => searchCompactRecords({ limit: 20, query: 'benchmark needle', root }),
  fullSearch: (_records, root) => searchRecords({ limit: 20, query: 'benchmark needle', root }),
  gather: (records, root) => gatherRecords({ root, ...gatherBenchmarkInput(records) }),
  largePayloadSearch: (_records, root) => searchCompactRecords({ query: 'large payload', root }),
  list: (_records, root) => listRecords({ limit: 20, root }),
  listMaximum: (_records, root) => listRecords({ limit: 1000, root }),
  maximumPayloadSearch: (_records, root) => searchCompactRecords({ query: 'maximum preview', root }),
  missingSearch: (_records, root) => searchCompactRecords({ query: 'absentuniqueneedle', root }),
  payloadOnlySearch: (_records, root) => searchCompactRecords({ query: 'deepuniqueneedle', root }),
  show: (records, root) => showRecord({ id: shownIdForBenchmarkCase(records), root }),
  stalePrepare: (_records, root) => prepare({ root }),
  strictCacheValidation: (_records, root) => listRecords({ limit: 1, root }),
  unchangedPrepare: (_records, root) => prepare({ root }),
  validateArtifacts: (_records, root) => validateRecords({ root }),
}

const hasExpectedResultCardinality = (records: number, result: unknown): boolean =>
  Array.isArray(result) && (records === 0 ? result.length === 0 : result.length > 0)

const activeCount = (records: number) => (records === 0 ? 0 : records - Math.max(1, Math.floor(records * 0.1)) + 1)

const hasMaximumPayloadMatch = (records: number, result: unknown): boolean =>
  Array.isArray(result) &&
  result.length === (records >= 4 ? 1 : 0) &&
  result.every(
    entry =>
      isObject(entry) &&
      entry.id === `small-${String(records - 1).padStart(5, '0')}` &&
      typeof entry.snippet === 'string' &&
      entry.snippet.length > 0,
  )

const hasExpectedGatherResult = (records: number, result: unknown): boolean => {
  const input = gatherBenchmarkInput(records)
  return (
    isObject(result) &&
    result.hydrated === null &&
    Array.isArray(result.searches) &&
    result.searches.length === input.searches.length &&
    result.searches.every((entry, index) => isObject(entry) && entry.query === input.searches[index]) &&
    Array.isArray(result.records) &&
    result.records.length === input.shows.length &&
    result.records.every((entry, index) => isObject(entry) && entry.id === input.shows[index])
  )
}

const resultValidators: Record<BenchmarkOperation, ResultValidator> = {
  coldHydrate: (records, result) => isObject(result) && result.recordsIndexed === records,
  compactSearch: hasExpectedResultCardinality,
  fullSearch: hasExpectedResultCardinality,
  gather: hasExpectedGatherResult,
  largePayloadSearch: (records, result) =>
    Array.isArray(result) && (records < 2 ? result.length === 0 : result.length > 0),
  list: (records, result) => Array.isArray(result) && result.length === Math.min(20, activeCount(records)),
  listMaximum: (records, result) => Array.isArray(result) && result.length === activeCount(records),
  maximumPayloadSearch: hasMaximumPayloadMatch,
  missingSearch: (_records, result) => Array.isArray(result) && result.length === 0,
  payloadOnlySearch: hasMaximumPayloadMatch,
  show: (records, result) =>
    records === 0 ? result === null : isObject(result) && result.id === shownIdForBenchmarkCase(records),
  stalePrepare: (records, result) => isObject(result) && result.recordsIndexed === records && result.hydrated === true,
  strictCacheValidation: (records, result) => Array.isArray(result) && result.length === Math.min(1, records),
  unchangedPrepare: (records, result) =>
    isObject(result) && result.recordsIndexed === records && result.hydrated === false,
  validateArtifacts: (records, result) =>
    isObject(result) && result.valid === true && result.recordsChecked === records,
}

const runOperation = (operation: BenchmarkOperation, records: number, root: string): unknown =>
  operationRunners[operation](records, root)

const assertOperationResult = (operation: BenchmarkOperation, records: number, result: unknown): void => {
  if (!resultValidators[operation](records, result)) {
    throw new Error(`The ${operation} benchmark returned an unexpected result.`)
  }
}

const measure = (operation: BenchmarkOperation, records: number, root: string): BenchmarkSample => {
  const startingRss = process.memoryUsage().rss
  const start = performance.now()
  const preparationOnly =
    operation === 'coldHydrate' || operation.endsWith('Prepare') || operation === 'validateArtifacts'
  const boundary: { state: ReadBoundaryState } = {
    state: preparationOnly ? 'not-applicable' : 'awaiting-before',
  }
  let integrityValidations = 0
  let resultReadStart: number | undefined
  let resultReadEnd: number | undefined
  if (!preparationOnly) {
    cacheReadInstrumentation.afterIntegrityValidation = () => {
      integrityValidations += 1
    }
    cacheReadInstrumentation.beforeResultRead = () => {
      if (boundary.state !== 'awaiting-before') {
        throw new Error(`The ${operation} benchmark repeated its read boundary.`)
      }
      resultReadStart = performance.now()
      boundary.state = 'reading'
    }
    cacheReadInstrumentation.afterResultRead = () => {
      if (boundary.state !== 'reading') {
        throw new Error(`The ${operation} benchmark reported read boundaries out of order.`)
      }
      resultReadEnd = performance.now()
      boundary.state = 'complete'
    }
  }
  let result: unknown
  let end: number
  try {
    result = runOperation(operation, records, root)
    end = performance.now()
  } finally {
    cacheReadInstrumentation.afterIntegrityValidation = undefined
    cacheReadInstrumentation.beforeResultRead = undefined
    cacheReadInstrumentation.afterResultRead = undefined
  }
  if (boundary.state !== 'complete' && boundary.state !== 'not-applicable') {
    throw new Error(`The ${operation} benchmark did not report a complete read boundary.`)
  }
  if (!preparationOnly && integrityValidations !== 1) {
    throw new Error(`The ${operation} benchmark did not validate exactly one cache generation.`)
  }
  assertOperationResult(operation, records, result)
  const endingRss = process.memoryUsage().rss
  const readStart = resultReadStart ?? end
  const readEnd = resultReadEnd ?? readStart
  return {
    overheadMs: preparationOnly ? 0 : end - readEnd,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    preparationIntegrityMs: preparationOnly ? end - start : readStart - start,
    queryProjectionMs: preparationOnly ? 0 : readEnd - readStart,
    rssDeltaBytes: endingRss - startingRss,
    totalMs: end - start,
  }
}

process.once('message', value => {
  const request = value as WorkerRequest
  if (
    typeof request.nonce !== 'string' ||
    !isOperation(request.operation) ||
    !Number.isSafeInteger(request.records) ||
    (request.records as number) < 0 ||
    typeof request.root !== 'string'
  ) {
    process.exitCode = 2
    process.disconnect()
    return
  }
  const result: BenchmarkWorkerResult = {
    nonce: request.nonce,
    processId: process.pid,
    sample: measure(request.operation, request.records as number, request.root),
  }
  if (process.send !== undefined) {
    process.send(result, () => process.disconnect())
  }
})
