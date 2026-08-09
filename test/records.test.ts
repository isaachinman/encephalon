import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
import {
  addRecordResolved,
  assertRecordGraph,
  MAX_CANONICAL_RECORD_BYTES,
  MAX_CANONICAL_RECORDS,
  planRecordAddition,
  validateRecordsResolved,
} from '../src/records.ts'
import { discoverRepository } from '../src/repository.ts'
import { validateKind } from '../src/schema.ts'
import type { ValidateResult } from '../src/types.ts'
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

const postCommitRecoveryAction = {
  cacheHydration: 'Run prepare to rebuild disposable cache state, then validate before retrying this add.',
  publicationFlush:
    'Confirm the canonical record file is present; prepare does not re-fsync the kind directory, so treat durability as unverified until that sync succeeds.',
  stagingCleanup: 'Retry this add; leftovers under encephalon/_staging are cleared by the next add.',
} as const

const assertPostCommitError = (
  operation: () => unknown,
  expected: {
    phase: keyof typeof postCommitRecoveryAction
    path: string
    recordId: string
  },
) => {
  assert.throws(operation, (error: unknown) => {
    const actual = error as {
      code?: unknown
      details?: Record<string, unknown>
    }
    assert.equal(actual.code, 'IO_ERROR')
    assert.deepEqual(actual.details, {
      canonicalCommitted: true,
      path: expected.path,
      postCommitPhase: expected.phase,
      recordId: expected.recordId,
      recoveryAction: postCommitRecoveryAction[expected.phase],
    })
    return true
  })
}

const assertValidationFailureCode = (operation: () => unknown, code: string) => {
  assert.throws(operation, (error: unknown) => {
    const typed = error as { code?: unknown; details?: { errors?: Array<{ code?: unknown }> } }
    assert.equal(typed.code, 'VALIDATION_FAILED')
    assert.equal(
      typed.details?.errors?.some(validationIssue => validationIssue.code === code),
      true,
    )
    return true
  })
}

const assertInvalidRecord = (result: ValidateResult, path?: string) => {
  assert.equal(result.valid, false)
  assert.equal(
    result.errors.some(error => error.code === 'INVALID_RECORD' && (path === undefined || error.path === path)),
    true,
  )
}

