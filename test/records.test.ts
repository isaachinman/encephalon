import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { artifactInspectionTestHooks } from '../src/artifact-inspection.ts'
import { cacheReadTestHooks } from '../src/cache.ts'
import * as api from '../src/index.ts'
import { withOperationLock } from '../src/lock.ts'
import { ordinalStringCompare } from '../src/order.ts'
import {
  addRecordResolved,
  assertCanonicalLayoutAdditions,
  assertRecordGraph,
  MAX_CANONICAL_RECORD_BYTES,
  MAX_CANONICAL_RECORDS,
  nextRecordCreatedAt,
  planRecordAddition,
  projectedKindDirectoryOverflow,
  publishPlannedRecordOutcome,
  type RecordReadHooks,
  readRecordSnapshotResolved,
  readValidatedRecordSnapshotResolved,
  recordWriteTestHooks,
  validateRecordsResolved,
} from '../src/records.ts'
import { discoverRepository, repositoryTestHooks } from '../src/repository.ts'
import {
  formatRecordFile,
  MAX_PAYLOAD_NODES,
  parseRecordFile,
  validateAddRecordInput,
  validateJsonValue,
  validateKind,
} from '../src/schema.ts'
import * as stagingInternals from '../src/staging.ts'
import type { BrainRecord, ValidateResult } from '../src/types.ts'
import {
  canRenameParentWithOpenChild,
  createTestRepository,
  ensureParent,
  removeTestRepository,
} from '../test/helpers.ts'

const roots: string[] = []
const mutationRecordWriteTestHooks = recordWriteTestHooks as typeof recordWriteTestHooks & {
  readHooks?: RecordReadHooks | undefined
}
const renameParentWithOpenChildSkip = canRenameParentWithOpenChild()
  ? false
  : 'The filesystem does not allow replacing a parent while a child descriptor is open.'

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const timestampAt = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString()

const ownedStagingName = (index: number) =>
  stagingInternals.createOwnedStagingName(123, `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`)

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

const assertCommittedRepositoryChange = (operation: () => unknown, path: string, recordId: string) => {
  assert.throws(operation, (error: unknown) => {
    const actual = error as {
      code?: unknown
      details?: Record<string, unknown>
    }
    assert.equal(actual.code, 'REPOSITORY_CHANGED')
    assert.equal(actual.details?.canonicalCommitted, true)
    assert.equal(actual.details?.path, path)
    assert.equal(actual.details?.postCommitPhase, 'publicationVerification')
    assert.equal(actual.details?.recordId, recordId)
    assert.equal(typeof actual.details?.recoveryAction, 'string')
    return true
  })
}

const postCommitRecoveryAction = {
  cacheHydration: 'Run prepare to rebuild disposable cache state, then validate before retrying this add.',
  publicationFlush:
    'Confirm the canonical record file is present; prepare does not re-fsync the kind directory, so treat durability as unverified until that sync succeeds.',
  publicationVerification:
    'Inspect the canonical directory generation before retrying; the linked record may have been displaced by a concurrent replacement.',
  stagingCleanup: 'Inspect encephalon/_staging and remove only a confirmed leftover from this operation.',
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
  artifactInspectionTestHooks.close = undefined
  artifactInspectionTestHooks.fault = undefined
  artifactInspectionTestHooks.open = undefined
  repositoryTestHooks.afterGitMarkerDecision = undefined
  cacheReadTestHooks.afterCanonicalValidation = undefined
  cacheReadTestHooks.duringDatabaseInitialisation = undefined
  recordWriteTestHooks.afterOperationLock = undefined
  recordWriteTestHooks.beforeOperationLock = undefined
  recordWriteTestHooks.fault = undefined
  mutationRecordWriteTestHooks.readHooks = undefined
  stagingInternals.stagingTestHooks.fsyncDirectory = undefined
  roots.splice(0).forEach(removeTestRepository)
})

