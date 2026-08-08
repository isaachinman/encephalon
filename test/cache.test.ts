import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, test } from 'node:test'
import { cacheReadTestHooks } from '../src/cache.ts'
import { PACKAGE_VERSION } from '../src/generated/version.ts'
import * as api from '../src/index.ts'
import { withOperationLock } from '../src/lock.ts'
import { ordinalStringCompare } from '../src/order.ts'
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

const assertBudgetError = (operation: () => unknown, budget: string) => {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'INVALID_ARGUMENT')
    assert.equal((error as { details?: { budget?: unknown } }).details?.budget, budget)
    return true
  })
}

const waitForPath = (path: string, process: ReturnType<typeof spawn>) => {
  const deadline = Date.now() + 5000
  while (!existsSync(path) && process.exitCode === null && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  assert.equal(existsSync(path), true)
}

const cacheDirectoryPath = (root: string) => join(root, 'node_modules', '.cache', 'encephalon')

const cacheDatabasePath = (root: string) => join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')

const addCacheRecord = (root: string) =>
  functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
    id: 'cache-record',
    kind: 'context',
    payload: { detail: 'cache corruption marker', summary: 'Cache record' },
    root,
    searchText: 'recoverable cache row',
    source: 'agent',
    subject: 'cache.validation',
  })

const mutateCache = (root: string, mutation: (database: DatabaseSync) => void) => {
  const database = new DatabaseSync(cacheDatabasePath(root))
  try {
    mutation(database)
  } finally {
    database.close()
  }
}

