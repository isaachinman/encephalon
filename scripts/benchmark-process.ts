import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { BenchmarkOperation, BenchmarkWorkerResult } from './benchmark-model.ts'

type RunBenchmarkWorkerOptions = {
  operation: BenchmarkOperation
  records: number
  root: string
  signal?: AbortSignal
  timeoutMilliseconds: number
  workerPath: string
}

const maximumOutputBytes = 16 * 1024
const phaseToleranceMilliseconds = 0.01

const validFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isValidWorkerResult = (message: unknown, nonce: string): message is BenchmarkWorkerResult => {
  if (typeof message !== 'object' || message === null) {
    return false
  }
  const candidate = message as Partial<BenchmarkWorkerResult>
  const { sample } = candidate
  if (
    candidate.nonce !== nonce ||
    !Number.isSafeInteger(candidate.processId) ||
    (candidate.processId ?? 0) <= 0 ||
    typeof sample !== 'object' ||
    sample === null
  ) {
    return false
  }
  const nonNegative = [sample.overheadMs, sample.preparationIntegrityMs, sample.queryProjectionMs, sample.totalMs]
  const validTimings = nonNegative.every(metric => validFinite(metric) && metric >= 0)
  const validPeak = Number.isSafeInteger(sample.peakRssBytes) && sample.peakRssBytes >= 0
  if (!(validTimings && validPeak && Number.isSafeInteger(sample.rssDeltaBytes))) {
    return false
  }
  const phaseTotal = sample.preparationIntegrityMs + sample.queryProjectionMs + sample.overheadMs
  return Math.abs(sample.totalMs - phaseTotal) < phaseToleranceMilliseconds
}

const workerContext = ({ operation, records }: RunBenchmarkWorkerOptions) =>
  `Benchmark ${operation} for ${records} records`

export const runBenchmarkWorker = async (options: RunBenchmarkWorkerOptions): Promise<BenchmarkWorkerResult> => {
  if (options.signal?.aborted === true) {
    throw new Error(`${workerContext(options)} was aborted.`)
  }
  const nonce = randomUUID()
  const child = fork(options.workerPath, [], {
    env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
    execArgv: [],
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let messages = 0
  let result: BenchmarkWorkerResult | undefined
  let standardOutputBytes = 0
  let timedOut = false
  let aborted = false
  let childError: Error | undefined
  let sendError: Error | undefined

  const abort = () => {
    aborted = true
    child.kill('SIGKILL')
  }
  options.signal?.addEventListener('abort', abort, { once: true })

  child.stdout?.on('data', chunk => {
    standardOutputBytes = Math.min(maximumOutputBytes, standardOutputBytes + Buffer.byteLength(chunk as Buffer))
  })
  child.stderr?.on('data', () => undefined)
  child.on('message', value => {
    messages += 1
    if (messages === 1 && isValidWorkerResult(value, nonce)) {
      result = value
    }
  })

  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', error => {
      childError = error
    })
    child.once('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abort)
      resolve({ code, signal })
    })
  })
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, options.timeoutMilliseconds)

  try {
    try {
      child.send({ nonce, operation: options.operation, records: options.records, root: options.root }, error => {
        if (error !== null) {
          sendError = error
        }
      })
    } catch (error) {
      sendError = error instanceof Error ? error : new Error('Unknown IPC send failure.')
    }
    const closed = await close
    if (timedOut) {
      throw new Error(`${workerContext(options)} timed out after ${options.timeoutMilliseconds} ms.`)
    }
    if (aborted) {
      throw new Error(`${workerContext(options)} was aborted.`)
    }
    if (childError !== undefined || sendError !== undefined) {
      throw new Error(`${workerContext(options)} could not start or receive its request.`)
    }
    if (closed.code !== 0 || closed.signal !== null) {
      const exit = closed.signal === null ? `code ${String(closed.code)}` : `signal ${closed.signal}`
      const timing = messages === 0 ? 'before' : 'after'
      throw new Error(`${workerContext(options)} exited with ${exit} ${timing} producing a result.`)
    }
    if (messages > 1) {
      throw new Error(`${workerContext(options)} returned more than one worker result.`)
    }
    if (messages !== 1 || result === undefined) {
      throw new Error(`${workerContext(options)} returned an invalid worker result.`)
    }
    if (standardOutputBytes > 0) {
      throw new Error(`${workerContext(options)} wrote unexpected stdout.`)
    }
    return result
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