describe('canonical records', () => {
  test('rebuilds add cache from one validated mutation snapshot', () => {
    const root = createRoot()
    const counts = {
      canonicalScans: 0,
      diskCacheValidations: 0,
      graphValidations: 0,
    }
    mutationRecordWriteTestHooks.readHooks = {
      canonicalScan: () => {
        counts.canonicalScans += 1
      },
      graphValidation: () => {
        counts.graphValidations += 1
      },
    }
    cacheReadTestHooks.afterCanonicalValidation = () => {
      counts.diskCacheValidations += 1
    }

    const added = api.addRecord({
      id: 'validated-mutation-snapshot',
      kind: 'decision',
      payload: { summary: 'Reused validated mutation snapshot' },
      root,
      source: 'agent',
      subject: 'cache.validated-mutation-snapshot',
    })

    assert.equal(added.id, 'validated-mutation-snapshot')
    assert.deepEqual(counts, {
      canonicalScans: 1,
      diskCacheValidations: 0,
      graphValidations: 1,
    })
    assert.deepEqual(api.prepare({ root }), { hydrated: false, recordsIndexed: 1 })
  })

  test('orders add and generated baseline timestamps after canonical history', () => {
    const root = createRoot()
    const future = new Date(Date.now() + 86_400_000).toISOString()
    writeCanonicalRecord(root, {
      createdAt: future,
      id: 'future-history',
      subject: 'timestamp.future-history',
    })

    const added = api.addRecord({
      id: 'after-future-history',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'timestamp.after-future-history',
    })
    const baseline = api.initEncephalon({ root }).recordsCreated
    const timestamps = [future, added.createdAt, ...baseline.map(record => record.createdAt)]

    assert.deepEqual(
      timestamps,
      Array.from({ length: timestamps.length }, (_, index) => new Date(Date.parse(future) + index).toISOString()),
    )
  })

  test('orders cross-process timestamps by lock acquisition rather than input validation', async () => {
    const root = createRoot()
    const barrierRoot = createRoot()
    const validatedPath = join(barrierRoot, 'first-input-validated')
    const resultPath = join(barrierRoot, 'first-record-result.json')
    let first: ReturnType<typeof spawn> | undefined
    let second: BrainRecord | undefined
    try {
      withOperationLock(root, cacheLocation => {
        first = spawn(
          process.execPath,
          [
            join(import.meta.dirname, 'fixtures', 'add-record-after-validation-release.ts'),
            root,
            validatedPath,
            resultPath,
          ],
          { stdio: 'inherit' },
        )
        const validationDeadline = Date.now() + 10_000
        while (!existsSync(validatedPath) && first.exitCode === null && Date.now() < validationDeadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
        }
        assert.equal(existsSync(validatedPath), true)
        second = addRecordResolved(
          root,
          {
            id: 'second-process-first-publication',
            kind: 'decision',
            payload: {},
            root,
            source: 'agent',
            subject: 'timestamp.second-process',
          },
          { cacheLocation },
        )
      })

      const runningFirst = first
      assert.ok(runningFirst)
      if (runningFirst.exitCode === null) {
        await once(runningFirst, 'exit', { signal: AbortSignal.timeout(10_000) })
      }
      assert.equal(runningFirst.exitCode, 0)
      assert.ok(second)
      const firstRecord = JSON.parse(readFileSync(resultPath, 'utf8')) as BrainRecord
      assert.equal(Date.parse(firstRecord.createdAt) > Date.parse(second.createdAt), true)
    } finally {
      if (first?.exitCode === null) {
        first.kill()
        await once(first, 'exit')
      }
    }
  })

  test('does not consume canonical timestamp order when publication fails before commit', () => {
    const root = createRoot()
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const id = 'retry-after-failed-publication'
    writeCanonicalRecord(root, { createdAt: future, id: 'future-retry-history' })
    let failed = false
    recordWriteTestHooks.fault = point => {
      if (point === 'before-publication' && !failed) {
        failed = true
        throw Object.assign(new Error('injected publication failure'), { code: 'EIO' })
      }
    }
    const input = {
      id,
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'timestamp.retry',
    } as const

    assertErrorCode(() => api.addRecord(input), 'IO_ERROR')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', `${id}.json`)), false)
    recordWriteTestHooks.fault = undefined

    const record = api.addRecord(input)
    assert.equal(record.createdAt, new Date(Date.parse(future) + 1).toISOString())
  })

  test('derives the next timestamp from the latest canonical value and fails at the schema ceiling', () => {
    assert.equal(
      nextRecordCreatedAt(
        [{ createdAt: '2026-01-01T00:00:00.005Z' }, { createdAt: '2026-01-01T00:00:00.001Z' }],
        Date.parse('2026-01-01T00:00:00.004Z'),
      ),
      '2026-01-01T00:00:00.006Z',
    )
    assertErrorCode(
      () => nextRecordCreatedAt([{ createdAt: '9999-12-31T23:59:59.999Z' }], Date.parse('2026-01-01')),
      'VALIDATION_FAILED',
    )
  })

  test('reports invalid canonical history before a timestamp ceiling', () => {
    const root = createRoot()
    writeCanonicalRecord(root, {
      createdAt: '9999-12-31T23:59:59.999Z',
      id: 'ceiling-invalid-history-a',
      subject: 'timestamp.invalid-history',
    })
    writeCanonicalRecord(root, {
      createdAt: '9999-12-31T23:59:59.998Z',
      id: 'ceiling-invalid-history-b',
      subject: 'timestamp.invalid-history',
    })

    assert.throws(
      () =>
        api.addRecord({
          id: 'ceiling-invalid-history-candidate',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'timestamp.candidate',
        }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: { errors?: Array<{ code?: unknown }> } }
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(
          actual.details?.errors?.some(issue => issue.code === 'MULTIPLE_ACTIVE_HEADS'),
          true,
        )
        return true
      },
    )
  })

  test('does not publish into a repository root replaced after lock acquisition', {
    skip: renameParentWithOpenChildSkip,
  }, () => {
    const root = createRoot()
    const replacement = createRoot()
    const displaced = `${root}-locked-root`
    roots.push(displaced)
    recordWriteTestHooks.afterOperationLock = () => {
      renameSync(root, displaced)
      renameSync(replacement, root)
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'replacement-root-candidate',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'timestamp.replacement-root',
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'replacement-root-candidate.json')), false)
  })

  test('does not publish into a repository root replaced after scan validation', {
    skip: renameParentWithOpenChildSkip,
  }, () => {
    const root = createRoot()
    const replacement = createRoot()
    const displaced = `${root}-post-scan-root`
    roots.push(displaced)
    recordWriteTestHooks.fault = point => {
      if (point === 'after-scan-validation') {
        renameSync(root, displaced)
        renameSync(replacement, root)
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'post-scan-replacement-root-candidate',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'timestamp.post-scan-replacement-root',
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'post-scan-replacement-root-candidate.json')), false)
  })

  test('does not publish after an observed canonical record changes in place', () => {
    const root = createRoot()
    writeCanonicalRecord(root, { id: 'observed-record-before-publication' })
    const existingPath = join(root, 'encephalon', 'decision', 'observed-record-before-publication.json')
    recordWriteTestHooks.fault = point => {
      if (point === 'after-scan-validation') {
        const existing = JSON.parse(readFileSync(existingPath, 'utf8')) as Record<string, unknown>
        writeFileSync(existingPath, `${JSON.stringify({ ...existing, payload: { changed: true } }, null, 2)}\n`)
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'candidate-after-observed-mutation',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'timestamp.observed-mutation',
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'candidate-after-observed-mutation.json')), false)
  })

  test('record publication outcome returns the canonical record with a post-link failure', () => {
    const root = createRoot()
    const plan = planRecordAddition(root, {
      createdAt: timestampAt(0),
      id: 'record-publication-outcome-committed',
      kind: 'decision',
      payload: { summary: 'Canonical despite verification failure' },
      source: 'agent',
      subject: 'record.publication-outcome.committed',
    })
    const snapshot = readRecordSnapshotResolved(root)
    const authority = assertCanonicalLayoutAdditions([plan.record.kind], snapshot.authority)

    const outcome = publishPlannedRecordOutcome(root, plan, {
      authority,
      hooks: {
        fault: point => {
          if (point === 'after-publication-accept') {
            throw Object.assign(new Error('Injected post-link verification failure'), {
              code: 'EIO',
            })
          }
        },
      },
    })

    assert.equal(outcome.record.id, plan.record.id)
    assert.ok(outcome.committedError)
    assert.equal(outcome.committedError.details.canonicalCommitted, true)
  })

  test('record publication outcome preserves the first post-link verification failure', () => {
    const root = createRoot()
    const firstFailure = Object.assign(new Error('first post-link verification failure'), {
      code: 'EIO',
    })
    const laterFailure = Object.assign(new Error('later final verification failure'), {
      code: 'EIO',
    })
    const plan = planRecordAddition(root, {
      createdAt: timestampAt(0),
      id: 'record-publication-outcome-first-verification',
      kind: 'decision',
      payload: {},
      source: 'agent',
      subject: 'record.publication-outcome.first-verification',
    })
    const snapshot = readRecordSnapshotResolved(root)
    const authority = assertCanonicalLayoutAdditions([plan.record.kind], snapshot.authority)

    const outcome = publishPlannedRecordOutcome(root, plan, {
      authority,
      hooks: {
        fault: point => {
          if (point === 'after-canonical-link') {
            throw firstFailure
          }
          if (point === 'before-final-publication-revalidation') {
            throw laterFailure
          }
        },
      },
    })

    assert.equal(outcome.committedError?.cause, firstFailure)
    assert.equal(outcome.committedErrorPhase, 'publicationVerification')
  })

  test('record publication outcome retains staging when canonical publication is displaced after verification fails', () => {
    const root = createRoot()
    const firstFailure = Object.assign(new Error('first post-link verification failure'), {
      code: 'EIO',
    })
    const successorBytes = 'concurrent canonical successor\n'
    const displacedPath = join(root, 'displaced-record-publication.json')
    const plan = planRecordAddition(root, {
      createdAt: timestampAt(0),
      id: 'record-publication-outcome-displaced',
      kind: 'decision',
      payload: { summary: 'Preserve recovery staging' },
      source: 'agent',
      subject: 'record.publication-outcome.displaced',
    })
    const canonicalPath = join(root, plan.record.path)
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const snapshot = readRecordSnapshotResolved(root)
    const authority = assertCanonicalLayoutAdditions([plan.record.kind], snapshot.authority)
    let publishedBytes = ''

    const outcome = publishPlannedRecordOutcome(root, plan, {
      authority,
      hooks: {
        fault: point => {
          if (point === 'after-canonical-link') {
            throw firstFailure
          }
          if (point === 'before-final-publication-revalidation') {
            publishedBytes = readFileSync(canonicalPath, 'utf8')
            renameSync(canonicalPath, displacedPath)
            writeFileSync(canonicalPath, successorBytes)
          }
        },
      },
    })

    assert.equal(outcome.committedError?.cause, firstFailure)
    assert.equal(outcome.committedErrorPhase, 'publicationVerification')
    assert.equal(readFileSync(displacedPath, 'utf8'), publishedBytes)
    assert.equal(readFileSync(canonicalPath, 'utf8'), successorBytes)
    assert.equal(readdirSync(stagingDirectory).length, 1)
  })

  test('record publication outcome still throws before canonical linking', () => {
    const root = createRoot()
    const plan = planRecordAddition(root, {
      createdAt: timestampAt(0),
      id: 'record-publication-outcome-pre-link',
      kind: 'decision',
      payload: {},
      source: 'agent',
      subject: 'record.publication-outcome.pre-link',
    })
    const snapshot = readRecordSnapshotResolved(root)
    const authority = assertCanonicalLayoutAdditions([plan.record.kind], snapshot.authority)

    assert.throws(
      () =>
        publishPlannedRecordOutcome(root, plan, {
          authority,
          hooks: {
            fault: point => {
              if (point === 'during-staging-write') {
                throw Object.assign(new Error('Injected pre-link write failure'), { code: 'EIO' })
              }
            },
          },
        }),
      (error: unknown) => {
        assert.equal((error as { details?: Record<string, unknown> }).details?.canonicalCommitted, undefined)
        return true
      },
    )
  })

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
    let repositoryInspected = false
    repositoryTestHooks.afterGitMarkerDecision = () => {
      repositoryInspected = true
    }
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
    assert.equal(repositoryInspected, false)
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
    const validated = readValidatedRecordSnapshotResolved(root)
    assert.equal(Object.isFrozen(validated), true)
    assert.equal(Object.isFrozen(validated.artifacts), true)
    assert.equal(validated.artifacts.length, 1)
    assert.equal(Object.isFrozen(validated.artifacts[0]), true)
  })

  test('does not inspect the artifact filesystem for an artifact-free corpus', () => {
    const root = createRoot()
    writeCanonicalRecord(root, { id: 'artifact-free' })
    artifactInspectionTestHooks.fault = point => {
      if (point === 'after-brain-lstat') {
        throw new Error('artifact inspection should not run')
      }
    }

    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('classifies public artifact validation failures without leaking repository paths', () => {
    const cases = [
      { code: undefined, expected: 'INVALID_ARTIFACT', name: 'stable-invalid' },
      { code: 'REPOSITORY_CHANGED', expected: undefined, name: 'concurrent-change' },
      { code: 'IO_ERROR', expected: undefined, name: 'operational-io' },
    ] as const
    for (const entry of cases) {
      const root = createRoot()
      const artifact = `_artifacts/decision/${entry.name}/evidence.txt`
      const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
      ensureParent(artifactPath)
      writeFileSync(artifactPath, 'evidence')
      writeCanonicalRecord(root, {
        artifacts: [artifact],
        id: entry.name,
        subject: `validation.${entry.name}`,
      })
      if (entry.name === 'stable-invalid') {
        rmSync(artifactPath)
      } else {
        artifactInspectionTestHooks.fault = (point, path) => {
          if (path === artifact && point === 'after-artifact-fstat') {
            if (entry.name === 'concurrent-change') {
              writeFileSync(artifactPath, 'changed evidence')
            } else {
              throw Object.assign(new Error('simulated artifact I/O failure'), { code: 'EIO' })
            }
          }
        }
      }

      if (entry.expected === undefined) {
        assert.throws(
          () => api.validateRecords({ root }),
          (error: unknown) => {
            const publicError = error as { code?: unknown; details?: unknown; message?: unknown }
            assert.equal(publicError.code, entry.code)
            assert.equal(typeof publicError.message === 'string' && publicError.message.includes(root), false)
            assert.equal(JSON.stringify(publicError.details ?? null).includes(root), false)
            return true
          },
        )
      } else {
        const result = api.validateRecords({ root })
        const [issue] = result.errors
        assert.ok(issue)
        assert.equal(result.valid, false)
        assert.equal(issue.code, entry.expected)
        assert.equal(typeof issue.path === 'string' && issue.path.startsWith('encephalon/'), true)
        assert.equal(issue.message.includes(root), false)
      }
      artifactInspectionTestHooks.fault = undefined
    }
  })

  test('classifies existing artifact mutation during addRecord validation before publication', () => {
    const root = createRoot()
    const artifact = '_artifacts/decision/existing-artifact/evidence.txt'
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    const candidatePath = join(root, 'encephalon', 'decision', 'artifact-validation-candidate.json')
    ensureParent(artifactPath)
    writeFileSync(artifactPath, 'stable evidence')
    writeCanonicalRecord(root, {
      artifacts: [artifact],
      id: 'existing-artifact',
      subject: 'validation.existing-artifact',
    })
    artifactInspectionTestHooks.fault = (point, path) => {
      if (point === 'after-artifact-fstat' && path === artifact) {
        writeFileSync(artifactPath, 'mutated evidence with different metadata')
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'artifact-validation-candidate',
          kind: 'decision',
          payload: {},
          root,
          source: 'test',
          subject: 'validation.candidate',
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(existsSync(candidatePath), false)
  })

  test('validates planned graph bytes without counting runtime paths', () => {
    const root = createRoot()
    const plans = Array.from({ length: 8 }, (_, index) =>
      planRecordAddition(root, {
        createdAt: timestampAt(index),
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
      .sort((first, second) => ordinalStringCompare(String(first[1]), String(second[1])))
    assert.deepEqual(
      result.errors.map(error => [error.code, error.path]),
      expected,
    )
  })

  test('detects kind directory case and unicode-normalization collisions', () => {
    const root = createRoot()
    mkdirSync(join(root, 'encephalon', 'context'), { recursive: true })
    canCreateDirectory(root, 'Context')
    const unicodeKindCandidates = ['cafe\u0301', 'café']
    for (const name of unicodeKindCandidates) {
      canCreateDirectory(root, name)
    }
    const kindDirectoryNames = readdirSync(join(root, 'encephalon')).sort(ordinalStringCompare)
    const invalidKindPaths = kindDirectoryNames.reduce<string[]>((paths, name) => {
      try {
        validateKind(name)
        return paths
      } catch {
        return [...paths, `encephalon/${name}`]
      }
    }, [])
    const collisionPaths = kindDirectoryNames.reduce<{ paths: string[]; seen: Set<string> }>(
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
      ...invalidKindPaths.map(path => ['INVALID_KIND_DIRECTORY', path]),
      ...collisionPaths.map(path => ['KIND_DIRECTORY_COLLISION', path]),
    ].sort((first, second) => ordinalStringCompare(String(first[1]), String(second[1])))

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

  test('rejects a dangling canonical-root symlink during validation', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit directory symlink creation.' : false,
  }, () => {
    const root = createRoot()
    symlinkSync(join(root, 'missing-encephalon'), join(root, 'encephalon'), 'dir')

    const result = api.validateRecords({ root })

    assert.equal(result.valid, false)
    assert.deepEqual(
      result.errors.map(error => [error.code, error.path]),
      [['INVALID_RECORD_LAYOUT', 'encephalon']],
    )
  })

  test('does not create a cache for a dangling canonical-root symlink', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit directory symlink creation.' : false,
  }, () => {
    const root = createRoot()
    symlinkSync(join(root, 'missing-encephalon'), join(root, 'encephalon'), 'dir')
    let failure: unknown

    try {
      api.prepare({ root })
    } catch (error) {
      failure = error
    }

    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
    assert.equal((failure as { code?: unknown } | undefined)?.code, 'VALIDATION_FAILED')
  })

  test('does not follow a staging directory replaced during cleanup', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit directory symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const displacedStaging = join(root, 'displaced-staging')
    const outside = join(root, 'outside-staging-cleanup')
    const outsideSentinel = join(outside, 'sentinel')
    mkdirSync(stagingDirectory, { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(stagingDirectory, ownedStagingName(0)), 'staged')
    writeFileSync(outsideSentinel, 'outside')
    let replaced = false
    let failure: unknown

    try {
      addRecordResolved(
        root,
        {
          id: 'staging-cleanup-replacement',
          kind: 'decision',
          payload: {},
          source: 'agent',
          subject: 'staging.cleanup-replacement',
        },
        {
          hooks: {
            fault: point => {
              if ((point as string) === 'after-staging-cleanup-preflight' && !replaced) {
                replaced = true
                renameSync(stagingDirectory, displacedStaging)
                symlinkSync(outside, stagingDirectory, 'dir')
              }
            },
          },
          hydrate: false,
        },
      )
    } catch (error) {
      failure = error
    }

    assert.equal(replaced, true)
    assert.equal(existsSync(outsideSentinel), true)
    assert.equal((failure as { code?: unknown } | undefined)?.code, 'REPOSITORY_CHANGED')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-cleanup-replacement.json')), false)
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
      'REPOSITORY_CHANGED',
    )
    assert.equal(readFileSync(join(root, 'encephalon', 'decision'), 'utf8'), 'not a directory')
  })

  test('cleans only recognised stale files, hard links, and owned-name symlinks', () => {
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
    const outside = join(root, 'outside-staging-target')
    writeFileSync(join(stagingDirectory, ownedStagingName(0)), 'stale')
    linkSync(join(root, first.path), join(stagingDirectory, ownedStagingName(1)))
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(stagingDirectory, ownedStagingName(2)), 'file')

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
    assert.equal(readFileSync(outside, 'utf8'), 'outside')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'after-orphan.json')), true)
  })

  test('fails closed before cleanup for unrecognised names and unsupported entry types', () => {
    const cases = [
      {
        create: (path: string) => writeFileSync(path, 'unknown'),
        name: 'unrecognised regular file',
        stagingName: 'orphan.tmp',
      },
      {
        create: (path: string) => writeFileSync(path, 'owned-like'),
        name: 'non-canonical owned-like name',
        stagingName: 'record-0123-00000000-0000-4000-8000-000000000000.tmp',
      },
      {
        create: (path: string) => writeFileSync(path, 'malformed quarantine'),
        name: 'malformed crash quarantine',
        stagingName: `.${ownedStagingName(12)}.00000000-0000-4000-7000-000000000001.quarantine`,
      },
      {
        create: (path: string) => mkdirSync(path),
        name: 'owned-name directory',
        stagingName: ownedStagingName(10),
      },
      {
        create: (path: string, root: string) => {
          const target = join(root, 'unknown-link-target')
          writeFileSync(target, 'outside')
          symlinkSync(target, path, 'file')
        },
        name: 'unrecognised symlink',
        stagingName: 'unknown-link.tmp',
      },
      ...(process.platform === 'win32'
        ? []
        : [
            {
              create: (path: string) => execFileSync('mkfifo', [path]),
              name: 'owned-name FIFO',
              stagingName: ownedStagingName(11),
            },
          ]),
    ]

    for (const [index, fixture] of cases.entries()) {
      const root = createRoot()
      const stagingDirectory = join(root, 'encephalon', '_staging')
      mkdirSync(stagingDirectory, { recursive: true })
      const recognisedPath = join(stagingDirectory, ownedStagingName(100 + index))
      const unsafePath = join(stagingDirectory, fixture.stagingName)
      writeFileSync(recognisedPath, 'recognised')
      fixture.create(unsafePath, root)
      let failure: unknown

      try {
        api.addRecord({
          id: `unsafe-staging-${index}`,
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: `staging.unsafe.${index}`,
        })
      } catch (error) {
        failure = error
      }

      const typed = failure as {
        code?: unknown
        details?: { errors?: Array<{ code?: unknown; message?: unknown; path?: unknown }> }
      }
      assert.equal(typed.code, 'VALIDATION_FAILED', fixture.name)
      assert.deepEqual(
        typed.details?.errors?.map(issue => [issue.code, issue.path]),
        [['INVALID_STAGING_LAYOUT', 'encephalon/_staging']],
      )
      assert.match(String(typed.details?.errors?.[0]?.message), /remove.*encephalon\/_staging.*retry/i)
      assert.equal(JSON.stringify(typed).includes(fixture.stagingName), false)
      assert.equal(existsSync(recognisedPath), true)
      assert.equal(existsSync(unsafePath), true)
      assert.equal(existsSync(join(root, 'encephalon', 'decision', `unsafe-staging-${index}.json`)), false)
    }
  })

  test('accepts exactly 1000 staging entries and rejects one excess without deleting any', () => {
    const exactRoot = createRoot()
    const exactStaging = join(exactRoot, 'encephalon', '_staging')
    mkdirSync(exactStaging, { recursive: true })
    for (const index of Array.from({ length: 1000 }, (_, value) => value)) {
      writeFileSync(join(exactStaging, ownedStagingName(index)), '')
    }

    api.addRecord({
      id: 'exact-staging-bound',
      kind: 'decision',
      payload: {},
      root: exactRoot,
      source: 'agent',
      subject: 'staging.bound.exact',
    })

    assert.deepEqual(readdirSync(exactStaging), [])

    const overflowRoot = createRoot()
    const overflowStaging = join(overflowRoot, 'encephalon', '_staging')
    mkdirSync(overflowStaging, { recursive: true })
    for (const index of Array.from({ length: 1001 }, (_, value) => value)) {
      writeFileSync(join(overflowStaging, ownedStagingName(index)), '')
    }
    let failure: unknown

    try {
      api.addRecord({
        id: 'overflow-staging-bound',
        kind: 'decision',
        payload: {},
        root: overflowRoot,
        source: 'agent',
        subject: 'staging.bound.overflow',
      })
    } catch (error) {
      failure = error
    }

    const typed = failure as {
      code?: unknown
      details?: { errors?: Array<{ code?: unknown; message?: unknown; path?: unknown }> }
    }
    assert.equal(typed.code, 'VALIDATION_FAILED')
    assert.deepEqual(
      typed.details?.errors?.map(issue => [issue.code, issue.path]),
      [['STAGING_DIRECTORY_ENTRY_LIMIT', 'encephalon/_staging']],
    )
    assert.match(String(typed.details?.errors?.[0]?.message), /at most 1000.*remove.*retry/i)
    assert.equal(JSON.stringify(typed).includes(ownedStagingName(1000)), false)
    assert.equal(readdirSync(overflowStaging).length, 1001)
    assert.equal(existsSync(join(overflowRoot, 'encephalon', 'decision', 'overflow-staging-bound.json')), false)
  })

  test('preserves a staging replacement observed immediately before unlink', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const stagingPath = join(stagingDirectory, ownedStagingName(0))
    const displaced = join(root, 'displaced-owned-staging')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(stagingPath, 'preflight')
    let replaced = false
    recordWriteTestHooks.fault = point => {
      if (point === 'before-staging-cleanup-entry-lstat' && !replaced) {
        replaced = true
        renameSync(stagingPath, displaced)
        writeFileSync(stagingPath, 'replacement')
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'staging-entry-replacement',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.entry-replacement',
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(replaced, true)
    assert.equal(readFileSync(stagingPath, 'utf8'), 'replacement')
    assert.equal(readFileSync(displaced, 'utf8'), 'preflight')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-entry-replacement.json')), false)
  })

  test('preserves an entry that arrives after staging cleanup preflight', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const stalePath = join(stagingDirectory, ownedStagingName(0))
    const latePath = join(stagingDirectory, 'late-after-preflight.tmp')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(stalePath, 'stale')
    recordWriteTestHooks.fault = point => {
      if ((point as string) === 'after-staging-cleanup-preflight') {
        writeFileSync(latePath, 'late')
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'late-staging-entry',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.late-entry',
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(readFileSync(stalePath, 'utf8'), 'stale')
    assert.equal(readFileSync(latePath, 'utf8'), 'late')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'late-staging-entry.json')), false)
  })

  test('preserves an entry that arrives before the final staging emptiness probe', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const stalePath = join(stagingDirectory, ownedStagingName(0))
    const latePath = join(stagingDirectory, 'late-before-empty-probe.tmp')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(stalePath, 'stale')
    recordWriteTestHooks.fault = point => {
      if ((point as string) === 'before-staging-cleanup-empty-probe') {
        writeFileSync(latePath, 'late')
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'late-before-empty-probe',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.late-empty-probe',
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(readFileSync(latePath, 'utf8'), 'late')
    assert.equal(existsSync(stalePath), false)
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'late-before-empty-probe.json')), false)
  })

  test('preserves a replacement installed at the immediate staging deletion boundary', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const stagingPath = join(stagingDirectory, ownedStagingName(0))
    const displaced = join(root, 'displaced-staging-at-delete')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(stagingPath, 'preflight')
    let replaced = false
    recordWriteTestHooks.fault = point => {
      if ((point as string) === 'before-staging-cleanup-quarantine' && !replaced) {
        replaced = true
        renameSync(stagingPath, displaced)
        writeFileSync(stagingPath, 'replacement')
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'staging-delete-replacement',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.delete-replacement',
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(replaced, true)
    assert.equal(readFileSync(stagingPath, 'utf8'), 'replacement')
    assert.equal(readFileSync(displaced, 'utf8'), 'preflight')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-delete-replacement.json')), false)
  })

  test('cleans multiple owned hard-link aliases of the same stale inode', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const first = join(stagingDirectory, ownedStagingName(0))
    const second = join(stagingDirectory, ownedStagingName(1))
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(first, 'stale')
    linkSync(first, second)

    api.addRecord({
      id: 'after-hard-link-aliases',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'staging.hard-link-aliases',
    })

    assert.deepEqual(readdirSync(stagingDirectory), [])
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'after-hard-link-aliases.json')), true)
  })

  test('does not adopt an in-place canonical rewrite during stale staging cleanup', () => {
    const root = createRoot()
    writeCanonicalRecord(root, { id: 'canonical-during-staging-cleanup' })
    const canonicalPath = join(root, 'encephalon', 'decision', 'canonical-during-staging-cleanup.json')
    const stagingDirectory = join(root, 'encephalon', '_staging')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(join(stagingDirectory, ownedStagingName(0)), 'stale')
    const fixedTime = new Date('2026-01-01T00:00:00.000Z')
    utimesSync(canonicalPath, fixedTime, fixedTime)
    const original = readFileSync(canonicalPath, 'utf8')
    const originalMetadata = statSync(canonicalPath)
    recordWriteTestHooks.fault = point => {
      if (point === 'after-staging-cleanup-preflight') {
        writeFileSync(canonicalPath, original.replace('"payload": {}', '"payload": []'))
        utimesSync(canonicalPath, originalMetadata.atime, originalMetadata.mtime)
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'candidate-after-staging-cleanup-rewrite',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.canonical-rewrite',
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(
      existsSync(join(root, 'encephalon', 'decision', 'candidate-after-staging-cleanup-rewrite.json')),
      false,
    )
  })

  test('cleans a stale owned alias of an existing canonical record before publication', () => {
    const root = createRoot()
    writeCanonicalRecord(root, { id: 'canonical-with-stale-staging-alias' })
    const canonicalPath = join(root, 'encephalon', 'decision', 'canonical-with-stale-staging-alias.json')
    const canonicalBytes = readFileSync(canonicalPath, 'utf8')
    const stagingDirectory = join(root, 'encephalon', '_staging')
    mkdirSync(stagingDirectory, { recursive: true })
    linkSync(canonicalPath, join(stagingDirectory, ownedStagingName(0)))

    api.addRecord({
      id: 'candidate-after-canonical-staging-alias',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'staging.canonical-alias',
    })

    assert.deepEqual(readdirSync(stagingDirectory), [])
    assert.equal(readFileSync(canonicalPath, 'utf8'), canonicalBytes)
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'candidate-after-canonical-staging-alias.json')), true)
  })

  test('reports baseline corpus limits before a canonical timestamp ceiling', () => {
    const root = createRoot()
    for (const index of Array.from({ length: MAX_CANONICAL_RECORDS }, (_, position) => position)) {
      writeCanonicalRecord(root, {
        createdAt: index === MAX_CANONICAL_RECORDS - 1 ? '9999-12-31T23:59:59.999Z' : timestampAt(index),
        id: `baseline-limit-${index.toString().padStart(4, '0')}`,
        subject: `baseline.limit.${index}`,
      })
    }

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: { errors?: Array<{ code?: unknown }> } }
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(
          actual.details?.errors?.some(issue => issue.code === 'CORPUS_RECORD_LIMIT'),
          true,
        )
        return true
      },
    )
  })

  test('preserves a stale entry whose incarnation changes after cleanup preflight', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const stalePath = join(stagingDirectory, ownedStagingName(0))
    const temporaryAlias = join(root, 'temporary-staging-alias')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(stalePath, 'stale')
    recordWriteTestHooks.fault = point => {
      if (point === 'after-staging-cleanup-preflight') {
        linkSync(stalePath, temporaryAlias)
        rmSync(temporaryAlias)
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'staging-incarnation-change',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.incarnation-change',
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(readFileSync(stalePath, 'utf8'), 'stale')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-incarnation-change.json')), false)
  })

  test('preserves a quarantine pathname replacement at the immediate unlink boundary', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const sourcePath = join(stagingDirectory, ownedStagingName(0))
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(sourcePath, 'preflight')
    const displaced = join(root, 'displaced-staging-quarantine')
    let replacementPath: string | undefined
    recordWriteTestHooks.fault = point => {
      if ((point as string) === 'after-staging-cleanup-quarantine' && replacementPath === undefined) {
        const [quarantineName] = readdirSync(stagingDirectory)
        assert.notEqual(quarantineName, undefined)
        if (quarantineName !== undefined) {
          replacementPath = join(stagingDirectory, quarantineName)
          renameSync(replacementPath, displaced)
          writeFileSync(replacementPath, 'replacement')
          writeFileSync(sourcePath, 'successor')
        }
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'staging-quarantine-replacement',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.quarantine-replacement',
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(replacementPath === undefined ? undefined : readFileSync(replacementPath, 'utf8'), 'replacement')
    assert.equal(readFileSync(displaced, 'utf8'), 'preflight')
    assert.equal(readFileSync(sourcePath, 'utf8'), 'successor')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-quarantine-replacement.json')), false)
  })

  test('does not unlink through a staging directory generation replaced before entry inspection', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const displacedStaging = join(root, 'displaced-staging-entry')
    const name = ownedStagingName(0)
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(join(stagingDirectory, name), 'same inode')
    let replaced = false
    recordWriteTestHooks.fault = point => {
      if (point === 'before-staging-cleanup-entry-lstat' && !replaced) {
        replaced = true
        renameSync(stagingDirectory, displacedStaging)
        mkdirSync(stagingDirectory)
        linkSync(join(displacedStaging, name), join(stagingDirectory, name))
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'staging-ancestor-replacement',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.ancestor-replacement',
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(replaced, true)
    assert.equal(readFileSync(join(stagingDirectory, name), 'utf8'), 'same inode')
    assert.equal(readFileSync(join(displacedStaging, name), 'utf8'), 'same inode')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-ancestor-replacement.json')), false)
  })

  test('fails a staging cleanup flush before canonical publication', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(join(stagingDirectory, ownedStagingName(0)), 'stale')
    recordWriteTestHooks.fault = point => {
      if (point === 'during-staging-cleanup-flush') {
        throw Object.assign(new Error('Injected staging cleanup flush failure'), { code: 'EIO' })
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'staging-cleanup-flush',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.cleanup-flush',
        }),
      'IO_ERROR',
    )

    assert.deepEqual(readdirSync(stagingDirectory), [])
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-cleanup-flush.json')), false)
  })

  test('retries staging durability after cleanup before publishing', {
    skip: process.platform === 'win32' ? 'Windows does not flush staging directories.' : false,
  }, () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(join(stagingDirectory, ownedStagingName(0)), 'stale')
    let flushes = 0
    stagingInternals.stagingTestHooks.fsyncDirectory = descriptor => {
      flushes += 1
      if (flushes === 1) {
        throw Object.assign(new Error('Injected staging directory fsync failure'), {
          code: 'EIO',
        })
      }
      fsyncSync(descriptor)
    }

    let failure: unknown
    try {
      api.addRecord({
        id: 'staging-durability-first',
        kind: 'decision',
        payload: {},
        root,
        source: 'agent',
        subject: 'staging.durability-first',
      })
    } catch (error) {
      failure = error
    }
    assert.equal((failure as { code?: unknown } | undefined)?.code, 'IO_ERROR')
    assert.equal(
      (failure as { details?: { canonicalCommitted?: unknown } } | undefined)?.details?.canonicalCommitted ?? false,
      false,
    )
    assert.deepEqual(readdirSync(stagingDirectory), [])
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-durability-first.json')), false)

    api.addRecord({
      id: 'staging-durability-retry',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'staging.durability-retry',
    })

    assert.equal(flushes, 3)
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-durability-retry.json')), true)
  })

  test('rejects changed staging bytes and preserves a late unknown child before publication', () => {
    for (const scenario of ['changed-bytes', 'late-child'] as const) {
      const root = createRoot()
      const stagingDirectory = join(root, 'encephalon', '_staging')
      const displacedStaging = join(root, `displaced-current-staging-${scenario}`)
      let injectedPath: string | undefined
      let failure: unknown

      try {
        addRecordResolved(
          root,
          {
            id: `current-staging-${scenario}`,
            kind: 'decision',
            payload: {},
            source: 'agent',
            subject: `staging.current.${scenario}`,
          },
          {
            hooks: {
              fault: point => {
                if (point === 'during-staging-write') {
                  const [currentName] = readdirSync(stagingDirectory)
                  assert.notEqual(currentName, undefined)
                  if (currentName !== undefined) {
                    if (scenario === 'changed-bytes') {
                      renameSync(join(stagingDirectory, currentName), displacedStaging)
                      injectedPath = join(stagingDirectory, currentName)
                      writeFileSync(injectedPath, 'replacement bytes')
                    } else {
                      injectedPath = join(stagingDirectory, 'unknown-during-write.tmp')
                      writeFileSync(injectedPath, 'preserve')
                    }
                  }
                }
              },
            },
            hydrate: false,
          },
        )
      } catch (error) {
        failure = error
      }

      assert.equal((failure as { code?: unknown } | undefined)?.code, 'REPOSITORY_CHANGED', scenario)
      assert.equal(
        existsSync(join(root, 'encephalon', 'decision', `current-staging-${scenario}.json`)),
        false,
        scenario,
      )
      if (scenario === 'late-child') {
        assert.equal(injectedPath === undefined ? false : existsSync(injectedPath), true)
      } else {
        assert.equal(injectedPath === undefined ? undefined : readFileSync(injectedPath, 'utf8'), 'replacement bytes')
        assert.match(readFileSync(displacedStaging, 'utf8'), /"id": "current-staging-changed-bytes"/)
      }
    }
  })

  test('does not accept a canonical link substituted before descriptor verification', () => {
    const root = createRoot()
    const canonicalPath = join(root, 'encephalon', 'decision', 'canonical-link-substitution.json')
    const displaced = join(root, 'displaced-canonical-link')
    let replaced = false

    assertCommittedRepositoryChange(
      () =>
        addRecordResolved(
          root,
          {
            id: 'canonical-link-substitution',
            kind: 'decision',
            payload: {},
            source: 'agent',
            subject: 'staging.canonical-link-substitution',
          },
          {
            hooks: {
              fault: point => {
                if ((point as string) === 'after-canonical-link' && !replaced) {
                  replaced = true
                  renameSync(canonicalPath, displaced)
                  writeFileSync(canonicalPath, 'replacement')
                }
              },
            },
            hydrate: false,
          },
        ),
      'encephalon/decision/canonical-link-substitution.json',
      'canonical-link-substitution',
    )

    assert.equal(replaced, true)
    assert.equal(readFileSync(canonicalPath, 'utf8'), 'replacement')
    assert.match(readFileSync(displaced, 'utf8'), /"id": "canonical-link-substitution"/)
  })

  test('does not accept a canonical successor across final publication verification', () => {
    for (const point of ['after-publication', 'after-publication-accept'] as const) {
      const root = createRoot()
      const id = `final-canonical-substitution-${point}`
      const relativePath = `encephalon/decision/${id}.json`
      const canonicalPath = join(root, ...relativePath.split('/'))
      const displaced = join(root, `displaced-final-canonical-link-${point}`)

      assertCommittedRepositoryChange(
        () =>
          addRecordResolved(
            root,
            {
              id,
              kind: 'decision',
              payload: {},
              source: 'agent',
              subject: `staging.final-canonical-substitution.${point}`,
            },
            {
              hooks: {
                fault: actualPoint => {
                  if ((actualPoint as string) === point) {
                    renameSync(canonicalPath, displaced)
                    writeFileSync(canonicalPath, 'successor')
                  }
                },
              },
              hydrate: false,
            },
          ),
        relativePath,
        id,
      )

      assert.equal(readFileSync(canonicalPath, 'utf8'), 'successor')
      assert.match(readFileSync(displaced, 'utf8'), new RegExp(`"id": "${id}"`, 'u'))
    }
  })

  test('reports an operational final publication verification failure as committed I/O', () => {
    const root = createRoot()
    assertPostCommitError(
      () =>
        addRecordResolved(
          root,
          {
            id: 'final-publication-verification-io',
            kind: 'decision',
            payload: {},
            source: 'agent',
            subject: 'staging.final-verification-io',
          },
          {
            hooks: {
              fault: point => {
                if ((point as string) === 'after-publication-accept') {
                  throw Object.assign(new Error('injected verification I/O'), { code: 'EIO' })
                }
              },
            },
            hydrate: false,
          },
        ),
      {
        path: 'encephalon/decision/final-publication-verification-io.json',
        phase: 'publicationVerification',
        recordId: 'final-publication-verification-io',
      },
    )
  })

  test('reports operational final directory revalidation failure as committed I/O', () => {
    const root = createRoot()
    assertPostCommitError(
      () =>
        addRecordResolved(
          root,
          {
            id: 'final-directory-revalidation-io',
            kind: 'decision',
            payload: {},
            source: 'agent',
            subject: 'staging.final-directory-revalidation-io',
          },
          {
            hooks: {
              fault: point => {
                if ((point as string) === 'before-final-publication-revalidation') {
                  throw Object.assign(new Error('injected final directory revalidation I/O'), {
                    code: 'EIO',
                  })
                }
              },
            },
            hydrate: false,
          },
        ),
      {
        path: 'encephalon/decision/final-directory-revalidation-io.json',
        phase: 'publicationVerification',
        recordId: 'final-directory-revalidation-io',
      },
    )
  })

  test('classifies a staging entry disappearance without leaking its name', () => {
    for (const code of ['ENOENT', 'EIO'] as const) {
      const root = createRoot()
      const stagingDirectory = join(root, 'encephalon', '_staging')
      const stagingPath = join(stagingDirectory, ownedStagingName(0))
      mkdirSync(stagingDirectory, { recursive: true })
      writeFileSync(stagingPath, 'stale')
      let failure: unknown
      recordWriteTestHooks.fault = point => {
        if (point === 'before-staging-cleanup-entry-lstat') {
          if (code === 'ENOENT') {
            rmSync(stagingPath)
          } else {
            throw Object.assign(new Error('injected EIO'), { code })
          }
        }
      }

      try {
        api.addRecord({
          id: `staging-race-${code.toLowerCase()}`,
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: `staging.race.${code.toLowerCase()}`,
        })
      } catch (error) {
        failure = error
      }

      const typed = failure as { code?: unknown; details?: Record<string, unknown> }
      assert.equal(typed.code, code === 'EIO' ? 'IO_ERROR' : 'REPOSITORY_CHANGED', code)
      if (code !== 'EIO') {
        assert.deepEqual(typed.details, {
          action: 'Inspect the staging directory and retry.',
          path: 'encephalon/_staging',
        })
      }
      assert.equal(existsSync(join(root, 'encephalon', 'decision', `staging-race-${code.toLowerCase()}.json`)), false)
    }
  })

  test('reports a late staging child after linking as a committed repository change', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const latePath = join(stagingDirectory, 'late-after-link.tmp')
    let reachedPublication = false

    assertCommittedRepositoryChange(
      () =>
        addRecordResolved(
          root,
          {
            id: 'late-staging-after-link',
            kind: 'decision',
            payload: {},
            source: 'agent',
            subject: 'staging.late-after-link',
          },
          {
            hooks: {
              fault: point => {
                if ((point as string) === 'after-canonical-link') {
                  writeFileSync(latePath, 'late')
                } else if (point === 'after-publication') {
                  reachedPublication = true
                }
              },
            },
            hydrate: false,
          },
        ),
      'encephalon/decision/late-staging-after-link.json',
      'late-staging-after-link',
    )

    assert.equal(readFileSync(latePath, 'utf8'), 'late')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'late-staging-after-link.json')), true)
    assert.equal(reachedPublication, false)
  })

  test('does not accept a late child introduced during current-operation cleanup', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const latePath = join(stagingDirectory, 'late-during-current-cleanup.tmp')

    assertCommittedRepositoryChange(
      () =>
        addRecordResolved(
          root,
          {
            id: 'late-during-current-cleanup',
            kind: 'decision',
            payload: {},
            source: 'agent',
            subject: 'staging.late-during-current-cleanup',
          },
          {
            hooks: {
              fault: point => {
                if (point === 'before-staging-cleanup-empty-probe') {
                  writeFileSync(latePath, 'late')
                }
              },
            },
            hydrate: false,
          },
        ),
      'encephalon/decision/late-during-current-cleanup.json',
      'late-during-current-cleanup',
    )

    assert.equal(readFileSync(latePath, 'utf8'), 'late')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'late-during-current-cleanup.json')), true)
  })

  test('does not accept a late staging child after publication authority acceptance', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const latePath = join(stagingDirectory, 'late-after-publication-accept.tmp')

    assertCommittedRepositoryChange(
      () =>
        addRecordResolved(
          root,
          {
            id: 'late-after-publication-accept',
            kind: 'decision',
            payload: {},
            source: 'agent',
            subject: 'staging.late-after-publication-accept',
          },
          {
            hooks: {
              fault: point => {
                if (point === 'after-publication-accept') {
                  writeFileSync(latePath, 'late')
                }
              },
            },
            hydrate: false,
          },
        ),
      'encephalon/decision/late-after-publication-accept.json',
      'late-after-publication-accept',
    )

    assert.equal(readFileSync(latePath, 'utf8'), 'late')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'late-after-publication-accept.json')), true)
  })

  test('recovers a canonical crash-quarantine staging leftover', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const writerName = ownedStagingName(0)
    const quarantineName = `.${writerName}.550e8400-e29b-41d4-a716-446655440000.quarantine`
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(join(stagingDirectory, quarantineName), 'crash leftover')
    let recoveredQuarantineWriterName: string | undefined
    recordWriteTestHooks.fault = point => {
      if ((point as string) === 'after-staging-cleanup-quarantine' && recoveredQuarantineWriterName === undefined) {
        const [currentName] = readdirSync(stagingDirectory)
        assert.notEqual(currentName, undefined)
        if (currentName !== undefined) {
          const quarantine = stagingInternals.parseOwnedStagingQuarantineName(currentName)
          recoveredQuarantineWriterName = quarantine === undefined ? undefined : quarantine.writerName
        }
      }
    }

    api.addRecord({
      id: 'after-crash-quarantine',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'staging.after-crash-quarantine',
    })

    assert.deepEqual(readdirSync(stagingDirectory), [])
    assert.equal(recoveredQuarantineWriterName, writerName)
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'after-crash-quarantine.json')), true)
  })

  test('does not flush a staging-root replacement after cleanup', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    const displacedStaging = join(root, 'displaced-staging-flush')
    const successorSentinel = join(stagingDirectory, 'successor-sentinel')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(join(stagingDirectory, ownedStagingName(0)), 'stale')
    recordWriteTestHooks.fault = point => {
      if (point === 'during-staging-cleanup-flush') {
        renameSync(stagingDirectory, displacedStaging)
        mkdirSync(stagingDirectory)
        writeFileSync(successorSentinel, 'successor')
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'staging-cleanup-flush-replacement',
          kind: 'decision',
          payload: {},
          root,
          source: 'agent',
          subject: 'staging.cleanup-flush-replacement',
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(readFileSync(successorSentinel, 'utf8'), 'successor')
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'staging-cleanup-flush-replacement.json')), false)
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
    const counts = {
      canonicalScans: 0,
      diskCacheValidations: 0,
      graphValidations: 0,
    }
    mutationRecordWriteTestHooks.readHooks = {
      canonicalScan: () => {
        counts.canonicalScans += 1
      },
      graphValidation: () => {
        counts.graphValidations += 1
      },
    }
    cacheReadTestHooks.afterCanonicalValidation = () => {
      counts.diskCacheValidations += 1
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        cacheReadTestHooks.duringDatabaseInitialisation = undefined
        throw Object.assign(new Error('Injected hydration failure'), { code: 'EIO' })
      }
    }
    assertPostCommitError(
      () =>
        api.addRecord({
          id: 'hydration-failure',
          kind: 'decision',
          payload: { summary: 'Published' },
          root,
          source: 'agent',
          subject: 'hydration.failure',
        }),
      {
        path: 'encephalon/decision/hydration-failure.json',
        phase: 'cacheHydration',
        recordId: 'hydration-failure',
      },
    )

    assert.deepEqual(counts, {
      canonicalScans: 1,
      diskCacheValidations: 0,
      graphValidations: 1,
    })
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'hydration-failure.json')), true)
    cacheReadTestHooks.afterCanonicalValidation = undefined
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

  test('preserves operational artifact I/O during mutation-snapshot hydration', () => {
    const root = createRoot()
    const id = 'snapshot-artifact-io'
    const artifact = `_artifacts/decision/${id}/evidence.txt`
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, 'stable evidence')
    let matchingArtifactInspections = 0
    recordWriteTestHooks.fault = point => {
      if (point === 'during-hydration') {
        recordWriteTestHooks.fault = undefined
        artifactInspectionTestHooks.fault = (artifactPoint, path) => {
          if (artifactPoint === 'after-artifact-fstat' && path === artifact) {
            matchingArtifactInspections += 1
            throw Object.assign(new Error('Injected artifact I/O failure'), { code: 'EIO' })
          }
        }
      }
    }

    assertPostCommitError(
      () =>
        api.addRecord({
          artifacts: [artifact],
          id,
          kind: 'decision',
          payload: { summary: 'Published before artifact I/O' },
          root,
          source: 'agent',
          subject: 'snapshot.artifact-io',
        }),
      {
        path: `encephalon/decision/${id}.json`,
        phase: 'cacheHydration',
        recordId: id,
      },
    )

    assert.equal(matchingArtifactInspections, 1)
    artifactInspectionTestHooks.fault = undefined
    assert.deepEqual(api.prepare({ root }), { hydrated: true, recordsIndexed: 1 })
  })

  test('rebuilds from disk after committed publication failures', () => {
    const cases = [
      { id: 'verification-failure-disk-cache', phase: 'publicationVerification', point: 'after-publication-accept' },
      { id: 'cleanup-failure-disk-cache', phase: 'stagingCleanup', point: 'during-cleanup' },
    ] as const

    for (const entry of cases) {
      const root = createRoot()
      let diskCacheValidations = 0
      cacheReadTestHooks.afterCanonicalValidation = () => {
        diskCacheValidations += 1
      }
      recordWriteTestHooks.fault = point => {
        if (point === entry.point) {
          recordWriteTestHooks.fault = undefined
          throw Object.assign(new Error(`Injected ${entry.point}`), { code: 'EIO' })
        }
      }

      assertPostCommitError(
        () =>
          api.addRecord({
            id: entry.id,
            kind: 'decision',
            payload: { summary: 'Published before recovery' },
            root,
            source: 'agent',
            subject: `cache.${entry.id}`,
          }),
        {
          path: `encephalon/decision/${entry.id}.json`,
          phase: entry.phase,
          recordId: entry.id,
        },
      )

      assert.equal(diskCacheValidations, 1, entry.phase)
      cacheReadTestHooks.afterCanonicalValidation = undefined
      assert.deepEqual(api.prepare({ root }), { hydrated: false, recordsIndexed: 1 })
    }
  })

  test('reports publication flush failure after canonical publication as committed', () => {
    const root = createRoot()
    let writerInitialisations = 0
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }
    recordWriteTestHooks.fault = point => {
      if (point === 'during-publication-flush') {
        throw Object.assign(new Error('Injected directory flush failure'), {
          code: 'EIO',
        })
      }
    }
    assertPostCommitError(
      () =>
        api.addRecord({
          id: 'flush-failure',
          kind: 'decision',
          payload: { summary: 'Published' },
          root,
          source: 'agent',
          subject: 'flush.failure',
        }),
      {
        path: 'encephalon/decision/flush-failure.json',
        phase: 'publicationFlush',
        recordId: 'flush-failure',
      },
    )

    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'flush-failure.json')), true)
    assert.deepEqual(readdirSync(join(root, 'encephalon', '_staging')), [])
    assert.equal(writerInitialisations, 0)
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
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

  test('bounds graph work for a corpus-limit supersession chain', () => {
    const root = createRoot()
    for (const index of Array.from({ length: 1000 }, (_, value) => value)) {
      writeCanonicalRecord(root, {
        createdAt: timestampAt(index),
        id: `chain-${index}`,
        ...(index === 0
          ? {}
          : { supersedes: index === 999 ? [`chain-${index - 1}`, 'chain-0'] : [`chain-${index - 1}`] }),
      })
    }

    const work = new Map<string, number>()
    const result = validateRecordsResolved(root, {
      hooks: {
        onWork: operation => work.set(operation, (work.get(operation) ?? 0) + 1),
      },
    }) as { truncated?: boolean } & ReturnType<typeof api.validateRecords>
    assert.equal(result.valid, true)
    assert.equal(result.recordsChecked, 1000)
    assert.equal(result.errors.length, 0)
    assert.equal(result.truncated, false)
    assert.deepEqual(Object.fromEntries(work), {
      'active-group-write': 1,
      'canonical-entry': 1000,
      'cycle-edge': 1000,
      'duplicate-record': 1000,
      'edge-validation': 1000,
      'superseded-edge': 1000,
    })
  })

  test('preflights exact and overflowing planned kind directory entries', () => {
    const witnessedEntryCounts = new Map([
      ['context', 998],
      ['decision', 999],
    ])

    assert.equal(projectedKindDirectoryOverflow(witnessedEntryCounts, ['decision']), null)
    assert.equal(projectedKindDirectoryOverflow(witnessedEntryCounts, ['decision', 'decision']), 'decision')
    assert.equal(
      projectedKindDirectoryOverflow(witnessedEntryCounts, ['decision', 'context', 'context', 'context']),
      'context',
    )
  })

  test('reports corpus budget overflows deterministically', () => {
    const recordCountRoot = createRoot()
    for (const index of Array.from({ length: 1001 }, (_, value) => value)) {
      writeCanonicalRecord(recordCountRoot, {
        createdAt: timestampAt(index),
        id: `count-${index}`,
        ...(index === 1000 ? { kind: 'context' } : {}),
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
      id: 'edge-budget-at-maximum',
      supersedes: Array.from({ length: 1000 }, (_, index) => `missing-${index}`),
    })
    writeCanonicalRecord(edgeRoot, {
      createdAt: timestampAt(1),
      id: 'edge-budget-overflow',
      supersedes: ['one-more-missing-edge'],
    })
    let traversedOverflowEdges = 0
    const edgeResult = validateRecordsResolved(edgeRoot, {
      hooks: {
        onWork: operation => {
          if (operation === 'cycle-edge' || operation === 'edge-validation' || operation === 'superseded-edge') {
            traversedOverflowEdges += 1
          }
        },
      },
    })
    assert.equal(edgeResult.valid, false)
    assert.equal(edgeResult.errors[0]?.code, 'CORPUS_SUPERSEDES_LIMIT')
    assert.equal(traversedOverflowEdges, 0, 'supersession traversal continued after the edge budget failed')

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

  test('bounds canonical brain-root entries and kind directories before reporting layout details', () => {
    const rawEntryRoot = createRoot()
    const brainDirectory = join(rawEntryRoot, 'encephalon')
    mkdirSync(join(brainDirectory, '_artifacts'), { recursive: true })
    mkdirSync(join(brainDirectory, '_staging'))
    for (const index of Array.from({ length: 1001 }, (_, value) => value)) {
      mkdirSync(join(brainDirectory, `kind-${String(index).padStart(4, '0')}`))
    }

    const rawEntryResult = api.validateRecords({ root: rawEntryRoot })
    assert.deepEqual(rawEntryResult.errors, [
      {
        code: 'CORPUS_DIRECTORY_ENTRY_LIMIT',
        message: 'encephalon may contain at most 1002 directory entries.',
        path: 'encephalon',
      },
    ])
    assert.equal(rawEntryResult.recordsChecked, 0)
    assert.equal(rawEntryResult.truncated, false)

    const kindDirectoryRoot = createRoot()
    for (const index of Array.from({ length: 1001 }, (_, value) => value)) {
      mkdirSync(join(kindDirectoryRoot, 'encephalon', `kind-${String(index).padStart(4, '0')}`), {
        recursive: true,
      })
    }
    const kindDirectoryResult = api.validateRecords({ root: kindDirectoryRoot })
    assert.deepEqual(kindDirectoryResult.errors, [
      {
        code: 'CORPUS_DIRECTORY_ENTRY_LIMIT',
        message: 'encephalon may contain at most 1000 kind directories.',
        path: 'encephalon',
      },
    ])
  })

  test('accepts canonical directory limits exactly and rejects one excess kind entry without reading it', () => {
    const root = createRoot()
    const brainDirectory = join(root, 'encephalon')
    mkdirSync(join(brainDirectory, '_artifacts'), { recursive: true })
    mkdirSync(join(brainDirectory, '_staging'))
    for (const index of Array.from({ length: 999 }, (_, value) => value)) {
      mkdirSync(join(brainDirectory, `kind-${String(index).padStart(4, '0')}`))
    }
    writeCanonicalRecord(root, { id: 'first-boundary-record' })
    for (const index of Array.from({ length: 999 }, (_, value) => value)) {
      writeCanonicalRecord(root, {
        id: `boundary-${String(index).padStart(4, '0')}`,
        subject: `validation.boundary.${index}`,
      })
    }
    assert.equal(api.validateRecords({ root }).valid, true)

    writeFileSync(join(brainDirectory, 'decision', 'zzzz-excess-entry'), 'not JSON')
    const overflow = api.validateRecords({ root })
    assert.deepEqual(overflow.errors, [
      {
        code: 'CORPUS_DIRECTORY_ENTRY_LIMIT',
        message: 'encephalon/decision may contain at most 1000 directory entries.',
        path: 'encephalon/decision',
      },
    ])
    assert.equal(overflow.recordsChecked, 0)
  })

  test('rejects a candidate new kind before creating canonical or cache state', () => {
    const root = createRoot()
    for (const index of Array.from({ length: 1000 }, (_, value) => value)) {
      mkdirSync(join(root, 'encephalon', `kind-${String(index).padStart(4, '0')}`), {
        recursive: true,
      })
    }

    assertValidationFailureCode(
      () =>
        api.addRecord({
          id: 'new-kind-overflow',
          kind: 'new-kind',
          payload: {},
          root,
          source: 'test',
          subject: 'validation.new-kind-overflow',
        }),
      'CORPUS_DIRECTORY_ENTRY_LIMIT',
    )
    assert.equal(existsSync(join(root, 'encephalon', 'new-kind')), false)
    assert.equal(existsSync(join(root, 'encephalon', '_staging')), false)
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)

    assert.doesNotThrow(() =>
      api.addRecord({
        id: 'existing-kind-boundary',
        kind: 'kind-0000',
        payload: {},
        root,
        source: 'test',
        subject: 'validation.existing-kind-boundary',
      }),
    )
  })

  test('does not publish a superseding record into a replacement canonical generation', () => {
    const root = createRoot()
    writeCanonicalRecord(root, {
      id: 'predecessor',
      subject: 'generation.subject',
    })
    const kindDirectory = join(root, 'encephalon', 'decision')
    const displaced = join(root, 'predecessor-decision')
    let replaced = false
    recordWriteTestHooks.fault = point => {
      if (point === 'after-scan-validation' && !replaced) {
        replaced = true
        renameSync(kindDirectory, displaced)
        writeCanonicalRecord(root, {
          id: 'successor-head',
          subject: 'generation.subject',
        })
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'candidate',
          kind: 'decision',
          payload: {},
          root,
          source: 'test',
          subject: 'generation.subject',
          supersedes: ['predecessor'],
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(replaced, true)
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'candidate.json')), false)
    assert.equal(existsSync(join(root, 'encephalon', '_staging')), false)
  })

  test('rejects an existing canonical root replacement before directory preparation', () => {
    const root = createRoot()
    writeCanonicalRecord(root, { id: 'existing-root-before-preparation' })
    const brainDirectory = join(root, 'encephalon')
    let replaced = false

    assertErrorCode(
      () =>
        addRecordResolved(
          root,
          {
            id: 'candidate-root-before-preparation',
            kind: 'decision',
            payload: {},
            source: 'test',
            subject: 'generation.root-before-preparation',
          },
          {
            hooks: {
              fault: point => {
                if (point === 'before-directory-preparation' && !replaced) {
                  replaced = true
                  renameSync(brainDirectory, join(root, 'displaced-encephalon-before-preparation'))
                  mkdirSync(join(brainDirectory, 'decision'), { recursive: true })
                }
              },
            },
            hydrate: false,
          },
        ),
      'REPOSITORY_CHANGED',
    )
    assert.equal(replaced, true)
    assert.equal(existsSync(join(brainDirectory, 'decision', 'candidate-root-before-preparation.json')), false)
    assert.equal(existsSync(join(brainDirectory, '_staging')), false)
  })

  test('rejects an existing canonical kind replacement before directory preparation', () => {
    const root = createRoot()
    writeCanonicalRecord(root, { id: 'existing-kind-before-preparation' })
    const kindDirectory = join(root, 'encephalon', 'decision')
    let replaced = false

    assertErrorCode(
      () =>
        addRecordResolved(
          root,
          {
            id: 'candidate-kind-before-preparation',
            kind: 'decision',
            payload: {},
            source: 'test',
            subject: 'generation.kind-before-preparation',
          },
          {
            hooks: {
              fault: point => {
                if (point === 'before-directory-preparation' && !replaced) {
                  replaced = true
                  renameSync(kindDirectory, join(root, 'displaced-decision-before-preparation'))
                  mkdirSync(kindDirectory)
                }
              },
            },
            hydrate: false,
          },
        ),
      'REPOSITORY_CHANGED',
    )
    assert.equal(replaced, true)
    assert.equal(existsSync(join(kindDirectory, 'candidate-kind-before-preparation.json')), false)
    assert.equal(existsSync(join(root, 'encephalon', '_staging')), false)
  })

  test('does not publish after the validated kind is replaced at the publication boundary', () => {
    const root = createRoot()
    writeCanonicalRecord(root, { id: 'existing' })
    const kindDirectory = join(root, 'encephalon', 'decision')
    const displaced = join(root, 'displaced-decision-before-publication')
    let replaced = false
    recordWriteTestHooks.fault = point => {
      if (point === 'before-publication' && !replaced) {
        replaced = true
        renameSync(kindDirectory, displaced)
        mkdirSync(kindDirectory)
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'candidate-before-publication',
          kind: 'decision',
          payload: {},
          root,
          source: 'test',
          subject: 'generation.publication',
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(replaced, true)
    assert.equal(existsSync(join(kindDirectory, 'candidate-before-publication.json')), false)
  })

  test('reports a canonical generation replacement after linking as a committed repository change', () => {
    const root = createRoot()
    writeCanonicalRecord(root, { id: 'existing-after-publication' })
    const kindDirectory = join(root, 'encephalon', 'decision')
    const displaced = join(root, 'displaced-decision-after-publication')
    let replaced = false

    assertCommittedRepositoryChange(
      () =>
        addRecordResolved(
          root,
          {
            id: 'candidate-after-publication',
            kind: 'decision',
            payload: {},
            source: 'test',
            subject: 'generation.after-publication',
          },
          {
            hooks: {
              fault: point => {
                if (point === 'after-publication' && !replaced) {
                  replaced = true
                  renameSync(kindDirectory, displaced)
                  mkdirSync(kindDirectory)
                }
              },
            },
            hydrate: false,
          },
        ),
      'encephalon/decision/candidate-after-publication.json',
      'candidate-after-publication',
    )
    assert.equal(replaced, true)
    assert.equal(existsSync(join(kindDirectory, 'candidate-after-publication.json')), false)
    assert.equal(existsSync(join(displaced, 'candidate-after-publication.json')), true)
  })

  test('does not adopt a candidate kind created at the directory preparation boundary', () => {
    const root = createRoot()
    let created = false
    recordWriteTestHooks.fault = point => {
      if (point === 'before-directory-preparation' && !created) {
        created = true
        mkdirSync(join(root, 'encephalon', 'new-kind'), { recursive: true })
      }
    }

    assertErrorCode(
      () =>
        api.addRecord({
          id: 'candidate-kind-race',
          kind: 'new-kind',
          payload: {},
          root,
          source: 'test',
          subject: 'generation.kind-race',
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(created, true)
    assert.deepEqual(readdirSync(join(root, 'encephalon', 'new-kind')), [])
    assert.equal(existsSync(join(root, 'encephalon', '_staging')), false)
  })

  test('enforces supersedes count before item validation and repository access', () => {
    const validSupersedes = Array.from({ length: 1000 }, (_, index) => `superseded-${index}`)
    const candidate = {
      id: 'supersedes-boundary-candidate',
      kind: 'decision',
      payload: {},
      source: 'test',
      subject: 'validation.supersedes-boundary',
      supersedes: validSupersedes,
    }
    assert.equal(validateAddRecordInput(candidate).supersedes?.length, 1000)
    assert.equal(parseRecordFile({ ...candidate, createdAt: timestampAt(0) }).supersedes?.length, 1000)

    const root = createRoot()
    const oversizedSupersedes = ['not a valid supersedes id', ...validSupersedes]
    let repositoryHookCalls = 0
    repositoryTestHooks.afterGitMarkerDecision = () => {
      repositoryHookCalls += 1
    }
    const assertSupersedesBudget = (operation: () => unknown) => {
      assert.throws(operation, (error: unknown) => {
        const actual = error as { code?: unknown; details?: unknown; message?: unknown }
        assert.equal(actual.code, 'INVALID_ARGUMENT')
        assert.deepEqual(actual.details, {
          budget: 'supersessionEdges',
          field: 'supersedes',
          maximum: 1000,
        })
        const exposed = JSON.stringify({ details: actual.details, message: actual.message })
        assert.equal(
          oversizedSupersedes.some(entry => exposed.includes(entry)),
          false,
        )
        return true
      })
    }

    assertSupersedesBudget(() =>
      parseRecordFile({ ...candidate, createdAt: timestampAt(0), supersedes: oversizedSupersedes }),
    )
    assertSupersedesBudget(() => api.addRecord({ ...candidate, root, supersedes: oversizedSupersedes }))
    assert.equal(repositoryHookCalls, 0)
    assert.equal(existsSync(join(root, 'encephalon')), false)
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon')), false)
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
    const reservedArtifactNames = [
      'con',
      'CON',
      'CoN.txt',
      'prn',
      'AUX.md',
      'nul',
      'COM1',
      'com9.log',
      'LPT1',
      'lpt9.txt',
      'COM¹',
      'com².txt',
      'CoM³.log',
      'LPT¹',
      'lpt².txt',
      'LpT³.log',
    ]
    for (const artifactName of reservedArtifactNames) {
      assertErrorCode(
        () =>
          api.addRecord({
            artifacts: [`_artifacts/decision/record-safe/${artifactName}`],
            id: 'record-safe',
            kind: 'decision',
            payload: {},
            root,
            source: 'agent',
            subject: 'x',
          }),
        'INVALID_ARGUMENT',
      )
    }
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

    const payloadArray = ['value'] as string[] & { metadata?: string }
    Object.defineProperty(payloadArray, 'metadata', {
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
          payload: payloadArray,
          root,
          source: 'agent',
          subject: 'payload.array-accessor',
        }),
      'INVALID_ARGUMENT',
    )
    assert.equal(getterCalls, 0)
  })

  test('returns stable invalid argument errors for hostile payload descriptors', () => {
    const root = createRoot()
    const hostilePayloads: Array<{ message: string; payload: unknown; secret?: string }> = [
      {
        message: 'payload object descriptors could not be inspected.',
        payload: new Proxy(
          { summary: 'Hidden' },
          {
            getOwnPropertyDescriptor: () => {
              throw new Error('PRIVATE_DESCRIPTOR_TRAP')
            },
          },
        ),
        secret: 'PRIVATE_DESCRIPTOR_TRAP',
      },
      {
        message: 'payload object descriptors could not be inspected.',
        payload: new Proxy(
          { summary: 'Hidden' },
          {
            ownKeys: () => {
              throw new Error('PRIVATE_OWN_KEYS_TRAP')
            },
          },
        ),
        secret: 'PRIVATE_OWN_KEYS_TRAP',
      },
      {
        message: 'payload object metadata could not be inspected.',
        payload: new Proxy(
          { summary: 'Hidden' },
          {
            getPrototypeOf: () => {
              throw new Error('PRIVATE_PROTOTYPE_TRAP')
            },
          },
        ),
        secret: 'PRIVATE_PROTOTYPE_TRAP',
      },
      {
        message: 'payload object descriptors could not be inspected.',
        payload: new Proxy(
          {},
          {
            ownKeys: () => ['duplicate', 'duplicate'],
          },
        ),
      },
    ]

    for (const { message, payload, secret } of hostilePayloads) {
      assert.throws(
        () =>
          api.addRecord({
            kind: 'decision',
            payload: payload as never,
            root,
            source: 'agent',
            subject: 'payload.proxy',
          }),
        (error: unknown) => {
          const actual = error as {
            cause?: unknown
            code?: unknown
            details?: unknown
            message?: unknown
            name?: unknown
          }
          assert.equal(actual.name, 'EncephalonError')
          assert.equal(actual.code, 'INVALID_ARGUMENT')
          assert.equal(actual.message, message)
          assert.deepEqual(actual.details, { field: 'payload' })
          assert.equal(actual.cause, undefined)
          if (secret !== undefined) {
            assert.equal(JSON.stringify({ details: actual.details, message: actual.message }).includes(secret), false)
          }
          return true
        },
      )
    }
  })

  test('rejects oversized arrays and revoked proxies at the guarded metadata boundary', () => {
    const oversizedArrayCalls: string[] = []
    const oversizedArray = new Proxy(new Array(2 ** 32 - 1), {
      getOwnPropertyDescriptor: (target, key) => {
        oversizedArrayCalls.push(`descriptor:${String(key)}`)
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      ownKeys: target => {
        oversizedArrayCalls.push('ownKeys')
        throw new Error(`oversized ownKeys must not run for ${Reflect.ownKeys(target).length} keys`)
      },
    })

    assert.throws(
      () => validateJsonValue(oversizedArray),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: unknown; message?: unknown }
        assert.equal(actual.code, 'INVALID_ARGUMENT')
        assert.equal(actual.message, 'payload may contain at most 10000 JSON nodes.')
        assert.deepEqual(actual.details, { field: 'payload' })
        return true
      },
    )
    assert.deepEqual(oversizedArrayCalls, ['descriptor:length'])

    const invalidLengthDescriptor = (target: unknown[], key: PropertyKey) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
      return key === 'length' && descriptor !== undefined ? { ...descriptor, value: -1 } : descriptor
    }
    const symbolArray: unknown[] = []
    Object.defineProperty(symbolArray, Symbol('metadata'), { value: null })
    const accessorArray: unknown[] = []
    Object.defineProperty(accessorArray, 'metadata', {
      get: () => {
        throw new Error('accessor must not run')
      },
    })
    const invalidLengthCases = [
      {
        message: 'payload contains a symbol-keyed property.',
        payload: new Proxy(symbolArray, { getOwnPropertyDescriptor: invalidLengthDescriptor }),
      },
      {
        message: 'payload contains an accessor property.',
        payload: new Proxy(accessorArray, { getOwnPropertyDescriptor: invalidLengthDescriptor }),
      },
      {
        message: 'payload object descriptors could not be inspected.',
        payload: new Proxy([], {
          getOwnPropertyDescriptor: invalidLengthDescriptor,
          ownKeys: () => {
            throw new Error('invalid-length ownKeys trap must remain classified')
          },
        }),
      },
    ]
    for (const { message, payload } of invalidLengthCases) {
      assert.throws(
        () => validateJsonValue(payload),
        (error: unknown) => {
          const actual = error as { code?: unknown; details?: unknown; message?: unknown }
          assert.equal(actual.code, 'INVALID_ARGUMENT')
          assert.equal(actual.message, message)
          assert.deepEqual(actual.details, { field: 'payload' })
          return true
        },
      )
    }

    for (const target of [{}, []]) {
      const { proxy, revoke } = Proxy.revocable(target, {})
      revoke()
      assert.throws(
        () => validateJsonValue(proxy),
        (error: unknown) => {
          const actual = error as { code?: unknown; details?: unknown; message?: unknown }
          assert.equal(actual.code, 'INVALID_ARGUMENT')
          assert.equal(actual.message, 'payload object metadata could not be inspected.')
          assert.deepEqual(actual.details, { field: 'payload' })
          return true
        },
      )
    }
  })

  test('bounds payload depth and total node count', () => {
    const root = createRoot()
    const buildNestedPayload = (depth: number) =>
      Array.from({ length: depth }).reduce<unknown>(payload => ({ child: payload }), null)
    const buildWidePayload = (properties: number) =>
      Object.fromEntries(Array.from({ length: properties }, (_, index) => [`k${index}`, null]))

    const assertCanonicalBoundary = (id: string, payload: unknown, bytes: number, digest: string) => {
      const formatted = formatRecordFile(
        parseRecordFile({
          createdAt: '2026-01-01T00:00:00.000Z',
          id,
          kind: 'decision',
          payload,
          source: 'test',
          subject: `payload.${id}`,
        }),
      )
      assert.equal(Buffer.byteLength(formatted), bytes)
      assert.equal(createHash('sha256').update(formatted).digest('hex'), digest)
    }

    const deepestPayload = buildNestedPayload(64)
    assertCanonicalBoundary(
      'boundary-depth',
      deepestPayload,
      9452,
      '6a04ae78319ead1fedec08327013931bad08971794db94d1dc22c916dbad1ac0',
    )
    const deepestValid = api.addRecord({
      id: 'payload-depth-limit',
      kind: 'decision',
      payload: deepestPayload as never,
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

    const widestPayload = buildWidePayload(MAX_PAYLOAD_NODES - 1)
    assertCanonicalBoundary(
      'boundary-width',
      widestPayload,
      189_043,
      '098091eb7228eb18c8fad2c45150d5afdacc865db010f2a2c099419b84e31b7e',
    )
    const widestValid = api.addRecord({
      id: 'payload-node-limit',
      kind: 'decision',
      payload: widestPayload,
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

    const widestArray = Array.from({ length: MAX_PAYLOAD_NODES - 1 }, () => null)
    const validatedArray = validateJsonValue(widestArray)
    assert.ok(Array.isArray(validatedArray))
    assert.equal(validatedArray.length, MAX_PAYLOAD_NODES - 1)

    assert.throws(
      () => validateJsonValue(Array.from({ length: MAX_PAYLOAD_NODES }, () => null)),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: unknown; message?: unknown }
        assert.equal(actual.code, 'INVALID_ARGUMENT')
        assert.equal(actual.message, 'payload may contain at most 10000 JSON nodes.')
        assert.deepEqual(actual.details, { field: 'payload' })
        return true
      },
    )
  })

  test('bounds wide-object descriptor work before child traversal', () => {
    const validatePayload = (payload: unknown) =>
      validateAddRecordInput({
        kind: 'decision',
        payload: payload as never,
        source: 'agent',
        subject: 'payload.descriptor-budget',
      }).payload

    const wideObjectCalls = { descriptors: 0, ownKeys: 0 }
    let childVisits = 0
    const child = new Proxy(
      {},
      {
        getPrototypeOf: target => {
          childVisits += 1
          return Reflect.getPrototypeOf(target)
        },
      },
    )
    const wideObjectTarget: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: MAX_PAYLOAD_NODES }, (_, index) => [`k${index}`, null]),
    )
    wideObjectTarget.k0 = child
    const wideObject = new Proxy(wideObjectTarget, {
      getOwnPropertyDescriptor: (target, key) => {
        wideObjectCalls.descriptors += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      ownKeys: target => {
        wideObjectCalls.ownKeys += 1
        return Reflect.ownKeys(target)
      },
    })
    const allocationWork = {
      'payload-output-container': 0,
      'payload-retained-value': 0,
    }
    assert.throws(
      () =>
        validateJsonValue(wideObject, {
          onWork: operation => {
            allocationWork[operation] += 1
          },
        }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: unknown; message?: unknown }
        assert.equal(actual.code, 'INVALID_ARGUMENT')
        assert.equal(actual.message, 'payload may contain at most 10000 JSON nodes.')
        assert.deepEqual(actual.details, { field: 'payload' })
        return true
      },
    )
    assert.deepEqual(wideObjectCalls, { descriptors: MAX_PAYLOAD_NODES, ownKeys: 1 })
    assert.deepEqual(allocationWork, {
      'payload-output-container': 0,
      'payload-retained-value': MAX_PAYLOAD_NODES - 1,
    })
    assert.equal(childVisits, 0)

    const overBudgetAccessorTarget = Object.fromEntries(
      Array.from({ length: MAX_PAYLOAD_NODES }, (_, index) => [`k${index}`, null]),
    )
    Object.defineProperty(overBudgetAccessorTarget, 'laterAccessor', {
      enumerable: true,
      get: () => {
        throw new Error('accessor must not run')
      },
    })
    assert.throws(
      () => validatePayload(overBudgetAccessorTarget),
      (error: unknown) => {
        assert.equal((error as { message?: unknown }).message, 'payload contains an accessor property.')
        return true
      },
    )

    const boundaryObjectCalls = { descriptors: 0, ownKeys: 0 }
    const boundaryObject = new Proxy(
      Object.fromEntries(Array.from({ length: MAX_PAYLOAD_NODES - 1 }, (_, index) => [`k${index}`, null])),
      {
        getOwnPropertyDescriptor: (target, key) => {
          boundaryObjectCalls.descriptors += 1
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
        ownKeys: target => {
          boundaryObjectCalls.ownKeys += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    const boundaryResult = validatePayload(boundaryObject)
    assert.equal(Object.keys(boundaryResult as Record<string, unknown>).length, MAX_PAYLOAD_NODES - 1)
    assert.deepEqual(boundaryObjectCalls, { descriptors: MAX_PAYLOAD_NODES - 1, ownKeys: 1 })

    const hiddenWideTarget = { summary: 'Hidden properties do not consume the JSON-node budget' }
    for (let index = 0; index < MAX_PAYLOAD_NODES; index += 1) {
      Object.defineProperty(hiddenWideTarget, `hidden${index}`, { value: null })
    }
    assert.deepEqual(validatePayload(hiddenWideTarget), {
      summary: 'Hidden properties do not consume the JSON-node budget',
    })
  })

  test('inspects accepted arrays once and preserves numeric traversal order', () => {
    const validatePayload = (payload: unknown) =>
      validateAddRecordInput({
        kind: 'decision',
        payload: payload as never,
        source: 'agent',
        subject: 'payload.descriptor-order',
      }).payload

    const acceptedArrayCalls = { descriptors: [] as string[], ownKeys: 0 }
    const acceptedArrayTarget = ['first', 'second'] as string[] & { metadata?: string }
    acceptedArrayTarget.metadata = 'ignored'
    const acceptedArray = new Proxy(acceptedArrayTarget, {
      getOwnPropertyDescriptor: (target, key) => {
        acceptedArrayCalls.descriptors.push(String(key))
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      ownKeys: target => {
        acceptedArrayCalls.ownKeys += 1
        return Reflect.ownKeys(target)
      },
    })
    assert.deepEqual(validatePayload(acceptedArray), ['first', 'second'])
    assert.deepEqual(acceptedArrayCalls, {
      descriptors: ['length', '0', '1', 'metadata'],
      ownKeys: 1,
    })

    const reorderedArray = new Proxy([() => undefined, Symbol('later invalid value')], {
      ownKeys: () => ['1', '0', 'length'],
    })
    assert.throws(
      () => validatePayload(reorderedArray),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: unknown; message?: unknown }
        assert.equal(actual.code, 'INVALID_ARGUMENT')
        assert.equal(actual.message, 'payload contains a value that is not JSON serializable.')
        assert.deepEqual(actual.details, { field: 'payload[0]' })
        return true
      },
    )

    const reorderedObject = new Proxy(
      { 0: () => undefined, 1: Symbol('later invalid value') },
      {
        ownKeys: () => ['1', '0'],
      },
    )
    assert.throws(
      () => validatePayload(reorderedObject),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: unknown; message?: unknown }
        assert.equal(actual.code, 'INVALID_ARGUMENT')
        assert.equal(actual.message, 'payload contains a value that is not JSON serializable.')
        assert.deepEqual(actual.details, { field: 'payload.0' })
        return true
      },
    )
  })

  test('preserves canonical bytes for valid descriptor-safe payloads', () => {
    const shared = Object.create(null) as Record<string, unknown>
    shared.value = -0
    Object.defineProperty(shared, 'hidden', { value: 'ignored' })

    const list = ['first', 'second'] as string[] & { metadata?: string }
    Object.defineProperty(list, 'metadata', {
      enumerable: true,
      value: 'ignored',
    })
    const payload = new Proxy(
      {
        0: 'zero',
        1: 'one',
        alpha: 'A',
        beta: 'B',
        left: shared,
        list,
        right: shared,
      },
      {
        ownKeys: () => ['right', '1', 'alpha', 'list', '0', 'left', 'beta'],
      },
    )

    const formatted = formatRecordFile(
      parseRecordFile({
        createdAt: '2026-01-01T00:00:00.000Z',
        id: 'payload-compat',
        kind: 'decision',
        payload,
        source: 'test',
        subject: 'payload.compat',
      }),
    )
    assert.equal(
      formatted,
      `{
  "createdAt": "2026-01-01T00:00:00.000Z",
  "id": "payload-compat",
  "kind": "decision",
  "payload": {
    "0": "zero",
    "1": "one",
    "right": {
      "value": 0
    },
    "alpha": "A",
    "list": [
      "first",
      "second"
    ],
    "left": {
      "value": 0
    },
    "beta": "B"
  },
  "source": "test",
  "subject": "payload.compat"
}
`,
    )

    const root = createRoot()
    const publicRecord = api.addRecord({
      id: 'payload-compat-public',
      kind: 'decision',
      payload: payload as never,
      root,
      source: 'test',
      subject: 'payload.compat.public',
    })
    const expectedPublicRecord = parseRecordFile({
      createdAt: publicRecord.createdAt,
      id: 'payload-compat-public',
      kind: 'decision',
      payload,
      source: 'test',
      subject: 'payload.compat.public',
    })
    assert.deepEqual(publicRecord.payload, expectedPublicRecord.payload)
    assert.equal(readFileSync(join(root, publicRecord.path), 'utf8'), formatRecordFile(expectedPublicRecord))
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
    const persisted = JSON.parse(readFileSync(join(root, record.path), 'utf8')) as {
      payload: { value: number }
    }
    assert.equal(Object.is(persisted.payload.value, 0), true)
    assert.deepEqual(record.payload, persisted.payload)
  })

  test('normalizes negative-zero confidence across validation, publication, and cache reads', () => {
    const candidate = {
      confidence: -0,
      id: 'confidence-negative-zero',
      kind: 'decision',
      payload: { summary: 'Canonical confidence' },
      searchText: 'canonical confidence value',
      source: 'agent',
      subject: 'confidence.negative-zero',
    }
    const validated = validateAddRecordInput(candidate)
    const parsed = parseRecordFile({ ...candidate, createdAt: timestampAt(0) })
    assert.equal(Object.is(validated.confidence, 0), true)
    assert.equal(Object.is(parsed.confidence, 0), true)

    for (const confidence of [0, 0.375, 1]) {
      assert.equal(validateAddRecordInput({ ...candidate, confidence }).confidence, confidence)
    }
    for (const confidence of [-Number.MIN_VALUE, 1 + Number.EPSILON, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => validateAddRecordInput({ ...candidate, confidence }),
        (error: unknown) => {
          const actual = error as { code?: unknown; details?: unknown; message?: unknown }
          assert.equal(actual.code, 'INVALID_ARGUMENT')
          assert.equal(actual.message, 'confidence must be a finite number between 0 and 1.')
          assert.deepEqual(actual.details, { field: 'confidence' })
          return true
        },
      )
    }

    const root = createRoot()
    const added = api.addRecord({ ...candidate, root })
    assert.equal(Object.is(added.confidence, 0), true)

    const persistedBytes = readFileSync(join(root, added.path), 'utf8')
    assert.match(persistedBytes, /^ {2}"confidence": 0,$/mu)
    assert.doesNotMatch(persistedBytes, /^ {2}"confidence": -0,$/mu)
    const persisted = JSON.parse(persistedBytes) as { confidence: number }
    assert.equal(Object.is(persisted.confidence, 0), true)
    assert.equal(added.confidence, persisted.confidence)

    const assertCachedConfidence = (records: Array<BrainRecord | null | undefined>) => {
      for (const record of records) {
        assert.ok(record)
        assert.equal(Object.is(record.confidence, 0), true)
        assert.equal(record.confidence, added.confidence)
      }
    }
    assertCachedConfidence([
      api.showRecord({ id: added.id, root }),
      api.listRecords({ root }).find(record => record.id === added.id),
      api.searchRecords({ query: 'canonical confidence', root }).find(record => record.id === added.id),
    ])

    const existingId = 'confidence-negative-zero-existing'
    const existingPath = join(root, 'encephalon', 'decision', `${existingId}.json`)
    const existingBytes = `{
  "confidence": -0,
  "createdAt": "${timestampAt(1)}",
  "id": "${existingId}",
  "kind": "decision",
  "payload": {
    "summary": "Existing negative-zero confidence"
  },
  "searchText": "existing negative-zero confidence value",
  "source": "agent",
  "subject": "confidence.negative-zero-existing"
}\n`
    writeFileSync(existingPath, existingBytes)

    api.hydrate({ root })
    assert.equal(readFileSync(existingPath, 'utf8'), existingBytes)
    assertCachedConfidence([
      api.showRecord({ id: added.id, root }),
      api.listRecords({ root }).find(record => record.id === added.id),
      api.searchRecords({ query: 'canonical confidence', root }).find(record => record.id === added.id),
      api.showRecord({ id: existingId, root }),
      api.listRecords({ root }).find(record => record.id === existingId),
      api.searchRecords({ query: 'existing negative-zero', root }).find(record => record.id === existingId),
    ])
  })

  test('enforces portable artifact path component lengths', () => {
    const root = createRoot()
    const validComponent = 'a'.repeat(255)
    const validArtifact = `_artifacts/decision/record-safe/${validComponent}`
    const validArtifactPath = join(root, 'encephalon', ...validArtifact.split('/'))
    ensureParent(validArtifactPath)
    writeFileSync(validArtifactPath, 'artifact')

    const record = api.addRecord({
      artifacts: [validArtifact],
      id: 'record-safe',
      kind: 'decision',
      payload: {},
      root,
      source: 'agent',
      subject: 'component.length',
    })
    assert.deepEqual(record.artifacts, [validArtifact])

    for (const artifactName of ['a'.repeat(256), 'é'.repeat(128)]) {
      assertErrorCode(
        () =>
          api.addRecord({
            artifacts: [`_artifacts/decision/too-long/${artifactName}`],
            id: 'too-long',
            kind: 'decision',
            payload: {},
            root,
            source: 'agent',
            subject: 'component.length',
          }),
        'INVALID_ARGUMENT',
      )
    }
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

  test('rejects a brain-root generation replaced after bounded enumeration', () => {
    const root = createRoot()
    const brainDirectory = join(root, 'encephalon')
    const displaced = join(root, 'displaced-encephalon')
    const replacement = join(root, 'replacement-encephalon')
    mkdirSync(brainDirectory)
    mkdirSync(replacement)
    writeFileSync(join(replacement, 'outside-sentinel'), 'outside')

    const result = validateRecordsResolved(root, {
      hooks: {
        afterBrainRootEnumeration: () => {
          renameSync(brainDirectory, displaced)
          renameSync(replacement, brainDirectory)
        },
      },
    })

    assert.equal(result.valid, false)
    assert.deepEqual(
      result.errors.map(error => [error.code, error.path]),
      [['INVALID_RECORD_LAYOUT', 'encephalon']],
    )
    assert.equal(readFileSync(join(brainDirectory, 'outside-sentinel'), 'utf8'), 'outside')
  })

  test('rejects an empty kind generation replaced after bounded enumeration', () => {
    const root = createRoot()
    const kindDirectory = join(root, 'encephalon', 'decision')
    const displaced = join(root, 'displaced-decision')
    mkdirSync(kindDirectory, { recursive: true })

    const result = validateRecordsResolved(root, {
      hooks: {
        afterKindEnumeration: path => {
          if (path === kindDirectory) {
            renameSync(kindDirectory, displaced)
            mkdirSync(kindDirectory)
          }
        },
      },
    })

    assert.equal(result.valid, false)
    assert.deepEqual(
      result.errors.map(error => [error.code, error.path]),
      [['INVALID_RECORD_LAYOUT', 'encephalon/decision']],
    )
  })

  test('revalidates an empty kind generation at final scan acceptance', () => {
    const root = createRoot()
    const kindDirectory = join(root, 'encephalon', 'decision')
    const displaced = join(root, 'displaced-decision-final-validation')
    mkdirSync(kindDirectory, { recursive: true })

    const result = validateRecordsResolved(root, {
      hooks: {
        beforeFinalWitnessValidation: () => {
          renameSync(kindDirectory, displaced)
          mkdirSync(kindDirectory)
        },
      },
    })

    assert.equal(result.valid, false)
    assert.deepEqual(
      result.errors.map(error => [error.code, error.path]),
      [['INVALID_RECORD_LAYOUT', 'encephalon/decision']],
    )
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
