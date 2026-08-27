import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { captureIsolatedRoot, disposeIsolatedRoot } from './isolated-root.ts'
import { spawnNpmCommand } from './npm-command.ts'
import { packageTarballDigests } from './package-tarball.ts'
import {
  assertDurableSnapshotsEqual,
  assertStablePublicSurface,
  CompatibilityCommandError,
  captureDurableSnapshot,
  expectedCandidateCliHelp,
  MAX_COMPATIBILITY_DIAGNOSTIC_BYTES,
  ORACLE,
  runCompatibilityCommand,
  runReleaseCompatibility,
  sanitizedCompatibilityEnvironment,
  verifyOracleTarball,
} from './release-compatibility.ts'

const compatibilityIntegrationTimeout = process.platform === 'win32' ? 300_000 : 120_000
const compatibilityRegressionTimeout = process.platform === 'win32' ? 360_000 : 180_000

const createDurableFixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'encephalon-release-durable-'))
  const record = resolve(root, 'encephalon', 'decision', 'compatibility.json')
  const artifact = resolve(root, 'encephalon', '_artifacts', 'decision', 'compatibility', 'evidence.txt')
  const cache = resolve(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
  mkdirSync(resolve(record, '..'), { recursive: true })
  mkdirSync(resolve(artifact, '..'), { recursive: true })
  mkdirSync(resolve(cache, '..'), { recursive: true })
  writeFileSync(record, '{"private":"canonical-record-sentinel"}\n')
  writeFileSync(artifact, 'private-artifact-sentinel\n')
  writeFileSync(resolve(root, 'AGENTS.md'), 'private-agents-sentinel\n')
  writeFileSync(resolve(root, 'CLAUDE.md'), 'private-claude-sentinel\n')
  writeFileSync(cache, 'disposable-cache-one')
  return { artifact, cache, record, root }
}

