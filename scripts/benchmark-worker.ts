import { cacheReadTestHooks } from '../src/cache.ts'
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

const runOperation = (operation: BenchmarkOperation, records: number, root: string): unknown => {
  const shownId = shownIdForCase(records)
  if (operation === 'coldHydrate') {
    return hydrate({ root })
  }
  if (operation === 'unchangedPrepare' || operation === 'stalePrepare') {
    return prepare({ root })
  }
  if (operation === 'list') {
    return listRecords({ limit: 20, root })
  }
  if (operation === 'show') {
    return showRecord({ id: shownId, root })
  }
  if (operation === 'compactSearch') {
    return searchCompactRecords({ limit: 20, query: 'benchmark needle', root })
  }
  if (operation === 'fullSearch') {
    return searchRecords({ limit: 20, query: 'benchmark needle', root })
  }
  return gatherRecords({
    root,
    searches: ['benchmark needle', 'large payload'],
    shows: [shownId, 'missing'],
  })
}

const assertResultCardinality = (value: unknown, records: number, operation: string): void => {
  const valid = Array.isArray(value) && (records === 0 ? value.length === 0 : value.length > 0)
  if (!valid) {
    throw new Error(`The ${operation} benchmark returned an unexpected result.`)
  }
}

const assertOperationResult = (operation: BenchmarkOperation, records: number, result: unknown): void => {
  if (operation === 'coldHydrate' || operation.endsWith('Prepare')) {
    const expectedHydrated = operation === 'stalePrepare'
    const valid =
      isObject(result) &&
      result.recordsIndexed === records &&
      (operation === 'coldHydrate' || result.hydrated === expectedHydrated)
    if (!valid) {
      throw new Error(`The ${operation} benchmark returned an unexpected result.`)
    }
  } else if (operation === 'list' || operation === 'compactSearch' || operation === 'fullSearch') {
    assertResultCardinality(result, records, operation)
  } else if (operation === 'show') {
    const valid = records === 0 ? result === null : isObject(result)
    if (!valid) {
      throw new Error('The show benchmark returned an unexpected result.')
    }
  } else {
    const valid =
      isObject(result) &&
      result.hydrated === null &&
      Array.isArray(result.searches) &&
      result.searches.length === 2 &&
      Array.isArray(result.records) &&
      result.records.length === 2
    if (!valid) {
      throw new Error('The gather benchmark returned an unexpected result.')
    }
  }
}

const measure = (operation: BenchmarkOperation, records: number, root: string): BenchmarkSample => {
  const startingRss = process.memoryUsage().rss
  const start = performance.now()
  const preparationOnly = operation === 'coldHydrate' || operation.endsWith('Prepare')
  const boundary: { state: ReadBoundaryState } = {
    state: preparationOnly ? 'not-applicable' : 'awaiting-before',
  }
  let resultReadStart: number | undefined
  let resultReadEnd: number | undefined
  if (!preparationOnly) {
    cacheReadTestHooks.beforeResultRead = () => {
      if (boundary.state !== 'awaiting-before') {
        throw new Error(`The ${operation} benchmark repeated its read boundary.`)
      }
      resultReadStart = performance.now()
      boundary.state = 'reading'
    }
    cacheReadTestHooks.afterResultRead = () => {
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
    cacheReadTestHooks.beforeResultRead = undefined
    cacheReadTestHooks.afterResultRead = undefined
  }
  if (boundary.state !== 'complete' && boundary.state !== 'not-applicable') {
    throw new Error(`The ${operation} benchmark did not report a complete read boundary.`)
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
