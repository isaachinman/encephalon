import { randomUUID } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hydrate, prepare } from '../src/index.ts'
import { formatRecordFile } from '../src/schema.ts'
import type { BrainRecordFile } from '../src/types.ts'
import {
  assertPerformanceBudget,
  type BenchmarkArguments,
  type BenchmarkCase,
  type BenchmarkOperation,
  type BenchmarkReport,
  benchmarkOperations,
  type CacheMetric,
  collectMeasuredSamples,
  type PerformanceBudget,
  parseBenchmarkArguments,
  parsePerformanceBudget,
  summarizeSamples,
} from './benchmark-model.ts'
import { runBenchmarkWorker } from './benchmark-process.ts'

type CorpusFacts = {
  artifacts: number
  canonicalJsonBytes: number
  largePayloads: number
  records: number
  supersessionDepth: number
}

type CaseTemplates = {
  corpus: CorpusFacts
  prepared: string
  sampleRoot: string
  unprepared: string
}

type BenchmarkControllerOptions = {
  afterTemporaryRepositoryAllocation?: ((phase: 'repository' | 'snapshot') => void) | undefined
  signal?: AbortSignal
  temporaryParent?: string
  workerPath?: string
}

type ResolvedBenchmarkControllerOptions = {
  afterTemporaryRepositoryAllocation: ((phase: 'repository' | 'snapshot') => void) | undefined
  signal: AbortSignal | undefined
  temporaryParent: string
  workerPath: string
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultWorkerPath = join(packageRoot, 'scripts', 'benchmark-worker.ts')
const deterministicStart = Date.UTC(2026, 0, 1)

const help = `Usage: node scripts/benchmark.ts [options]

Options:
  --profile baseline|ci|full  Select corpus and sample defaults
  --records COUNT            Override corpus sizes; repeatable
  --warmups COUNT            Override discarded warmup samples
  --repetitions COUNT        Override measured samples
  --timeout-ms COUNT         Override each child timeout
  --budget PATH              Enforce a schema-version 2 budget
  --output, -o PATH          Atomically write JSON instead of stdout
  --help, -h                 Show this help
`

const round = (value: number, digits = 3) => Number(value.toFixed(digits))
const byteSize = (path: string) => (existsSync(path) ? statSync(path).size : 0)
const timestamp = (index: number) => new Date(deterministicStart + index).toISOString()

const createRepository = (
  temporaryParent: string,
  prefix: string,
  afterAllocation: BenchmarkControllerOptions['afterTemporaryRepositoryAllocation'],
) => {
  const root = mkdtempSync(join(temporaryParent, prefix))
  try {
    afterAllocation?.('repository')
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'node_modules'))
    symlinkSync(
      packageRoot,
      join(root, 'node_modules', 'encephalon'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    return root
  } catch (error) {
    rmSync(root, { force: true, recursive: true })
    throw error
  }
}

const snapshotRepository = (
  template: string,
  temporaryParent: string,
  afterAllocation: BenchmarkControllerOptions['afterTemporaryRepositoryAllocation'],
) => {
  const root = mkdtempSync(join(temporaryParent, 'encephalon-benchmark-template-'))
  try {
    afterAllocation?.('snapshot')
    cpSync(template, root, { recursive: true, verbatimSymlinks: true })
    return root
  } catch (error) {
    rmSync(root, { force: true, recursive: true })
    throw error
  }
}

const restoreRepository = (template: string, root: string): void => {
  rmSync(root, { force: true, recursive: true })
  cpSync(template, root, { recursive: true, verbatimSymlinks: true })
}

export const restoreBenchmarkSample = (template: string, root: string, operation: BenchmarkOperation): void => {
  restoreRepository(template, root)
  if (operation !== 'coldHydrate') {
    prepare({ root })
    if (operation === 'stalePrepare') {
      makePreparedRepositoryStale(root)
    }
  }
}

const writeRecord = (root: string, record: BrainRecordFile) => {
  const path = join(root, 'encephalon', record.kind, `${record.id}.json`)
  mkdirSync(dirname(path), { recursive: true })
  const content = formatRecordFile(record)
  writeFileSync(path, content, 'utf8')
  return Buffer.byteLength(content, 'utf8')
}

const largeText = (index: number) =>
  Array.from({ length: 96 }, (_, offset) => `large-payload-${index}-${offset}`).join(' ')

const createCorpus = (root: string, records: number): CorpusFacts => {
  if (records === 0) {
    mkdirSync(join(root, 'encephalon'), { recursive: true })
    return {
      artifacts: 0,
      canonicalJsonBytes: 0,
      largePayloads: 0,
      records: 0,
      supersessionDepth: 0,
    }
  }

  const supersessionDepth = Math.max(1, Math.floor(records * 0.1))
  const artifactRecords = Math.max(1, Math.floor(records * 0.1))
  const largePayloads = Math.max(1, Math.floor(records * 0.1))
  let artifacts = 0
  let generatedLargePayloads = 0
  let written = 0
  let canonicalJsonBytes = 0

  const nextRecord = (record: BrainRecordFile) => {
    canonicalJsonBytes += writeRecord(root, record)
    written += 1
  }

  for (const index of Array.from({ length: supersessionDepth }, (_, value) => value)) {
    const id = `chain-${String(index).padStart(5, '0')}`
    nextRecord({
      createdAt: timestamp(written),
      id,
      kind: 'decision',
      payload: {
        phase: index,
        summary: `Supersession checkpoint ${index}`,
      },
      searchText: `benchmark needle chain ${index}`,
      source: 'benchmark',
      subject: 'benchmark.supersession',
      ...(index === 0 ? {} : { supersedes: [`chain-${String(index - 1).padStart(5, '0')}`] }),
    })
  }

  for (const index of Array.from({ length: largePayloads }, (_, value) => value)) {
    if (written < records) {
      generatedLargePayloads += 1
      nextRecord({
        createdAt: timestamp(written),
        id: `large-${String(index).padStart(5, '0')}`,
        kind: 'context',
        payload: {
          body: largeText(index),
          detail: Array.from({ length: 16 }, (_, offset) => ({
            marker: `benchmark-large-${index}-${offset}`,
            value: largeText(offset),
          })),
          summary: `Large payload ${index}`,
        },
        searchText: `benchmark needle large ${index}`,
        source: 'benchmark',
        subject: `benchmark.large.${index}`,
      })
    }
  }

  for (const index of Array.from({ length: artifactRecords }, (_, value) => value)) {
    if (written < records) {
      artifacts += 1
      const id = `artifact-${String(index).padStart(5, '0')}`
      const artifact = `_artifacts/architecture/${id}/evidence-${index}.txt`
      const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
      mkdirSync(dirname(artifactPath), { recursive: true })
      writeFileSync(artifactPath, `artifact evidence ${index}\n${largeText(index).slice(0, 512)}\n`, 'utf8')
      nextRecord({
        artifacts: [artifact],
        createdAt: timestamp(written),
        id,
        kind: 'architecture',
        payload: { summary: `Artifact record ${index}` },
        searchText: `benchmark needle artifact ${index}`,
        source: 'benchmark',
        subject: `benchmark.artifact.${index}`,
      })
    }
  }

  while (written < records) {
    const index = written
    nextRecord({
      createdAt: timestamp(written),
      id: `small-${String(index).padStart(5, '0')}`,
      kind: 'context',
      payload: {
        detail: `Small deterministic record ${index}`,
        summary: `Small record ${index}`,
      },
      searchText: `benchmark needle small ${index}`,
      source: 'benchmark',
      subject: `benchmark.small.${index}`,
    })
  }

  return {
    artifacts,
    canonicalJsonBytes,
    largePayloads: generatedLargePayloads,
    records,
    supersessionDepth,
  }
}

const cacheMetric = (root: string, canonicalJsonBytes: number): CacheMetric => {
  const cacheDirectory = join(root, 'node_modules', '.cache', 'encephalon')
  const databasePath = join(cacheDirectory, 'brain.sqlite')
  const databaseBytes = byteSize(databasePath)
  const walBytes = byteSize(`${databasePath}-wal`)
  const shmBytes = byteSize(`${databasePath}-shm`)
  const totalBytes = databaseBytes + walBytes + shmBytes
  return {
    amplification: canonicalJsonBytes === 0 ? null : round(totalBytes / canonicalJsonBytes),
    databaseBytes,
    shmBytes,
    totalBytes,
    walBytes,
  }
}

export const makePreparedRepositoryStale = (root: string): void => {
  const path = join(root, 'encephalon', 'decision', 'chain-00000.json')
  const content = readFileSync(path, 'utf8')
  const stale = content.replace('benchmark needle chain 0', 'benchmark stale needle chain 0')
  if (stale === content) {
    throw new Error('Unable to establish the stale benchmark case.')
  }
  writeFileSync(path, stale, 'utf8')
}

const createCaseTemplates = (
  records: number,
  temporaryParent: string,
  afterAllocation: BenchmarkControllerOptions['afterTemporaryRepositoryAllocation'],
): CaseTemplates => {
  const sampleRoot = createRepository(temporaryParent, 'encephalon-benchmark-sample-', afterAllocation)
  let unprepared: string | undefined
  let prepared: string | undefined
  try {
    const corpus = createCorpus(sampleRoot, records)
    unprepared = snapshotRepository(sampleRoot, temporaryParent, afterAllocation)
    hydrate({ root: sampleRoot })
    prepared = snapshotRepository(sampleRoot, temporaryParent, afterAllocation)
    return { corpus, prepared, sampleRoot, unprepared }
  } catch (error) {
    rmSync(sampleRoot, { force: true, recursive: true })
    if (unprepared !== undefined) {
      rmSync(unprepared, { force: true, recursive: true })
    }
    if (prepared !== undefined) {
      rmSync(prepared, { force: true, recursive: true })
    }
    throw error
  }
}

const templateForOperation = (operation: BenchmarkOperation, templates: CaseTemplates) =>
  operation === 'coldHydrate' ? templates.unprepared : templates.prepared

const runOperationSamples = async (
  operation: BenchmarkOperation,
  records: number,
  templates: CaseTemplates,
  configuration: BenchmarkArguments,
  options: ResolvedBenchmarkControllerOptions,
) => {
  const samples = await collectMeasuredSamples(configuration.warmups, configuration.repetitions, async () => {
    if (options.signal?.aborted === true) {
      throw new Error(`Benchmark ${operation} for ${records} records was aborted.`)
    }
    const root = templates.sampleRoot
    restoreBenchmarkSample(templateForOperation(operation, templates), root, operation)
    try {
      const result = await runBenchmarkWorker({
        operation,
        records,
        root,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMilliseconds: configuration.timeoutMilliseconds,
        workerPath: options.workerPath,
      })
      return result.sample
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
  return summarizeSamples(samples)
}

const runCase = async (
  records: number,
  configuration: BenchmarkArguments,
  options: ResolvedBenchmarkControllerOptions,
): Promise<BenchmarkCase> => {
  const templates = createCaseTemplates(records, options.temporaryParent, options.afterTemporaryRepositoryAllocation)
  try {
    const operationEntries: Array<
      readonly [BenchmarkOperation, Awaited<ReturnType<typeof runOperationSamples>> | null]
    > = []
    for (const operation of benchmarkOperations) {
      const distributions =
        operation === 'stalePrepare' && records === 0
          ? null
          : // biome-ignore lint/performance/noAwaitInLoops: operations share one sample path and must remain sequential.
            await runOperationSamples(operation, records, templates, configuration, options)
      operationEntries.push([operation, distributions])
    }
    return {
      ...templates.corpus,
      cache: cacheMetric(templates.prepared, templates.corpus.canonicalJsonBytes),
      operations: Object.fromEntries(operationEntries) as BenchmarkCase['operations'],
    }
  } finally {
    rmSync(templates.prepared, { force: true, recursive: true })
    rmSync(templates.sampleRoot, { force: true, recursive: true })
    rmSync(templates.unprepared, { force: true, recursive: true })
  }
}

const loadBudget = (path: string | undefined, records: number[]): PerformanceBudget | undefined => {
  if (path !== undefined) {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(resolve(path), 'utf8'))
    } catch (error) {
      throw new Error('Unable to read the benchmark budget.', { cause: error })
    }
    return parsePerformanceBudget(value, records)
  }
}

const runConfiguredBenchmark = async (
  configuration: BenchmarkArguments,
  controllerOptions: BenchmarkControllerOptions = {},
): Promise<BenchmarkReport> => {
  const budget = loadBudget(configuration.budget, configuration.records)
  const options = {
    afterTemporaryRepositoryAllocation: controllerOptions.afterTemporaryRepositoryAllocation,
    signal: controllerOptions.signal,
    temporaryParent: controllerOptions.temporaryParent ?? tmpdir(),
    workerPath: controllerOptions.workerPath ?? defaultWorkerPath,
  }
  const cases: BenchmarkCase[] = []
  for (const records of configuration.records) {
    // biome-ignore lint/performance/noAwaitInLoops: cases run sequentially to avoid benchmark contention.
    cases.push(await runCase(records, configuration, options))
  }
  const report: BenchmarkReport = {
    cases,
    configuration: {
      repetitions: configuration.repetitions,
      timeoutMilliseconds: configuration.timeoutMilliseconds,
      warmups: configuration.warmups,
    },
    environment: {
      arch: process.arch,
      cpu: cpus()[0]?.model ?? null,
      node: process.version,
      platform: process.platform,
    },
    generatedAt: new Date().toISOString(),
    memory: {
      peakRssBytes: 'Each isolated child process.resourceUsage().maxRSS converted from KiB to bytes.',
      rssDeltaBytes: 'Current-RSS delta within each isolated child; noisy and may be negative.',
    },
    profile: configuration.profile,
    schemaVersion: 2,
  }
  if (budget !== undefined) {
    assertPerformanceBudget(report, budget)
  }
  return report
}

export const runBenchmark = async (
  arguments_: string[],
  controllerOptions: BenchmarkControllerOptions = {},
): Promise<BenchmarkReport> => runConfiguredBenchmark(parseBenchmarkArguments(arguments_), controllerOptions)

const outputMode = (destination: string): number => {
  try {
    const metadata = lstatSync(destination)
    if (metadata.isFile()) {
      return metadata.mode & 0o777
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return 0o666 & ~process.umask()
}

const writeAtomic = (path: string, content: string): void => {
  const destination = resolve(path)
  const temporary = join(dirname(destination), `.${randomUUID()}.benchmark.tmp`)
  let descriptor: number | undefined
  let failure: Error | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, content, { encoding: 'utf8' })
    const mode = outputMode(destination)
    renameSync(temporary, destination)
    fchmodSync(descriptor, mode)
  } catch (error) {
    failure = new Error('Unable to write the benchmark report.', { cause: error })
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor)
    } catch (error) {
      if (failure === undefined) {
        failure = new Error('Unable to write the benchmark report.', { cause: error })
      }
    }
  }
  try {
    rmSync(temporary, { force: true })
  } catch (error) {
    if (failure === undefined) {
      failure = new Error('Unable to write the benchmark report.', { cause: error })
    }
  }
  if (failure !== undefined) {
    throw failure
  }
}

const errorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.replaceAll(packageRoot, '<repository>').replaceAll(tmpdir(), '<temporary>')
  }
  return 'Benchmark failed.'
}

const signalExitCode = (signal: 'SIGINT' | 'SIGTERM' | undefined) => {
  if (signal === 'SIGINT') {
    return 130
  }
  return signal === 'SIGTERM' ? 143 : 1
}

const main = async (): Promise<void> => {
  const arguments_ = process.argv.slice(2)
  if (arguments_.some(argument => argument === '--help' || argument === '-h')) {
    process.stdout.write(help)
    return
  }
  const controller = new AbortController()
  let receivedSignal: 'SIGINT' | 'SIGTERM' | undefined
  const interrupt = () => {
    receivedSignal = 'SIGINT'
    controller.abort()
  }
  const terminate = () => {
    receivedSignal = 'SIGTERM'
    controller.abort()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    const configuration = parseBenchmarkArguments(arguments_)
    const report = await runConfiguredBenchmark(configuration, { signal: controller.signal })
    if (controller.signal.aborted) {
      throw new Error('Benchmark was aborted.')
    }
    const output = `${JSON.stringify(report, null, 2)}\n`
    const outputPath = configuration.output
    if (outputPath === undefined) {
      process.stdout.write(output)
    } else {
      writeAtomic(outputPath, output)
    }
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = signalExitCode(receivedSignal)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

const [, entryPath] = process.argv
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  await main()
}
