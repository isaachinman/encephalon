import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  gatherRecords,
  hydrate,
  listRecords,
  prepare,
  searchCompactRecords,
  searchRecords,
  showRecord,
} from '../src/index.ts'
import { MAX_CANONICAL_RECORDS } from '../src/records.ts'
import { formatRecordFile } from '../src/schema.ts'
import type { BrainRecordFile } from '../src/types.ts'

type ProfileName = 'baseline' | 'ci' | 'full'

type BenchmarkCase = {
  artifacts: number
  canonicalJsonBytes: number
  largePayloads: number
  records: number
  supersessionDepth: number
}

type OperationMetric = {
  durationMs: number
  peakRssBytes: number
  rssDeltaBytes: number
}

type CacheMetric = {
  amplification: number | null
  databaseBytes: number
  shmBytes: number
  totalBytes: number
  walBytes: number
}

type CaseResult = BenchmarkCase & {
  cache: CacheMetric
  operations: {
    coldHydrate: OperationMetric
    compactSearch: OperationMetric
    fullSearch: OperationMetric
    gather: OperationMetric
    list: OperationMetric
    show: OperationMetric
    stalePrepare: OperationMetric
    unchangedPrepare: OperationMetric
  }
}

type BudgetFile = {
  cases: Array<{
    max: Partial<{
      amplification: number
      coldHydrateMs: number
      compactSearchMs: number
      fullSearchMs: number
      gatherMs: number
      listMs: number
      showMs: number
      stalePrepareMs: number
      totalCacheBytes: number
      unchangedPrepareMs: number
    }>
    records: number
  }>
  schemaVersion: 1
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const deterministicStart = Date.UTC(2026, 0, 1)

const productLimitProfile = [0, 100, MAX_CANONICAL_RECORDS] as const

const profiles = {
  baseline: [...productLimitProfile],
  ci: [0, 100],
  full: [...productLimitProfile],
} satisfies Record<ProfileName, number[]>

const round = (value: number, digits = 3) => Number(value.toFixed(digits))

const parseProfile = (value: string | undefined): ProfileName => {
  if (value === undefined || value === 'baseline' || value === 'ci' || value === 'full') {
    return value ?? 'baseline'
  }
  throw new Error(`Unknown benchmark profile: ${value}.`)
}

const byteSize = (path: string) => (existsSync(path) ? statSync(path).size : 0)

const createRepository = () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-benchmark-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(packageRoot, join(root, 'node_modules', 'encephalon'), process.platform === 'win32' ? 'junction' : 'dir')
  return root
}

const timestamp = (index: number) => new Date(deterministicStart + index).toISOString()

const writeRecord = (root: string, record: BrainRecordFile) => {
  const path = join(root, 'encephalon', record.kind, `${record.id}.json`)
  mkdirSync(dirname(path), { recursive: true })
  const content = formatRecordFile(record)
  writeFileSync(path, content, 'utf8')
  return Buffer.byteLength(content, 'utf8')
}

const largeText = (index: number) =>
  Array.from({ length: 96 }, (_, offset) => `large-payload-${index}-${offset}`).join(' ')

