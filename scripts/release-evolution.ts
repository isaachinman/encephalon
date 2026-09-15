import assert from 'node:assert/strict'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BrainRecord } from '../src/types.ts'
import { assertDurableSnapshotsEqualExcept, type DurableSnapshot } from './release-compatibility-filesystem.ts'

export const EVOLUTION_USER_INSTRUCTIONS = 'User guidance\r\nKeep this text'

// Only called after fixture subprocesses exit; never replay process-owned lock files.
export const snapshotLegacyCache = (root: string, destination: string) => {
  const path = resolve(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
  const database = new DatabaseSync(path)
  try {
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    assert.equal(checkpoint?.busy, 0)
  } finally {
    database.close()
  }
  for (const suffix of ['-wal', '-journal']) {
    const entry = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false })
    assert.ok(entry === undefined || entry.size === 0, 'An old-cache snapshot must be self-contained.')
  }
  copyFileSync(path, destination)
}

export const restoreLegacyCache = (root: string, source: string) => {
  const directory = resolve(root, 'node_modules', '.cache', 'encephalon')
  rmSync(directory, { force: true, recursive: true })
  mkdirSync(directory, { recursive: true })
  copyFileSync(source, resolve(directory, 'brain.sqlite'))
}

export const assertBaselineAppendOnly = (
  before: DurableSnapshot,
  after: DurableSnapshot,
  previous: readonly BrainRecord[],
  created: readonly BrainRecord[],
) => {
  assert.ok(created.length > 0)
  const superseded = new Set(previous.flatMap(record => record.supersedes ?? []))
  const paths = new Set(created.map(record => record.path))
  assert.equal(paths.size, created.length)
  const baselineKinds: Readonly<Record<string, string>> = {
    'encephalon:init/commands-ci': 'workflow',
    'encephalon:init/repository-overview': 'context',
    'encephalon:init/tooling-layout': 'architecture',
  }
  for (const record of created) {
    assert.equal(baselineKinds[record.subject], record.kind)
    const heads = previous.filter(
      old =>
        old.source === 'encephalon:init' &&
        old.kind === record.kind &&
        old.subject === record.subject &&
        !superseded.has(old.id),
    )
    assert.equal(record.source, 'encephalon:init')
    assert.ok(heads.length > 0)
    assert.deepEqual(record.supersedes?.toSorted(), heads.map(old => old.id).toSorted())
    assert.equal(record.path, `encephalon/${record.kind}/${record.id}.json`)
    assert.equal(
      previous.some(old => old.id === record.id),
      false,
    )
    const entry = after.find(file => file.path === record.path)
    assert.ok(entry?.bytes !== undefined)
    const { path: _path, ...persisted } = record
    assert.deepEqual(JSON.parse(entry.bytes.toString('utf8')), persisted)
  }
  const parents = new Set(created.map(record => record.path.slice(0, record.path.lastIndexOf('/'))))
  assertDurableSnapshotsEqualExcept(
    before,
    after,
    change =>
      (change.kind === 'added' && paths.has(change.path)) || (change.kind === 'links' && parents.has(change.path)),
  )
}

export const assertRestoredInstructions = (root: string) => {
  assert.deepEqual(readFileSync(resolve(root, 'AGENTS.md')), Buffer.from(EVOLUTION_USER_INSTRUCTIONS))
  assert.equal(lstatSync(resolve(root, 'CLAUDE.md'), { throwIfNoEntry: false }), undefined)
}

export type EvolutionProbeResult = Readonly<{
  created: readonly BrainRecord[]
  records: readonly BrainRecord[]
  schema: string
  schemaBefore?: string
  snippet?: string
}>

export const EVOLUTION_PROBE_SOURCE = `
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [phase, root, packageEntry] = process.argv.slice(2)
const stringify = JSON.stringify.bind(JSON)
const stdout = process.stdout.write.bind(process.stdout)
const stderr = process.stderr.write.bind(process.stderr)
const api = await import(packageEntry)
const query = 'evolutionpayloadneedle'
const records = () => api.listRecords({ root, includeSuperseded: true, limit: 1000 })
const schema = () => {
  const database = new DatabaseSync(resolve(root, 'node_modules/.cache/encephalon/brain.sqlite'), { readOnly: true })
  try { return database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get().value }
  finally { database.close() }
}
const overview = values => values.find(record => record.subject === 'encephalon:init/repository-overview')
const legacy = values => {
  const payload = overview(values)?.payload
  assert.ok(payload.languageCounts.some(row => row.language === 'TypeScript' && row.files > 0))
  assert.ok(payload.scannedRegularFiles > 0)
}
const match = candidate => {
  const found = api.searchRecords({ root, query })
  assert.deepEqual(found.map(record => record.id), ['evolution-late'])
  const compact = api.searchCompactRecords({ root, query })
  assert.deepEqual(compact.map(record => record.id), ['evolution-late'])
  assert.equal(found[0].confidence, 0.75)
  assert.equal(found[0].payload.body, query)
  assert.ok(!JSON.stringify([found[0].kind, found[0].subject, found[0].source, found[0].payload.summary, found[0].path]).includes(query))
  if (candidate) assert.equal(compact[0].snippet, 'decision\\nrelease.evolution\\nrelease-compatibility\\nEvolution example')
  return compact[0].snippet
}

try {
  let created = []
  let schemaBefore
  let snippet
  if (phase === 'seed') {
    api.initEncephalon({ root })
    legacy(records())
  } else if (phase === 'initialise') {
    const artifact = resolve(root, 'encephalon/_artifacts/decision/evolution-late/evidence.txt')
    mkdirSync(resolve(artifact, '..'), { recursive: true })
    writeFileSync(artifact, 'Published oracle artifact\\n')
    api.addRecord({ root, id: 'evolution-late', kind: 'decision', subject: 'release.evolution', source: 'release-compatibility', confidence: 0.75, artifacts: ['_artifacts/decision/evolution-late/evidence.txt'], payload: { summary: 'Evolution example', body: query } })
    snippet = match(false)
  } else if (phase === 'read') {
    api.prepare({ root })
    assert.equal(schema(), '4')
    snippet = match(true)
  } else if (phase === 'refresh') {
    const old = records()
    legacy(old)
    created = api.initEncephalon({ root, refreshBaseline: true }).recordsCreated
    const current = overview(api.listRecords({ root, limit: 1000 }))
    assert.ok(created.some(record => record.id === current.id))
    assert.ok(!('languageCounts' in current.payload) && !('scannedRegularFiles' in current.payload))
    for (const record of old) assert.deepEqual(api.showRecord({ root, id: record.id }), record)
  } else if (phase === 'remove') {
    api.initEncephalon({ root, remove: true })
  } else if (phase === 'downgrade') {
    schemaBefore = schema()
    assert.equal(schemaBefore, '4')
    api.prepare({ root })
    assert.equal(schema(), '2')
    snippet = match(false)
  } else {
    throw new Error('Unknown evolution phase')
  }
  assert.equal(api.validateRecords({ root }).valid, true)
  stdout(stringify({ created, records: records(), schema: schema(), schemaBefore, snippet }) + '\\n')
} catch (error) {
  stderr(stringify({ phase, message: error.message }) + '\\n')
  process.exitCode = 1
}
`
