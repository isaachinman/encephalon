import { PACKAGE_DECLARATION_CONSUMER_SOURCE } from './package-declaration-consumer.ts'

export const API_PROBE_SOURCE = `
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [phase, root, packageEntry] = process.argv.slice(2)
const api = await import(packageEntry)
const manifest = JSON.parse(readFileSync(resolve(root, 'node_modules', 'encephalon', 'package.json'), 'utf8'))
const fail = stage => { throw Object.assign(new Error(stage), { stage }) }
const assert = (condition, stage) => { if (!condition) fail(stage) }
const at = (stage, action) => {
  try {
    return action()
  } catch (error) {
    if (typeof error?.stage === 'string') {
      throw error
    }
    throw Object.assign(new Error(stage), { code: error?.code, stage })
  }
}
const cacheSchema = () => {
  const database = new DatabaseSync(resolve(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'), { readOnly: true })
  try {
    const row = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get()
    return row?.value
  } finally {
    database.close()
  }
}
const assertRecord = (record, id, stage) => assert(record?.id === id, stage)
const normalisePublicValue = (value, key) => {
  if (key === 'createdAt' && typeof value === 'string') return '<timestamp>'
  if (typeof value === 'string') return value.replaceAll(root, '<fixture-root>')
  if (Array.isArray(value)) return value.map(item => normalisePublicValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalisePublicValue(item, name)]))
  }
  return value
}
const errorShape = (error, stage) => {
  assert(error instanceof api.EncephalonError, stage + '-type')
  return normalisePublicValue({
    code: error.code,
    details: error.details,
    message: error.message,
    name: error.name,
    ownKeys: Reflect.ownKeys(error).filter(key => typeof key === 'string').sort(),
  })
}
const captureError = (action, stage) => {
  let failure
  try {
    action()
  } catch (error) {
    failure = error
  }
  assert(failure !== undefined, stage + '-missing')
  return errorShape(failure, stage)
}
const limits = [50, 100, 101, 999, 1000, 1001]
const operationNames = ['list', 'search', 'searchCompact', 'gather']
const operations = {
  gather: limit => api.gatherRecords({ includeSuperseded: true, limit, root, searches: ['compatibility-marker'] }),
  list: limit => api.listRecords({ includeSuperseded: true, limit, root }),
  search: limit => api.searchRecords({ includeSuperseded: true, limit, query: 'compatibility-marker', root }),
  searchCompact: limit => api.searchCompactRecords({ includeSuperseded: true, limit, query: 'compatibility-marker', root }),
}
const resultLimits = () => {
  const maximums = phase === 'upgrade'
    ? { gather: 1000, list: 1000, search: 1000, searchCompact: 1000 }
    : { gather: 100, list: 50, search: 50, searchCompact: 100 }
  return Object.fromEntries(operationNames.map(name => [name, limits.reduce((outcome, limit) => {
    const budget = name === 'list' || name === 'search' ? 'fullResultLimit' : 'compactResultLimit'
    if (limit <= maximums[name]) {
      at('api-limit-accepted-' + name + '-' + limit, () => operations[name](limit))
      return { ...outcome, accepted: [...outcome.accepted, limit] }
    }
    let failure
    try {
      operations[name](limit)
    } catch (error) {
      failure = error
    }
    assert(failure instanceof api.EncephalonError, 'api-limit-error-type-' + name + '-' + limit)
    assert(failure.code === 'INVALID_ARGUMENT', 'api-limit-error-code-' + name + '-' + limit)
    if (phase !== 'upgrade' && limit === 1001) {
      assert(failure.details?.field === 'limit', 'api-limit-parser-field-' + name + '-' + limit)
    } else {
      assert(failure.details?.budget === budget, 'api-limit-error-budget-' + name + '-' + limit)
      assert(failure.details?.field === 'limit', 'api-limit-error-field-' + name + '-' + limit)
      assert(failure.details?.maximum === maximums[name], 'api-limit-error-maximum-' + name + '-' + limit)
    }
    return { ...outcome, rejected: [...outcome.rejected, limit] }
  }, { accepted: [], rejected: [] })]))
}
const readCompatibilityState = () => {
  const validation = api.validateRecords({ root })
  assert(validation.valid === true, 'api-validate')
  const listed = api.listRecords({ includeSuperseded: true, limit: phase === 'upgrade' ? 1000 : 50, root })
  assert(listed.some(record => record.id === 'compatibility-base'), 'api-list-base')
  assertRecord(api.showRecord({ id: 'compatibility-base', root }), 'compatibility-base', 'api-show-base')
  assert(api.searchRecords({ includeSuperseded: true, query: 'compatibility-marker', root }).length > 0, 'api-search')
  assert(api.searchCompactRecords({ includeSuperseded: true, query: 'compatibility-marker', root }).length > 0, 'api-search-compact')
  const gathered = api.gatherRecords({ includeSuperseded: true, root, searches: ['compatibility-marker'], shows: ['compatibility-base'] })
  assert(gathered.records?.[0]?.record?.id === 'compatibility-base', 'api-gather-show')
  assert(gathered.searches?.[0]?.results?.length > 0, 'api-gather-search')
}
const publicSurface = () => {
  const initialised = at('surface-init', () => api.initEncephalon({ root }))
  const added = at('surface-add', () => api.addRecord({
    id: 'compatibility-api-surface-add',
    kind: 'decision',
    payload: { summary: 'Compatibility API surface add' },
    root,
    searchText: 'compatibility-marker api-surface-add',
    source: 'release-compatibility',
    subject: 'release.compatibility.api-surface-add',
  }))
  rmSync(resolve(root, 'encephalon', 'decision', 'compatibility-api-surface-add.json'))
  const duplicate = captureError(() => api.addRecord({
    id: 'compatibility-base',
    kind: 'decision',
    payload: {},
    root,
    source: 'release-compatibility',
    subject: 'release.compatibility.base',
  }), 'surface-add-error')
  const prepared = at('surface-prepare', () => api.prepare({ root }))
  const hydrated = at('surface-hydrate', () => api.hydrate({ root }))
  return normalisePublicValue({
    add: added,
    addError: duplicate,
    gather: at('surface-gather', () => api.gatherRecords({
      includeSuperseded: true,
      root,
      searches: ['compatibility-marker'],
      shows: ['compatibility-base'],
    })),
    hydrate: hydrated,
    init: initialised,
    list: at('surface-list', () => api.listRecords({ includeSuperseded: true, kind: 'decision', root })),
    prepare: prepared,
    search: at('surface-search', () => api.searchRecords({
      includeSuperseded: true,
      query: 'compatibility-marker',
      root,
    })),
    searchCompact: at('surface-search-compact', () => api.searchCompactRecords({
      includeSuperseded: true,
      query: 'compatibility-marker',
      root,
    })),
    show: at('surface-show', () => api.showRecord({ id: 'compatibility-base', root })),
    validate: at('surface-validate', () => api.validateRecords({ root })),
  })
}
const initialise = () => {
  at('initialise-init', () => api.initEncephalon({ root }))
  const artifact = resolve(root, 'encephalon', '_artifacts', 'decision', 'compatibility-base', 'evidence.txt')
  mkdirSync(resolve(artifact, '..'), { recursive: true })
  writeFileSync(artifact, 'oracle artifact evidence\\n')
  at('initialise-add-base', () => api.addRecord({
    artifacts: ['_artifacts/decision/compatibility-base/evidence.txt'],
    id: 'compatibility-base',
    kind: 'decision',
    payload: { summary: 'Oracle compatibility base' },
    root,
    searchText: 'compatibility-marker oracle-base',
    source: 'release-compatibility',
    subject: 'release.compatibility.base',
  }))
  at('initialise-add-successor', () => api.addRecord({
    id: 'compatibility-successor',
    kind: 'decision',
    payload: { summary: 'Oracle compatibility successor' },
    root,
    searchText: 'compatibility-marker oracle-successor',
    source: 'release-compatibility',
    subject: 'release.compatibility.base',
    supersedes: ['compatibility-base'],
  }))
  at('initialise-prepare', () => api.prepare({ root }))
  return { limits: at('initialise-result-limits', resultLimits), schemaAfter: cacheSchema(), surface: publicSurface() }
}
const upgrade = () => {
  const schemaBefore = cacheSchema()
  api.initEncephalon({ root })
  readCompatibilityState()
  let duplicate
  try {
    api.addRecord({ id: 'compatibility-base', kind: 'decision', payload: {}, root, source: 'release-compatibility', subject: 'release.compatibility.base' })
  } catch (error) {
    duplicate = error
  }
  assert(duplicate instanceof api.EncephalonError && duplicate.code === 'RECORD_EXISTS', 'api-add-duplicate')
  const prepared = api.prepare({ root })
  assert(typeof prepared?.recordsIndexed === 'number', 'api-prepare')
  const schemaAfter = cacheSchema()
  const hydrated = api.hydrate({ root })
  assert(typeof hydrated?.recordsIndexed === 'number', 'api-hydrate')
  return { limits: resultLimits(), schemaAfter, schemaBefore, surface: publicSurface() }
}
const downgrade = () => {
  const schemaBefore = cacheSchema()
  readCompatibilityState()
  const prepared = api.prepare({ root })
  assert(typeof prepared?.recordsIndexed === 'number', 'api-downgrade-prepare')
  return { limits: resultLimits(), schemaAfter: cacheSchema(), schemaBefore, surface: publicSurface() }
}

try {
  const result = phase === 'initialise' ? initialise() : phase === 'upgrade' ? upgrade() : phase === 'downgrade' ? downgrade() : fail('unknown-phase')
  process.stdout.write(JSON.stringify({ ...result, version: manifest.version }) + '\\n')
} catch (error) {
  process.stderr.write(JSON.stringify({ code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR', stage: typeof error?.stage === 'string' ? error.stage : 'api-probe' }) + '\\n')
  process.exitCode = 1
}
`

