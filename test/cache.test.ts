import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, test } from 'node:test'
import * as api from '../src/index.ts'
import { createTestRepository, ensureParent, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

const functionFromApi = <T>(name: string) => (api as unknown as Record<string, T>)[name] as T

describe('SQLite cache and reads', () => {
  test('prepares an empty repository before a cache directory exists', () => {
    const root = createRoot()
    const prepare =
      functionFromApi<
        (input: Record<string, unknown>) => {
          hydrated: boolean
          recordsIndexed: number
        }
      >('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('automatically prepares active list, show, search, compact search, and gather reads', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const first = addRecord({
      id: 'database-v1',
      kind: 'decision',
      payload: { detail: 'database storage', summary: 'Use a remote database' },
      root,
      source: 'agent',
      subject: 'backend.database',
    })
    const second = addRecord({
      id: 'database-v2',
      kind: 'decision',
      payload: { detail: 'local database storage', summary: 'Use SQLite' },
      root,
      searchText: 'portable persistence',
      source: 'agent',
      subject: 'backend.database',
      supersedes: [first.id],
    })

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    assert.deepEqual(
      listRecords({ root }).map(record => record.id),
      [second.id],
    )
    assert.deepEqual(
      listRecords({ includeSuperseded: true, root }).map(record => record.id),
      [second.id, first.id],
    )

    const showRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown> | null>('showRecord')
    assert.equal(showRecord({ activeOnly: true, id: first.id, root }), null)
    assert.equal(showRecord({ id: first.id, root })?.id, first.id)

    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    assert.deepEqual(
      searchRecords({ query: 'database/storage', root }).map(record => record.id),
      [second.id],
    )
    assert.deepEqual(searchRecords({ query: '   ', root }), [])

    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const compact = searchCompactRecords({
      query: 'portable persistence',
      root,
    })
    assert.deepEqual(Object.keys(compact[0] ?? {}).sort(), [
      'id',
      'kind',
      'path',
      'rank',
      'snippet',
      'subject',
      'summary',
    ])
    assert.equal(compact[0]?.summary, 'Use SQLite')
    assert.match(String(compact[0]?.snippet), /\[(portable|persistence)\]/i)
    assert.equal(compact[0]?.path, 'encephalon/decision/database-v2.json')

    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
    const gathered = gatherRecords({
      root,
      searches: ['SQLite', 'SQLite'],
      shows: [second.id, first.id, 'missing', second.id],
    }) as {
      hydrated: { recordsIndexed: number } | null
      searches: Array<{ query: string; results: Array<{ id: string }> }>
      records: Array<{ id: string; record: { id: string } | null }>
    }
    assert.deepEqual(
      gathered.searches.map(entry => entry.query),
      ['SQLite', 'SQLite'],
    )
    assert.equal((gathered as { hydrated?: unknown }).hydrated, null)
    assert.deepEqual(
      gathered.records.map(entry => [entry.id, entry.record?.id ?? null]),
      [
        [second.id, second.id],
        [first.id, null],
        ['missing', null],
        [second.id, second.id],
      ],
    )
    assert.deepEqual(gatherRecords({ hydrate: true, root }), {
      hydrated: { recordsIndexed: 2 },
      records: [],
      searches: [],
    })

    functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'without-summary',
      kind: 'context',
      payload: { detail: 'searchable marker' },
      root,
      source: 'agent',
      subject: 'no.summary',
    })
    assert.equal(searchCompactRecords({ query: 'searchable marker', root })[0]?.summary, null)
  })

  test('keeps compact search and repeated gather ordering aligned with full search for large records', () => {
    const root = createRoot()
    const largePayload = 'payload filler '.repeat(10_000)
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const records = [
      addRecord({
        id: 'large-search-alpha',
        kind: 'context',
        payload: { body: largePayload, summary: 'Alpha compact summary' },
        root,
        searchText: 'shared performance needle',
        source: 'agent',
        subject: 'search.large.alpha',
      }),
      addRecord({
        id: 'large-search-beta',
        kind: 'context',
        payload: { body: largePayload, summary: 'Beta compact summary' },
        root,
        searchText: 'shared performance needle',
        source: 'agent',
        subject: 'search.large.beta',
      }),
    ]
    const expectedIds = records.map(record => record.id).reverse()

    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const fullIds = searchRecords({ query: 'shared performance needle', root }).map(record => record.id)
    const compactResults = searchCompactRecords({ query: 'shared performance needle', root })

    assert.deepEqual(fullIds, expectedIds)
    assert.deepEqual(
      compactResults.map(record => record.id),
      fullIds,
    )
    assert.deepEqual(
      compactResults.map(record => Object.keys(record).sort()),
      compactResults.map(() => ['id', 'kind', 'path', 'rank', 'snippet', 'subject', 'summary']),
    )

    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
    const gathered = gatherRecords({
      root,
      searches: ['shared performance needle', 'shared performance needle'],
    }) as { searches: Array<{ results: Array<{ id: string }> }> }
    assert.deepEqual(
      gathered.searches.map(entry => entry.results.map(record => record.id)),
      [fullIds, fullIds],
    )
  })

  test('selects record_json only for full search rows', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'cache.ts'), 'utf8')
    const fullSearchRows = source.match(/const fullSearchRows[\s\S]*?\.all\(\.\.\.parameters\)/)?.[0] ?? ''
    const compactSearchRows = source.match(/const compactSearchRows[\s\S]*?\.all\(\.\.\.parameters\)/)?.[0] ?? ''

    assert.match(fullSearchRows, /\brecord_json\b/)
    assert.ok(compactSearchRows.length > 0)
    assert.doesNotMatch(compactSearchRows, /\brecord_json\b/)
  })

  test('tracks record and referenced-artifact freshness', () => {
    const root = createRoot()
    const id = 'architecture-with-artifact'
    const artifact = `_artifacts/architecture/${id}/diagram.svg`
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, '<svg>one</svg>')

    functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
      artifacts: [artifact],
      id,
      kind: 'architecture',
      payload: { summary: 'System overview' },
      root,
      source: 'agent',
      subject: 'system.overview',
    })
    const prepare =
      functionFromApi<
        (input: Record<string, unknown>) => {
          hydrated: boolean
          recordsIndexed: number
        }
      >('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 1 })

    const recordPath = join(root, 'encephalon', 'architecture', `${id}.json`)
    writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')} `)
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 1 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 1 })

    writeFileSync(artifactPath, '<svg>two</svg>')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 1 })
  })

  test('does not serve a preserved stale cache after canonical validation fails', () => {
    const root = createRoot()
    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'valid-before-corruption',
      kind: 'context',
      payload: { summary: 'Valid' },
      root,
      source: 'agent',
      subject: 'repository.overview',
    })
    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    assert.equal(listRecords({ root }).length, 1)
    writeFileSync(join(root, String(record.path)), '{not-json')

    assert.throws(
      () => listRecords({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
  })

  test('rebuilds a corrupt disposable cache', () => {
    const root = createRoot()
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    prepare({ root })
    writeFileSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'), 'not a sqlite database')

    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('rebuilds a disposable cache with an incompatible table schema', () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    mkdirSync(join(root, 'node_modules', '.cache', 'encephalon'), {
      recursive: true,
    })
    const database = new DatabaseSync(cachePath)
    database.exec('CREATE TABLE metadata (wrong_column TEXT)')
    database.close()

    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('recovers an ownerless or malformed operation lock', () => {
    const root = createRoot()
    const lockPath = join(root, 'node_modules', '.cache', 'encephalon', 'operation.lock')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), 'not-json')
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
  })

  test('serialises two contenders that both observed the same stale lock', async () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon')
    const lockPath = join(cachePath, 'operation.lock')
    const releasePath = join(root, 'release-contenders')
    const activePath = join(root, 'active-contender')
    const firstObserved = join(root, 'first-observed')
    const secondObserved = join(root, 'second-observed')
    const firstEntered = join(root, 'first-entered')
    const secondEntered = join(root, 'second-entered')
    const deadProcess = spawnSync(process.execPath, ['-e', ''])
    const deadPid = deadProcess.pid
    assert.equal(deadProcess.status, 0)
    assert.ok(deadPid !== undefined)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({
        acquiredAt: '2026-08-06T10:00:00.000Z',
        pid: deadPid,
        token: 'dead-owner',
      })}\n`,
    )

    const fixture = join(import.meta.dirname, 'fixtures', 'contend-for-stale-lock.ts')
    const first = spawn(process.execPath, [fixture, root, firstObserved, releasePath, activePath, firstEntered, '0'], {
      stdio: 'inherit',
    })
    const second = spawn(
      process.execPath,
      [fixture, root, secondObserved, releasePath, activePath, secondEntered, '75'],
      { stdio: 'inherit' },
    )

    const deadline = Date.now() + 5000
    while (
      !(existsSync(firstObserved) && existsSync(secondObserved)) &&
      first.exitCode === null &&
      second.exitCode === null &&
      Date.now() < deadline
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    assert.equal(existsSync(firstObserved), true)
    assert.equal(existsSync(secondObserved), true)
    writeFileSync(releasePath, 'release')

    if (first.exitCode === null) {
      await once(first, 'exit')
    }
    if (second.exitCode === null) {
      await once(second, 'exit')
    }
    assert.equal(first.exitCode, 0)
    assert.equal(second.exitCode, 0)
    assert.equal(existsSync(firstEntered), true)
    assert.equal(existsSync(secondEntered), true)
    assert.equal(existsSync(join(cachePath, 'operation-lock.sqlite')), true)
  })

  test('rejects a symlinked canonical root without traversing it', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit directory symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const target = createRoot()
    symlinkSync(target, join(root, 'encephalon'), 'dir')
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.throws(
      () => prepare({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
  })

  test('serialises cache mutations across processes', async () => {
    const root = createRoot()
    const readyPath = join(root, 'lock-ready')
    const holder = spawn(
      process.execPath,
      [join(import.meta.dirname, 'fixtures', 'hold-operation-lock.ts'), root, readyPath],
      { stdio: 'inherit' },
    )
    const deadline = Date.now() + 5000
    while (!existsSync(readyPath) && holder.exitCode === null && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    assert.equal(existsSync(readyPath), true)

    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'added-after-external-lock',
      kind: 'context',
      payload: { summary: 'Cross-process serialisation' },
      root,
      source: 'test',
      subject: 'cache.locking',
    })
    assert.equal(record.id, 'added-after-external-lock')
    if (holder.exitCode === null) {
      await once(holder, 'exit')
    }
    assert.equal(holder.exitCode, 0)
  })

  test('rejects a cache shared by two repository realpaths', () => {
    const firstRoot = createRoot()
    const secondRoot = createRoot()
    functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
      id: 'first-scope-record',
      kind: 'context',
      payload: { summary: 'First repository' },
      root: firstRoot,
      source: 'agent',
      subject: 'repository.scope',
    })

    rmSync(join(secondRoot, 'node_modules'), { recursive: true })
    symlinkSync(join(firstRoot, 'node_modules'), join(secondRoot, 'node_modules'), 'dir')
    const listRecords = functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')
    assert.throws(
      () => listRecords({ root: secondRoot }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'CACHE_SCOPE_MISMATCH')
        return true
      },
    )
  })
})