const canCreateDirectory = (root: string, name: string) => {
  try {
    mkdirSync(join(root, 'encephalon', name), { recursive: true })
    return readdirSync(join(root, 'encephalon')).includes(name)
  } catch {
    return false
  }
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

  test('validates planned graph bytes without counting runtime paths', () => {
    const root = createRoot()
    const plans = Array.from({ length: 8 }, (_, index) =>
      planRecordAddition(root, {
        id: `planned-byte-accounting-${index}`,
        kind: 'decision',
        payload: { summary: 'x'.repeat(1_048_350) },
        source: 'agent',
        subject: `planning.bytes.${index}`,
      }),
    )
    const canonicalBytes = plans.reduce((total, plan) => total + Buffer.byteLength(plan.formatted, 'utf8'), 0)
    const runtimeBytes = plans.reduce(
      (total, plan) => total + Buffer.byteLength(`${JSON.stringify(plan.record, null, 2)}\n`, 'utf8'),
      0,
    )

    assert.equal(canonicalBytes <= MAX_CANONICAL_RECORD_BYTES, true)
    assert.equal(runtimeBytes > MAX_CANONICAL_RECORD_BYTES, true)
    assert.doesNotThrow(() =>
      assertRecordGraph(
        root,
        plans.map(plan => plan.record),
      ),
    )
    assert.doesNotThrow(() =>
      assertRecordGraph(
        root,
        plans.map(plan => plan.record),
        'Canonical records are invalid.',
        {},
        canonicalBytes,
      ),
    )
  })

  test('uses the record kind portable path predicate for kind directories', () => {
    for (const invalid of ['Decision', 'bad kind', 'CON', 'kind.', 'kind ']) {
      assertErrorCode(() => validateKind(invalid), 'INVALID_ARGUMENT')
    }
    assert.equal(validateKind('custom_kind-1'), 'custom_kind-1')
  })

  test('validates empty invalid kind directories and valid empty custom kinds', () => {
    const root = createRoot()
    mkdirSync(join(root, 'encephalon'), { recursive: true })
    const created = ['Decision', 'bad kind', 'CON', 'kind.', 'kind '].filter(name => canCreateDirectory(root, name))
    mkdirSync(join(root, 'encephalon', 'custom_kind-1'))

    const result = api.validateRecords({ root })
    assert.equal(result.valid, false)
    const expected = created
      .map(name => ['INVALID_KIND_DIRECTORY', `encephalon/${name}`])
      .sort((first, second) => String(first[1]).localeCompare(String(second[1])))
    assert.deepEqual(
      result.errors.map(error => [error.code, error.path]),
      expected,
    )
  })

  test('detects kind directory case and unicode-normalization collisions', () => {
    const root = createRoot()
    mkdirSync(join(root, 'encephalon', 'context'), { recursive: true })
    const caseVariantCreated = canCreateDirectory(root, 'Context')
    const unicodeNames = ['cafe\u0301', 'café'].filter(name => canCreateDirectory(root, name))
    const unicodeOrderedNames = readdirSync(join(root, 'encephalon'))
      .filter(name => unicodeNames.includes(name))
      .sort((first, second) => first.localeCompare(second))
    const unicodeCollisionPaths = unicodeOrderedNames.reduce<{ paths: string[]; seen: Set<string> }>(
      (accumulator, name) => {
        const collisionKey = name.normalize('NFC').toLowerCase()
        return {
          paths: accumulator.seen.has(collisionKey) ? [...accumulator.paths, `encephalon/${name}`] : accumulator.paths,
          seen: new Set([...accumulator.seen, collisionKey]),
        }
      },
      { paths: [], seen: new Set<string>() },
    ).paths
    const expected = [
      ...(caseVariantCreated
        ? [
            ['INVALID_KIND_DIRECTORY', 'encephalon/Context'],
            ['KIND_DIRECTORY_COLLISION', 'encephalon/Context'],
          ]
        : []),
      ...unicodeOrderedNames.map(name => ['INVALID_KIND_DIRECTORY', `encephalon/${name}`]),
      ...unicodeCollisionPaths.map(path => ['KIND_DIRECTORY_COLLISION', path]),
    ].sort((first, second) => String(first[1]).localeCompare(String(second[1])))

    const result = api.validateRecords({ root })
    assert.equal(result.valid, expected.length === 0)
    assert.deepEqual(
      result.errors.map(error => [error.code, error.path]),
      expected,
    )
  })

  test('reports invalid kind directories containing records without rewriting them', () => {
    const root = createRoot()
    const directory = join(root, 'encephalon', 'Bad')
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'record-a.json'),
      `${JSON.stringify(
        {
          createdAt: '2026-08-08T00:00:00.000Z',
          id: 'record-a',
          kind: 'context',
          payload: { summary: 'Wrong parent' },
          source: 'test',
          subject: 'invalid.kind-dir',
        },
        null,
        2,
      )}\n`,
    )

    const result = api.validateRecords({ root })
    assert.equal(result.valid, false)
    assert.equal(result.errors[0]?.code, 'INVALID_KIND_DIRECTORY')
    assert.equal(result.errors[0]?.path, 'encephalon/Bad')
    assert.equal(existsSync(join(directory, 'record-a.json')), true)
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

  test('reports staging cleanup failure after canonical publication as committed', () => {
    const root = createRoot()
    assertPostCommitError(
      () =>
        addRecordResolved(
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
                  throw Object.assign(new Error('Injected cleanup failure'), { code: 'EIO' })
                }
              },
            },
            hydrate: false,
          },
        ),
      {
        path: 'encephalon/decision/cleanup-failure.json',
        phase: 'stagingCleanup',
        recordId: 'cleanup-failure',
      },
    )

    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'cleanup-failure.json')), true)
    assert.equal(readdirSync(join(root, 'encephalon', '_staging')).length, 1)
  })

  test('reports cache hydration failure after canonical publication as committed', () => {
    const root = createRoot()
    assertPostCommitError(
      () =>
        addRecordResolved(
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
                  throw Object.assign(new Error('Injected hydration failure'), { code: 'EIO' })
                }
              },
            },
          },
        ),
      {
        path: 'encephalon/decision/hydration-failure.json',
        phase: 'cacheHydration',
        recordId: 'hydration-failure',
      },
    )

    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'hydration-failure.json')), true)
    assert.deepEqual(api.prepare({ root }), { hydrated: true, recordsIndexed: 1 })
    assertErrorCode(
      () =>
        api.addRecord({
          id: 'hydration-failure',
          kind: 'decision',
          payload: { summary: 'Retry' },
          root,
          source: 'agent',
          subject: 'hydration.failure',
        }),
      'RECORD_EXISTS',
    )
  })

  test('reports publication flush failure after canonical publication as committed', () => {
    const root = createRoot()
    assertPostCommitError(
      () =>
        addRecordResolved(
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
                  throw Object.assign(new Error('Injected directory flush failure'), { code: 'EIO' })
                }
              },
            },
            hydrate: false,
          },
        ),
      {
        path: 'encephalon/decision/flush-failure.json',
        phase: 'publicationFlush',
        recordId: 'flush-failure',
      },
    )

    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'flush-failure.json')), true)
    assert.deepEqual(readdirSync(join(root, 'encephalon', '_staging')), [])
  })

  test('does not let cleanup failure replace publication flush failure after commit', () => {
    const root = createRoot()
    assertPostCommitError(
      () =>
        addRecordResolved(
          root,
          {
            id: 'flush-and-cleanup-failure',
            kind: 'decision',
            payload: { summary: 'Published' },
            source: 'agent',
            subject: 'flush.cleanup',
          },
          {
            hooks: {
              fault: point => {
                if (point === 'during-publication-flush' || point === 'during-cleanup') {
                  throw Object.assign(new Error(`Injected ${point}`), { code: 'EIO' })
                }
              },
            },
            hydrate: false,
          },
        ),
      {
        path: 'encephalon/decision/flush-and-cleanup-failure.json',
        phase: 'publicationFlush',
        recordId: 'flush-and-cleanup-failure',
      },
    )

    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'flush-and-cleanup-failure.json')), true)
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

  test('rejects addRecord when the candidate would exceed corpus count or byte budgets', () => {
    const countRoot = createRoot()
    for (const index of Array.from({ length: MAX_CANONICAL_RECORDS }, (_, value) => value)) {
      writeCanonicalRecord(countRoot, {
        createdAt: timestampAt(index),
        id: `count-existing-${index}`,
        subject: `validation.count-existing.${index}`,
      })
    }

    assertValidationFailureCode(
      () =>
        api.addRecord({
          id: 'count-overflow',
          kind: 'decision',
          payload: {},
          root: countRoot,
          source: 'test',
          subject: 'validation.count-overflow',
        }),
      'CORPUS_RECORD_LIMIT',
    )
    assert.equal(existsSync(join(countRoot, 'encephalon', 'decision', 'count-overflow.json')), false)

    const byteRoot = createRoot()
    for (const index of Array.from({ length: 8 }, (_, value) => value)) {
      writeCanonicalRecord(byteRoot, {
        createdAt: timestampAt(index),
        id: `byte-existing-${index}`,
        payload: { text: 'x'.repeat(1000 * 1024) },
        subject: `validation.byte-existing.${index}`,
      })
    }
    assert.equal(api.validateRecords({ root: byteRoot }).valid, true)

    assertValidationFailureCode(
      () =>
        api.addRecord({
          id: 'byte-overflow',
          kind: 'decision',
          payload: { text: 'x'.repeat(300 * 1024) },
          root: byteRoot,
          source: 'test',
          subject: 'validation.byte-overflow',
        }),
      'CORPUS_BYTE_LIMIT',
    )
    assert.equal(existsSync(join(byteRoot, 'encephalon', 'decision', 'byte-overflow.json')), false)
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
    assert.equal(result.errors.at(-1)?.message, 'Validation stopped reporting after 99 concrete issues.')
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
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: cyclic as never,
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

  test('rejects payload accessors without invoking them', () => {
    const root = createRoot()
    let getterCalls = 0
    const payloadWithGetter: Record<string, unknown> = {}
    Object.defineProperty(payloadWithGetter, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 'side effect'
      },
    })

    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: payloadWithGetter as never,
          root,
          source: 'agent',
          subject: 'payload.accessor',
        }),
      'INVALID_ARGUMENT',
    )
    assert.equal(getterCalls, 0)

    const payloadWithSetter = {}
    Object.defineProperty(payloadWithSetter, 'secret', {
      enumerable: true,
      set: () => {
        throw new Error('setter must not run')
      },
    })

    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: payloadWithSetter,
          root,
          source: 'agent',
          subject: 'payload.setter',
        }),
      'INVALID_ARGUMENT',
    )
  })

  test('returns stable invalid argument errors for hostile payload descriptors', () => {
    const root = createRoot()
    const throwingDescriptorProxy = new Proxy(
      { summary: 'Hidden' },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('descriptor trap must not escape')
        },
      },
    )

    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: throwingDescriptorProxy,
          root,
          source: 'agent',
          subject: 'payload.proxy',
        }),
      'INVALID_ARGUMENT',
    )
  })

  test('bounds payload depth and total node count', () => {
    const root = createRoot()
    const buildNestedPayload = (depth: number) =>
      Array.from({ length: depth }).reduce<unknown>(payload => ({ child: payload }), null)
    const buildWidePayload = (properties: number) =>
      Object.fromEntries(Array.from({ length: properties }, (_, index) => [`k${index}`, null]))

    const deepestValid = api.addRecord({
      id: 'payload-depth-limit',
      kind: 'decision',
      payload: buildNestedPayload(64) as never,
      root,
      source: 'agent',
      subject: 'payload.depth.valid',
    })
    assert.equal(existsSync(join(root, deepestValid.path)), true)

    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: buildNestedPayload(65) as never,
          root,
          source: 'agent',
          subject: 'payload.depth.invalid',
        }),
      'INVALID_ARGUMENT',
    )

    const widestValid = api.addRecord({
      id: 'payload-node-limit',
      kind: 'decision',
      payload: buildWidePayload(9999),
      root,
      source: 'agent',
      subject: 'payload.nodes.valid',
    })
    assert.equal(existsSync(join(root, widestValid.path)), true)

    assertErrorCode(
      () =>
        api.addRecord({
          kind: 'decision',
          payload: buildWidePayload(10_000),
          root,
          source: 'agent',
          subject: 'payload.nodes.invalid',
        }),
      'INVALID_ARGUMENT',
    )
  })

  test('normalizes negative zero payload numbers before formatting', () => {
    const root = createRoot()
    const record = api.addRecord({
      id: 'payload-negative-zero',
      kind: 'decision',
      payload: { value: -0 },
      root,
      source: 'agent',
      subject: 'payload.negative-zero',
    })

    assert.equal(Object.is((record.payload as { value: number }).value, 0), true)
    const persisted = JSON.parse(readFileSync(join(root, record.path), 'utf8')) as { payload: { value: number } }
    assert.equal(Object.is(persisted.payload.value, 0), true)
    assert.deepEqual(record.payload, persisted.payload)
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

  test('rejects a record replaced by a symlink between enumeration and open', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const record = api.addRecord({
      id: 'record-symlink-race',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'record.symlink-race',
    })
    const path = join(root, record.path)
    const target = join(root, 'outside-record.json')
    writeFileSync(target, '{}')
    let replaced = false

    const result = validateRecordsResolved(root, {
      hooks: {
        fault: point => {
          if (point === 'after-record-lstat' && !replaced) {
            replaced = true
            rmSync(path)
            symlinkSync(target, path)
          }
        },
      },
    })

    assertInvalidRecord(result, record.path)
  })

  test('rejects a record when its parent kind directory is replaced during read', () => {
    const root = createRoot()
    const record = api.addRecord({
      id: 'parent-replaced',
      kind: 'decision',
      payload: { summary: 'Original' },
      root,
      source: 'agent',
      subject: 'record.parent-race',
    })
    const kindPath = join(root, 'encephalon', 'decision')
    const recordPath = join(root, record.path)
    let replaced = false

    const result = validateRecordsResolved(root, {
      hooks: {
        fault: point => {
          if (point === 'after-record-lstat' && !replaced) {
            replaced = true
            rmSync(kindPath, { recursive: true })
            mkdirSync(kindPath)
            writeFileSync(
              recordPath,
              JSON.stringify({
                createdAt: record.createdAt,
                id: record.id,
                kind: record.kind,
                payload: { summary: 'Replacement' },
                source: record.source,
                subject: record.subject,
              }),
            )
          }
        },
      },
    })

    assertInvalidRecord(result, record.path)
  })

  test('rejects a symlink record whose target exceeds the byte limit', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const record = api.addRecord({
      id: 'oversized-symlink-target',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'record.oversized-symlink',
    })
    const path = join(root, record.path)
    const target = join(root, 'oversized-target.json')
    writeFileSync(target, 'x'.repeat(1024 * 1024 + 1))
    let replaced = false

    const result = validateRecordsResolved(root, {
      hooks: {
        fault: point => {
          if (point === 'after-record-lstat' && !replaced) {
            replaced = true
            rmSync(path)
            symlinkSync(target, path)
          }
        },
      },
    })

    assertInvalidRecord(result, record.path)
  })

  test('rejects non-regular canonical record entries where supported', {
    skip: process.platform === 'win32' ? 'Windows runners do not provide mkfifo.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'encephalon', 'decision', 'fifo-record.json')
    ensureParent(path)
    execFileSync('mkfifo', [path])

    const result = api.validateRecords({ root })

    assert.equal(result.valid, false)
    assert.equal(
      result.errors.some(
        error => error.code === 'INVALID_RECORD_LAYOUT' && error.path === 'encephalon/decision/fifo-record.json',
      ),
      true,
    )
  })

  test('rejects invalid UTF-8 record bytes', () => {
    const root = createRoot()
    const record = api.addRecord({
      id: 'invalid-utf8',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'record.invalid-utf8',
    })
    writeFileSync(join(root, record.path), Buffer.from([0xff, 0xfe, 0xfd]))

    const result = api.validateRecords({ root })

    assertInvalidRecord(result, record.path)
    assert.equal(
      result.errors.some(error => error.message === 'Record file is not valid UTF-8.'),
      true,
    )
  })

  test('rejects a record changed after descriptor verification but before read', () => {
    const root = createRoot()
    const record = api.addRecord({
      id: 'changed-after-open',
      kind: 'decision',
      payload: { summary: 'Original' },
      root,
      source: 'agent',
      subject: 'record.changed-after-open',
    })
    const path = join(root, record.path)
    let changed = false

    const result = validateRecordsResolved(root, {
      hooks: {
        fault: point => {
          if (point === 'after-record-fstat' && !changed) {
            changed = true
            writeFileSync(path, '{"changed":true}')
          }
        },
      },
    })

    assertInvalidRecord(result, record.path)
    assert.equal(
      result.errors.some(error => error.message === 'Record file changed while it was being read.'),
      true,
    )
  })

  test('reports malformed JSON without echoing source content', () => {
    const root = createRoot()
    const record = api.addRecord({
      id: 'malformed-json',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'record.malformed-json',
    })
    const secret = 'SECRET_TOKEN_SHOULD_NOT_APPEAR'
    writeFileSync(join(root, record.path), `{"payload":"${secret}",`)

    const result = api.validateRecords({ root })

    assertInvalidRecord(result, record.path)
    assert.equal(
      result.errors.some(error => error.message === 'Record file contains invalid JSON.'),
      true,
    )
    assert.equal(
      result.errors.some(error => error.message.includes(secret)),
      false,
    )
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