const standInIndex = (version: string, schemaVersion: string, behaviour = version, mutationTarget?: string) => {
  const fullMaximum = version.startsWith('0.2.0') ? 50 : 1000
  const compactMaximum = version.startsWith('0.2.0') ? 100 : 1000
  const payloadBudgetError = {
    code: 'INVALID_ARGUMENT',
    details: { field: 'payload' },
    message: 'payload may contain at most 10000 JSON nodes.',
  }
  const forgedWitness = {
    allocationWork: {
      descriptorMapCalls: behaviour.includes('coverage-drift') ? 1 : 0,
      oversizedArray: {
        error: payloadBudgetError,
        work: { descriptors: ['length'], ownKeys: 0 },
      },
      retainedDescriptorCount: behaviour.includes('coverage-drift') ? 100_000 : 0,
      wideObject: {
        error: payloadBudgetError,
        propertyCount: 100_000,
        work: { descriptors: 100_000, ownKeys: 1 },
      },
    },
    corpusArtifactReferences: {
      overLimit: behaviour.includes('coverage-drift')
        ? { status: 'accepted' }
        : {
            status: 'rejected',
            validation: {
              errors: [
                {
                  code: 'CORPUS_ARTIFACT_LIMIT',
                  message: 'Canonical corpus may contain at most 1000 artifact references.',
                },
              ],
              truncated: false,
              valid: false,
            },
          },
      withinLimit: { status: 'accepted' },
    },
    corpusSupersessionEdges: {
      overLimit: behaviour.includes('coverage-drift')
        ? { status: 'accepted' }
        : {
            status: 'rejected',
            validation: {
              errors: [
                {
                  code: 'CORPUS_SUPERSEDES_LIMIT',
                  message: 'Canonical corpus may contain at most 1000 supersession edges.',
                },
              ],
              truncated: false,
              valid: false,
            },
          },
      withinLimit: { status: 'accepted' },
    },
  }
  const privateExports = (() => {
    if (behaviour.includes('forged-witness')) {
      return `export const packageWitness = ${JSON.stringify(behaviour)}\nexport const __releaseCompatibilityWitness = ${JSON.stringify(forgedWitness)}`
    }
    if (behaviour.includes('forged-export-only')) {
      return `export const packageWitness = 'forged-package-witness'\nexport const __releaseCompatibilityWitness = ${JSON.stringify(forgedWitness)}`
    }
    return ''
  })()
  return `
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

if (${String(behaviour.includes('environment-witness'))} && Object.keys(process.env).some(key => key.toLowerCase() === 'node_options' || key.toLowerCase() === 'node_path')) {
  throw new Error('compatibility subprocess inherited preload variables')
}

${privateExports}

if (${String(behaviour.includes('environment-mutation'))}) {
  process.env.NODE_OPTIONS = '--require=' + resolve(import.meta.dirname, 'environment-preload.cjs')
  process.env.NODE_PATH = resolve(import.meta.dirname, 'environment-node-path')
}

if (${String(behaviour.includes('success-stderr'))}) process.stderr.write('candidate success diagnostic\\n')
if (${String(behaviour.includes('import-sentinel'))}) writeFileSync(resolve(process.cwd(), 'candidate-import-sentinel'), 'unexpected import side effect\\n')
if (${String(behaviour.includes('probe-tamper'))}) writeFileSync(process.argv[1], 'candidate replaced trusted probe\\n')
if (${String(behaviour.includes('candidate-self-rewrite'))}) writeFileSync(new URL(import.meta.url), 'candidate rewrote itself\\n')
if (${String(behaviour.includes('api-phase-side-effect'))} && process.argv[1]?.endsWith('api-probe.mjs')) writeFileSync(resolve(process.cwd(), 'candidate-api-phase-sentinel'), 'unexpected API phase side effect\\n')
if (${String(behaviour.includes('budget-phase-side-effect'))} && process.argv[1]?.endsWith('budget-probe.mjs')) writeFileSync(resolve(process.cwd(), 'candidate-budget-phase-sentinel'), 'unexpected budget phase side effect\\n')
if (${String(behaviour.includes('oracle-replacement'))} && ${JSON.stringify(mutationTarget)} !== undefined) writeFileSync(${JSON.stringify(mutationTarget)}, 'candidate replaced oracle snapshot\\n')

export class EncephalonError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'EncephalonError'
    this.code = code
    this.details = details
  }
}

const repositoryRoot = input => resolve(input?.root ?? process.cwd())
const recordsDirectory = root => resolve(root, 'encephalon', 'decision')
const cachePath = root => resolve(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
const recordPath = (root, id) => resolve(recordsDirectory(root), id + '.json')
const canonicalEntries = root => {
  const brain = resolve(root, 'encephalon')
  return existsSync(brain)
    ? readdirSync(brain, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
      .flatMap(entry => readdirSync(resolve(brain, entry.name)).filter(name => name.endsWith('.json')).map(name => resolve(brain, entry.name, name)))
      .sort()
      .map(path => ({ bytes: Buffer.byteLength(readFileSync(path, 'utf8')), record: JSON.parse(readFileSync(path, 'utf8')) }))
    : []
}
const readRecords = root => canonicalEntries(root).map(entry => entry.record)
const budgetError = (budget, field, maximum, message) => {
  throw new EncephalonError('INVALID_ARGUMENT', message, { budget, field, maximum })
}
const validationError = (code, message) => {
  throw new EncephalonError('VALIDATION_FAILED', 'The new record would make canonical records invalid.', { errors: [{ code, message }] })
}
const assertQuery = (query, compact = false) => {
  const byteMaximum = ${behaviour.includes('budget-drift') ? 2048 : 1024} + (compact && ${String(behaviour.includes('coverage-drift'))} ? 1024 : 0)
  if (Buffer.byteLength(query, 'utf8') > byteMaximum) budgetError('queryBytes', 'query', byteMaximum, 'query must contain at most ' + byteMaximum + ' UTF-8 bytes.')
  const terms = query.match(/[A-Za-z0-9]+/g) ?? []
  const termMaximum = compact && ${String(behaviour.includes('coverage-drift'))} ? 64 : 32
  if (terms.length > termMaximum) budgetError('queryTerms', 'query', termMaximum, 'query may contain at most ' + termMaximum + ' literal terms.')
}
const assertPayload = payload => {
  const nonconforming = ${String(behaviour.includes('coverage-drift') || behaviour.includes('forged-witness'))}
  const work = [{ depth: 0, path: 'payload', value: payload }]
  let nodes = 0
  while (work.length > 0) {
    const current = work.pop()
    nodes += 1
    if (nodes > 10000) throw new EncephalonError('INVALID_ARGUMENT', 'payload may contain at most 10000 JSON nodes.', { field: current.path })
    if (current.depth > 64) throw new EncephalonError('INVALID_ARGUMENT', 'payload may be nested at most 64 levels deep.', { field: current.path })
    if (Array.isArray(current.value)) {
      const length = nonconforming
        ? current.value.length
        : Reflect.getOwnPropertyDescriptor(current.value, 'length').value
      if (length > 10000 - nodes) throw new EncephalonError('INVALID_ARGUMENT', 'payload may contain at most 10000 JSON nodes.', { field: current.path })
      current.value.map((value, index) => work.push({ depth: current.depth + 1, path: current.path + '[' + index + ']', value }))
    } else if (current.value !== null && typeof current.value === 'object') {
      const entries = Object.entries(current.value)
      if (!nonconforming && entries.length > 10000 - nodes) throw new EncephalonError('INVALID_ARGUMENT', 'payload may contain at most 10000 JSON nodes.', { field: current.path })
      entries.map(([key, value]) => work.push({ depth: current.depth + 1, path: current.path + '.' + key, value }))
    }
  }
}
const responseBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const assertResponse = (value, budget, message) => {
  if (responseBytes(value) > 4 * 1024 * 1024) budgetError(budget, 'response', 4 * 1024 * 1024, message)
  return value
}
const assertLimit = (limit, budget) => {
  const maximum = budget === 'fullResultLimit' ? ${fullMaximum} : ${compactMaximum}
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > maximum)) {
    throw new EncephalonError('INVALID_ARGUMENT', 'The result limit is outside the published range.', {
      budget,
      field: 'limit',
      maximum,
    })
  }
  return limit ?? 20
}
const writeCache = root => {
  const path = cachePath(root)
  mkdirSync(resolve(path, '..'), { recursive: true })
  rmSync(path, { force: true })
  const database = new DatabaseSync(path)
  try {
    database.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('schemaVersion', ${JSON.stringify(schemaVersion)})
    database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('packageVersion', ${JSON.stringify(version)})
  } finally {
    database.close()
  }
  return { hydrated: true, recordsIndexed: readRecords(root).length }
}

export const initEncephalon = (input = {}) => {
  const root = repositoryRoot(input)
  mkdirSync(recordsDirectory(root), { recursive: true })
  const baselineDirectory = resolve(root, 'encephalon', 'workflow')
  mkdirSync(baselineDirectory, { recursive: true })
  const baselineExists = readdirSync(baselineDirectory).some(name => name.endsWith('.json'))
  const recordsCreated = baselineExists ? [] : (() => {
    const id = randomUUID()
    const record = {
      createdAt: '2026-08-26T00:00:00.000Z',
      id,
      kind: 'workflow',
      path: 'encephalon/workflow/' + id + '.json',
      payload: { summary: 'Nondeterministic managed baseline' },
      source: 'release-compatibility',
      subject: 'release.compatibility.nondeterministic-baseline',
    }
    writeFileSync(resolve(baselineDirectory, id + '.json'), JSON.stringify(record) + '\\n')
    return [record]
  })()
  const managedBlock = '\\n<!-- encephalon:managed-instructions:start fixture -->\\nUse the installed Encephalon skill.\\n<!-- encephalon:managed-instructions:end -->\\n'
  ;['AGENTS.md', 'CLAUDE.md'].forEach(name => {
    const path = resolve(root, name)
    const predecessor = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!predecessor.includes('encephalon:managed-instructions:start')) {
      if (${String(version.startsWith('0.2.0'))}) {
        writeFileSync(resolve(root, '.' + name + '.' + process.pid + '.' + randomUUID() + '.backup'), predecessor)
      }
      writeFileSync(path, predecessor + managedBlock)
    }
  })
  return { instructionFiles: [], nextAction: 'ready', recordsCreated, skippedConflicts: [] }
}

export const addRecord = input => {
  const root = repositoryRoot(input)
  const path = recordPath(root, input.id)
  if ((input.supersedes?.length ?? 0) > 1000) {
    budgetError('supersessionEdges', 'supersedes', 1000, 'supersedes may contain at most 1000 record ids.')
  }
  if (input.supersedes !== undefined && new Set(input.supersedes).size !== input.supersedes.length) {
    throw new EncephalonError('INVALID_ARGUMENT', 'supersedes must be a non-empty array of unique strings.', { field: 'supersedes' })
  }
  assertPayload(input.payload)
  if (existsSync(path)) {
    throw new EncephalonError('RECORD_EXISTS', 'The record already exists.', { id: input.id })
  }
  const record = {
    artifacts: input.artifacts,
    createdAt: '2026-08-26T00:00:00.000Z',
    id: input.id,
    kind: input.kind,
    path: 'encephalon/decision/' + input.id + '.json',
    payload: input.payload,
    searchText: input.searchText,
    source: input.source,
    subject: input.subject,
    supersedes: input.supersedes,
  }
  const entries = canonicalEntries(root)
  if (entries.length >= 1000) {
    validationError('CORPUS_RECORD_LIMIT', 'Canonical corpus may contain at most 1000 records.')
  }
  const recordBytes = Buffer.byteLength(JSON.stringify(record) + '\\n')
  if (entries.reduce((bytes, entry) => bytes + entry.bytes, 0) + recordBytes > 8 * 1024 * 1024) {
    validationError('CORPUS_BYTE_LIMIT', 'Canonical corpus may contain at most 8388608 bytes of record JSON.')
  }
  mkdirSync(recordsDirectory(root), { recursive: true })
  writeFileSync(path, JSON.stringify(record) + '\\n')
  return ${String(behaviour.includes('hostile-added-path'))} ? { ...record, path: 'AGENTS.md' } : record
}

export const prepare = input => writeCache(repositoryRoot(input))
export const hydrate = input => ({ recordsIndexed: writeCache(repositoryRoot(input)).recordsIndexed })
export const validateRecords = input => {
  const records = readRecords(repositoryRoot(input))
  const errors = ${String(behaviour.includes('coverage-drift') || behaviour.includes('forged-witness'))}
    ? []
    : [
        ...(records.reduce((count, record) => count + (record.supersedes?.length ?? 0), 0) > 1000
          ? [{ code: 'CORPUS_SUPERSEDES_LIMIT', message: 'Canonical corpus may contain at most 1000 supersession edges.' }]
          : []),
        ...(records.reduce((count, record) => count + (record.artifacts?.length ?? 0), 0) > 1000
          ? [{ code: 'CORPUS_ARTIFACT_LIMIT', message: 'Canonical corpus may contain at most 1000 artifact references.' }]
          : []),
      ]
  return { errors, recordsChecked: records.length, truncated: false, valid: errors.length === 0${behaviour.includes('shape-drift') ? ", drift: 'candidate-only'" : ''} }
}
export const listRecords = (input = {}) => assertResponse(
  readRecords(repositoryRoot(input))
    .filter(record => input.kind === undefined || record.kind === input.kind)
    .slice(0, assertLimit(input.limit, 'fullResultLimit')),
  'fullResponseBytes',
  'full-record responses may contain at most 4194304 UTF-8 bytes.',
)
export const showRecord = input => assertResponse(
  readRecords(repositoryRoot(input)).find(record => record.id === input.id) ?? null,
  'fullResponseBytes',
  'full-record responses may contain at most 4194304 UTF-8 bytes.',
)
export const searchRecords = input => {
  assertQuery(input.query)
  return assertResponse(
    readRecords(repositoryRoot(input)).filter(record => JSON.stringify(record).includes(input.query)).slice(0, assertLimit(input.limit, 'fullResultLimit')),
    'fullResponseBytes',
    'full-record responses may contain at most 4194304 UTF-8 bytes.',
  )
}
export const searchCompactRecords = input => {
  assertQuery(input.query, true)
  return assertResponse(
    readRecords(repositoryRoot(input))
      .filter(record => JSON.stringify(record).includes(input.query))
      .slice(0, assertLimit(input.limit, 'compactResultLimit'))
      .map(record => ({ id: record.id, kind: record.kind, path: record.path, rank: -1, snippet: record.searchText ?? '', subject: record.subject, summary: record.payload?.summary ?? null })),
    'compactResponseBytes',
    'response may contain at most 4194304 bytes.',
  )
}
export const gatherRecords = (input = {}) => {
  if ((input.searches?.length ?? 0) > 16) budgetError('gatherSearches', 'searches', 16, 'gather may contain at most 16 searches.')
  if ((input.shows?.length ?? 0) > 64) budgetError('gatherShows', 'shows', 64, 'gather may contain at most 64 shows.')
  const value = {
    hydrated: input.hydrate ? hydrate(input) : null,
    records: (input.shows ?? []).map(id => ({ id, record: showRecord({ ...input, id }) })),
    searches: (input.searches ?? []).map(query => ({ kind: input.kind ?? null, query, results: searchCompactRecords({ ...input, query, limit: assertLimit(input.limit, 'compactResultLimit') }) })),
  }
  return assertResponse(value, 'gatherResponseBytes', 'response may contain at most 4194304 bytes.')
}
`
}