const createCorpus = (root: string, records: number): BenchmarkCase => {
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
        payload: {
          summary: `Artifact record ${index}`,
        },
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

const removeCache = (root: string) => {
  rmSync(join(root, 'node_modules', '.cache', 'encephalon'), { force: true, recursive: true })
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

const metric = <Result>(measure: () => Result): { metric: OperationMetric; result: Result } => {
  const startingRss = process.memoryUsage().rss
  const startingPeak = process.resourceUsage().maxRSS * 1024
  const start = performance.now()
  const result = measure()
  const durationMs = round(performance.now() - start)
  const endingRss = process.memoryUsage().rss
  const endingPeak = process.resourceUsage().maxRSS * 1024
  return {
    metric: {
      durationMs,
      peakRssBytes: Math.max(startingRss, startingPeak, endingRss, endingPeak),
      rssDeltaBytes: endingRss - startingRss,
    },
    result,
  }
}

const touchFirstRecord = (root: string) => {
  const path = join(root, 'encephalon', 'decision', 'chain-00000.json')
  if (existsSync(path)) {
    writeFileSync(path, readFileSync(path, 'utf8'), 'utf8')
  }
}

const shownIdForCase = (records: number) => {
  if (records === 0) {
    return 'missing'
  }
  const activeChainIndex = Math.max(0, Math.floor(records * 0.1) - 1)
  return `chain-${String(activeChainIndex).padStart(5, '0')}`
}

const runCase = (records: number): CaseResult => {
  const root = createRepository()
  try {
    const corpus = createCorpus(root, records)
    removeCache(root)

    const coldHydrate = metric(() => hydrate({ root })).metric
    const unchangedPrepare = metric(() => prepare({ root })).metric
    touchFirstRecord(root)
    const stalePrepare = metric(() => prepare({ root })).metric

    const shownId = shownIdForCase(records)
    const list = metric(() => listRecords({ limit: 20, root })).metric
    const show = metric(() => showRecord({ id: shownId, root })).metric
    const compactSearch = metric(() => searchCompactRecords({ limit: 20, query: 'benchmark needle', root })).metric
    const fullSearch = metric(() => searchRecords({ limit: 20, query: 'benchmark needle', root })).metric
    const gather = metric(() =>
      gatherRecords({
        root,
        searches: ['benchmark needle', 'large payload'],
        shows: [shownId, 'missing'],
      }),
    ).metric

    return {
      ...corpus,
      cache: cacheMetric(root, corpus.canonicalJsonBytes),
      operations: {
        coldHydrate,
        compactSearch,
        fullSearch,
        gather,
        list,
        show,
        stalePrepare,
        unchangedPrepare,
      },
    }
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

const loadBudget = (path: string | undefined): BudgetFile | undefined =>
  path === undefined ? undefined : (JSON.parse(readFileSync(resolve(path), 'utf8')) as BudgetFile)

const assertBudget = (caseResults: CaseResult[], budget: BudgetFile | undefined) => {
  if (budget === undefined) {
    return
  }
  const failures = caseResults.flatMap(result => {
    const expected = budget.cases.find(entry => entry.records === result.records)
    if (expected === undefined) {
      return []
    }
    const checks: [string, number | null, number | undefined][] = [
      ['coldHydrateMs', result.operations.coldHydrate.durationMs, expected.max.coldHydrateMs],
      ['unchangedPrepareMs', result.operations.unchangedPrepare.durationMs, expected.max.unchangedPrepareMs],
      ['stalePrepareMs', result.operations.stalePrepare.durationMs, expected.max.stalePrepareMs],
      ['listMs', result.operations.list.durationMs, expected.max.listMs],
      ['showMs', result.operations.show.durationMs, expected.max.showMs],
      ['compactSearchMs', result.operations.compactSearch.durationMs, expected.max.compactSearchMs],
      ['fullSearchMs', result.operations.fullSearch.durationMs, expected.max.fullSearchMs],
      ['gatherMs', result.operations.gather.durationMs, expected.max.gatherMs],
      ['totalCacheBytes', result.cache.totalBytes, expected.max.totalCacheBytes],
      ['amplification', result.cache.amplification, expected.max.amplification],
    ]
    return checks.flatMap(([name, actual, maximum]) => {
      if (actual !== null && maximum !== undefined && actual > maximum) {
        return [`${result.records} records ${name}: ${actual} > ${maximum}`]
      }
      return []
    })
  })
  if (failures.length > 0) {
    throw new Error(`Performance budget exceeded:\n${failures.join('\n')}`)
  }
}

const { values } = parseArgs({
  options: {
    budget: { type: 'string' },
    output: { short: 'o', type: 'string' },
    profile: { default: 'baseline', type: 'string' },
    records: { multiple: true, type: 'string' },
  },
})

const profile = parseProfile(values.profile)
const explicitRecordCounts =
  values.records === undefined
    ? undefined
    : values.records.map(value => {
        const records = Number(value)
        if (!Number.isInteger(records) || records < 0) {
          throw new Error(`Invalid --records value: ${value}.`)
        }
        return records
      })
const recordCounts = explicitRecordCounts ?? profiles[profile]
const results = recordCounts.map(runCase)
assertBudget(results, loadBudget(values.budget))

const report = {
  cases: results,
  environment: {
    arch: process.arch,
    cpu: cpus()[0]?.model ?? null,
    node: process.version,
    platform: process.platform,
  },
  generatedAt: new Date().toISOString(),
  profile,
  schemaVersion: 1,
}

const output = `${JSON.stringify(report, null, 2)}\n`
if (values.output === undefined) {
  process.stdout.write(output)
} else {
  writeFileSync(resolve(values.output), output, 'utf8')
}
