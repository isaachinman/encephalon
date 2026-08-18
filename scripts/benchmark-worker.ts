import { cacheReadInstrumentation } from '../src/cache.ts'
import {
  gatherRecords,
  hydrate,
  listRecords,
  prepare,
  searchCompactRecords,
  searchRecords,
  showRecord,
} from '../src/index.ts'
import {
  type BenchmarkOperation,
  type BenchmarkSample,
  type BenchmarkWorkerResult,
  benchmarkOperations,
} from './benchmark-model.ts'

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

const shownIdForCase = (records: number) => {
  if (records === 0) {
    return 'missing'
  }
  const activeChainIndex = Math.max(0, Math.floor(records * 0.1) - 1)
  return `chain-${String(activeChainIndex).padStart(5, '0')}`
}

type OperationRunner = (records: number, root: string) => unknown
type ResultValidator = (records: number, result: unknown) => boolean

const operationRunners: Record<BenchmarkOperation, OperationRunner> = {
  coldHydrate: (_records, root) => hydrate({ root }),
  compactSearch: (_records, root) => searchCompactRecords({ limit: 20, query: 'benchmark needle', root }),
  fullSearch: (_records, root) => searchRecords({ limit: 20, query: 'benchmark needle', root }),
  gather: (records, root) =>
    gatherRecords({
      root,
      searches: Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 'benchmark needle' : 'large payload')),
      shows: Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? shownIdForCase(records) : 'missing')),
    }),
  list: (_records, root) => listRecords({ limit: 20, root }),
  show: (records, root) => showRecord({ id: shownIdForCase(records), root }),
  stalePrepare: (_records, root) => prepare({ root }),
  unchangedPrepare: (_records, root) => prepare({ root }),
}

const hasExpectedResultCardinality = (records: number, result: unknown): boolean =>
  Array.isArray(result) && (records === 0 ? result.length === 0 : result.length > 0)

const resultValidators: Record<BenchmarkOperation, ResultValidator> = {
  coldHydrate: (records, result) => isObject(result) && result.recordsIndexed === records,
  compactSearch: hasExpectedResultCardinality,
  fullSearch: hasExpectedResultCardinality,
  gather: (_records, result) =>
    isObject(result) &&
    result.hydrated === null &&
    Array.isArray(result.searches) &&
    result.searches.length === 16 &&
    Array.isArray(result.records) &&
    result.records.length === 64,
  list: hasExpectedResultCardinality,
  show: (records, result) => (records === 0 ? result === null : isObject(result)),
  stalePrepare: (records, result) => isObject(result) && result.recordsIndexed === records && result.hydrated === true,
  unchangedPrepare: (records, result) =>
    isObject(result) && result.recordsIndexed === records && result.hydrated === false,
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
  const preparationOnly = operation === 'coldHydrate' || operation.endsWith('Prepare')
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