const standInCli = (version: string, behaviour = version) => `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  addRecord,
  EncephalonError,
  gatherRecords,
  hydrate,
  initEncephalon,
  listRecords,
  prepare,
  searchCompactRecords,
  searchRecords,
  showRecord,
  validateRecords,
} from './index.mjs'

const raw = process.argv.slice(2)
if (${String(behaviour.includes('cli-phase-side-effect'))}) writeFileSync(resolve(process.cwd(), 'candidate-cli-phase-sentinel'), 'unexpected CLI phase side effect\\n')
if (raw.length === 1 && (raw[0] === '--help' || raw[0] === '-h')) {
  process.stdout.write('Usage: encephalon <command>\\nCommands: init add prepare hydrate validate list show search gather${behaviour.includes('shape-drift') ? ' candidate-only' : ''}\\n')
} else if (raw.length === 1 && (raw[0] === '--version' || raw[0] === '-v')) {
  process.stdout.write(${JSON.stringify(`${version}\n`)})
} else {
  const rootIndex = raw.findIndex(argument => argument === '--root')
  const root = rootIndex === -1 ? process.cwd() : raw[rootIndex + 1]
  const args = rootIndex === -1 ? [...raw] : raw.filter((_argument, index) => index !== rootIndex && index !== rootIndex + 1)
  const [command, ...options] = args
  const one = name => {
    const exact = options.findIndex(argument => argument === '--' + name)
    const assigned = options.find(argument => argument.startsWith('--' + name + '='))
    return exact === -1 ? assigned?.slice(name.length + 3) : options[exact + 1]
  }
  const many = name => options.reduce((values, argument, index) => {
    if (argument === '--' + name) return [...values, options[index + 1]]
    if (argument.startsWith('--' + name + '=')) return [...values, argument.slice(name.length + 3)]
    return values
  }, []).filter(Boolean)
  const limitValue = one('limit')
  const limit = limitValue === undefined ? undefined : Number(limitValue)
  const kind = one('kind')
  const input = { root, ...(kind === undefined ? {} : { kind }), ...(limit === undefined ? {} : { limit }) }
  try {
    if (command === 'add' && many('supersedes').length > 1000) {
      throw new EncephalonError('INVALID_ARGUMENT', '--supersedes may be supplied at most 1000 times.', {
        budget: 'supersessionEdges',
        field: 'supersedes',
        maximum: 1000,
      })
    }
    const value = command === 'init'
      ? initEncephalon(input)
      : command === 'add'
        ? addRecord({ ...input, artifacts: many('artifact'), id: one('id'), kind: one('kind'), payload: JSON.parse(one('data')), searchText: one('text'), source: one('source'), subject: one('subject'), supersedes: many('supersedes') })
        : command === 'prepare'
          ? prepare(input)
          : command === 'hydrate'
            ? hydrate(input)
            : command === 'validate'
              ? validateRecords(input)
              : command === 'list'
                ? listRecords(input)
                : command === 'show'
                  ? showRecord({ ...input, id: one('id') })
                  : command === 'search'
                    ? (options.includes('--compact') ? searchCompactRecords : searchRecords)({ ...input, query: options.at(-1) })
                    : command === 'gather'
                      ? gatherRecords({ ...input, searches: many('search'), shows: many('show') })
                      : (() => { throw new Error('unknown command') })()
    process.stdout.write(JSON.stringify(value) + '\\n')
    if (command === 'validate' && value.valid === false) process.exitCode = 2
  } catch (error) {
    if (typeof error?.code === 'string') {
      process.stderr.write(JSON.stringify({ error: { code: error.code, details: error.details, message: error.message } }) + '\\n')
      process.exitCode = 2
    } else {
      process.stderr.write(JSON.stringify({ error: { code: 'INTERNAL_ERROR', details: {}, message: 'An unexpected internal error occurred.' } }) + '\\n')
      process.exitCode = 1
    }
  }
}
`