export const IMPORT_PROBE_SOURCE = `
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [root, packageEntry] = process.argv.slice(2)
const api = await import(packageEntry)
const required = ['EncephalonError', 'addRecord', 'gatherRecords', 'hydrate', 'initEncephalon', 'listRecords', 'prepare', 'searchCompactRecords', 'searchRecords', 'showRecord', 'validateRecords']
const manifest = JSON.parse(readFileSync(resolve(root, 'node_modules', 'encephalon', 'package.json'), 'utf8'))
if (required.some(name => typeof api[name] !== 'function')) {
  process.stderr.write('{"stage":"import-contract"}\\n')
  process.exitCode = 1
} else {
  process.stdout.write(JSON.stringify({ exports: required, version: manifest.version }) + '\\n')
}
`

export const BUDGET_PROBE_SOURCE = `
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [root, packagePhase, packageEntry] = process.argv.slice(2)
const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const retainedDescriptorMaps = []
let descriptorMapCalls = 0
const observedGetOwnPropertyDescriptors = value => {
  descriptorMapCalls += 1
  const descriptors = originalGetOwnPropertyDescriptors(value)
  retainedDescriptorMaps.push(descriptors)
  return descriptors
}
if (packagePhase === 'candidate') Object.getOwnPropertyDescriptors = observedGetOwnPropertyDescriptors
const api = await import(packageEntry)
if (packagePhase === 'candidate') Object.getOwnPropertyDescriptors = observedGetOwnPropertyDescriptors
const cli = resolve(root, 'node_modules', 'encephalon', 'dist', 'cli.mjs')
const sanitizedChildEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => {
    const normalized = key.toLowerCase()
    return normalized !== 'node_options' && normalized !== 'node_path'
  }),
)
const MAX_CANONICAL_BYTES = 8 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const fail = stage => { throw Object.assign(new Error(stage), { stage }) }
const errorValue = error => {
  if (!(error instanceof api.EncephalonError)) fail('budget-api-error-type')
  return { code: error.code, details: error.details, message: error.message }
}
const apiObservation = action => {
  try {
    action()
    return { status: 'accepted' }
  } catch (error) {
    return { error: errorValue(error), status: 'rejected' }
  }
}
const cliResult = arguments_ =>
  spawnSync(process.execPath, [cli, '--root', root, ...arguments_], {
    cwd: root,
    encoding: 'utf8',
    env: sanitizedChildEnvironment,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 120000,
  })
const cliObservation = arguments_ => {
  const result = cliResult(arguments_)
  if (result.error === undefined && result.status === 0 && result.stderr === '') {
    try {
      JSON.parse(result.stdout)
    } catch {
      fail('budget-cli-success-json')
    }
    return { status: 'accepted' }
  }
  if (result.error === undefined && result.status === 2 && result.stdout === '') {
    try {
      const body = JSON.parse(result.stderr)
      if (body?.error?.code !== undefined && body?.error?.details !== undefined && body?.error?.message !== undefined) {
        return { error: body.error, status: 'rejected' }
      }
    } catch {
      fail('budget-cli-error-json')
    }
  }
  fail('budget-cli-process')
}
const boundary = (withinLimit, overLimit) => ({
  overLimit: overLimit(),
  withinLimit: withinLimit(),
})
const validationObservation = value => {
  if (!Array.isArray(value?.errors) || typeof value?.truncated !== 'boolean' || typeof value?.valid !== 'boolean') {
    fail('budget-validation-shape')
  }
  const validation = {
    errors: value.errors.map(error => ({ code: error?.code, message: error?.message })),
    truncated: value.truncated,
    valid: value.valid,
  }
  return validation.valid && validation.errors.length === 0 && !validation.truncated
    ? { status: 'accepted' }
    : { status: 'rejected', validation }
}
const apiValidationObservation = () => validationObservation(api.validateRecords({ root }))
const cliValidationObservation = () => {
  const result = cliResult(['validate'])
  if (result.error !== undefined || result.stderr !== '') fail('budget-cli-validation-process')
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    fail('budget-cli-validation-json')
  }
  if (result.status !== (value?.valid === true ? 0 : 2)) fail('budget-cli-validation-status')
  return validationObservation(value)
}
const canonicalFiles = () => {
  const brain = resolve(root, 'encephalon')
  return readdirSync(brain, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('_'))
    .flatMap(entry => readdirSync(resolve(brain, entry.name)).filter(name => name.endsWith('.json')).map(name => resolve(brain, entry.name, name)))
}
const canonicalRecords = () => canonicalFiles().map(path => JSON.parse(readFileSync(path, 'utf8')))
const recordValue = (kind, id, index, payload = {}, searchText) => ({
  createdAt: new Date(Date.UTC(2000, 0, 1) + index).toISOString(),
  id,
  kind,
  payload,
  source: 'release-compatibility',
  subject: 'release.compatibility.' + id,
  ...(searchText === undefined ? {} : { searchText }),
})
const formatted = record => JSON.stringify(record, null, 2) + '\\n'
const withRecords = (kind, records, action) => {
  const directory = resolve(root, 'encephalon', kind)
  mkdirSync(directory)
  try {
    records.map(record => writeFileSync(resolve(directory, record.id + '.json'), formatted(record)))
    return action()
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}
const exactByteRecord = (kind, id, index, targetBytes) => {
  const empty = recordValue(kind, id, index, { text: '' })
  const overhead = Buffer.byteLength(formatted(empty))
  if (targetBytes < overhead || targetBytes > MAX_RECORD_BYTES) fail('budget-byte-fixture')
  const record = recordValue(kind, id, index, { text: 'x'.repeat(targetBytes - overhead) })
  if (Buffer.byteLength(formatted(record)) !== targetBytes) fail('budget-byte-fixture-size')
  return record
}
const temporaryApiAdd = (id, payload, extra = {}) => () => {
  const path = resolve(root, 'encephalon', 'decision', id + '.json')
  try {
    api.addRecord({ id, kind: 'decision', payload, root, source: 'release-compatibility', subject: 'release.compatibility.' + id, ...extra })
  } finally {
    rmSync(path, { force: true })
  }
}
const temporaryCliAdd = (id, payload, extraArguments = []) => () => {
  const path = resolve(root, 'encephalon', 'decision', id + '.json')
  try {
    return cliObservation(['add', '--id', id, '--kind', 'decision', '--subject', 'release.compatibility.' + id, '--source', 'release-compatibility', '--data', JSON.stringify(payload), ...extraArguments])
  } finally {
    rmSync(path, { force: true })
  }
}
const nestedPayload = levels => Array.from({ length: levels }).reduce(value => [value], null)
const queryBytesWithin = 'q'.repeat(1024)
const queryBytesOver = queryBytesWithin + 'q'
const queryTermsWithin = Array.from({ length: 32 }, (_, index) => 'term' + index).join(' ')
const queryTermsOver = queryTermsWithin + ' term32'
const searchesWithin = Array.from({ length: 16 }, () => '!')
const searchesOver = [...searchesWithin, '!']
const showsWithin = Array.from({ length: 64 }, () => 'compatibility-missing')
const showsOver = [...showsWithin, 'compatibility-missing']
const supersedesWithin = Array.from({ length: 1000 }, () => 'compatibility-base')
const supersedesOver = [...supersedesWithin, 'compatibility-base']
const payloadNodesWithin = Array.from({ length: 9999 }, () => 0)
const payloadNodesOver = [...payloadNodesWithin, 0]

const apiReport = {
  queryBytes: boundary(
    () => apiObservation(() => api.searchRecords({ query: queryBytesWithin, root })),
    () => apiObservation(() => api.searchRecords({ query: queryBytesOver, root })),
  ),
  compactQueryBytes: boundary(
    () => apiObservation(() => api.searchCompactRecords({ query: queryBytesWithin, root })),
    () => apiObservation(() => api.searchCompactRecords({ query: queryBytesOver, root })),
  ),
  gatherQueryBytes: boundary(
    () => apiObservation(() => api.gatherRecords({ root, searches: [queryBytesWithin] })),
    () => apiObservation(() => api.gatherRecords({ root, searches: [queryBytesOver] })),
  ),
  queryTerms: boundary(
    () => apiObservation(() => api.searchRecords({ query: queryTermsWithin, root })),
    () => apiObservation(() => api.searchRecords({ query: queryTermsOver, root })),
  ),
  compactQueryTerms: boundary(
    () => apiObservation(() => api.searchCompactRecords({ query: queryTermsWithin, root })),
    () => apiObservation(() => api.searchCompactRecords({ query: queryTermsOver, root })),
  ),
  gatherQueryTerms: boundary(
    () => apiObservation(() => api.gatherRecords({ root, searches: [queryTermsWithin] })),
    () => apiObservation(() => api.gatherRecords({ root, searches: [queryTermsOver] })),
  ),
  gatherSearches: boundary(
    () => apiObservation(() => api.gatherRecords({ root, searches: searchesWithin })),
    () => apiObservation(() => api.gatherRecords({ root, searches: searchesOver })),
  ),
  gatherShows: boundary(
    () => apiObservation(() => api.gatherRecords({ root, shows: showsWithin })),
    () => apiObservation(() => api.gatherRecords({ root, shows: showsOver })),
  ),
  supersessionEdges: boundary(
    () => apiObservation(temporaryApiAdd('compatibility-supersedes-within', {}, { supersedes: supersedesWithin })),
    () => apiObservation(temporaryApiAdd('compatibility-supersedes-over', {}, { supersedes: supersedesOver })),
  ),
  payloadNodes: boundary(
    () => apiObservation(temporaryApiAdd('compatibility-payload-nodes-within', payloadNodesWithin)),
    () => apiObservation(temporaryApiAdd('compatibility-payload-nodes-over', payloadNodesOver)),
  ),
  payloadDepth: boundary(
    () => apiObservation(temporaryApiAdd('compatibility-payload-depth-within', nestedPayload(64))),
    () => apiObservation(temporaryApiAdd('compatibility-payload-depth-over', nestedPayload(65))),
  ),
}

const cliReport = {
  queryBytes: boundary(
    () => cliObservation(['search', '--', queryBytesWithin]),
    () => cliObservation(['search', '--', queryBytesOver]),
  ),
  compactQueryBytes: boundary(
    () => cliObservation(['search', '--compact', '--', queryBytesWithin]),
    () => cliObservation(['search', '--compact', '--', queryBytesOver]),
  ),
  gatherQueryBytes: boundary(
    () => cliObservation(['gather', '--search', queryBytesWithin]),
    () => cliObservation(['gather', '--search', queryBytesOver]),
  ),
  queryTerms: boundary(
    () => cliObservation(['search', '--', queryTermsWithin]),
    () => cliObservation(['search', '--', queryTermsOver]),
  ),
  compactQueryTerms: boundary(
    () => cliObservation(['search', '--compact', '--', queryTermsWithin]),
    () => cliObservation(['search', '--compact', '--', queryTermsOver]),
  ),
  gatherQueryTerms: boundary(
    () => cliObservation(['gather', '--search', queryTermsWithin]),
    () => cliObservation(['gather', '--search', queryTermsOver]),
  ),
  gatherSearches: boundary(
    () => cliObservation(['gather', ...searchesWithin.flatMap(query => ['--search', query])]),
    () => cliObservation(['gather', ...searchesOver.flatMap(query => ['--search', query])]),
  ),
  gatherShows: boundary(
    () => cliObservation(['gather', ...showsWithin.flatMap(id => ['--show', id])]),
    () => cliObservation(['gather', ...showsOver.flatMap(id => ['--show', id])]),
  ),
  supersessionEdges: boundary(
    temporaryCliAdd('compatibility-cli-supersedes-within', {}, supersedesWithin.map(id => '--supersedes=' + id)),
    temporaryCliAdd('compatibility-cli-supersedes-over', {}, supersedesOver.map(id => '--supersedes=' + id)),
  ),
  payloadNodes: boundary(
    temporaryCliAdd('compatibility-cli-payload-nodes-within', payloadNodesWithin),
    temporaryCliAdd('compatibility-cli-payload-nodes-over', payloadNodesOver),
  ),
  payloadDepth: boundary(
    temporaryCliAdd('compatibility-cli-payload-depth-within', nestedPayload(64)),
    temporaryCliAdd('compatibility-cli-payload-depth-over', nestedPayload(65)),
  ),
}

const captureApiError = action => {
  let failure
  try {
    action()
  } catch (error) {
    failure = error
  }
  if (failure === undefined) fail('allocation-api-error-missing')
  return errorValue(failure)
}
const captureAllocationWork = () => {
  descriptorMapCalls = 0
  retainedDescriptorMaps.length = 0
  Object.getOwnPropertyDescriptors = observedGetOwnPropertyDescriptors
  const propertyCount = 100000
  const target = {}
  for (let index = 0; index < propertyCount; index += 1) {
    target['key-' + index] = index
  }
  const work = { descriptors: 0, ownKeys: 0 }
  const payload = new Proxy(target, {
    getOwnPropertyDescriptor: (object, key) => {
      work.descriptors += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
    ownKeys: object => {
      work.ownKeys += 1
      return Reflect.ownKeys(object)
    },
  })
  const oversizedArrayWork = { descriptors: [], ownKeys: 0 }
  const oversizedArray = new Proxy(new Array(2 ** 32 - 1), {
    getOwnPropertyDescriptor: (array, key) => {
      oversizedArrayWork.descriptors.push(String(key))
      return Reflect.getOwnPropertyDescriptor(array, key)
    },
    ownKeys: array => {
      oversizedArrayWork.ownKeys += 1
      return Reflect.ownKeys(array)
    },
  })
  const addPayload = value => api.addRecord({
    id: 'compatibility-allocation-work',
    kind: 'decision',
    payload: value,
    root: resolve(root, '.release-compatibility', 'unused-allocation-root'),
    source: 'release-compatibility',
    subject: 'release.compatibility.allocation-work',
  })
  let wideObjectError
  let oversizedArrayError
  try {
    wideObjectError = captureApiError(() => addPayload(payload))
    oversizedArrayError = captureApiError(() => addPayload(oversizedArray))
  } finally {
    Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors
  }
  return {
    descriptorMapCalls,
    oversizedArray: { error: oversizedArrayError, work: oversizedArrayWork },
    retainedDescriptorCount: retainedDescriptorMaps.reduce(
      (count, descriptors) => count + Reflect.ownKeys(descriptors).length,
      0,
    ),
    wideObject: { error: wideObjectError, propertyCount, work },
  }
}
if (packagePhase === 'candidate') {
  apiReport.allocationWork = captureAllocationWork()
} else {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors
}

const existingCount = canonicalFiles().length
const countKind = 'compatibilitybudgetcount'
const countRecords = Array.from({ length: 1000 - existingCount }, (_, index) =>
  recordValue(countKind, 'compatibility-count-' + String(index).padStart(4, '0'), index),
)
const countEvidence = withRecords(countKind, countRecords, () => ({
  api: boundary(
    () => apiObservation(() => api.validateRecords({ root })),
    () => apiObservation(temporaryApiAdd('compatibility-count-over', {})),
  ),
  cli: boundary(
    () => cliObservation(['validate']),
    temporaryCliAdd('compatibility-cli-count-over', {}),
  ),
}))
apiReport.corpusRecords = countEvidence.api
cliReport.corpusRecords = countEvidence.cli

const existingBytes = canonicalFiles().reduce((bytes, path) => bytes + statSync(path).size, 0)
const remainingBytes = MAX_CANONICAL_BYTES - existingBytes
const byteKind = 'compatibilitybudgetbytes'
const byteRecordCount = Math.ceil(remainingBytes / (MAX_RECORD_BYTES - 1024))
const baseByteTarget = Math.floor(remainingBytes / byteRecordCount)
const extraByteTargets = remainingBytes % byteRecordCount
const byteRecords = Array.from({ length: byteRecordCount }, (_, index) =>
  exactByteRecord(
    byteKind,
    'compatibility-bytes-' + String(index).padStart(2, '0'),
    index,
    baseByteTarget + (index < extraByteTargets ? 1 : 0),
  ),
)
const byteEvidence = withRecords(byteKind, byteRecords, () => ({
  api: boundary(
    () => apiObservation(() => api.validateRecords({ root })),
    () => apiObservation(temporaryApiAdd('compatibility-bytes-over', {})),
  ),
  cli: boundary(
    () => cliObservation(['validate']),
    temporaryCliAdd('compatibility-cli-bytes-over', {}),
  ),
}))
apiReport.corpusBytes = byteEvidence.api
cliReport.corpusBytes = byteEvidence.cli

const aggregateSupersessionEvidence = (() => {
  const existingRecords = canonicalRecords()
  const remainingEdges = 1000 - existingRecords.reduce(
    (count, record) => count + (record.supersedes?.length ?? 0),
    0,
  )
  const kind = 'compatibilitybudgetsupersession'
  const recordCount = Math.ceil((remainingEdges + 4) / 2)
  if (remainingEdges < 1 || recordCount > 1000 - existingRecords.length) {
    fail('budget-corpus-supersession-fixture')
  }
  const records = Array.from({ length: recordCount }, (_, index) => ({
    ...recordValue(kind, 'compatibility-supersession-' + String(index).padStart(4, '0'), index),
    subject: 'release.compatibility.aggregate-supersession',
    ...(index === 0 ? {} : { supersedes: ['compatibility-supersession-' + String(index - 1).padStart(4, '0')] }),
  }))
  const last = records.at(-1)
  if (last === undefined) fail('budget-corpus-supersession-last')
  const chainEdges = records.length - 1
  const additionalEdges = remainingEdges - chainEdges
  if (additionalEdges < 0 || additionalEdges > records.length - 3) {
    fail('budget-corpus-supersession-capacity')
  }
  const withinLast = {
    ...last,
    supersedes: [
      ...(last.supersedes ?? []),
      ...records.slice(0, additionalEdges).map(record => record.id),
    ],
  }
  const withinRecords = [...records.slice(0, -1), withinLast]
  const overTarget = records[additionalEdges]
  if (overTarget === undefined || withinLast.supersedes.includes(overTarget.id)) {
    fail('budget-corpus-supersession-over-target')
  }
  return withRecords(kind, withinRecords, () => {
    const apiWithin = apiValidationObservation()
    const cliWithin = cliValidationObservation()
    writeFileSync(
      resolve(root, 'encephalon', kind, withinLast.id + '.json'),
      formatted({ ...withinLast, supersedes: [...withinLast.supersedes, overTarget.id] }),
    )
    return {
      api: { overLimit: apiValidationObservation(), withinLimit: apiWithin },
      cli: { overLimit: cliValidationObservation(), withinLimit: cliWithin },
    }
  })
})()
apiReport.corpusSupersessionEdges = aggregateSupersessionEvidence.api
cliReport.corpusSupersessionEdges = aggregateSupersessionEvidence.cli

const aggregateArtifactEvidence = (() => {
  const existingArtifactCount = canonicalRecords().reduce(
    (count, record) => count + (record.artifacts?.length ?? 0),
    0,
  )
  const remainingArtifacts = 1000 - existingArtifactCount
  const kind = 'compatibilitybudgetartifacts'
  const artifactsPerRecord = 250
  const recordCount = Math.ceil(remainingArtifacts / artifactsPerRecord)
  if (remainingArtifacts < 1 || recordCount < 1) fail('budget-corpus-artifact-fixture')
  const records = Array.from({ length: recordCount }, (_, recordIndex) => {
    const id = 'compatibility-artifacts-' + String(recordIndex).padStart(2, '0')
    const count = Math.min(artifactsPerRecord, remainingArtifacts - recordIndex * artifactsPerRecord)
    return {
      ...recordValue(kind, id, recordIndex),
      artifacts: Array.from(
        { length: count },
        (_, artifactIndex) =>
          '_artifacts/' + kind + '/' + id + '/evidence-' + String(artifactIndex).padStart(3, '0') + '.txt',
      ),
    }
  })
  const recordDirectory = resolve(root, 'encephalon', kind)
  const artifactDirectory = resolve(root, 'encephalon', '_artifacts', kind)
  mkdirSync(recordDirectory)
  mkdirSync(artifactDirectory, { recursive: true })
  try {
    records.map(record => {
      writeFileSync(resolve(recordDirectory, record.id + '.json'), formatted(record))
      record.artifacts.map(path => {
        const directory = resolve(root, 'encephalon', '_artifacts', kind, record.id)
        mkdirSync(directory, { recursive: true })
        writeFileSync(resolve(root, 'encephalon', path), '')
      })
    })
    const apiWithin = apiValidationObservation()
    const cliWithin = cliValidationObservation()
    const last = records.at(-1)
    if (last === undefined) fail('budget-corpus-artifact-last')
    const overPath = '_artifacts/' + kind + '/' + last.id + '/over-limit.txt'
    writeFileSync(
      resolve(recordDirectory, last.id + '.json'),
      formatted({ ...last, artifacts: [...last.artifacts, overPath] }),
    )
    return {
      api: { overLimit: apiValidationObservation(), withinLimit: apiWithin },
      cli: { overLimit: cliValidationObservation(), withinLimit: cliWithin },
    }
  } finally {
    rmSync(recordDirectory, { force: true, recursive: true })
    rmSync(artifactDirectory, { force: true, recursive: true })
  }
})()
apiReport.corpusArtifactReferences = aggregateArtifactEvidence.api
cliReport.corpusArtifactReferences = aggregateArtifactEvidence.cli

const responseKind = 'compatibilitybudgetresponse'
const responseRecords = Array.from({ length: 5 }, (_, index) =>
  recordValue(
    responseKind,
    'compatibility-response-' + index,
    index,
    { summary: 'x '.repeat(450000) },
    'compatibility-response-marker',
  ),
)
const responseEvidence = withRecords(responseKind, responseRecords, () => ({
  api: {
    fullResponseBytes: boundary(
      () => apiObservation(() => api.searchRecords({ includeSuperseded: true, limit: 4, query: 'compatibility-response-marker', root })),
      () => apiObservation(() => api.searchRecords({ includeSuperseded: true, limit: 5, query: 'compatibility-response-marker', root })),
    ),
    compactResponseBytes: boundary(
      () => apiObservation(() => api.searchCompactRecords({ includeSuperseded: true, limit: 4, query: 'compatibility-response-marker', root })),
      () => apiObservation(() => api.searchCompactRecords({ includeSuperseded: true, limit: 5, query: 'compatibility-response-marker', root })),
    ),
    gatherResponseBytes: boundary(
      () => apiObservation(() => api.gatherRecords({ root, shows: Array.from({ length: 4 }, () => 'compatibility-response-0') })),
      () => apiObservation(() => api.gatherRecords({ root, shows: Array.from({ length: 5 }, () => 'compatibility-response-0') })),
    ),
  },
  cli: {
    fullResponseBytes: boundary(
      () => cliObservation(['search', '--include-superseded', '--limit=4', '--', 'compatibility-response-marker']),
      () => cliObservation(['search', '--include-superseded', '--limit=5', '--', 'compatibility-response-marker']),
    ),
    compactResponseBytes: boundary(
      () => cliObservation(['search', '--compact', '--include-superseded', '--limit=4', '--', 'compatibility-response-marker']),
      () => cliObservation(['search', '--compact', '--include-superseded', '--limit=5', '--', 'compatibility-response-marker']),
    ),
    gatherResponseBytes: boundary(
      () => cliObservation(['gather', ...Array.from({ length: 4 }, () => ['--show', 'compatibility-response-0']).flat()]),
      () => cliObservation(['gather', ...Array.from({ length: 5 }, () => ['--show', 'compatibility-response-0']).flat()]),
    ),
  },
}))
Object.assign(apiReport, responseEvidence.api)
Object.assign(cliReport, responseEvidence.cli)

process.stdout.write(JSON.stringify({ api: apiReport, cli: cliReport }) + '\\n')
`

export const DECLARATION_CONSUMER_SOURCE = PACKAGE_DECLARATION_CONSUMER_SOURCE