describe('SQLite cache and reads', () => {
  test('rejects invalid public API inputs before repository side effects', () => {
    const cases: [string, (root: string) => void][] = [
      [
        'list includeSuperseded',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({
            includeSuperseded: 'yes',
            root,
          })
        },
      ],
      [
        'list limit',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ limit: 0, root })
        },
      ],
      [
        'show id',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('showRecord')({ id: '../bad', root })
        },
      ],
      [
        'show activeOnly',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('showRecord')({
            activeOnly: 'yes',
            id: 'record-1',
            root,
          })
        },
      ],
      [
        'search query',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('searchRecords')({ query: 42, root })
        },
      ],
      [
        'search kind',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('searchCompactRecords')({
            kind: '../bad',
            query: 'safe',
            root,
          })
        },
      ],
      [
        'gather hydrate searches',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            hydrate: true,
            root,
            searches: 'safe',
          })
        },
      ],
      [
        'gather show id',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            root,
            shows: ['../bad'],
          })
        },
      ],
      [
        'add kind',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
            kind: '../bad',
            payload: null,
            root,
            source: 'agent',
            subject: 'cache.validation',
          })
        },
      ],
      [
        'add root',
        () => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
            kind: 'context',
            payload: null,
            root: 123,
            source: 'agent',
            subject: 'cache.validation',
          })
        },
      ],
      [
        'init booleans',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('initEncephalon')({
            refreshBaseline: 'yes',
            root,
          })
        },
      ],
    ]

    for (const [name, action] of cases) {
      const root = createRoot()
      assert.throws(
        () => action(root),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'INVALID_ARGUMENT', name)
          return true
        },
      )
      assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon')), false, name)
      assert.equal(existsSync(join(root, 'AGENTS.md')), false, name)
      assert.equal(existsSync(join(root, 'CLAUDE.md')), false, name)
    }
  })

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

  test('uses schema version rather than package version for cache compatibility', () => {
    const root = createRoot()
    const prepare =
      functionFromApi<
        (input: Record<string, unknown>) => {
          hydrated: boolean
          recordsIndexed: number
        }
      >('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    const database = new DatabaseSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'))
    const metadata = database.prepare("SELECT value FROM metadata WHERE key = 'packageVersion'").get()
    assert.equal(metadata?.value, PACKAGE_VERSION)
    database.prepare("UPDATE metadata SET value = '9.9.9' WHERE key = 'packageVersion'").run()
    database.close()

    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })

    const schemaDatabase = new DatabaseSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'))
    schemaDatabase.prepare("UPDATE metadata SET value = '0' WHERE key = 'schemaVersion'").run()
    schemaDatabase.close()

    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
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
    assert.deepEqual(Object.keys(compact[0] ?? {}).sort(ordinalStringCompare), [
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

  test('accepts request budget boundaries and rejects one unit over before cache I/O', () => {
    const validRoot = createRoot()
    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')

    assert.deepEqual(listRecords({ limit: 50, root: validRoot }), [])
    assert.deepEqual(searchRecords({ limit: 50, query: 'x'.repeat(1024), root: validRoot }), [])
    assert.deepEqual(
      searchRecords({ limit: 50, query: Array.from({ length: 32 }, () => 'x').join(' '), root: validRoot }),
      [],
    )
    assert.deepEqual(searchCompactRecords({ limit: 100, query: 'x', root: validRoot }), [])
    const gathered = gatherRecords({
      limit: 100,
      root: validRoot,
      searches: Array.from({ length: 16 }, () => 'x'),
      shows: Array.from({ length: 64 }, () => 'missing'),
    }) as {
      records: Array<{ id: string }>
      searches: Array<{ query: string }>
    }
    assert.deepEqual(
      gathered.searches.map(search => search.query),
      Array.from({ length: 16 }, () => 'x'),
    )
    assert.deepEqual(
      gathered.records.map(record => record.id),
      Array.from({ length: 64 }, () => 'missing'),
    )

    const invalidCases: Array<{ budget: string; run: (root: string) => void }> = [
      { budget: 'fullResultLimit', run: root => listRecords({ limit: 51, root }) },
      { budget: 'fullResultLimit', run: root => searchRecords({ limit: 51, query: 'x', root }) },
      { budget: 'compactResultLimit', run: root => searchCompactRecords({ limit: 101, query: 'x', root }) },
      { budget: 'queryBytes', run: root => searchRecords({ query: `${'x'.repeat(1024)}y`, root }) },
      { budget: 'queryBytes', run: root => searchCompactRecords({ query: `${'x'.repeat(1024)}y`, root }) },
      {
        budget: 'queryTerms',
        run: root => searchRecords({ query: Array.from({ length: 33 }, () => 'x').join(' '), root }),
      },
      {
        budget: 'queryTerms',
        run: root => searchCompactRecords({ query: Array.from({ length: 33 }, () => 'x').join(' '), root }),
      },
      {
        budget: 'gatherSearches',
        run: root => gatherRecords({ root, searches: Array.from({ length: 17 }, () => 'x') }),
      },
      {
        budget: 'gatherShows',
        run: root => gatherRecords({ root, shows: Array.from({ length: 65 }, () => 'missing') }),
      },
      { budget: 'compactResultLimit', run: root => gatherRecords({ limit: 101, root, searches: ['x'] }) },
      {
        budget: 'queryTerms',
        run: root => gatherRecords({ root, searches: [Array.from({ length: 33 }, () => 'x').join(' ')] }),
      },
    ]

    for (const invalidCase of invalidCases) {
      const root = createRoot()
      assertBudgetError(() => invalidCase.run(root), invalidCase.budget)
      assert.equal(existsSync(cacheDirectoryPath(root)), false)
    }
  })

  test('stops full-record responses at the aggregate byte budget while compact search remains usable', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    for (const index of Array.from({ length: 5 }, (_, value) => value)) {
      addRecord({
        id: `large-response-${index}`,
        kind: 'context',
        payload: { text: 'x'.repeat(900 * 1024) },
        root,
        searchText: 'response budget marker',
        source: 'agent',
        subject: `response.budget.${index}`,
      })
    }

    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    assertBudgetError(() => searchRecords({ limit: 5, query: 'response budget marker', root }), 'fullResponseBytes')

    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    assert.equal(searchCompactRecords({ limit: 5, query: 'response budget marker', root }).length, 5)
  })

  test('gather reads every item from one cache snapshot', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const firstId = 'snapshot-v1'
    addRecord({
      id: firstId,
      kind: 'context',
      payload: { summary: 'Snapshot generation one' },
      root,
      source: 'agent',
      subject: 'cache.snapshot',
    })
    const replacement = {
      createdAt: '2026-08-08T00:00:01.000Z',
      id: 'snapshot-v2',
      kind: 'context',
      path: 'encephalon/context/snapshot-v2.json',
      payload: { summary: 'Snapshot generation two' },
      source: 'agent',
      subject: 'cache.snapshot',
      supersedes: [firstId],
    }
    let mutatedBetweenItems = false

    cacheReadTestHooks.afterShowRead = () => {
      if (!mutatedBetweenItems) {
        mutatedBetweenItems = true
        const database = new DatabaseSync(cacheDatabasePath(root))
        try {
          database.exec('BEGIN IMMEDIATE')
          database.prepare('UPDATE records SET active = 0 WHERE id = ?').run(firstId)
          database
            .prepare(`
              INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              replacement.id,
              replacement.kind,
              replacement.subject,
              replacement.source,
              replacement.createdAt,
              replacement.path,
              1,
              'Snapshot generation two',
              JSON.stringify(replacement),
            )
          database
            .prepare('INSERT INTO record_search(id, text) VALUES (?, ?)')
            .run(replacement.id, 'Snapshot generation two')
          database.exec('COMMIT')
        } catch (error) {
          try {
            database.exec('ROLLBACK')
          } catch {}
          throw error
        } finally {
          database.close()
        }
      }
    }

    try {
      const gatherRecords =
        functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
      const gathered = gatherRecords({ root, shows: [firstId, firstId] }) as {
        records: Array<{ id: string; record: { id: string } | null }>
      }
      assert.equal(mutatedBetweenItems, true)
      assert.deepEqual(
        gathered.records.map(entry => [entry.id, entry.record?.id ?? null]),
        [
          [firstId, firstId],
          [firstId, firstId],
        ],
      )
    } finally {
      cacheReadTestHooks.afterShowRead = undefined
    }
  })

  test('gather reads every search from one cache snapshot', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const firstId = 'search-snapshot-v1'
    addRecord({
      id: firstId,
      kind: 'context',
      payload: { summary: 'Search snapshot generation one' },
      root,
      searchText: 'snapshot searchable generation one',
      source: 'agent',
      subject: 'cache.search-snapshot',
    })
    const replacement = {
      createdAt: '2026-08-08T00:00:01.000Z',
      id: 'search-snapshot-v2',
      kind: 'context',
      path: 'encephalon/context/search-snapshot-v2.json',
      payload: { summary: 'Search snapshot generation two' },
      searchText: 'snapshot searchable generation two',
      source: 'agent',
      subject: 'cache.search-snapshot',
      supersedes: [firstId],
    }
    let mutatedBetweenSearches = false

    cacheReadTestHooks.afterCompactSearchRead = () => {
      if (!mutatedBetweenSearches) {
        mutatedBetweenSearches = true
        const database = new DatabaseSync(cacheDatabasePath(root))
        try {
          database.exec('BEGIN IMMEDIATE')
          database.prepare('UPDATE records SET active = 0 WHERE id = ?').run(firstId)
          database
            .prepare(`
              INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              replacement.id,
              replacement.kind,
              replacement.subject,
              replacement.source,
              replacement.createdAt,
              replacement.path,
              1,
              'Search snapshot generation two',
              JSON.stringify(replacement),
            )
          database
            .prepare('INSERT INTO record_search(id, text) VALUES (?, ?)')
            .run(replacement.id, replacement.searchText)
          database.exec('COMMIT')
        } catch (error) {
          try {
            database.exec('ROLLBACK')
          } catch {}
          throw error
        } finally {
          database.close()
        }
      }
    }

    try {
      const gatherRecords =
        functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
      const gathered = gatherRecords({
        root,
        searches: ['snapshot searchable', 'snapshot searchable'],
      }) as {
        searches: Array<{ results: Array<{ id: string }> }>
      }
      assert.equal(mutatedBetweenSearches, true)
      assert.deepEqual(
        gathered.searches.map(entry => entry.results.map(result => result.id)),
        [[firstId], [firstId]],
      )
    } finally {
      cacheReadTestHooks.afterCompactSearchRead = undefined
    }
  })

  test('gather preserves duplicate order while reusing show and search statements', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const first = addRecord({
      id: 'reuse-v1',
      kind: 'decision',
      payload: { summary: 'First reusable decision' },
      root,
      source: 'agent',
      subject: 'cache.reuse',
    })
    const second = addRecord({
      id: 'reuse-v2',
      kind: 'decision',
      payload: { summary: 'Second reusable decision' },
      root,
      searchText: 'statement reuse marker',
      source: 'agent',
      subject: 'cache.reuse',
      supersedes: [first.id],
    })
    let showPrepareCount = 0
    let searchPrepareCount = 0
    let compactSearchSelectedRecordJson = false

    cacheReadTestHooks.onShowPrepare = () => {
      showPrepareCount += 1
    }
    cacheReadTestHooks.onCompactSearchPrepare = source => {
      searchPrepareCount += 1
      compactSearchSelectedRecordJson ||= source.includes('records.record_json')
    }

    try {
      const gatherRecords =
        functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
      const gathered = gatherRecords({
        root,
        searches: ['statement reuse marker', 'statement reuse marker', '   '],
        shows: [second.id, second.id, first.id],
      }) as {
        records: Array<{ id: string; record: { id: string } | null }>
        searches: Array<{ query: string; results: Array<{ id: string }> }>
      }
      assert.deepEqual(
        gathered.records.map(entry => [entry.id, entry.record?.id ?? null]),
        [
          [second.id, second.id],
          [second.id, second.id],
          [first.id, null],
        ],
      )
      assert.deepEqual(
        gathered.searches.map(entry => [entry.query, entry.results.map(result => result.id)]),
        [
          ['statement reuse marker', [second.id]],
          ['statement reuse marker', [second.id]],
          ['   ', []],
        ],
      )
    } finally {
      cacheReadTestHooks.onShowPrepare = undefined
      cacheReadTestHooks.onCompactSearchPrepare = undefined
    }

    assert.equal(showPrepareCount, 1)
    assert.equal(searchPrepareCount, 1)
    assert.equal(compactSearchSelectedRecordJson, false)
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
    const path = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    mkdirSync(join(root, 'node_modules', '.cache', 'encephalon'), {
      recursive: true,
    })
    const database = new DatabaseSync(path)
    database.exec('CREATE TABLE metadata (wrong_column TEXT)')
    database.close()

    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('rebuilds an empty read-only cache file through writer preparation', {
    skip: process.platform === 'win32' ? 'Windows read-only file replacement semantics differ.' : false,
  }, () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    mkdirSync(join(root, 'node_modules', '.cache', 'encephalon'), {
      recursive: true,
    })
    writeFileSync(cachePath, '')
    chmodSync(cachePath, 0o444)

    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('reads a fresh cache without touching the database file', () => {
    const root = createRoot()
    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'read-only-cache-record',
      kind: 'context',
      payload: { summary: 'Read-only cache access' },
      root,
      searchText: 'stable reader metadata',
      source: 'agent',
      subject: 'cache.reader',
    })
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    const before = statSync(cachePath, { bigint: true }).mtimeNs

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    const showRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown> | null>('showRecord')
    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
    assert.equal(listRecords({ root })[0]?.id, record.id)
    assert.equal(showRecord({ id: record.id, root })?.id, record.id)
    assert.equal(searchRecords({ query: 'stable metadata', root })[0]?.id, record.id)
    assert.equal(
      (
        gatherRecords({ root, searches: ['stable reader'], shows: [record.id] }) as {
          records: Array<{ record: { id: string } | null }>
        }
      ).records[0]?.record?.id,
      record.id,
    )

    assert.equal(statSync(cachePath, { bigint: true }).mtimeNs, before)
  })

  test('waits for a concurrent SQLite writer before reading', async () => {
    const root = createRoot()
    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'read-after-sqlite-writer',
      kind: 'context',
      payload: { summary: 'Read waits for writer' },
      root,
      source: 'agent',
      subject: 'cache.reader',
    })
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    const readyPath = join(root, 'cache-writer-ready')
    const holder = spawn(
      process.execPath,
      [join(import.meta.dirname, 'fixtures', 'hold-cache-database-lock.ts'), cachePath, readyPath, '250'],
      { stdio: 'inherit' },
    )
    waitForPath(readyPath, holder)

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    assert.equal(listRecords({ root })[0]?.id, record.id)
    if (holder.exitCode === null) {
      await once(holder, 'exit')
    }
    assert.equal(holder.exitCode, 0)
  })

  test('returns a bounded error when a SQLite writer outlives the reader timeout', async () => {
    const root = createRoot()
    functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'blocked-by-sqlite-writer',
      kind: 'context',
      payload: { summary: 'Writer outlives reader timeout' },
      root,
      source: 'agent',
      subject: 'cache.reader',
    })
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    const readyPath = join(root, 'cache-writer-timeout-ready')
    const holder = spawn(
      process.execPath,
      [join(import.meta.dirname, 'fixtures', 'hold-cache-database-lock.ts'), cachePath, readyPath, '4500'],
      { stdio: 'inherit' },
    )
    waitForPath(readyPath, holder)

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    const startedAt = Date.now()
    assert.throws(
      () => listRecords({ root }),
      (error: unknown) => {
        const candidate = error as { cause?: unknown; code?: unknown; message?: unknown }
        const cause = candidate.cause as { message?: unknown } | undefined
        assert.equal(candidate.code, 'IO_ERROR')
        assert.match(`${String(candidate.message)} ${String(cause?.message)}`, /locked|busy/i)
        return true
      },
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 800)
    assert.ok(elapsed < 4000)
    if (holder.exitCode === null) {
      await once(holder, 'exit')
    }
    assert.equal(holder.exitCode, 0)
  })

  const readRecoveryCases = [
    {
      name: 'list',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
          root,
        })
        assert.deepEqual(
          result.map(entry => entry.id),
          [record.id],
        )
      },
    },
    {
      name: 'show',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown> | null>(
          'showRecord',
        )({
          id: record.id,
          root,
        })
        assert.equal(result?.id, record.id)
      },
    },
    {
      name: 'full search',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')({
          query: 'recoverable cache row',
          root,
        })
        assert.deepEqual(
          result.map(entry => entry.id),
          [record.id],
        )
      },
    },
    {
      name: 'compact search',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>(
          'searchCompactRecords',
        )({
          query: 'recoverable cache row',
          root,
        })
        assert.deepEqual(
          result.map(entry => entry.id),
          [record.id],
        )
      },
    },
    {
      name: 'gather',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')({
          root,
          searches: ['recoverable cache row'],
          shows: [record.id],
        }) as {
          records: Array<{ record: { id: unknown } | null }>
          searches: Array<{ results: Array<{ id: unknown }> }>
        }
        assert.equal(result.records[0]?.record?.id, record.id)
        assert.equal(result.searches[0]?.results[0]?.id, record.id)
      },
    },
  ] as const

  for (const { name, read } of readRecoveryCases) {
    test(`rebuilds invalid cached row JSON during ${name}`, () => {
      const root = createRoot()
      const record = addCacheRecord(root)
      mutateCache(root, database => {
        database.prepare('UPDATE records SET record_json = ? WHERE id = ?').run('{not-json', String(record.id))
      })

      read(root, record)
    })
  }

  test('rebuilds non-text cached record JSON before reading it', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    mutateCache(root, database => {
      database.prepare('UPDATE records SET record_json = ? WHERE id = ?').run(42, String(record.id))
    })

    assert.deepEqual(
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({ root }).map(
        entry => entry.id,
      ),
      [record.id],
    )
  })

  test('rebuilds cached records with invalid shapes and runtime paths', () => {
    const invalidRecordJson = (record: Record<string, unknown>) => [
      JSON.stringify({ ...record, unexpected: true }),
      JSON.stringify({ ...record, path: '/tmp/elsewhere.json' }),
      JSON.stringify({ ...record, path: '../elsewhere.json' }),
    ]

    for (const recordJson of invalidRecordJson(addCacheRecord(createRoot()))) {
      const root = roots.at(-1)
      assert.ok(root)
      mutateCache(root, database => {
        database.prepare('UPDATE records SET record_json = ?').run(recordJson)
      })
      const records = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
        root,
      })
      assert.deepEqual(
        records.map(record => record.id),
        ['cache-record'],
      )
    }
  })

  test('rebuilds cached record columns that disagree with validated JSON', () => {
    const root = createRoot()
    const oldRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'old-cache-record',
      kind: 'context',
      payload: { summary: 'Old cache record' },
      root,
      source: 'agent',
      subject: 'cache.validation',
    })
    const newRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'new-cache-record',
      kind: 'context',
      payload: { summary: 'New cache record' },
      root,
      source: 'agent',
      subject: 'cache.validation',
      supersedes: [oldRecord.id],
    })
    mutateCache(root, database => {
      database.prepare('UPDATE records SET kind = ? WHERE id = ?').run('decision', String(newRecord.id))
      database.prepare('UPDATE records SET active = 1 WHERE id = ?').run(String(oldRecord.id))
    })

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    assert.deepEqual(listRecords({ kind: 'decision', root }), [])
    assert.deepEqual(
      listRecords({ root }).map(record => record.id),
      [newRecord.id],
    )
  })

  test('rebuilds invalid cache metadata instead of trusting it', () => {
    const metadataCases = [
      ['artifactPaths', JSON.stringify(['../outside'])],
      ['recordsIndexed', '-1'],
      ['recordsIndexed', String(Number.MAX_SAFE_INTEGER + 1)],
      ['artifactPaths', JSON.stringify(['x'.repeat(1024 * 1024 + 1)])],
    ] as const

    for (const [key, value] of metadataCases) {
      const root = createRoot()
      addCacheRecord(root)
      mutateCache(root, database => {
        database.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(value, key)
      })
      assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
        hydrated: true,
        recordsIndexed: 1,
      })
    }

    const root = createRoot()
    addCacheRecord(root)
    mutateCache(root, database => {
      database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('unexpected', 'value')
    })
    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 1,
    })
  })

  test('rebuilds missing and duplicate FTS rows', () => {
    for (const duplicate of [false, true]) {
      const root = createRoot()
      const record = addCacheRecord(root)
      mutateCache(root, database => {
        if (duplicate) {
          database
            .prepare('INSERT INTO record_search(id, text) VALUES (?, ?)')
            .run(String(record.id), 'duplicate search row')
        } else {
          database.prepare('DELETE FROM record_search WHERE id = ?').run(String(record.id))
        }
      })
      assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
        hydrated: true,
        recordsIndexed: 1,
      })
    }
  })

  test('recovers an ownerless or malformed operation lock', () => {
    const root = createRoot()
    const lockPath = join(root, 'node_modules', '.cache', 'encephalon', 'operation.lock')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), 'not-json')
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
  })

  test('ignores stale owner metadata with a reused live PID after acquiring the gate', () => {
    const root = createRoot()
    const lockPath = join(root, 'node_modules', '.cache', 'encephalon', 'operation.lock')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({
        acquiredAt: '2026-08-06T10:00:00.000Z',
        pid: process.pid,
        token: 'stale-live-pid-owner',
      })}\n`,
    )
    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(existsSync(lockPath), false)
  })

  test('recovers a malformed disposable operation gate database', () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
  })

  test('reclaims an abandoned operation gate recovery marker', () => {
    const root = createRoot()
    const recoveryPath = join(root, 'node_modules', '.cache', 'encephalon', 'operation-lock.recovery')
    const deadProcess = spawnSync(process.execPath, ['-e', ''])
    const deadPid = deadProcess.pid
    assert.equal(deadProcess.status, 0)
    assert.ok(deadPid !== undefined)
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({
        acquiredAt: new Date().toISOString(),
        pid: deadPid,
        token: 'dead-recovery-owner',
      })}\n`,
    )

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(existsSync(recoveryPath), false)
  })

  test('serialises two contenders recovering the same malformed operation gate', async () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon')
    const gatePath = join(cachePath, 'operation-lock.sqlite')
    const releasePath = join(root, 'release-corrupt-gate-contenders')
    const activePath = join(root, 'active-corrupt-gate-contender')
    const firstReady = join(root, 'first-corrupt-gate-ready')
    const secondReady = join(root, 'second-corrupt-gate-ready')
    const firstEntered = join(root, 'first-corrupt-gate-entered')
    const secondEntered = join(root, 'second-corrupt-gate-entered')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(gatePath, 'not a sqlite database')

    const fixture = join(import.meta.dirname, 'fixtures', 'contend-for-corrupt-gate.ts')
    const first = spawn(process.execPath, [fixture, root, firstReady, releasePath, activePath, firstEntered, '300'], {
      stdio: 'inherit',
    })
    const second = spawn(
      process.execPath,
      [fixture, root, secondReady, releasePath, activePath, secondEntered, '300'],
      {
        stdio: 'inherit',
      },
    )

    waitForPath(firstReady, first)
    waitForPath(secondReady, second)
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