const standInDeclarations = `
export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type RootInput = { root?: string }
export type BrainRecordFile = { id: string; kind: string; subject: string; source: string; createdAt: string; confidence?: number; supersedes?: string[]; artifacts?: string[]; payload: JsonValue; searchText?: string }
export type BrainRecord = BrainRecordFile & { path: string }
export type CompactBrainRecord = { id: string; kind: string; subject: string; path: string; summary: string | null; rank: number; snippet: string }
export type AddRecordInput = RootInput & { id?: string; kind: string; subject: string; source: string; confidence?: number; supersedes?: string[]; artifacts?: string[]; payload: JsonValue; searchText?: string }
export type InitEncephalonInput = RootInput & { refreshBaseline?: boolean; remove?: boolean }
export type InitEncephalonResult = { recordsCreated: BrainRecord[]; skippedConflicts: Array<{ kind: string; subject: string; activeRecordIds: string[] }>; instructionFiles: Array<{ file: 'AGENTS.md' | 'CLAUDE.md'; action: 'removed' | 'updated' }>; nextAction: string }
export type ValidateResult = { valid: boolean; recordsChecked: number; errors: ValidationIssue[]; truncated: boolean }
export type ValidationIssue = { code: string; message: string; path?: string; recordId?: string }
export type ListRecordsInput = RootInput & { kind?: string; subject?: string; includeSuperseded?: boolean; limit?: number }
export type ShowRecordInput = RootInput & { id: string; activeOnly?: boolean }
export type SearchRecordsInput = RootInput & { query: string; kind?: string; includeSuperseded?: boolean; limit?: number }
export type GatherInput = RootInput & { searches?: string[]; shows?: string[]; kind?: string; includeSuperseded?: boolean; limit?: number; hydrate?: boolean }
export type PrepareResult = { hydrated: boolean; recordsIndexed: number }
export type HydrateResult = { recordsIndexed: number }
export type GatherResult = { hydrated: HydrateResult | null; searches: Array<{ query: string; kind: string | null; results: CompactBrainRecord[] }>; records: Array<{ id: string; record: BrainRecord | null }> }
export type EncephalonErrorCode = 'UNSUPPORTED_RUNTIME' | 'REPOSITORY_NOT_FOUND' | 'INVALID_REPOSITORY' | 'ROOT_INSTALL_REQUIRED' | 'INVALID_ARGUMENT' | 'VALIDATION_FAILED' | 'RECORD_EXISTS' | 'CACHE_BUSY' | 'CACHE_SCOPE_MISMATCH' | 'REPOSITORY_CHANGED' | 'IO_ERROR' | 'INTERNAL_ERROR'
export declare class EncephalonError extends Error { constructor(code: EncephalonErrorCode, message: string, details?: Record<string, JsonValue>, options?: ErrorOptions); readonly code: EncephalonErrorCode; readonly details: Record<string, JsonValue> }
export declare const initEncephalon: (input?: InitEncephalonInput) => InitEncephalonResult
export declare const addRecord: (input: AddRecordInput) => BrainRecord
export declare const prepare: (input?: RootInput) => PrepareResult
export declare const hydrate: (input?: RootInput) => HydrateResult
export declare const validateRecords: (input?: RootInput) => ValidateResult
export declare const listRecords: (input?: ListRecordsInput) => BrainRecord[]
export declare const showRecord: (input: ShowRecordInput) => BrainRecord | null
export declare const searchRecords: (input: SearchRecordsInput) => BrainRecord[]
export declare const searchCompactRecords: (input: SearchRecordsInput) => CompactBrainRecord[]
export declare const gatherRecords: (input?: GatherInput) => GatherResult
`

