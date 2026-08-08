import assert from 'node:assert/strict'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import * as api from '../src/index.ts'
import { addRecordResolved } from '../src/records.ts'
import { discoverRepository } from '../src/repository.ts'
import { createTestRepository, ensureParent, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const timestampAt = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString()

const writeCanonicalRecord = (
  root: string,
  record: {
    id: string
    kind?: string
    subject?: string
    payload?: Record<string, unknown>
    supersedes?: string[]
    artifacts?: string[]
    createdAt?: string
  },
) => {
  const kind = record.kind ?? 'decision'
  const path = join(root, 'encephalon', kind, `${record.id}.json`)
  ensureParent(path)
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        createdAt: record.createdAt ?? timestampAt(0),
        id: record.id,
        kind,
        payload: record.payload ?? {},
        source: 'test',
        subject: record.subject ?? 'validation.corpus',
        ...(record.artifacts === undefined ? {} : { artifacts: record.artifacts }),
        ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
      },
      null,
      2,
    )}\n`,
  )
}

const assertErrorCode = (operation: () => unknown, code: string) => {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code)
    return true
  })
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

describe('canonical records', () => {
  test('adds a formatted append-only record and returns a relative runtime path', () => {
    const root = createRoot()
    const record = api.addRecord({
      confidence: 0.9,
      id: '550e8400-e29b-41d4-a716-446655440000',
      kind: 'decision',
      payload: { reasons: ['Portable', 'Fast'], summary: 'Use SQLite' },
      root,
      searchText: 'storage persistence',
      source: 'agent',
      subject: 'backend.database',
    })

    assert.equal(record.path, 'encephalon/decision/550e8400-e29b-41d4-a716-446655440000.json')
    assert.equal(existsSync(join(root, 'encephalon', '_artifacts', 'decision', record.id)), false)
    const filePath = join(root, record.path)
    assert.equal(existsSync(filePath), true)
    assert.equal(
      readFileSync(filePath, 'utf8'),
      `${JSON.stringify(
        {
          confidence: 0.9,
          createdAt: record.createdAt,
          id: '550e8400-e29b-41d4-a716-446655440000',
          kind: 'decision',
          payload: { reasons: ['Portable', 'Fast'], summary: 'Use SQLite' },
          searchText: 'storage persistence',
          source: 'agent',
          subject: 'backend.database',
        },
        null,
        2,
      )}\n`,
    )

    assertErrorCode(
      () =>
        api.addRecord({
          id: record.id,
          kind: 'decision',
          payload: { summary: 'Overwrite' },
          root,
          source: 'agent',
          subject: 'backend.database',
        }),
      'RECORD_EXISTS',
    )
  })

  test('does not create a canonical file when the formatted record exceeds its size limit', () => {
    const root = createRoot()
    const id = 'oversized-record'
    assertErrorCode(
      () =>
        api.addRecord({
          id,
          kind: 'context',
          payload: { value: 'x'.repeat(1024 * 1024) },
          root,
          source: 'test',
          subject: 'record.size-limit',
        }),
      'INVALID_ARGUMENT',
    )
    assert.equal(existsSync(join(root, 'encephalon', 'context', `${id}.json`)), false)
  })

  test('supports artifact-first creation with a caller-supplied id', () => {
    const root = createRoot()
    const id = '550e8400-e29b-41d4-a716-446655440001'
    const artifact = `_artifacts/architecture/${id}/diagram.svg`
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, '<svg/>')

    const record = api.addRecord({
      artifacts: [artifact],
      id,
      kind: 'architecture',
      payload: { summary: 'System boundaries' },
      root,
      source: 'agent',
      subject: 'system.overview',
    })

    assert.deepEqual(record.artifacts, [artifact])
    assert.deepEqual(readdirSync(join(root, 'encephalon', '_artifacts', 'architecture', id)), ['diagram.svg'])
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('rejects a symlinked internal staging directory before writing records', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit directory symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const outside = join(root, 'outside-staging')
    mkdirSync(outside)
    mkdirSync(join(root, 'encephalon'))
    symlinkSync(outside, join(root, 'encephalon', '_staging'), 'dir')

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'staging-symlink',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.symlink',
        }),
      'VALIDATION_FAILED',
    )
    assert.deepEqual(readdirSync(outside), [])
  })

  test('rejects a replaced kind directory immediately before publication', () => {
    const root = createRoot()

    assertErrorCode(
      () =>
        addRecordResolved(
          root,
          {
            id: 'kind-replaced',
            kind: 'decision',
            payload: {},
            source: 'agent',
            subject: 'kind.replaced',
          },
          {
            hooks: {
              fault: point => {
                if (point === 'before-publication') {
                  rmSync(join(root, 'encephalon', 'decision'), { force: true, recursive: true })
                  writeFileSync(join(root, 'encephalon', 'decision'), 'not a directory')
                }
              },
            },
            hydrate: false,
          },
        ),
      'VALIDATION_FAILED',
    )
    assert.equal(readFileSync(join(root, 'encephalon', 'decision'), 'utf8'), 'not a directory')
  })

  test('cleans orphaned internal staging aliases on the next mutation', () => {
    const root = createRoot()
    const first = api.addRecord({
      id: 'orphan-source',
      kind: 'decision',
      payload: { summary: 'Committed' },
      root,
      source: 'agent',
      subject: 'staging.orphan',
    })
    const stagingDirectory = join(root, 'encephalon', '_staging')
    mkdirSync(stagingDirectory, { recursive: true })
    linkSync(join(root, first.path), join(stagingDirectory, 'orphan.tmp'))

    api.addRecord({
      id: 'after-orphan',
      kind: 'decision',
      payload: { summary: 'Next' },
      root,
      source: 'agent',
      subject: 'staging.next',
    })

    assert.deepEqual(readdirSync(stagingDirectory), [])
    assert.equal(existsSync(join(root, first.path)), true)
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'after-orphan.json')), true)
  })

  test('does not misreport cleanup failure after canonical publication', () => {
    const root = createRoot()
    const record = addRecordResolved(
      root,
      {
        id: 'cleanup-failure',
        kind: 'decision',
        payload: { summary: 'Published' },
        source: 'agent',
        subject: 'cleanup.failure',
      },
      {
        hooks: {
          fault: point => {
            if (point === 'during-cleanup') {
              throw new Error('Injected cleanup failure')
            }
          },
        },
        hydrate: false,
      },
    )

    assert.equal(record.id, 'cleanup-failure')
    assert.equal(existsSync(join(root, record.path)), true)
    assert.equal(readdirSync(join(root, 'encephalon', '_staging')).length, 1)
  })

  test('does not misreport directory flush failure after canonical publication', () => {
    const root = createRoot()
    const record = addRecordResolved(
      root,
      {
        id: 'flush-failure',
        kind: 'decision',
        payload: { summary: 'Published' },
        source: 'agent',
        subject: 'flush.failure',
      },
      {
        hooks: {
          fault: point => {
            if (point === 'during-publication-flush') {
              throw new Error('Injected directory flush failure')
            }
          },
        },
        hydrate: false,
      },
    )

    assert.equal(record.id, 'flush-failure')
    assert.equal(existsSync(join(root, record.path)), true)
    assert.deepEqual(readdirSync(join(root, 'encephalon', '_staging')), [])
  })

  test('does not misreport cache hydration failure after canonical publication', () => {
    const root = createRoot()
    const record = addRecordResolved(
      root,
      {
        id: 'hydration-failure',
        kind: 'decision',
        payload: { summary: 'Published' },
        source: 'agent',
        subject: 'hydration.failure',
      },
      {
        hooks: {
          fault: point => {
            if (point === 'during-hydration') {
              throw new Error('Injected hydration failure')
            }
          },
        },
      },
    )

    assert.equal(record.id, 'hydration-failure')
    assert.equal(existsSync(join(root, record.path)), true)
    assertErrorCode(
      () =>
        api.addRecord({
          id: record.id,
          kind: 'decision',
          payload: { summary: 'Retry' },
          root,
          source: 'agent',
          subject: 'hydration.failure',
        }),
      'RECORD_EXISTS',
    )
  })

  test('validates supersession graphs and permits a multi-head resolver', () => {
    const root = createRoot()
    const first = api.addRecord({
      id: 'record-a',
      kind: 'decision',
      payload: { summary: 'REST' },
      root,
      source: 'agent',
      subject: 'api.style',
    })
    const second = api.addRecord({
      id: 'record-b',
      kind: 'decision',
      payload: { summary: 'GraphQL' },
      root,
      source: 'agent',
      subject: 'api.style',
      supersedes: [first.id],
    })
    const parallelPath = join(root, 'encephalon', 'decision', 'record-c.json')
    writeFileSync(
      parallelPath,
      `${JSON.stringify(
        {
          createdAt: '2026-08-06T10:00:00.000Z',
          id: 'record-c',
          kind: 'decision',
          payload: { summary: 'RPC' },
          source: 'agent',
          subject: 'api.style',
          supersedes: [first.id],
        },
        null,
        2,
      )}\n`,
    )

    const conflicted = api.validateRecords({ root })
    assert.equal(conflicted.valid, false)
    assert.equal(
      conflicted.errors.some(error => error.code === 'MULTIPLE_ACTIVE_HEADS'),
      true,
    )

    api.addRecord({
      id: 'record-d',
      kind: 'decision',
      payload: { summary: 'GraphQL with RPC internally' },
      root,
      source: 'agent',
      subject: 'api.style',
      supersedes: [second.id, 'record-c'],
    })
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('validates a corpus at the record limit with an iterative supersession chain', () => {
    const root = createRoot()
    for (const index of Array.from({ length: 1000 }, (_, value) => value)) {
      writeCanonicalRecord(root, {
        createdAt: timestampAt(index),
        id: `chain-${index}`,
        ...(index === 0 ? {} : { supersedes: [`chain-${index - 1}`] }),
      })
    }

    const result = api.validateRecords({ root }) as { truncated?: boolean } & ReturnType<typeof api.validateRecords>
    assert.equal(result.valid, true)
    assert.equal(result.recordsChecked, 1000)
    assert.equal(result.errors.length, 0)
    assert.equal(result.truncated, false)
  })

  test('reports corpus budget overflows deterministically', () => {
    const recordCountRoot = createRoot()
    for (const index of Array.from({ length: 1001 }, (_, value) => value)) {
      writeCanonicalRecord(recordCountRoot, {
        createdAt: timestampAt(index),
        id: `count-${index}`,
        subject: `validation.count.${index}`,
      })
    }
    const recordCountResult = api.validateRecords({ root: recordCountRoot })
    assert.equal(recordCountResult.valid, false)
    assert.equal(recordCountResult.errors[0]?.code, 'CORPUS_RECORD_LIMIT')
    assert.equal(recordCountResult.recordsChecked, 1000)

    const byteRoot = createRoot()
    for (const index of Array.from({ length: 10 }, (_, value) => value)) {
      writeCanonicalRecord(byteRoot, {
        createdAt: timestampAt(index),
        id: `bytes-${index}`,
        payload: { text: 'x'.repeat(900 * 1024) },
        subject: `validation.bytes.${index}`,
      })
    }
    const byteResult = api.validateRecords({ root: byteRoot })
    assert.equal(byteResult.valid, false)
    assert.equal(byteResult.errors[0]?.code, 'CORPUS_BYTE_LIMIT')

    const edgeRoot = createRoot()
    writeCanonicalRecord(edgeRoot, {
      id: 'too-many-edges',
      supersedes: Array.from({ length: 1001 }, (_, index) => `missing-${index}`),
    })
    const edgeResult = api.validateRecords({ root: edgeRoot })
    assert.equal(edgeResult.valid, false)
    assert.equal(edgeResult.errors[0]?.code, 'CORPUS_SUPERSEDES_LIMIT')

    const artifactRoot = createRoot()
    for (const recordIndex of Array.from({ length: 201 }, (_, value) => value)) {
      const id = `artifact-${recordIndex}`
      writeCanonicalRecord(artifactRoot, {
        artifacts: Array.from(
          { length: 5 },
          (_, artifactIndex) => `_artifacts/decision/${id}/file-${artifactIndex}.txt`,
        ),
        id,
        subject: `validation.artifacts.${recordIndex}`,
      })
    }
    const artifactResult = api.validateRecords({ root: artifactRoot })
    assert.equal(artifactResult.valid, false)
    assert.equal(artifactResult.errors[0]?.code, 'CORPUS_ARTIFACT_LIMIT')
  })

  test('detects a long supersession cycle without recursive stack growth', () => {
    const root = createRoot()
    for (const index of Array.from({ length: 1000 }, (_, value) => value)) {
      writeCanonicalRecord(root, {
        createdAt: timestampAt(index),
        id: `cycle-${index}`,
        supersedes: index === 0 ? ['cycle-999'] : [`cycle-${index - 1}`],
      })
    }

    assert.doesNotThrow(() => api.validateRecords({ root }))
    const result = api.validateRecords({ root })
    assert.equal(result.valid, false)
    assert.equal(
      result.errors.some(error => error.code === 'SUPERSEDES_CYCLE'),
      true,
    )
  })

  test('truncates validation issues with a deterministic sentinel', () => {
    const root = createRoot()
    for (const index of Array.from({ length: 105 }, (_, value) => value)) {
      const path = join(root, 'encephalon', 'decision', `invalid-${String(index).padStart(3, '0')}.json`)
      ensureParent(path)
      writeFileSync(path, '{invalid')
    }

    const result = api.validateRecords({ root }) as { truncated?: boolean } & ReturnType<typeof api.validateRecords>
    assert.equal(result.valid, false)
    assert.equal(result.truncated, true)
    assert.equal(result.errors.length, 100)
    assert.equal(result.errors[0]?.path, 'encephalon/decision/invalid-000.json')
    assert.equal(result.errors.at(-1)?.code, 'VALIDATION_ISSUES_TRUNCATED')
  })

  test('rejects non-JSON payloads and unsafe portable paths', () => {
    const root = createRoot()

    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'Decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          id: 'CON',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: { invalid: Number.NaN },
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    const sparse: unknown[] = []
    sparse.length = 1
    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: sparse as never,
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    const symbolKeyed = { summary: 'Hidden symbol' } as Record<PropertyKey, unknown>
    symbolKeyed[Symbol('hidden')] = 'not JSON'
    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: symbolKeyed as never,
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    const symbolArray = ['value'] as unknown[] & Record<PropertyKey, unknown>
    symbolArray[Symbol('hidden')] = 'not JSON'
    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: symbolArray as never,
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'x',
          supersedes: null as never,
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          artifacts: ['_artifacts/decision/record-safe/../secret.txt'],
          id: 'record-safe',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          artifacts: ['_artifacts/decision/record-safe/bad:name.txt'],
          id: 'record-safe',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          id: ' record-safe',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          id: 'record-safe',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: ' x',
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          artifacts: [' _artifacts/decision/record-safe/file.txt'],
          id: 'record-safe',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
    assertErrorCode(
      () =>
        api.addRecord({
          artifacts: ['_artifacts/decision/record-safe/cafe\u0301.txt'],
          id: 'record-safe',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'x',
        }),
      'INVALID_ARGUMENT',
    )
  })

  test('reports malformed files without rewriting them', () => {
    const root = createRoot()
    const path = join(root, 'encephalon', 'decision', 'wrong-name.json')
    ensureParent(path)
    const original = JSON.stringify({
      createdAt: '2026-08-06T10:00:00.000Z',
      id: 'actual-id',
      kind: 'decision',
      payload: {},
      source: 'manual',
      subject: 'broken',
    })
    writeFileSync(path, original)

    const result = api.validateRecords({ root })
    assert.equal(result.valid, false)
    assert.equal(
      result.errors.some(error => error.code === 'RECORD_PATH_MISMATCH'),
      true,
    )
    assert.equal(readFileSync(path, 'utf8'), original)
  })

  test('discovers a worktree-style git root and rejects an invalid explicit root', () => {
    const root = createRoot()
    const nested = join(root, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    assert.equal(discoverRepository({ start: nested }), realpathSync.native(root))
    assertErrorCode(() => discoverRepository({ root: join(root, 'packages') }), 'INVALID_REPOSITORY')
  })

  test('rejects execution when the package is not installed at the repository root', () => {
    const root = createRoot()
    rmSync(join(root, 'node_modules', 'encephalon'), { recursive: true })
    assertErrorCode(() => api.prepare({ root }), 'ROOT_INSTALL_REQUIRED')
  })
})