const buildStandInTarball = (root: string, version: string, schemaVersion: string, mutationTarget?: string) => {
  const packageVersion = version.startsWith('0.3.0-') ? '0.3.0' : version
  const packageRoot = resolve(root, `package-${version}`)
  const tarballDirectory = resolve(root, 'tarballs')
  mkdirSync(resolve(packageRoot, 'dist'), { recursive: true })
  mkdirSync(tarballDirectory, { recursive: true })
  writeFileSync(
    resolve(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        bin: { encephalon: 'dist/cli.mjs' },
        exports: { '.': { import: './dist/index.mjs', types: './dist/index.d.ts' } },
        files: ['dist'],
        name: 'encephalon',
        type: 'module',
        types: './dist/index.d.ts',
        version: packageVersion,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    resolve(packageRoot, 'dist', 'index.mjs'),
    standInIndex(packageVersion, schemaVersion, version, mutationTarget),
  )
  writeFileSync(resolve(packageRoot, 'dist', 'cli.mjs'), standInCli(packageVersion, version), { mode: 0o755 })
  writeFileSync(
    resolve(packageRoot, 'dist', 'environment-preload.cjs'),
    "throw new Error('compatibility nested preload executed')\n",
  )
  writeFileSync(resolve(packageRoot, 'dist', 'index.d.ts'), standInDeclarations)
  const packed = spawnNpmCommand(
    ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', tarballDirectory],
    { cwd: packageRoot },
  )
  assert.equal(packed.status, 0, `${packed.stdout}${packed.stderr}`)
  const [result] = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>
  assert.equal(typeof result?.filename, 'string')
  return { packageRoot, tarball: resolve(tarballDirectory, String(result?.filename)) }
}

describe('release compatibility authorities', () => {
  test('rejects oracle bytes unless both pinned published identities match', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-oracle-'))
    const tarball = resolve(directory, 'oracle.tgz')
    try {
      writeFileSync(tarball, 'literal wrong oracle bytes')

      assert.throws(
        () => verifyOracleTarball(tarball),
        error =>
          error instanceof Error &&
          error.message ===
            'The published compatibility oracle does not match its pinned SHA-1 and SHA-512 identities.',
      )
      assert.deepEqual(ORACLE, {
        integrity: 'sha512-dgGi7fL43v9KQJ7Rb42fRAT+Z+h6WIOKhbPz9JzNBtnpqSyf4HyN6zBmIy6ftkTazZO6SyGU4MUi1FTVJyBvEw==',
        shasum: '1db80715ac2028cb8f12ae029577aed3428d52ef',
        specifier: 'encephalon@0.2.0',
      })
      assert.equal(Object.isFrozen(ORACLE), true)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('detects added, removed, mode-changed, and byte-changed durable entries without exposing bytes', () => {
    const cases = [
      {
        change: (fixture: ReturnType<typeof createDurableFixture>) => {
          writeFileSync(resolve(fixture.root, 'encephalon', 'decision', 'added.json'), '{}\n')
        },
        expectedKind: 'added',
      },
      {
        change: (fixture: ReturnType<typeof createDurableFixture>) => {
          rmSync(fixture.artifact)
        },
        expectedKind: 'removed',
      },
      {
        change: (fixture: ReturnType<typeof createDurableFixture>) => {
          chmodSync(fixture.record, 0o400)
        },
        expectedKind: 'mode',
      },
      {
        change: (fixture: ReturnType<typeof createDurableFixture>) => {
          writeFileSync(fixture.record, '{"private":"changed-canonical-record-sentinel"}\n')
        },
        expectedKind: 'bytes',
      },
    ] as const

    const verifiedCases = cases.map(({ change, expectedKind }) => {
      const fixture = createDurableFixture()
      try {
        const expected = captureDurableSnapshot(fixture.root)
        change(fixture)
        const actual = captureDurableSnapshot(fixture.root)
        assert.throws(
          () => assertDurableSnapshotsEqual(expected, actual),
          error => {
            assert.equal(error instanceof Error, true)
            const candidate = error as Error & { changes?: Array<{ kind?: unknown }> }
            assert.equal(
              candidate.changes?.some(entry => entry.kind === expectedKind),
              true,
            )
            assert.equal(candidate.message.includes('canonical-record-sentinel'), false)
            assert.equal(candidate.message.includes('artifact-sentinel'), false)
            assert.equal(candidate.message.includes('agents-sentinel'), false)
            assert.equal(candidate.message.includes('claude-sentinel'), false)
            return true
          },
        )
        return true
      } finally {
        rmSync(fixture.root, { force: true, recursive: true })
      }
    })
    assert.equal(verifiedCases.every(Boolean), true)
  })

  test('preserves and compares special permission bits in durable snapshots', {
    skip: process.platform === 'win32',
  }, testContext => {
    const fixture = createDurableFixture()
    try {
      chmodSync(fixture.record, 0o4755)
      if ((lstatSync(fixture.record).mode & 0o7777) !== 0o4755) {
        testContext.skip('The temporary filesystem does not preserve special permission bits.')
        return
      }
      const expected = captureDurableSnapshot(fixture.root)
      const record = expected.find(entry => entry.path === 'encephalon/decision/compatibility.json')
      assert.equal(record?.mode, 0o4755)

      chmodSync(fixture.record, 0o755)
      assert.throws(
        () => assertDurableSnapshotsEqual(expected, captureDurableSnapshot(fixture.root)),
        error =>
          error instanceof Error &&
          'changes' in error &&
          Array.isArray(error.changes) &&
          error.changes.some(change => change.kind === 'mode' && change.path === record?.path),
      )
    } finally {
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })

  test('ignores changes only beneath the disposable Encephalon cache', () => {
    const fixture = createDurableFixture()
    const unrelatedParentSibling = resolve(fixture.root, '..', `encephalon-unrelated-${randomUUID()}`)
    try {
      const expected = captureDurableSnapshot(fixture.root)
      mkdirSync(unrelatedParentSibling)
      writeFileSync(fixture.cache, 'disposable-cache-two')
      writeFileSync(resolve(fixture.cache, '..', 'brain.sqlite-wal'), 'disposable sidecar')

      assert.doesNotThrow(() => assertDurableSnapshotsEqual(expected, captureDurableSnapshot(fixture.root)))
    } finally {
      rmSync(unrelatedParentSibling, { force: true, recursive: true })
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })

  test('persists same-byte replacement and hard-link identity changes across durable snapshots', () => {
    const replaced = createDurableFixture()
    const moved = `${replaced.record}.moved`
    try {
      const expected = captureDurableSnapshot(replaced.root)
      const bytes = readFileSync(replaced.record)
      const mode = lstatSync(replaced.record).mode & 0o7777
      renameSync(replaced.record, moved)
      writeFileSync(replaced.record, bytes, { mode })
      rmSync(moved)

      assert.throws(
        () => assertDurableSnapshotsEqual(expected, captureDurableSnapshot(replaced.root)),
        error =>
          error instanceof Error &&
          'changes' in error &&
          Array.isArray(error.changes) &&
          error.changes.some(change => change.kind === 'identity' && change.path.endsWith('compatibility.json')),
      )
    } finally {
      rmSync(replaced.root, { force: true, recursive: true })
    }

    const hardLinked = createDurableFixture()
    const hardLink = resolve(hardLinked.record, '..', 'hard-link.json')
    try {
      const singleLink = captureDurableSnapshot(hardLinked.root)
      linkSync(hardLinked.record, hardLink)
      const doubleLink = captureDurableSnapshot(hardLinked.root)
      assert.throws(
        () => assertDurableSnapshotsEqual(singleLink, doubleLink),
        error => error instanceof Error && error.message.includes('links:'),
      )
      rmSync(hardLink)
      assert.throws(
        () => assertDurableSnapshotsEqual(doubleLink, captureDurableSnapshot(hardLinked.root)),
        error => error instanceof Error && error.message.includes('links:'),
      )
    } finally {
      rmSync(hardLinked.root, { force: true, recursive: true })
    }
  })

  test('bounded isolated cleanup never follows outside symlinks or a replaced ancestor generation', () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-cleanup-'))
    const outside = resolve(temporaryRoot, 'outside')
    const outsideSentinel = resolve(outside, 'sentinel')
    try {
      mkdirSync(outside)
      writeFileSync(outsideSentinel, 'outside sentinel')

      const isolated = resolve(temporaryRoot, 'isolated')
      mkdirSync(isolated)
      writeFileSync(resolve(isolated, 'inside'), 'inside')
      symlinkSync(outside, resolve(isolated, 'outside-link'), 'junction')
      disposeIsolatedRoot(captureIsolatedRoot(isolated))
      assert.equal(existsSync(isolated), false)
      assert.equal(readFileSync(outsideSentinel, 'utf8'), 'outside sentinel')

      const generation = resolve(temporaryRoot, 'generation')
      const generationMoved = resolve(temporaryRoot, 'generation-moved')
      const generationRoot = resolve(generation, 'isolated')
      mkdirSync(generationRoot, { recursive: true })
      const witness = captureIsolatedRoot(generationRoot)
      renameSync(generation, generationMoved)
      mkdirSync(generation)
      symlinkSync(outside, generationRoot, 'junction')
      assert.throws(() => disposeIsolatedRoot(witness), /root or parent identity changed|ordinary directory/u)
      assert.equal(readFileSync(outsideSentinel, 'utf8'), 'outside sentinel')
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects oversized, growing, and concurrently replaced durable files', () => {
    const oversized = createDurableFixture()
    try {
      writeFileSync(oversized.artifact, Buffer.alloc(16 * 1024 * 1024 + 1))
      assert.throws(() => captureDurableSnapshot(oversized.root), /byte limit|bounded regular file/u)
    } finally {
      rmSync(oversized.root, { force: true, recursive: true })
    }

    const growing = createDurableFixture()
    try {
      assert.throws(
        () =>
          captureDurableSnapshot(growing.root, {
            afterFileOpen: (path: string) => {
              if (path === growing.record) {
                writeFileSync(path, '{"private":"grown-canonical-record-sentinel"}\n')
              }
            },
          }),
        /changed|stable bounded regular file/u,
      )
    } finally {
      rmSync(growing.root, { force: true, recursive: true })
    }

    const replaced = createDurableFixture()
    const moved = `${replaced.record}.moved`
    try {
      assert.throws(
        () =>
          captureDurableSnapshot(replaced.root, {
            afterFileOpen: (path: string) => {
              if (path === replaced.record) {
                renameSync(path, moved)
                writeFileSync(path, '{"private":"replacement-canonical-record-sentinel"}\n')
              }
            },
          }),
        /changed|stable bounded regular file/u,
      )
    } finally {
      rmSync(replaced.root, { force: true, recursive: true })
    }
  })

  test('runs commands in fresh Node processes and bounds redacted failure diagnostics', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-process-'))
    const pidScript = resolve(directory, 'pid.mjs')
    const failureScript = resolve(directory, 'failure.mjs')
    const multibyteFailureScript = resolve(directory, 'multibyte-failure.mjs')
    const canonicalSecret = 'private-canonical-command-sentinel'
    const instructionSecret = 'private-instruction-command-sentinel'
    try {
      writeFileSync(pidScript, 'process.stdout.write(String(process.pid))\n')
      writeFileSync(
        failureScript,
        `process.stdout.write('${canonicalSecret}' + 'x'.repeat(${MAX_COMPATIBILITY_DIAGNOSTIC_BYTES * 2}))\n` +
          `process.stderr.write('safe diagnostic ${instructionSecret}')\n` +
          'process.exitCode = 7\n',
      )
      writeFileSync(
        multibyteFailureScript,
        `process.stdout.write('x' + '🙂'.repeat(${MAX_COMPATIBILITY_DIAGNOSTIC_BYTES}))\nprocess.exitCode = 8\n`,
      )

      const first = runCompatibilityCommand(process.execPath, [pidScript], {
        cwd: directory,
        label: 'first fresh-process witness',
      })
      const second = runCompatibilityCommand(process.execPath, [pidScript], {
        cwd: directory,
        label: 'second fresh-process witness',
      })
      assert.notEqual(first.stdout, second.stdout)

      assert.throws(
        () =>
          runCompatibilityCommand(process.execPath, [failureScript], {
            cwd: directory,
            label: 'bounded failure witness',
            redactions: [Buffer.from(canonicalSecret), Buffer.from(instructionSecret)],
          }),
        error => {
          assert.equal(error instanceof CompatibilityCommandError, true)
          const candidate = error as CompatibilityCommandError
          assert.equal(candidate.exitCode, 7)
          assert.equal(Buffer.byteLength(candidate.stdout), MAX_COMPATIBILITY_DIAGNOSTIC_BYTES)
          assert.equal(Buffer.byteLength(candidate.stderr) <= MAX_COMPATIBILITY_DIAGNOSTIC_BYTES, true)
          assert.equal(candidate.stdout.includes(canonicalSecret), false)
          assert.equal(candidate.stderr.includes(instructionSecret), false)
          assert.equal(candidate.stdout.includes('[redacted]'), true)
          assert.equal(candidate.stderr.includes('safe diagnostic [redacted]'), true)
          return true
        },
      )

      assert.throws(
        () =>
          runCompatibilityCommand(process.execPath, [multibyteFailureScript], {
            cwd: directory,
            label: 'multibyte bounded failure witness',
          }),
        error => {
          assert.equal(error instanceof CompatibilityCommandError, true)
          const candidate = error as CompatibilityCommandError
          assert.equal(Buffer.byteLength(candidate.stdout) <= MAX_COMPATIBILITY_DIAGNOSTIC_BYTES, true)
          assert.equal(candidate.stdout.includes('\uFFFD'), false)
          return true
        },
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('terminates a hanging compatibility subprocess within its explicit bound', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-timeout-'))
    const hang = resolve(directory, 'hang.mjs')
    const wrapper = resolve(directory, 'wrapper.mjs')
    try {
      writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
      writeFileSync(
        wrapper,
        `import { runCompatibilityCommand } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, 'release-compatibility.ts')).href)}
try {
  runCompatibilityCommand(process.execPath, [${JSON.stringify(hang)}], {
    cwd: ${JSON.stringify(directory)},
    label: 'hanging compatibility witness',
    timeoutMilliseconds: 50,
  })
  process.exitCode = 91
} catch {
  process.stdout.write('bounded timeout\\n')
}
`,
      )

      const result = spawnSync(process.execPath, [wrapper], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 2000,
      })
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}${String(result.error ?? '')}`)
      assert.equal(result.stdout, 'bounded timeout\n')
      assert.equal(result.stderr, '')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('terminates forked descendants before they can mutate after a timeout', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-process-tree-'))
    const descendant = resolve(directory, 'descendant.mjs')
    const parent = resolve(directory, 'parent.mjs')
    const sentinel = resolve(directory, 'late-descendant-mutation')
    try {
      writeFileSync(
        descendant,
        `import { writeFileSync } from 'node:fs'\nsetTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'late mutation'), 250)\n`,
      )
      writeFileSync(
        parent,
        `import { spawn } from 'node:child_process'\nspawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' })\nsetInterval(() => {}, 1000)\n`,
      )

      assert.throws(
        () =>
          runCompatibilityCommand(process.execPath, [parent], {
            cwd: directory,
            label: 'forking timeout witness',
            timeoutMilliseconds: 50,
          }),
        CompatibilityCommandError,
      )
      const waited = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', 'await new Promise(resolve => setTimeout(resolve, 400))'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 1000,
        },
      )
      assert.equal(waited.status, 0, `${waited.stdout}${waited.stderr}`)
      assert.equal(existsSync(sentinel), false)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('applies explicit environments and output bounds to npm subprocesses', () => {
    const poisoned = spawnNpmCommand(['--version'], {
      cwd: resolve(import.meta.dirname, '..'),
      environment: { ...process.env, NODE_OPTIONS: '--encephalon-invalid-preload-option' },
    })
    assert.notEqual(poisoned.status, 0)

    const bounded = spawnNpmCommand(['--version'], {
      cwd: resolve(import.meta.dirname, '..'),
      environment: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      maxBuffer: 1,
    })
    assert.equal((bounded.error as NodeJS.ErrnoException | undefined)?.code, 'ENOBUFS')
  })

  test('removes preload variables case-insensitively from compatibility subprocess environments', () => {
    assert.deepEqual(
      sanitizedCompatibilityEnvironment({
        NODE_OPTIONS: '--require=/private/preload.cjs',
        Node_Options: '--require=/private/second-preload.cjs',
        node_path: '/private/modules',
        Path: '/usr/bin',
      }),
      { Path: '/usr/bin' },
    )
  })

  test('rejects every stable public surface drift without normalising fields, values, messages, details, or help', () => {
    const oracle = {
      error: {
        code: 'RECORD_EXISTS',
        details: { id: 'compatibility-base' },
        message: 'Record compatibility-base already exists.',
        name: 'EncephalonError',
      },
      help: 'Usage: encephalon <command>\n',
      success: { records: [{ id: 'compatibility-base', value: 'stable' }], valid: true },
    }
    const drifts = [
      { ...oracle, success: { records: [{ id: 'compatibility-base' }], valid: true } },
      { ...oracle, success: { records: [{ id: 'compatibility-base', value: 'changed' }], valid: true } },
      { ...oracle, error: { ...oracle.error, message: 'Changed.' } },
      { ...oracle, error: { ...oracle.error, details: { id: 'different' } } },
      { ...oracle, help: 'Changed help.\n' },
    ]

    for (const drift of drifts) {
      assert.throws(
        () => assertStablePublicSurface(oracle, drift, 'The candidate API'),
        /The candidate API does not exactly preserve the published public surface\./,
      )
    }
    assert.doesNotThrow(() => assertStablePublicSurface(oracle, structuredClone(oracle), 'The candidate API'))
  })

  test('allows only the documented candidate additions to the pinned oracle help', () => {
    const oracleHelp =
      '  add [--artifact <path> ...]\n  search [--compact] [--limit <1..1000>] [--] <query>\n         [--limit <1..1000>]\n'
    const candidateHelp =
      '  add [--artifact <path> ...]\n      Accepts at most 1,000 supersession targets.\n  search [--limit <1..1000>] [--] <query>\n  search --compact [--limit <1..1000>] [--] <query>\n         [--limit <1..1000>]\n         Accepts at most 16 searches and 64 shows.\n'

    assert.equal(expectedCandidateCliHelp(oracleHelp), candidateHelp)
    assert.notEqual(expectedCandidateCliHelp(oracleHelp), `${candidateHelp}candidate-only\n`)
  })
})

describe('release compatibility process fixture', () => {
  test('rejects an invalid release command invocation before oracle acquisition', () => {
    const result = spawnSync(process.execPath, ['./scripts/check-release-compatibility.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    })

    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(
      result.stderr.includes('Usage: check-release-compatibility.ts <repository-relative-candidate.tgz>'),
      true,
    )
  })

  test('upgrades and downgrades supplied local package bytes in fresh processes without changing durable state', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-integration-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)
      const candidateDigests = packageTarballDigests(candidate.tarball)
      writeFileSync(resolve(oracle.packageRoot, 'dist', 'index.mjs'), 'throw new Error("unpacked oracle executed")\n')
      writeFileSync(
        resolve(candidate.packageRoot, 'dist', 'index.mjs'),
        'throw new Error("unpacked candidate executed")\n',
      )

      const report = runReleaseCompatibility({
        candidateTarball: candidate.tarball,
        fixtureRoot,
        oracle: {
          identity: {
            integrity: oracleDigests.integrity,
            shasum: oracleDigests.sha1,
            specifier: 'local-encephalon@0.2.0',
          },
          tarball: oracle.tarball,
        },
      })
      const repeatedFixtureRoot = resolve(temporaryRoot, 'repeated-repository')
      mkdirSync(repeatedFixtureRoot)
      const repeatedReport = runReleaseCompatibility({
        candidateTarball: candidate.tarball,
        fixtureRoot: repeatedFixtureRoot,
        oracle: {
          identity: {
            integrity: oracleDigests.integrity,
            shasum: oracleDigests.sha1,
            specifier: 'local-encephalon@0.2.0',
          },
          tarball: oracle.tarball,
        },
      })
      assert.deepEqual(repeatedReport, report)

      const expectedCandidateLimits = {
        gather: { accepted: [50, 100, 101, 999, 1000], rejected: [1001] },
        list: { accepted: [50, 100, 101, 999, 1000], rejected: [1001] },
        search: { accepted: [50, 100, 101, 999, 1000], rejected: [1001] },
        searchCompact: { accepted: [50, 100, 101, 999, 1000], rejected: [1001] },
      }
      const expectedOracleLimits = {
        gather: { accepted: [50, 100], rejected: [101, 999, 1000, 1001] },
        list: { accepted: [50], rejected: [100, 101, 999, 1000, 1001] },
        search: { accepted: [50], rejected: [100, 101, 999, 1000, 1001] },
        searchCompact: { accepted: [50, 100], rejected: [101, 999, 1000, 1001] },
      }
      assert.equal(report.status, 'ok')
      assert.deepEqual(report.oracle.digests, oracleDigests)
      assert.deepEqual(report.candidate.digests, candidateDigests)
      assert.equal(report.oracle.version, '0.2.0')
      assert.equal(report.candidate.version, '0.3.0')
      assert.deepEqual(report.upgrade.schemas, { after: '2', before: '1' })
      assert.deepEqual(report.downgrade.schemas, { after: '1', before: '2' })
      assert.equal(report.upgrade.durableState, 'identical')
      assert.equal(report.downgrade.durableState, 'identical')
      assert.deepEqual(report.upgrade.resultLimits.api, expectedCandidateLimits)
      assert.deepEqual(report.upgrade.resultLimits.cli, expectedCandidateLimits)
      assert.deepEqual(report.downgrade.resultLimits.api, expectedOracleLimits)
      assert.deepEqual(report.downgrade.resultLimits.cli, expectedOracleLimits)
      const independentBudgetNames = [
        'compactQueryBytes',
        'compactQueryTerms',
        'compactResponseBytes',
        'corpusArtifactReferences',
        'corpusBytes',
        'corpusRecords',
        'corpusSupersessionEdges',
        'fullResponseBytes',
        'gatherQueryBytes',
        'gatherQueryTerms',
        'gatherResponseBytes',
        'gatherSearches',
        'gatherShows',
        'payloadDepth',
        'payloadNodes',
        'queryBytes',
        'queryTerms',
        'supersessionEdges',
      ]
      assert.deepEqual(
        Object.keys(report.upgrade.independentBudgets.api).sort(),
        ['allocationWork', ...independentBudgetNames].sort(),
      )
      assert.deepEqual(Object.keys(report.upgrade.independentBudgets.cli).sort(), independentBudgetNames)
      assert.deepEqual(report.upgrade.independentBudgets.api.queryBytes, {
        overLimit: {
          error: {
            code: 'INVALID_ARGUMENT',
            details: { budget: 'queryBytes', field: 'query', maximum: 1024 },
            message: 'query must contain at most 1024 UTF-8 bytes.',
          },
          status: 'rejected',
        },
        withinLimit: { status: 'accepted' },
      })
      assert.deepEqual(
        report.upgrade.independentBudgets.api.compactQueryBytes,
        report.upgrade.independentBudgets.api.queryBytes,
      )
      assert.deepEqual(
        report.upgrade.independentBudgets.api.gatherQueryBytes,
        report.upgrade.independentBudgets.api.queryBytes,
      )
      assert.deepEqual(report.upgrade.independentBudgets.api.allocationWork, {
        descriptorMapCalls: 0,
        oversizedArray: {
          error: {
            code: 'INVALID_ARGUMENT',
            details: { field: 'payload' },
            message: 'payload may contain at most 10000 JSON nodes.',
          },
          work: { descriptors: ['length'], ownKeys: 0 },
        },
        retainedDescriptorCount: 0,
        wideObject: {
          error: {
            code: 'INVALID_ARGUMENT',
            details: { field: 'payload' },
            message: 'payload may contain at most 10000 JSON nodes.',
          },
          propertyCount: 100_000,
          work: { descriptors: 100_000, ownKeys: 1 },
        },
      })
      assert.deepEqual(report.upgrade.independentBudgets.api.corpusSupersessionEdges, {
        overLimit: {
          status: 'rejected',
          validation: {
            errors: [
              {
                code: 'CORPUS_SUPERSEDES_LIMIT',
                message: 'Canonical corpus may contain at most 1000 supersession edges.',
              },
            ],
            truncated: false,
            valid: false,
          },
        },
        withinLimit: { status: 'accepted' },
      })
      assert.deepEqual(report.upgrade.independentBudgets.api.corpusArtifactReferences, {
        overLimit: {
          status: 'rejected',
          validation: {
            errors: [
              {
                code: 'CORPUS_ARTIFACT_LIMIT',
                message: 'Canonical corpus may contain at most 1000 artifact references.',
              },
            ],
            truncated: false,
            valid: false,
          },
        },
        withinLimit: { status: 'accepted' },
      })
      const cliSupersessionEvidence = report.upgrade.independentBudgets.cli.supersessionEdges
      assert.ok(cliSupersessionEvidence)
      assert.deepEqual(cliSupersessionEvidence, {
        overLimit: {
          error: {
            code: 'INVALID_ARGUMENT',
            details: { budget: 'supersessionEdges', field: 'supersedes', maximum: 1000 },
            message: '--supersedes may be supplied at most 1000 times.',
          },
          status: 'rejected',
        },
        withinLimit: {
          error: {
            code: 'INVALID_ARGUMENT',
            details: { field: 'supersedes' },
            message: 'supersedes must be a non-empty array of unique strings.',
          },
          status: 'rejected',
        },
      })
      assert.deepEqual(report.oracle.independentBudgets, report.downgrade.independentBudgets)
      assert.equal(JSON.stringify(report).includes(temporaryRoot), false)
      assert.equal(
        readFileSync(resolve(fixtureRoot, 'AGENTS.md'), 'utf8').startsWith('oracle agents predecessor\n'),
        true,
      )
      assert.equal(
        readFileSync(resolve(fixtureRoot, 'CLAUDE.md'), 'utf8').startsWith('oracle claude predecessor\n'),
        true,
      )
      assert.deepEqual(
        readdirSync(fixtureRoot).filter(name =>
          /^[.](?:AGENTS[.]md|CLAUDE[.]md)[.][0-9]+[.][0-9a-f-]+[.]backup$/u.test(name),
        ),
        [],
      )
      assert.equal(
        readFileSync(
          resolve(fixtureRoot, 'encephalon', '_artifacts', 'decision', 'compatibility-base', 'evidence.txt'),
          'utf8',
        ),
        'oracle artifact evidence\n',
      )
      const database = new DatabaseSync(resolve(fixtureRoot, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'), {
        readOnly: true,
      })
      try {
        const row = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as
          | { value?: unknown }
          | undefined
        assert.equal(row?.value, '1')
      } finally {
        database.close()
      }
      assert.equal(
        JSON.parse(readFileSync(resolve(fixtureRoot, 'node_modules', 'encephalon', 'package.json'), 'utf8')).version,
        '0.2.0',
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects a local oracle identity mismatch before creating or installing the fixture repository', () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-wrong-oracle-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(() =>
        runReleaseCompatibility({
          candidateTarball: candidate.tarball,
          fixtureRoot,
          oracle: {
            identity: {
              integrity: `${oracleDigests.integrity}-wrong`,
              shasum: oracleDigests.sha1,
              specifier: 'local-encephalon@0.2.0',
            },
            tarball: oracle.tarball,
          },
        }),
      )
      assert.equal(existsSync(resolve(fixtureRoot, 'package.json')), false)
      assert.equal(existsSync(resolve(fixtureRoot, 'node_modules', 'encephalon')), false)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('revalidates durable oracle identity immediately before downgrade installation', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-oracle-replacement-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(
        () =>
          runReleaseCompatibility({
            candidateTarball: candidate.tarball,
            fixtureRoot,
            hooks: {
              beforeOracleDowngrade: oracleSnapshot => {
                const bytes = readFileSync(oracleSnapshot)
                renameSync(oracleSnapshot, `${oracleSnapshot}.replaced`)
                writeFileSync(oracleSnapshot, bytes)
              },
            },
            oracle: {
              identity: {
                integrity: oracleDigests.integrity,
                shasum: oracleDigests.sha1,
                specifier: 'local-encephalon@0.2.0',
              },
              tarball: oracle.tarball,
            },
          }),
        /artifact changed|snapshot|identity|Durable compatibility state changed/iu,
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('requires the candidate manifest version to equal the source release version', {
    timeout: compatibilityRegressionTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-version-mismatch-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.1', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(
        () =>
          runReleaseCompatibility({
            candidateTarball: candidate.tarball,
            fixtureRoot,
            oracle: {
              identity: {
                integrity: oracleDigests.integrity,
                shasum: oracleDigests.sha1,
                specifier: 'local-encephalon@0.2.0',
              },
              tarball: oracle.tarball,
            },
          }),
        /candidate package version.*source release version/iu,
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects package self-rewrite, probe tamper, and unrelated per-phase side effects', {
    timeout: compatibilityRegressionTimeout,
  }, () => {
    for (const behaviour of [
      '0.3.0-import-sentinel',
      '0.3.0-probe-tamper',
      '0.3.0-success-stderr',
      '0.3.0-candidate-self-rewrite',
      '0.3.0-api-phase-side-effect',
      '0.3.0-cli-phase-side-effect',
      '0.3.0-budget-phase-side-effect',
    ]) {
      const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-import-contract-'))
      const fixtureRoot = resolve(temporaryRoot, 'repository')
      try {
        mkdirSync(fixtureRoot)
        const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
        const candidate = buildStandInTarball(temporaryRoot, behaviour, '2')
        const oracleDigests = packageTarballDigests(oracle.tarball)

        assert.throws(() =>
          runReleaseCompatibility({
            candidateTarball: candidate.tarball,
            fixtureRoot,
            oracle: {
              identity: {
                integrity: oracleDigests.integrity,
                shasum: oracleDigests.sha1,
                specifier: 'local-encephalon@0.2.0',
              },
              tarball: oracle.tarball,
            },
          }),
        )
      } finally {
        rmSync(temporaryRoot, { force: true, recursive: true })
      }
    }
  })

  test('never deletes a candidate-controlled added path during probe cleanup', {
    timeout: compatibilityRegressionTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-hostile-added-path-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0-hostile-added-path', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(() =>
        runReleaseCompatibility({
          candidateTarball: candidate.tarball,
          fixtureRoot,
          oracle: {
            identity: {
              integrity: oracleDigests.integrity,
              shasum: oracleDigests.sha1,
              specifier: 'local-encephalon@0.2.0',
            },
            tarball: oracle.tarball,
          },
        }),
      )
      assert.equal(
        readFileSync(resolve(fixtureRoot, 'AGENTS.md'), 'utf8').startsWith('oracle agents predecessor\n'),
        true,
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects candidate API and CLI surface drift that loose success checks would accept', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-shape-drift-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0-shape-drift', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(
        () =>
          runReleaseCompatibility({
            candidateTarball: candidate.tarball,
            fixtureRoot,
            oracle: {
              identity: {
                integrity: oracleDigests.integrity,
                shasum: oracleDigests.sha1,
                specifier: 'local-encephalon@0.2.0',
              },
              tarball: oracle.tarball,
            },
          }),
        /does not exactly preserve the published public surface/,
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects candidate independent-budget drift that result-limit checks cannot observe', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-budget-drift-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0-budget-drift', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(
        () =>
          runReleaseCompatibility({
            candidateTarball: candidate.tarball,
            fixtureRoot,
            oracle: {
              identity: {
                integrity: oracleDigests.integrity,
                shasum: oracleDigests.sha1,
                specifier: 'local-encephalon@0.2.0',
              },
              tarball: oracle.tarball,
            },
          }),
        /does not enforce the approved independent public budget boundaries exactly \(api\.compactQueryBytes\.overLimit\.error, .*api\.queryBytes\.overLimit\.status, cli\.compactQueryBytes\.overLimit\.error, .*cli\.queryBytes\.overLimit\.status\)\./,
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects compact/gather query, allocation-work, and aggregate-corpus drift', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-coverage-drift-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0-coverage-drift', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(
        () =>
          runReleaseCompatibility({
            candidateTarball: candidate.tarball,
            fixtureRoot,
            oracle: {
              identity: {
                integrity: oracleDigests.integrity,
                shasum: oracleDigests.sha1,
                specifier: 'local-encephalon@0.2.0',
              },
              tarball: oracle.tarball,
            },
          }),
        /does not enforce the approved independent public budget boundaries exactly/,
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects forged non-public witnesses when public allocation and aggregate validation do not conform', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-forged-witness-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0-forged-witness', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(
        () =>
          runReleaseCompatibility({
            candidateTarball: candidate.tarball,
            fixtureRoot,
            oracle: {
              identity: {
                integrity: oracleDigests.integrity,
                shasum: oracleDigests.sha1,
                specifier: 'local-encephalon@0.2.0',
              },
              tarball: oracle.tarball,
            },
          }),
        /does not enforce the approved independent public budget boundaries exactly/,
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('ignores candidate-supplied non-public witnesses when public behaviour conforms', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-forged-export-only-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0-forged-export-only', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.doesNotThrow(() =>
        runReleaseCompatibility({
          candidateTarball: candidate.tarball,
          fixtureRoot,
          oracle: {
            identity: {
              integrity: oracleDigests.integrity,
              shasum: oracleDigests.sha1,
              specifier: 'local-encephalon@0.2.0',
            },
            tarball: oracle.tarball,
          },
        }),
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('removes preload variables from npm and every installed-package child process', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-preload-isolation-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    const marker = resolve(temporaryRoot, 'npm-preload-marker')
    const preload = resolve(temporaryRoot, 'preload.cjs')
    const originalNodeOptions = process.env.NODE_OPTIONS
    const originalNodePath = process.env.NODE_PATH
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0-environment-witness', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0-environment-witness', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)
      writeFileSync(preload, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'loaded\\n')\n`)
      process.env.NODE_OPTIONS = `--require=${preload}`
      process.env.NODE_PATH = resolve(temporaryRoot, 'private-modules')

      assert.doesNotThrow(() =>
        runReleaseCompatibility({
          candidateTarball: candidate.tarball,
          fixtureRoot,
          oracle: {
            identity: {
              integrity: oracleDigests.integrity,
              shasum: oracleDigests.sha1,
              specifier: 'local-encephalon@0.2.0',
            },
            tarball: oracle.tarball,
          },
        }),
      )
      assert.equal(existsSync(marker), false)
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }
      if (originalNodePath === undefined) {
        delete process.env.NODE_PATH
      } else {
        process.env.NODE_PATH = originalNodePath
      }
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('removes preload variables added by an imported package before spawning nested CLI processes', {
    timeout: compatibilityIntegrationTimeout,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-import-environment-mutation-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0-environment-mutation', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.doesNotThrow(() =>
        runReleaseCompatibility({
          candidateTarball: candidate.tarball,
          fixtureRoot,
          oracle: {
            identity: {
              integrity: oracleDigests.integrity,
              shasum: oracleDigests.sha1,
              specifier: 'local-encephalon@0.2.0',
            },
            tarball: oracle.tarball,
          },
        }),
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })
})
