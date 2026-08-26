import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'

import { dirname, join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { artifactInspectionTestHooks } from '../src/artifact-inspection.ts'
import { scanBaseline, scanBaselineWithHooks } from '../src/baseline.ts'
import { cacheReadTestHooks } from '../src/cache.ts'
import { DirectoryWitnessError } from '../src/directory-witness.ts'
import { EncephalonError } from '../src/errors.ts'
import * as api from '../src/index.ts'
import { initEncephalonWithHooks } from '../src/init.ts'
import { applyInstructionChanges, planInstructionChanges } from '../src/instructions.ts'
import { ordinalStringCompare } from '../src/order.ts'
import { MAX_CANONICAL_RECORD_BYTES, type RecordWriteHooks } from '../src/records.ts'
import { validateAddRecordInput } from '../src/schema.ts'
import { createOwnedStagingName } from '../src/staging.ts'
import type { BrainRecord, BrainRecordFile } from '../src/types.ts'
import {
  canRenameParentWithOpenChild,
  createTestRepository,
  ensureParent,
  removeTestRepository,
} from '../test/helpers.ts'

const roots: string[] = []
const unreadableDirectorySkip =
  process.platform === 'win32' || process.getuid?.() === 0
    ? 'Windows permission handling differs or root bypasses POSIX directory permissions.'
    : false
const caseProbeRoot = createTestRepository()
const caseDistinctNamesSupported = (() => {
  const lower = join(caseProbeRoot, 'private-case-probe')
  const upper = join(caseProbeRoot, 'PRIVATE-case-probe')
  writeFileSync(lower, '')
  writeFileSync(upper, '')
  return readdirSync(caseProbeRoot).filter(entry => entry.toLowerCase() === 'private-case-probe').length === 2
})()
removeTestRepository(caseProbeRoot)
const caseInsensitiveSkip = caseDistinctNamesSupported ? 'Requires a case-insensitive file system.' : false
const caseSensitiveSkip = caseDistinctNamesSupported ? false : 'Requires a case-sensitive file system.'
const readOnlyProbeRoot = createTestRepository()
const readOnlyProbePath = join(readOnlyProbeRoot, 'read-only-probe')
writeFileSync(readOnlyProbePath, 'probe')
chmodSync(readOnlyProbePath, 0o444)
const readOnlyHoldSkip = (() => {
  try {
    const descriptor = openSync(readOnlyProbePath, 'r+')
    closeSync(descriptor)
    return 'The current filesystem does not enforce readable-but-not-writable mode bits.'
  } catch {
    return false
  }
})()
removeTestRepository(readOnlyProbeRoot)
const renameParentWithOpenChildSkip = canRenameParentWithOpenChild()
  ? false
  : 'The filesystem does not allow replacing a parent while a child descriptor is open.'

const generatedPayload = (records: readonly { payload: unknown; subject: string }[], subject: string) => {
  const payload = records.find(record => record.subject === subject)?.payload
  assert.equal(payload !== null && typeof payload === 'object' && !Array.isArray(payload), true)
  return payload as Record<string, unknown>
}

const assertPackageMetadataErrorReasons = (value: unknown) => {
  assert.ok(Array.isArray(value))
  assert.deepEqual(
    value,
    value.includes('unreadable-directory')
      ? ['package-metadata-error', 'unreadable-directory']
      : ['package-metadata-error'],
  )
}

type InitCounts = {
  baselineScans: number
  canonicalScans: number
  diskCacheValidations: number
  graphValidations: number
  hydrations: number
}

type InitFaultPoint = Parameters<NonNullable<RecordWriteHooks['fault']>>[0]

const initWithCounts = (
  input: Parameters<typeof initEncephalonWithHooks>[0],
  fault?: (point: InitFaultPoint) => void,
) => {
  const counts: InitCounts = {
    baselineScans: 0,
    canonicalScans: 0,
    diskCacheValidations: 0,
    graphValidations: 0,
    hydrations: 0,
  }
  cacheReadTestHooks.afterCanonicalValidation = () => {
    counts.diskCacheValidations += 1
  }
  try {
    const result = initEncephalonWithHooks(input, {
      baselineScan: () => {
        counts.baselineScans += 1
      },
      canonicalScan: () => {
        counts.canonicalScans += 1
      },
      graphValidation: () => {
        counts.graphValidations += 1
      },
      hydration: cacheResult => {
        if (cacheResult.hydrated) {
          counts.hydrations += 1
        }
      },
      ...(fault === undefined ? {} : { recordWriteHooks: { fault } }),
    })
    return { counts, result }
  } finally {
    cacheReadTestHooks.afterCanonicalValidation = undefined
  }
}

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const runCli = (root: string, arguments_: string[]) =>
  spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...arguments_], {
    cwd: root,
    encoding: 'utf8',
  })

const MAX_INSTRUCTION_FILE_BYTES = 1024 * 1024

const assertErrorCode = (operation: () => unknown, code: string, message?: RegExp) => {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code)
    if (message) {
      assert.match((error as Error).message, message)
    }
    return true
  })
}

const createDeletePlan = (root: string) => {
  api.initEncephalon({ root })
  const [agentsPlan] = planInstructionChanges(root, true)
  assert.equal(agentsPlan?.action, 'delete')
  return agentsPlan
}

const recordsForSubject = (root: string, subject: string) =>
  api.listRecords({ includeSuperseded: true, limit: 50, root }).filter(record => record.subject === subject)

const activeRecordsForSubject = (root: string, subject: string) =>
  api.listRecords({ limit: 50, root }).filter(record => record.subject === subject)

const generatedRecord = (root: string, subject: string) => {
  const record = api
    .listRecords({ includeSuperseded: true, limit: 20, root })
    .find(candidate => candidate.subject === subject)
  assert.ok(record)
  return record
}

const readRecordFile = (root: string, record: BrainRecord): BrainRecordFile =>
  JSON.parse(readFileSync(join(root, record.path), 'utf8')) as BrainRecordFile

const writeRecordFile = (root: string, record: BrainRecordFile) => {
  const path = join(root, 'encephalon', record.kind, `${record.id}.json`)
  ensureParent(path)
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
}

const rawRecordFilesForSubject = (root: string, kind: string, subject: string) =>
  readdirSync(join(root, 'encephalon', kind))
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(root, 'encephalon', kind, name), 'utf8')) as BrainRecordFile)
    .filter(record => record.subject === subject)

const cloneBaselineRecord = (
  root: string,
  subject: string,
  id: string,
  overrides: Partial<Pick<BrainRecordFile, 'payload' | 'source' | 'supersedes'>> = {},
) => {
  const [record] = recordsForSubject(root, subject)
  assert.ok(record)
  const cloned = {
    ...readRecordFile(root, record),
    id,
    ...overrides,
  }
  writeRecordFile(root, cloned)
  return { cloned, original: record }
}

afterEach(() => {
  artifactInspectionTestHooks.close = undefined
  artifactInspectionTestHooks.fault = undefined
  artifactInspectionTestHooks.open = undefined
  cacheReadTestHooks.afterCanonicalValidation = undefined
  cacheReadTestHooks.duringDatabaseInitialisation = undefined
  roots.splice(0).forEach(removeTestRepository)
})

describe('initialisation', () => {
  const canonicalRaceRecoveryAction =
    'Run validate and reconcile the canonical repository before retrying the operation.'
  const baselinePublicationOrder = [
    ['context', 'encephalon:init/repository-overview'],
    ['architecture', 'encephalon:init/tooling-layout'],
    ['workflow', 'encephalon:init/commands-ci'],
  ] as const

  const scannedBaselineEntries = (root: string) =>
    scanBaseline(root).map(record => [record.kind, record.subject] as const)

  const committedBaselineIds = (root: string) =>
    scannedBaselineEntries(root).flatMap(([kind, subject]) => {
      const directory = join(root, 'encephalon', kind)
      if (!existsSync(directory)) {
        return []
      }
      const record = readdirSync(directory)
        .filter(name => name.endsWith('.json'))
        .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as BrainRecordFile)
        .find(candidate => candidate.subject === subject)
      return record === undefined ? [] : [record.id]
    })

  const assertSafeInitError = (
    error: unknown,
    expected: {
      cacheState: 'notAttempted' | 'disposable' | 'prepared'
      code: string
      committedInstructionFiles: Array<{
        action: 'removed' | 'updated'
        file: 'AGENTS.md' | 'CLAUDE.md'
      }>
      committedRecordIds: string[]
      message: string
      phase: 'preflight' | 'recordPublication' | 'cachePreparation' | 'instructionApplication' | 'operationCleanup'
      recoveryAction: string
      recoveryMode: 'rerun' | 'inspectAndRerun'
      root: string
      sentinels?: readonly string[]
    },
  ) => {
    assert.ok(error instanceof EncephalonError)
    assert.equal(error.code, expected.code)
    assert.equal(error.message, expected.message)
    assert.deepEqual(error.details.initProgress, {
      cacheState: expected.cacheState,
      canonicalCommitted: expected.committedRecordIds.length > 0,
      committedInstructionFiles: expected.committedInstructionFiles,
      committedRecordIds: expected.committedRecordIds,
      phase: expected.phase,
      recoveryAction: expected.recoveryAction,
      recoveryMode: expected.recoveryMode,
    })
    const serialised = JSON.stringify(error)
    assert.equal(serialised.includes(expected.root), false)
    for (const sentinel of expected.sentinels ?? []) {
      assert.equal(serialised.includes(sentinel), false)
    }
    return true
  }

  test('baseline scan retains the fixed publication order', () => {
    const root = createRoot()

    assert.deepEqual(scannedBaselineEntries(root), baselinePublicationOrder)
  })

  test('init preflight progress reports no commits for a malformed second instruction file', () => {
    const root = createRoot()
    const secretInstructionBytes = Buffer.from([0x53, 0x45, 0x43, 0x52, 0x45, 0x54, 0xff])
    writeFileSync(join(root, 'AGENTS.md'), '# Existing guidance\n')
    writeFileSync(join(root, 'CLAUDE.md'), secretInstructionBytes)

    assert.throws(
      () => api.initEncephalon({ root }),
      error =>
        assertSafeInitError(error, {
          cacheState: 'notAttempted',
          code: 'VALIDATION_FAILED',
          committedInstructionFiles: [],
          committedRecordIds: [],
          message: 'CLAUDE.md must contain valid UTF-8.',
          phase: 'preflight',
          recoveryAction:
            'Resolve the reported preflight issue, then repeat the same init operation with the same options.',
          recoveryMode: 'rerun',
          root,
          sentinels: ['SECRET'],
        }),
    )
    assert.deepEqual(readFileSync(join(root, 'AGENTS.md')), Buffer.from('# Existing guidance\n'))
    assert.deepEqual(readFileSync(join(root, 'CLAUDE.md')), secretInstructionBytes)
    assert.equal(existsSync(join(root, 'encephalon')), false)
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
  })

  test('init preflight progress requires inspection for an internal failure', () => {
    const root = createRoot()
    const privateSentinel = 'PRIVATE_INTERNAL_PREFLIGHT_FAILURE'

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            baselineScan: () => {
              throw new Error(privateSentinel)
            },
          },
        ),
      error =>
        assertSafeInitError(error, {
          cacheState: 'notAttempted',
          code: 'INTERNAL_ERROR',
          committedInstructionFiles: [],
          committedRecordIds: [],
          message: 'Unable to coordinate Encephalon cache access.',
          phase: 'preflight',
          recoveryAction:
            'Inspect the reported preflight state, then repeat the same init operation with the same options.',
          recoveryMode: 'inspectAndRerun',
          root,
          sentinels: [privateSentinel],
        }),
    )
  })

  for (const failureAttempt of [2, 3] as const) {
    test(`partial init progress retains the committed prefix before record attempt ${failureAttempt}`, () => {
      const root = createRoot()
      const privateSentinel = `PRIVATE_RECORD_PAYLOAD_${failureAttempt}`
      writeFileSync(join(root, 'package.json'), JSON.stringify({ privateSentinel }))
      let publicationAttempts = 0
      let capturedError: unknown

      try {
        initEncephalonWithHooks(
          { root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'before-publication') {
                  publicationAttempts += 1
                  if (publicationAttempts === failureAttempt) {
                    throw Object.assign(new Error(privateSentinel), { code: 'EIO' })
                  }
                }
              },
            },
          },
        )
        assert.fail('Expected record publication to fail.')
      } catch (error) {
        capturedError = error
      }

      const expectedIds = committedBaselineIds(root)
      assert.equal(expectedIds.length, failureAttempt - 1)
      assertSafeInitError(capturedError, {
        cacheState: 'disposable',
        code: 'IO_ERROR',
        committedInstructionFiles: [],
        committedRecordIds: expectedIds,
        message: 'Unable to coordinate Encephalon cache access.',
        phase: 'recordPublication',
        recoveryAction: 'Repeat the same init operation with the same options.',
        recoveryMode: 'rerun',
        root,
        sentinels: [privateSentinel],
      })
      assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
      assert.equal(existsSync(join(root, 'AGENTS.md')), false)
      assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
    })
  }

  test('partial init progress reports an empty journal before the first record attempt and reruns', () => {
    const root = createRoot()

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'before-publication') {
                  throw Object.assign(new Error('Injected first record failure'), { code: 'EIO' })
                }
              },
            },
          },
        ),
      error =>
        assertSafeInitError(error, {
          cacheState: 'notAttempted',
          code: 'IO_ERROR',
          committedInstructionFiles: [],
          committedRecordIds: [],
          message: 'Unable to coordinate Encephalon cache access.',
          phase: 'recordPublication',
          recoveryAction: 'Repeat the same init operation with the same options.',
          recoveryMode: 'rerun',
          root,
        }),
    )

    const rerun = api.initEncephalon({ root })
    assert.equal(rerun.recordsCreated.length, scannedBaselineEntries(root).length)
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('partial init progress uses canonical inspection guidance for a sole internal failure', () => {
    const root = createRoot()
    const privateSentinel = 'PRIVATE_INTERNAL_RECORD_FAILURE'

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'before-publication') {
                  throw new Error(privateSentinel)
                }
              },
            },
          },
        ),
      error =>
        assertSafeInitError(error, {
          cacheState: 'notAttempted',
          code: 'INTERNAL_ERROR',
          committedInstructionFiles: [],
          committedRecordIds: [],
          message: 'Unable to coordinate Encephalon cache access.',
          phase: 'recordPublication',
          recoveryAction:
            'Inspect the reported canonical records, then repeat the same init operation with the same options.',
          recoveryMode: 'inspectAndRerun',
          root,
          sentinels: [privateSentinel],
        }),
    )
  })

  test('partial init progress includes the current record after post-link verification fails', () => {
    const root = createRoot()
    const privateSentinel = 'PRIVATE_POST_LINK_RECORD_BYTES'
    const injectedCause = Object.assign(new Error(privateSentinel), { code: 'EIO' })
    let acceptedPublications = 0
    let capturedError: unknown

    try {
      initEncephalonWithHooks(
        { root },
        {
          recordWriteHooks: {
            fault: point => {
              if (point === 'after-publication-accept') {
                acceptedPublications += 1
                if (acceptedPublications === 2) {
                  throw injectedCause
                }
              }
            },
          },
        },
      )
      assert.fail('Expected post-link verification to fail.')
    } catch (error) {
      capturedError = error
    }

    const committedRecordIds = committedBaselineIds(root)
    assert.equal(committedRecordIds.length, 2)
    const [, currentRecordId] = committedRecordIds
    assert.ok(currentRecordId)
    assertSafeInitError(capturedError, {
      cacheState: 'disposable',
      code: 'IO_ERROR',
      committedInstructionFiles: [],
      committedRecordIds,
      message: `Record ${currentRecordId} was committed, but the publicationVerification post-commit phase failed. Inspect the canonical directory generation before retrying; the linked record may have been displaced by a concurrent replacement.`,
      phase: 'recordPublication',
      recoveryAction:
        'Inspect the reported canonical records, then repeat the same init operation with the same options.',
      recoveryMode: 'inspectAndRerun',
      root,
      sentinels: [privateSentinel],
    })
    const { cause, details } = capturedError as EncephalonError
    assert.equal(cause, injectedCause)
    assert.equal(details.canonicalCommitted, true)
    assert.equal(details.postCommitPhase, 'publicationVerification')
    assert.equal(details.recordId, currentRecordId)
    assert.equal(
      details.recoveryAction,
      'Inspect the canonical directory generation before retrying; the linked record may have been displaced by a concurrent replacement.',
    )
  })

  test('partial init rerun cleans owned staging after the final record fails post-link', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    let linkedRecords = 0

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'after-canonical-link') {
                  linkedRecords += 1
                  if (linkedRecords === scannedBaselineEntries(root).length) {
                    throw Object.assign(new Error('Injected final record verification failure'), {
                      code: 'EIO',
                    })
                  }
                }
              },
            },
          },
        ),
      EncephalonError,
    )
    assert.equal(committedBaselineIds(root).length, scannedBaselineEntries(root).length)
    assert.equal(readdirSync(stagingDirectory).length, 0)

    const rerun = api.initEncephalon({ root })

    assert.deepEqual(rerun.recordsCreated, [])
    assert.deepEqual(readdirSync(stagingDirectory), [])
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('init cache progress reports all record commits and disposable cache state', () => {
    const root = createRoot()
    const privateSentinel = 'PRIVATE_CACHE_PAYLOAD'
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        throw Object.assign(new Error(privateSentinel), { code: 'EIO' })
      }
    }
    let capturedError: unknown

    try {
      api.initEncephalon({ root })
      assert.fail('Expected cache preparation to fail.')
    } catch (error) {
      capturedError = error
    }

    cacheReadTestHooks.duringDatabaseInitialisation = undefined
    const committedRecordIds = committedBaselineIds(root)
    assert.equal(committedRecordIds.length, scannedBaselineEntries(root).length)
    assertSafeInitError(capturedError, {
      cacheState: 'disposable',
      code: 'IO_ERROR',
      committedInstructionFiles: [],
      committedRecordIds,
      message: 'Unable to coordinate Encephalon cache access.',
      phase: 'cachePreparation',
      recoveryAction: 'Run prepare, run validate, then repeat the same init operation with the same options.',
      recoveryMode: 'rerun',
      root,
      sentinels: [privateSentinel],
    })
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('init cache inspection recovery includes canonical inspection and cache repair', () => {
    const root = createRoot()
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        throw new EncephalonError('REPOSITORY_CHANGED', 'Injected cache identity uncertainty.')
      }
    }

    assert.throws(
      () => api.initEncephalon({ root }),
      error =>
        assertSafeInitError(error, {
          cacheState: 'disposable',
          code: 'REPOSITORY_CHANGED',
          committedInstructionFiles: [],
          committedRecordIds: committedBaselineIds(root),
          message: 'Injected cache identity uncertainty.',
          phase: 'cachePreparation',
          recoveryAction:
            'Inspect canonical state, run prepare, run validate, then repeat the same init operation with the same options.',
          recoveryMode: 'inspectAndRerun',
          root,
        }),
    )
  })

  test('rejects a changed generation after the full baseline prefix and before instructions', () => {
    const root = createRoot()
    let injected = false
    let instructionHooks = 0

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            hydration: () => {
              if (!injected) {
                injected = true
                writeRecordFile(root, {
                  createdAt: '2099-01-01T00:00:00.000Z',
                  id: 'concurrent-init-cache-preparation',
                  kind: 'decision',
                  payload: {},
                  source: 'test',
                  subject: 'concurrent.init-cache-preparation',
                })
              }
            },
            instructionWriteHooks: {
              fault: () => {
                instructionHooks += 1
              },
            },
          },
        ),
      error => {
        const actual = error as EncephalonError
        const committedRecordIds = committedBaselineIds(root)
        assert.equal(actual.code, 'REPOSITORY_CHANGED')
        assert.equal(
          actual.message,
          `The canonical repository changed after 3 records were committed. ${canonicalRaceRecoveryAction}`,
        )
        assert.deepEqual(actual.details.committedRecordIds, committedRecordIds)
        assert.deepEqual(
          (actual.details.initProgress as { committedRecordIds?: unknown }).committedRecordIds,
          committedRecordIds,
        )
        return true
      },
    )

    assert.equal(injected, true)
    assert.equal(instructionHooks, 0)
    assert.equal(committedBaselineIds(root).length, baselinePublicationOrder.length)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('retains the committed prefix when cache and canonical generations both change', () => {
    const root = createRoot()
    let initialChange = false
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer' && !initialChange) {
        initialChange = true
        writeRecordFile(root, {
          createdAt: '2099-01-01T00:00:00.000Z',
          id: 'concurrent-init-cache-churn',
          kind: 'decision',
          payload: {},
          source: 'test',
          subject: 'concurrent.init-cache-churn',
        })
        throw new EncephalonError('REPOSITORY_CHANGED', 'Injected cache generation change.')
      }
    }

    assert.throws(
      () => api.initEncephalon({ root }),
      error => {
        const actual = error as EncephalonError
        const committedRecordIds = committedBaselineIds(root)
        assert.equal(actual.code, 'REPOSITORY_CHANGED')
        assert.equal(
          actual.message,
          `The canonical repository changed after 3 records were committed. ${canonicalRaceRecoveryAction}`,
        )
        assert.deepEqual(actual.details.committedRecordIds, committedRecordIds)
        assert.deepEqual(
          (actual.details.initProgress as { committedRecordIds?: unknown }).committedRecordIds,
          committedRecordIds,
        )
        return true
      },
    )

    assert.equal(initialChange, true)
    assert.equal(committedBaselineIds(root).length, baselinePublicationOrder.length)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('init instruction progress retains the first action when the second file fails before commit', () => {
    const root = createRoot()
    const privateSentinel = 'PRIVATE_SECOND_INSTRUCTION_BYTES'
    let capturedError: unknown

    try {
      initEncephalonWithHooks(
        { root },
        {
          instructionWriteHooks: {
            fault: (point, generatedPath) => {
              if (point === 'after-temp-create' && generatedPath?.includes('.CLAUDE.md.')) {
                throw Object.assign(new Error(privateSentinel), { code: 'EIO' })
              }
            },
          },
        },
      )
      assert.fail('Expected the second instruction publication to fail.')
    } catch (error) {
      capturedError = error
    }

    const committedRecordIds = committedBaselineIds(root)
    assert.equal(committedRecordIds.length, scannedBaselineEntries(root).length)
    assertSafeInitError(capturedError, {
      cacheState: 'prepared',
      code: 'IO_ERROR',
      committedInstructionFiles: [{ action: 'updated', file: 'AGENTS.md' }],
      committedRecordIds,
      message: 'Unable to update repository instruction files.',
      phase: 'instructionApplication',
      recoveryAction: 'Repeat the same init operation with the same options.',
      recoveryMode: 'rerun',
      root,
      sentinels: [privateSentinel],
    })
    assert.equal(
      readFileSync(join(root, 'AGENTS.md'), 'utf8').match(/encephalon:managed-instructions:start/gu)?.length,
      1,
    )
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('init instruction progress includes the current action and preserves post-commit recovery details', () => {
    const root = createRoot()
    const privateSentinel = 'PRIVATE_INSTRUCTION_RECOVERY_BYTES'
    let capturedError: unknown

    try {
      initEncephalonWithHooks(
        { root },
        {
          instructionWriteHooks: {
            fault: point => {
              if (point === 'after-publication' || point === 'during-temp-cleanup') {
                throw Object.assign(new Error(privateSentinel), { code: 'EIO' })
              }
            },
          },
        },
      )
      assert.fail('Expected instruction finalisation to fail.')
    } catch (error) {
      capturedError = error
    }

    const committedRecordIds = committedBaselineIds(root)
    assertSafeInitError(capturedError, {
      cacheState: 'prepared',
      code: 'IO_ERROR',
      committedInstructionFiles: [{ action: 'updated', file: 'AGENTS.md' }],
      committedRecordIds,
      message:
        'AGENTS.md was committed, but the publicationVerification post-commit phase failed. Inspect the canonical instruction file before retrying; the linked replacement may have been displaced by a concurrent change.',
      phase: 'instructionApplication',
      recoveryAction:
        'Inspect the reported canonical records, instruction files and recovery paths, then repeat the same init operation with the same options.',
      recoveryMode: 'inspectAndRerun',
      root,
      sentinels: [privateSentinel],
    })
    const { details } = capturedError as EncephalonError
    assert.deepEqual(details.postCommitFailures, [
      {
        postCommitPhase: 'publicationVerification',
        recoveryAction:
          'Inspect the canonical instruction file before retrying; the linked replacement may have been displaced by a concurrent change.',
      },
      {
        postCommitPhase: 'temporaryCleanup',
        recoveryAction:
          'Inspect the repository root and remove only a confirmed temporary file left by this operation before retrying.',
      },
    ])
    assert.ok(Array.isArray(details.recoveryPaths))
    assert.equal(details.recoveryPaths.length, 1)
    assert.equal(String(details.recoveryPaths[0]).includes(root), false)
  })

  test('partial init progress retains successful phases when operation cleanup fails', () => {
    const root = createRoot()
    const privateSentinel = 'PRIVATE_OPERATION_LOCK_OWNER'
    let capturedError: unknown
    let instructionPublications = 0
    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            instructionWriteHooks: {
              fault: point => {
                if (point === 'after-publication') {
                  instructionPublications += 1
                }
              },
            },
            lockHooks: {
              gateClose: database => {
                database.close()
                if (instructionPublications === 2) {
                  throw Object.assign(new Error(privateSentinel), { code: 'EIO' })
                }
              },
            },
          },
        ),
      error => {
        capturedError = error
        return true
      },
    )

    assertSafeInitError(capturedError, {
      cacheState: 'prepared',
      code: 'IO_ERROR',
      committedInstructionFiles: [
        { action: 'updated', file: 'AGENTS.md' },
        { action: 'updated', file: 'CLAUDE.md' },
      ],
      committedRecordIds: committedBaselineIds(root),
      message: 'Unable to initialise Encephalon.',
      phase: 'operationCleanup',
      recoveryAction: 'Inspect operation cleanup state, then repeat the same init operation with the same options.',
      recoveryMode: 'inspectAndRerun',
      root,
      sentinels: [privateSentinel],
    })
  })

  test('partial remove progress retains both removals when operation cleanup fails and reruns', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const baselineIds = committedBaselineIds(root)
    const privateSentinel = 'PRIVATE_REMOVE_OPERATION_CLEANUP_FAILURE'
    let capturedError: unknown

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { remove: true, root },
          {
            lockHooks: {
              gateClose: database => {
                database.close()
                throw Object.assign(new Error(privateSentinel), { code: 'EIO' })
              },
            },
          },
        ),
      error => {
        capturedError = error
        return true
      },
    )

    assertSafeInitError(capturedError, {
      cacheState: 'notAttempted',
      code: 'IO_ERROR',
      committedInstructionFiles: [
        { action: 'removed', file: 'AGENTS.md' },
        { action: 'removed', file: 'CLAUDE.md' },
      ],
      committedRecordIds: [],
      message: 'Unable to initialise Encephalon.',
      phase: 'operationCleanup',
      recoveryAction: 'Inspect operation cleanup state, then repeat the same init operation with the same options.',
      recoveryMode: 'inspectAndRerun',
      root,
      sentinels: [privateSentinel],
    })
    assert.deepEqual(committedBaselineIds(root), baselineIds)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)

    const rerun = api.initEncephalon({ remove: true, root })

    assert.deepEqual(rerun.instructionFiles, [])
    assert.deepEqual(rerun.recordsCreated, [])
    assert.deepEqual(committedBaselineIds(root), baselineIds)
  })

  test('partial init progress requires inspection for a retained pre-commit recovery path', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedPredecessor = join(root, 'retained-undurable-predecessor')
    let backupPath: string | undefined
    writeFileSync(path, '# Existing guidance\n')
    let capturedError: unknown

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            instructionWriteHooks: {
              fault: point => {
                if (point === 'after-backup-validation') {
                  const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
                  assert.ok(backupName)
                  backupPath = join(root, backupName)
                  throw Object.assign(new Error('Injected pre-commit failure'), { code: 'EIO' })
                }
                if (point === 'during-backup-restore') {
                  assert.ok(backupPath)
                  renameSync(backupPath, retainedPredecessor)
                }
                if (point === 'during-recovery-alias-flush') {
                  throw Object.assign(new Error('Injected recovery alias durability failure'), {
                    code: 'EIO',
                  })
                }
              },
            },
          },
        ),
      error => {
        capturedError = error
        return true
      },
    )

    assertSafeInitError(capturedError, {
      cacheState: 'prepared',
      code: 'IO_ERROR',
      committedInstructionFiles: [],
      committedRecordIds: committedBaselineIds(root),
      message: 'Unable to recover AGENTS.md before publication.',
      phase: 'instructionApplication',
      recoveryAction:
        'Inspect the reported canonical records, instruction files and recovery paths, then repeat the same init operation with the same options.',
      recoveryMode: 'inspectAndRerun',
      root,
    })
    const { details } = capturedError as EncephalonError
    assert.equal(details.instructionCommitted, undefined)
    assert.ok(Array.isArray(details.recoveryPaths))
    assert.equal(details.recoveryPaths.length, 1)
    assert.match(details.recoveryPaths[0] as string, /^\.AGENTS\.md\..+\.backup$/u)
  })

  test('partial init rerun creates only records missing after prefix and cache failures', () => {
    for (const failure of ['record-prefix', 'cache'] as const) {
      const root = createRoot()
      let publicationAttempts = 0
      if (failure === 'cache') {
        cacheReadTestHooks.duringDatabaseInitialisation = mode => {
          if (mode === 'writer') {
            throw Object.assign(new Error('Injected cache rerun failure'), { code: 'EIO' })
          }
        }
      }

      assert.throws(
        () =>
          initEncephalonWithHooks(
            { root },
            failure === 'record-prefix'
              ? {
                  recordWriteHooks: {
                    fault: point => {
                      if (point === 'before-publication') {
                        publicationAttempts += 1
                        if (publicationAttempts === 2) {
                          throw Object.assign(new Error('Injected record-prefix rerun failure'), {
                            code: 'EIO',
                          })
                        }
                      }
                    },
                  },
                }
              : {},
          ),
        EncephalonError,
      )
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
      const committedBeforeRerun = committedBaselineIds(root)
      const rerun = api.initEncephalon({ root })

      assert.equal(
        rerun.recordsCreated.length,
        scannedBaselineEntries(root).length - committedBeforeRerun.length,
        failure,
      )
      assert.deepEqual(committedBaselineIds(root).slice(0, committedBeforeRerun.length), committedBeforeRerun, failure)
      assert.equal(new Set(committedBaselineIds(root)).size, scannedBaselineEntries(root).length, failure)
      assert.equal(api.validateRecords({ root }).valid, true, failure)
    }
  })

  test('does not initialise a repository root replaced at record publication', {
    skip: renameParentWithOpenChildSkip,
  }, () => {
    const root = createRoot()
    const replacement = createRoot()
    const displaced = `${root}-init-publication-root`
    roots.push(displaced)
    let replaced = false

    assertErrorCode(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'before-directory-preparation' && !replaced) {
                  replaced = true
                  renameSync(root, displaced)
                  renameSync(replacement, root)
                }
              },
            },
          },
        ),
      'REPOSITORY_CHANGED',
    )
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('partial refresh rerun repairs only the unresolved generated subject', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const repairedSubject = 'encephalon:init/repository-overview'
    const unresolvedSubject = 'encephalon:init/tooling-layout'
    const originals = api.listRecords({ includeSuperseded: true, limit: 20, root })
    const repairedOriginal = originals.find(record => record.subject === repairedSubject)
    const unresolvedOriginal = originals.find(record => record.subject === unresolvedSubject)
    assert.ok(repairedOriginal)
    assert.ok(unresolvedOriginal)
    writeRecordFile(root, { ...readRecordFile(root, repairedOriginal), id: 'parallel-overview' })
    writeRecordFile(root, { ...readRecordFile(root, unresolvedOriginal), id: 'parallel-tooling' })
    let publicationAttempts = 0

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { refreshBaseline: true, root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'before-publication') {
                  publicationAttempts += 1
                  if (publicationAttempts === 2) {
                    throw Object.assign(new Error('Injected second resolver failure'), {
                      code: 'EIO',
                    })
                  }
                }
              },
            },
          },
        ),
      EncephalonError,
    )
    const repairedBeforeRerun = rawRecordFilesForSubject(root, 'context', repairedSubject).find(
      record => record.supersedes?.length === 2,
    )
    assert.ok(repairedBeforeRerun)

    const rerun = api.initEncephalon({ refreshBaseline: true, root })

    assert.deepEqual(
      rerun.recordsCreated.map(record => record.subject),
      [unresolvedSubject],
    )
    assert.deepEqual(
      activeRecordsForSubject(root, repairedSubject).map(record => record.id),
      [repairedBeforeRerun.id],
    )
    assert.equal(activeRecordsForSubject(root, unresolvedSubject).length, 1)
    assert.equal(recordsForSubject(root, repairedSubject).length, 3)
    assert.equal(recordsForSubject(root, unresolvedSubject).length, 3)
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('partial instruction rerun preserves concurrent bytes after a stale plan', () => {
    const root = createRoot()
    const concurrentClaude = '# Concurrent private guidance\n'
    let changed = false
    let capturedError: unknown

    try {
      initEncephalonWithHooks(
        { root },
        {
          instructionWriteHooks: {
            fault: point => {
              if (point === 'before-plan-validation' && !changed) {
                changed = true
                writeFileSync(join(root, 'CLAUDE.md'), concurrentClaude)
              }
            },
          },
        },
      )
      assert.fail('Expected the stale instruction plan to fail.')
    } catch (error) {
      capturedError = error
    }

    const progress = (capturedError as EncephalonError).details.initProgress as Record<string, unknown>
    assert.deepEqual(progress.committedInstructionFiles, [])
    assert.deepEqual(progress.committedRecordIds, committedBaselineIds(root))
    assert.equal(progress.recoveryMode, 'inspectAndRerun')
    assert.equal(
      progress.recoveryAction,
      'Inspect the reported canonical records, instruction files and recovery paths, then repeat the same init operation with the same options.',
    )
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), concurrentClaude)

    const rerun = api.initEncephalon({ root })

    assert.deepEqual(rerun.recordsCreated, [])
    assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /^# Concurrent private guidance\n/u)
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      assert.equal(
        readFileSync(join(root, filename), 'utf8').match(/encephalon:managed-instructions:start/gu)?.length,
        1,
      )
    }
  })

  test('partial instruction rerun completes remove mode without deleting baseline records', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const baselineIds = committedBaselineIds(root)
    let deletionAttempts = 0
    let capturedError: unknown

    try {
      initEncephalonWithHooks(
        { remove: true, root },
        {
          instructionWriteHooks: {
            fault: point => {
              if (point === 'before-delete-move') {
                deletionAttempts += 1
                if (deletionAttempts === 2) {
                  throw Object.assign(new Error('Injected second removal failure'), {
                    code: 'EIO',
                  })
                }
              }
            },
          },
        },
      )
      assert.fail('Expected the second instruction removal to fail.')
    } catch (error) {
      capturedError = error
    }

    assert.deepEqual((capturedError as EncephalonError).details.initProgress, {
      cacheState: 'notAttempted',
      canonicalCommitted: false,
      committedInstructionFiles: [{ action: 'removed', file: 'AGENTS.md' }],
      committedRecordIds: [],
      phase: 'instructionApplication',
      recoveryAction: 'Repeat the same init operation with the same options.',
      recoveryMode: 'rerun',
    })
    assert.deepEqual(committedBaselineIds(root), baselineIds)

    const rerun = api.initEncephalon({ remove: true, root })

    assert.deepEqual(rerun.recordsCreated, [])
    assert.deepEqual(committedBaselineIds(root), baselineIds)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('partial instruction rerun retains both updates when the second file fails post-commit', () => {
    const root = createRoot()
    let publications = 0
    let capturedError: unknown

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            instructionWriteHooks: {
              fault: point => {
                if (point === 'after-publication') {
                  publications += 1
                  if (publications === 2) {
                    throw Object.assign(new Error('Injected second update post-commit failure'), {
                      code: 'EIO',
                    })
                  }
                }
              },
            },
          },
        ),
      error => {
        capturedError = error
        return true
      },
    )
    assert.deepEqual((capturedError as EncephalonError).details.initProgress, {
      cacheState: 'prepared',
      canonicalCommitted: true,
      committedInstructionFiles: [
        { action: 'updated', file: 'AGENTS.md' },
        { action: 'updated', file: 'CLAUDE.md' },
      ],
      committedRecordIds: committedBaselineIds(root),
      phase: 'instructionApplication',
      recoveryAction:
        'Inspect the reported canonical records, instruction files and recovery paths, then repeat the same init operation with the same options.',
      recoveryMode: 'inspectAndRerun',
    })

    const rerun = api.initEncephalon({ root })
    assert.deepEqual(rerun.recordsCreated, [])
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      assert.equal(
        readFileSync(join(root, filename), 'utf8').match(/encephalon:managed-instructions:start/gu)?.length,
        1,
      )
    }
  })

  test('partial instruction rerun retains both removals when cleanup fails after the second file', {
    skip: process.platform === 'win32' ? 'Windows does not hold a repository-root directory descriptor.' : false,
  }, () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const baselineIds = committedBaselineIds(root)
    let capturedError: unknown

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { remove: true, root },
          {
            instructionWriteHooks: {
              rootClose: descriptor => {
                closeSync(descriptor)
                throw Object.assign(new Error('Injected second removal cleanup failure'), {
                  code: 'EIO',
                })
              },
            },
          },
        ),
      error => {
        capturedError = error
        return true
      },
    )
    assert.deepEqual((capturedError as EncephalonError).details.initProgress, {
      cacheState: 'notAttempted',
      canonicalCommitted: false,
      committedInstructionFiles: [
        { action: 'removed', file: 'AGENTS.md' },
        { action: 'removed', file: 'CLAUDE.md' },
      ],
      committedRecordIds: [],
      phase: 'instructionApplication',
      recoveryAction:
        'Inspect the reported canonical records, instruction files and recovery paths, then repeat the same init operation with the same options.',
      recoveryMode: 'inspectAndRerun',
    })

    const rerun = api.initEncephalon({ remove: true, root })
    assert.deepEqual(rerun.recordsCreated, [])
    assert.deepEqual(committedBaselineIds(root), baselineIds)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('no-new-record reruns report prepare and instruction failures in their exact phases', () => {
    for (const phase of ['cachePreparation', 'instructionApplication'] as const) {
      const root = createRoot()
      api.initEncephalon({ root })
      let capturedError: unknown
      if (phase === 'cachePreparation') {
        cacheReadTestHooks.duringDatabaseInitialisation = mode => {
          if (mode === 'reader') {
            throw Object.assign(new Error('Injected no-new prepare failure'), { code: 'EIO' })
          }
        }
      } else {
        writeFileSync(join(root, 'AGENTS.md'), '# Changed guidance\n')
      }

      assert.throws(
        () =>
          initEncephalonWithHooks(
            { root },
            phase === 'instructionApplication'
              ? {
                  instructionWriteHooks: {
                    fault: point => {
                      if (point === 'during-publication') {
                        throw Object.assign(new Error('Injected no-new instruction failure'), {
                          code: 'EIO',
                        })
                      }
                    },
                  },
                }
              : {},
          ),
        error => {
          capturedError = error
          return true
        },
      )
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
      const progress = (capturedError as EncephalonError).details.initProgress as Record<string, unknown>
      assert.equal(progress.phase, phase)
      assert.deepEqual(progress.committedRecordIds, [])
      assert.deepEqual(progress.committedInstructionFiles, [])
      assert.equal(progress.cacheState, phase === 'cachePreparation' ? 'disposable' : 'prepared')
    }
  })

  test('recovers a recognised stale staging entry before baseline publication', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    mkdirSync(stagingDirectory, { recursive: true })
    writeFileSync(join(stagingDirectory, createOwnedStagingName(123, '550e8400-e29b-41d4-a716-446655440000')), 'stale')

    const result = api.initEncephalon({ root })

    assert.equal(result.recordsCreated.length > 0, true)
    assert.deepEqual(readdirSync(stagingDirectory), [])
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('rejects baseline kind-directory overflow before publishing any batch state', () => {
    const root = createRoot()
    for (const index of Array.from({ length: 999 }, (_, value) => value)) {
      mkdirSync(join(root, 'encephalon', `kind-${String(index).padStart(4, '0')}`), {
        recursive: true,
      })
    }

    assertErrorCode(() => api.initEncephalon({ root }), 'VALIDATION_FAILED')
    for (const kind of ['architecture', 'context', 'workflow']) {
      assert.equal(existsSync(join(root, 'encephalon', kind)), false)
    }
    assert.equal(existsSync(join(root, 'encephalon', '_staging')), false)
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('replans a changed canonical generation before the first baseline commit', () => {
    const root = createRoot()
    const concurrentCreatedAt = '2099-01-01T00:00:00.000Z'
    const concurrentId = 'concurrent-init-repository-overview'
    let publicationAttempts = 0
    const result = initWithCounts({ root }, point => {
      if (point === 'before-publication') {
        publicationAttempts += 1
        if (publicationAttempts === 1) {
          writeRecordFile(root, {
            createdAt: concurrentCreatedAt,
            id: concurrentId,
            kind: 'context',
            payload: { summary: 'Concurrent repository overview' },
            source: 'test',
            subject: 'encephalon:init/repository-overview',
          })
        }
      }
    })

    assert.deepEqual(result.counts, {
      baselineScans: 1,
      canonicalScans: 2,
      diskCacheValidations: 0,
      graphValidations: 2,
      hydrations: 1,
    })
    assert.deepEqual(result.result.skippedConflicts, [
      {
        activeRecordIds: [concurrentId],
        kind: 'context',
        subject: 'encephalon:init/repository-overview',
      },
    ])
    assert.deepEqual(
      result.result.recordsCreated.map(record => [record.subject, record.createdAt]),
      [
        ['encephalon:init/tooling-layout', '2099-01-01T00:00:00.001Z'],
        ['encephalon:init/commands-ci', '2099-01-01T00:00:00.002Z'],
      ],
    )
    assert.equal(publicationAttempts, 3)
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('bounds repeated complete init replans before the first baseline commit', () => {
    const root = createRoot()
    let publicationAttempts = 0

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'before-publication') {
                  publicationAttempts += 1
                  writeRecordFile(root, {
                    createdAt: `2099-01-01T00:00:00.00${publicationAttempts}Z`,
                    id: `concurrent-init-replan-${publicationAttempts}`,
                    kind: 'decision',
                    payload: {},
                    source: 'test',
                    subject: `concurrent.init-replan-${publicationAttempts}`,
                  })
                }
              },
            },
          },
        ),
      error => {
        const actual = error as EncephalonError
        assert.equal(actual.code, 'REPOSITORY_CHANGED')
        assert.match(actual.message, /changed repeatedly/)
        assert.deepEqual((actual.details.initProgress as { committedRecordIds?: unknown }).committedRecordIds, [])
        return true
      },
    )

    assert.equal(publicationAttempts, 3)
    assert.deepEqual(committedBaselineIds(root), [])
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('preserves a stable batch-limit failure after a complete replan', () => {
    const root = createRoot()
    for (const index of Array.from({ length: 997 }, (_, value) => value)) {
      const suffix = String(index).padStart(4, '0')
      writeRecordFile(root, {
        createdAt: '2026-01-01T00:00:00.000Z',
        id: `existing-init-record-${suffix}`,
        kind: 'decision',
        payload: {},
        source: 'test',
        subject: `existing.init-record-${suffix}`,
      })
    }
    let changed = false

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'before-publication' && !changed) {
                  changed = true
                  writeRecordFile(root, {
                    createdAt: '2026-01-01T00:00:00.001Z',
                    id: 'concurrent-init-record-limit',
                    kind: 'decision',
                    payload: {},
                    source: 'test',
                    subject: 'concurrent.init-record-limit',
                  })
                }
              },
            },
          },
        ),
      error => {
        const actual = error as EncephalonError
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(
          (actual.details.errors as Array<{ code?: unknown }>).some(issue => issue.code === 'CORPUS_RECORD_LIMIT'),
          true,
        )
        return true
      },
    )

    assert.equal(changed, true)
    assert.deepEqual(committedBaselineIds(root), [])
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('classifies existing artifact mutation during init validation before publication', () => {
    const root = createRoot()
    const artifact = '_artifacts/decision/existing-init-artifact/evidence.txt'
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, 'stable evidence')
    writeRecordFile(root, {
      artifacts: [artifact],
      createdAt: '2026-08-13T00:00:00.000Z',
      id: 'existing-init-artifact',
      kind: 'decision',
      payload: {},
      source: 'test',
      subject: 'validation.existing-init-artifact',
    })
    artifactInspectionTestHooks.fault = (point, path) => {
      if (point === 'after-artifact-fstat' && path === artifact) {
        writeFileSync(artifactPath, 'mutated evidence with different metadata')
      }
    }

    assertErrorCode(() => api.initEncephalon({ root }), 'REPOSITORY_CHANGED')
    assert.deepEqual(readdirSync(join(root, 'encephalon', 'decision')), ['existing-init-artifact.json'])
    assert.equal(existsSync(join(root, 'encephalon', '_staging')), false)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('creates a safe deterministic baseline and exactly reversible instruction blocks', () => {
    const root = createRoot()
    const originalAgents = '# Existing agent guidance'
    writeFileSync(join(root, 'AGENTS.md'), originalAgents)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        packageManager: 'npm@11.0.0',
        scripts: {
          build: 'sensitive-command --registry=https://registry.example.invalid',
          test: 'SECRET_TOKEN=never-store-this node --test',
        },
        workspaces: ['packages/*'],
      }),
    )
    writeFileSync(join(root, 'package-lock.json'), '{}')
    writeFileSync(join(root, '.env'), 'SECRET_TOKEN=never-store-this')
    writeFileSync(join(root, 'README.md'), 'Run sensitive-command --password hidden')
    ensureParent(join(root, '.github', 'workflows', 'checks.yml'))
    writeFileSync(join(root, '.github', 'workflows', 'checks.yml'), 'env:\n  SECRET_TOKEN: never-store-this\n')
    ensureParent(join(root, 'src', 'index.ts'))
    writeFileSync(join(root, 'src', 'index.ts'), "export const secret = 'never-store-this'")

    const result = api.initEncephalon({ root })
    assert.equal(result.recordsCreated.length, 3)
    assert.deepEqual(result.skippedConflicts, [])
    assert.match(result.nextAction, /skills\/encephalon\/SKILL\.md/)

    const records = api.listRecords({
      includeSuperseded: true,
      limit: 20,
      root,
    })
    assert.equal(records.length, 3)
    assert.deepEqual(records.map(record => record.subject).sort(ordinalStringCompare), [
      'encephalon:init/commands-ci',
      'encephalon:init/repository-overview',
      'encephalon:init/tooling-layout',
    ])
    assert.equal(
      records.every(record => record.source === 'encephalon:init'),
      true,
    )
    const workflow = records.find(record => record.subject === 'encephalon:init/commands-ci')
    assert.ok(workflow)
    assert.deepEqual(workflow.payload, {
      scriptInvocations: [
        { arguments: ['run', 'build'], executable: 'npm', scriptKey: 'build' },
        { arguments: ['run', 'test'], executable: 'npm', scriptKey: 'test' },
      ],
      scriptKeys: ['build', 'test'],
      sources: ['package.json', '.github/workflows/checks.yml'],
      summary:
        'Derived package-script entry points and CI workflow filenames; use scriptInvocations as argv and treat scriptKeys as discovery-only.',
      workflowFiles: ['.github/workflows/checks.yml'],
    })
    const serialized = JSON.stringify(records)
    assert.doesNotMatch(serialized, /never-store-this|sensitive-command|registry\.example\.invalid|SECRET_TOKEN/)
    assert.doesNotMatch(serialized, /npm run|sensitive-command --password/)
    assert.match(serialized, /checks\.yml/)

    const agentsWithBlock = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    const claudeWithBlock = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    assert.match(agentsWithBlock, /\.\/node_modules\/encephalon\/skills\/encephalon\/SKILL\.md/)
    assert.match(claudeWithBlock, /\.\/node_modules\/encephalon\/skills\/encephalon\/SKILL\.md/)

    const removed = api.initEncephalon({ remove: true, root })
    assert.deepEqual(removed.recordsCreated, [])
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), originalAgents)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
    assert.equal(
      records.every(record => existsSync(join(root, record.path))),
      true,
    )
  })

  test('does not persist or print unrelated instruction-file content', () => {
    const root = createRoot()
    const sentinel = 'PRIVATE_INSTRUCTION_SENTINEL_do_not_store'
    writeFileSync(join(root, 'AGENTS.md'), `# Agent notes\n${sentinel}\n`)
    writeFileSync(join(root, 'CLAUDE.md'), `# Claude notes\n${sentinel}\n`)

    const initialized = runCli(root, ['--root', root, 'init'])
    assert.equal(initialized.status, 0)
    assert.equal(initialized.stderr, '')
    assert.doesNotMatch(initialized.stdout, new RegExp(sentinel))

    const records = api.listRecords({ includeSuperseded: true, limit: 20, root })
    assert.doesNotMatch(JSON.stringify(records), new RegExp(sentinel))
    assert.deepEqual(api.searchRecords({ query: sentinel, root }), [])

    writeFileSync(join(root, 'AGENTS.md'), `${sentinel}\n<!-- encephalon:managed-instructions:start invalid -->\n`)
    const failed = runCli(root, ['--root', root, 'init'])
    assert.equal(failed.status, 2)
    assert.equal(failed.stdout, '')
    assert.doesNotMatch(failed.stderr, new RegExp(sentinel))
    assert.equal(JSON.parse(failed.stderr).error.code, 'VALIDATION_FAILED')
  })

  test('is idempotent and refreshes only changed generated facts by superseding the active head', () => {
    const root = createRoot()
    const packagePath = join(root, 'package.json')
    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )
    writeFileSync(join(root, 'package-lock.json'), '{}')

    const first = api.initEncephalon({ root })
    const second = api.initEncephalon({ root })
    assert.equal(first.recordsCreated.length, 3)
    assert.deepEqual(second.recordsCreated, [])
    assert.equal(api.listRecords({ includeSuperseded: true, limit: 20, root }).length, 3)

    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'sample-project',
        scripts: { lint: 'lint-private-body', test: 'node --test' },
      }),
    )
    const refreshed = api.initEncephalon({ refreshBaseline: true, root })
    assert.equal(refreshed.recordsCreated.length, 1)
    const all = api.listRecords({ includeSuperseded: true, limit: 20, root })
    const workflow = all.filter(record => record.subject === 'encephalon:init/commands-ci')
    assert.equal(workflow.length, 2)
    assert.deepEqual(workflow[0]?.supersedes, [workflow[1]?.id])
    const [refreshedWorkflow] = workflow
    assert.ok(refreshedWorkflow)
    assert.deepEqual((refreshedWorkflow.payload as { scriptKeys?: unknown }).scriptKeys, ['lint', 'test'])
    assert.deepEqual((refreshedWorkflow.payload as { scriptInvocations?: unknown }).scriptInvocations, [
      { arguments: ['run', 'lint'], executable: 'npm', scriptKey: 'lint' },
      { arguments: ['run', 'test'], executable: 'npm', scriptKey: 'test' },
    ])
    assert.doesNotMatch(JSON.stringify(workflow[0]?.payload), /lint-private-body/)
    assert.equal(api.listRecords({ limit: 20, root }).length, 3)
  })

  test('records package-manager facts only when evidence supports them', () => {
    const packageJson = {
      name: 'sample-project',
      scripts: { test: 'node --test' },
    }
    const cases = [
      {
        evidence: { status: 'unknown' },
        files: { 'go.mod': 'module example.invalid/project\n' },
        manager: undefined,
        name: 'non-JavaScript repository',
        scriptInvocations: [],
        scriptKeys: [],
      },
      {
        evidence: { status: 'unknown' },
        files: { 'package.json': JSON.stringify(packageJson) },
        manager: undefined,
        name: 'package.json without manager evidence',
        scriptInvocations: [],
        scriptKeys: ['test'],
      },
      {
        evidence: {
          lockfiles: [{ file: 'bun.lock', manager: 'bun' }],
          manager: 'bun',
          status: 'lockfile-derived',
        },
        files: { 'bun.lock': '', 'package.json': JSON.stringify(packageJson) },
        manager: 'bun',
        name: 'bun text lockfile',
        scriptInvocations: [{ arguments: ['run', 'test'], executable: 'bun', scriptKey: 'test' }],
        scriptKeys: ['test'],
      },
      {
        evidence: {
          lockfiles: [{ file: 'bun.lockb', manager: 'bun' }],
          manager: 'bun',
          status: 'lockfile-derived',
        },
        files: { 'bun.lockb': '', 'package.json': JSON.stringify(packageJson) },
        manager: 'bun',
        name: 'bun binary lockfile',
        scriptInvocations: [{ arguments: ['run', 'test'], executable: 'bun', scriptKey: 'test' }],
        scriptKeys: ['test'],
      },
      {
        evidence: {
          lockfiles: [{ file: 'package-lock.json', manager: 'npm' }],
          manager: 'npm',
          status: 'lockfile-derived',
        },
        files: { 'package-lock.json': '{}', 'package.json': JSON.stringify(packageJson) },
        manager: 'npm',
        name: 'npm lockfile',
        scriptInvocations: [{ arguments: ['run', 'test'], executable: 'npm', scriptKey: 'test' }],
        scriptKeys: ['test'],
      },
      {
        evidence: {
          lockfiles: [{ file: 'pnpm-lock.yaml', manager: 'pnpm' }],
          manager: 'pnpm',
          status: 'lockfile-derived',
        },
        files: { 'package.json': JSON.stringify(packageJson), 'pnpm-lock.yaml': '' },
        manager: 'pnpm',
        name: 'pnpm lockfile',
        scriptInvocations: [{ arguments: ['run', 'test'], executable: 'pnpm', scriptKey: 'test' }],
        scriptKeys: ['test'],
      },
      {
        evidence: {
          lockfiles: [{ file: 'yarn.lock', manager: 'yarn' }],
          manager: 'yarn',
          status: 'lockfile-derived',
        },
        files: { 'package.json': JSON.stringify(packageJson), 'yarn.lock': '' },
        manager: 'yarn',
        name: 'yarn lockfile',
        scriptInvocations: [{ arguments: ['run', 'test'], executable: 'yarn', scriptKey: 'test' }],
        scriptKeys: ['test'],
      },
      {
        evidence: { declared: 'pnpm', manager: 'pnpm', status: 'declared' },
        files: { 'package.json': JSON.stringify({ ...packageJson, packageManager: 'pnpm@9.0.0' }) },
        manager: 'pnpm',
        name: 'valid declaration without lockfile',
        scriptInvocations: [{ arguments: ['run', 'test'], executable: 'pnpm', scriptKey: 'test' }],
        scriptKeys: ['test'],
      },
      {
        evidence: {
          declared: 'npm',
          lockfiles: [{ file: 'package-lock.json', manager: 'npm' }],
          manager: 'npm',
          status: 'declared-and-lockfile',
        },
        files: {
          'package-lock.json': '{}',
          'package.json': JSON.stringify({ ...packageJson, packageManager: 'npm@11.0.0' }),
        },
        manager: 'npm',
        name: 'matching declaration and lockfile',
        scriptInvocations: [{ arguments: ['run', 'test'], executable: 'npm', scriptKey: 'test' }],
        scriptKeys: ['test'],
      },
      {
        evidence: {
          candidates: ['npm', 'yarn'],
          declared: 'npm',
          lockfiles: [{ file: 'yarn.lock', manager: 'yarn' }],
          status: 'conflicted',
        },
        files: {
          'package.json': JSON.stringify({ ...packageJson, packageManager: 'npm@11.0.0' }),
          'yarn.lock': '',
        },
        manager: undefined,
        name: 'conflicting declaration and lockfile',
        scriptInvocations: [],
        scriptKeys: ['test'],
      },
      {
        evidence: {
          candidates: ['npm', 'pnpm'],
          lockfiles: [
            { file: 'package-lock.json', manager: 'npm' },
            { file: 'pnpm-lock.yaml', manager: 'pnpm' },
          ],
          status: 'conflicted',
        },
        files: {
          'package-lock.json': '{}',
          'package.json': JSON.stringify(packageJson),
          'pnpm-lock.yaml': '',
        },
        manager: undefined,
        name: 'multiple package-manager lockfiles',
        scriptInvocations: [],
        scriptKeys: ['test'],
      },
    ] as const

    for (const entry of cases) {
      const root = createRoot()
      for (const [relativePath, content] of Object.entries(entry.files)) {
        writeFileSync(join(root, relativePath), content)
      }

      const result = api.initEncephalon({ root })
      const architecture = generatedPayload(result.recordsCreated, 'encephalon:init/tooling-layout')
      const workflow = generatedPayload(result.recordsCreated, 'encephalon:init/commands-ci')

      assert.deepEqual(architecture.packageManagerEvidence, entry.evidence, entry.name)
      assert.equal(architecture.packageManager, entry.manager, entry.name)
      assert.deepEqual(workflow.scriptKeys, entry.scriptKeys, entry.name)
      assert.deepEqual(workflow.scriptInvocations, entry.scriptInvocations, entry.name)
    }
  })

  test('refreshes generated records when package-manager evidence changes', () => {
    const root = createRoot()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )

    api.initEncephalon({ root })
    writeFileSync(join(root, 'package-lock.json'), '{}')

    const refreshed = api.initEncephalon({ refreshBaseline: true, root })
    assert.deepEqual(refreshed.recordsCreated.map(record => record.subject).sort(ordinalStringCompare), [
      'encephalon:init/commands-ci',
      'encephalon:init/repository-overview',
      'encephalon:init/tooling-layout',
    ])
    const architecture = generatedPayload(refreshed.recordsCreated, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(refreshed.recordsCreated, 'encephalon:init/commands-ci')
    assert.equal(architecture.packageManager, 'npm')
    assert.deepEqual(workflow.scriptInvocations, [{ arguments: ['run', 'test'], executable: 'npm', scriptKey: 'test' }])
  })

  test('plans first and idempotent baseline additions against one canonical snapshot', () => {
    const root = createRoot()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )

    const first = initWithCounts({ root })
    assert.equal(first.result.recordsCreated.length, 3)
    assert.deepEqual(
      first.result.recordsCreated.map(record => record.id),
      committedBaselineIds(root),
    )
    assert.deepEqual(first.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      diskCacheValidations: 0,
      graphValidations: 1,
      hydrations: 1,
    })

    const second = initWithCounts({ root })
    assert.deepEqual(second.result.recordsCreated, [])
    assert.deepEqual(second.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      diskCacheValidations: 0,
      graphValidations: 1,
      hydrations: 0,
    })
  })

  test('preserves the canonical-history error before baseline candidate errors', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'invalid-history' }))
    for (const [index, id] of ['parallel-history-a', 'parallel-history-b'].entries()) {
      writeRecordFile(root, {
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
        id,
        kind: 'decision',
        payload: {},
        source: 'test',
        subject: 'parallel.history',
      })
    }
    const [candidate] = scanBaseline(root)
    assert.ok(candidate)
    const candidateId = validateAddRecordInput({ ...candidate, root }).id
    writeRecordFile(root, {
      createdAt: '2026-01-01T00:00:02.000Z',
      id: candidateId,
      kind: 'collision',
      payload: {},
      source: 'test',
      subject: 'baseline.id-collision',
    })

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown
          details?: { errors?: unknown }
          message?: unknown
        }
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(actual.message, 'Canonical records are invalid.')
        assert.deepEqual(actual.details?.errors, [
          {
            code: 'MULTIPLE_ACTIVE_HEADS',
            message: 'Multiple active records exist for decision/parallel.history.',
          },
          {
            code: 'MULTIPLE_ACTIVE_HEADS',
            message: 'Multiple active records exist for decision/parallel.history.',
          },
        ])
        return true
      },
    )
  })

  test('preserves canonical-history errors before invalid baseline input', () => {
    const root = createRoot()
    const scripts = Object.fromEntries(
      Array.from({ length: 9000 }, (_, index) => [`script-${String(index).padStart(4, '0')}-${'x'.repeat(64)}`, 'x']),
    )
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'invalid-baseline-input', packageManager: 'npm@10.0.0', scripts }),
    )
    for (const [index, id] of ['invalid-input-history-a', 'invalid-input-history-b'].entries()) {
      writeRecordFile(root, {
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
        id,
        kind: 'decision',
        payload: {},
        source: 'test',
        subject: 'invalid.input-history',
      })
    }

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: { errors?: unknown }; message?: unknown }
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(actual.message, 'Canonical records are invalid.')
        assert.deepEqual(actual.details?.errors, [
          {
            code: 'MULTIPLE_ACTIVE_HEADS',
            message: 'Multiple active records exist for decision/invalid.input-history.',
          },
          {
            code: 'MULTIPLE_ACTIVE_HEADS',
            message: 'Multiple active records exist for decision/invalid.input-history.',
          },
        ])
        return true
      },
    )
  })

  test('rebuilds an idempotent init snapshot using actual canonical bytes', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'actual-byte-snapshot' }))
    api.initEncephalon({ root })
    const payload = {
      padding: 'x'.repeat(700_000),
      ...Object.fromEntries(Array.from({ length: 9000 }, (_, index) => [`key-${index}`, 0])),
    }
    const directory = join(root, 'encephalon', 'context')
    for (const index of Array.from({ length: 10 }, (_, value) => value)) {
      const id = `minified-${index}`
      writeFileSync(
        join(directory, `${id}.json`),
        JSON.stringify({
          createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
          id,
          kind: 'context',
          payload,
          source: 'test',
          subject: `minified.${index}`,
        }),
      )
    }
    assert.equal(api.validateRecords({ root }).valid, true)

    const resumed = initWithCounts({ root })
    assert.deepEqual(resumed.result.recordsCreated, [])
    assert.deepEqual(resumed.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      diskCacheValidations: 0,
      graphValidations: 1,
      hydrations: 1,
    })
  })

  test('uses disk hydration when baseline additions exceed actual corpus bytes', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'actual-byte-overflow' }))
    const directory = join(root, 'encephalon', 'context')
    mkdirSync(directory, { recursive: true })
    const bytesPerRecord = 1_048_500
    for (const index of Array.from({ length: 8 }, (_, value) => value)) {
      const id = `padding-${index}`
      const json = JSON.stringify({
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
        id,
        kind: 'context',
        payload: {},
        source: 'test',
        subject: `padding.${index}`,
      })
      assert.equal(Buffer.byteLength(json, 'utf8') < bytesPerRecord, true)
      writeFileSync(join(directory, `${id}.json`), `${json}${' '.repeat(bytesPerRecord - Buffer.byteLength(json))}`)
    }
    assert.equal(bytesPerRecord * 8, MAX_CANONICAL_RECORD_BYTES - 608)
    assert.equal(api.validateRecords({ root }).valid, true)

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown
          details?: { initProgress?: { cacheState?: unknown; committedRecordIds?: unknown; phase?: unknown } }
          message?: unknown
        }
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(actual.message, 'Canonical records are invalid.')
        assert.equal(actual.details?.initProgress?.phase, 'cachePreparation')
        assert.equal(actual.details?.initProgress?.cacheState, 'disposable')
        assert.equal(
          Array.isArray(actual.details?.initProgress?.committedRecordIds) &&
            actual.details.initProgress.committedRecordIds.length,
          3,
        )
        return true
      },
    )
    assert.equal(api.validateRecords({ root }).valid, false)
    assertErrorCode(() => api.prepare({ root }), 'VALIDATION_FAILED')
  })

  test('refreshes one or three changed generated subjects with one planning scan', () => {
    const root = createRoot()
    const packagePath = join(root, 'package.json')
    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )
    initWithCounts({ root })

    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'sample-project',
        scripts: { lint: 'lint-private-body', test: 'node --test' },
      }),
    )
    const oneChanged = initWithCounts({ refreshBaseline: true, root })
    assert.equal(oneChanged.result.recordsCreated.length, 1)
    assert.deepEqual(oneChanged.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      diskCacheValidations: 0,
      graphValidations: 1,
      hydrations: 1,
    })

    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'renamed-project',
        scripts: { build: 'private-build-command', lint: 'lint-private-body', test: 'node --test' },
      }),
    )
    ensureParent(join(root, 'src', 'index.ts'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1')
    const threeChanged = initWithCounts({ refreshBaseline: true, root })
    assert.equal(threeChanged.result.recordsCreated.length, 3)
    assert.deepEqual(threeChanged.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      diskCacheValidations: 0,
      graphValidations: 1,
      hydrations: 1,
    })
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('reruns safely after a mid-batch baseline publication failure', () => {
    const root = createRoot()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )
    let publicationAttempts = 0
    assert.throws(
      () =>
        initWithCounts({ root }, point => {
          if (point === 'before-publication') {
            publicationAttempts += 1
            if (publicationAttempts === 2) {
              throw new Error('Injected mid-batch failure')
            }
          }
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
        return true
      },
    )

    assert.equal(api.validateRecords({ root }).valid, true)
    assert.equal(api.listRecords({ includeSuperseded: true, limit: 20, root }).length, 1)

    const rerun = initWithCounts({ root })
    assert.equal(rerun.result.recordsCreated.length, 2)
    assert.equal(api.validateRecords({ root }).valid, true)
    const records = api.listRecords({ includeSuperseded: true, limit: 20, root })
    assert.equal(records.length, 3)
    assert.deepEqual(new Set(records.map(record => record.subject)).size, 3)
  })

  test('stops a changed generation at the exact committed prefix and converges on rerun', () => {
    const root = createRoot()
    let publicationAttempts = 0
    let capturedError: unknown

    try {
      initWithCounts({ root }, point => {
        if (point === 'before-publication') {
          publicationAttempts += 1
          if (publicationAttempts === 2) {
            writeRecordFile(root, {
              createdAt: '2099-01-01T00:00:00.000Z',
              id: 'concurrent-init-mid-batch',
              kind: 'decision',
              payload: {},
              source: 'test',
              subject: 'concurrent.init-mid-batch',
            })
          }
        }
      })
      assert.fail('Expected the changed canonical generation to stop the batch.')
    } catch (error) {
      capturedError = error
    }

    assert.ok(capturedError instanceof EncephalonError)
    const committedRecordIds = committedBaselineIds(root)
    assert.equal(publicationAttempts, 2)
    assert.equal(capturedError.code, 'REPOSITORY_CHANGED')
    assert.equal(
      capturedError.message,
      `The canonical repository changed after 1 record was committed. ${canonicalRaceRecoveryAction}`,
    )
    const { initProgress, ...details } = capturedError.details
    assert.deepEqual(details, {
      canonicalCommitted: true,
      committedRecordIds,
      postCommitPhase: 'publicationVerification',
      recoveryAction: canonicalRaceRecoveryAction,
      repositoryChanged: true,
    })
    assert.equal(Object.isFrozen(details.committedRecordIds), true)
    assert.deepEqual((initProgress as { committedRecordIds?: unknown }).committedRecordIds, committedRecordIds)
    assert.equal(committedRecordIds.length, 1)
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)

    const rerun = initWithCounts({ root })
    assert.equal(rerun.result.recordsCreated.length, 2)
    assert.equal(api.validateRecords({ root }).valid, true)
    const records = api.listRecords({ includeSuperseded: true, limit: 20, root })
    assert.equal(records.length, 4)
    assert.deepEqual(new Set(records.map(record => record.subject)).size, 4)
    for (const [, subject] of baselinePublicationOrder) {
      assert.equal(records.filter(record => record.subject === subject).length, 1)
    }
  })

  test('stops a baseline batch after a post-link canonical generation replacement', () => {
    const root = createRoot()
    const kindDirectory = join(root, 'encephalon', 'context')
    const displaced = join(root, 'displaced-context-after-publication')
    let publicationAttempts = 0

    assert.throws(
      () =>
        initWithCounts({ root }, point => {
          if (point === 'after-publication') {
            publicationAttempts += 1
            if (publicationAttempts === 1) {
              renameSync(kindDirectory, displaced)
              mkdirSync(kindDirectory)
            }
          }
        }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: Record<string, unknown> }
        assert.equal(actual.code, 'REPOSITORY_CHANGED')
        assert.equal(actual.details?.canonicalCommitted, true)
        assert.equal(actual.details?.postCommitPhase, 'publicationVerification')
        assert.equal(typeof actual.details?.path, 'string')
        assert.equal(typeof actual.details?.recordId, 'string')
        assert.equal(typeof actual.details?.recoveryAction, 'string')
        return true
      },
    )
    assert.equal(publicationAttempts, 1)
    assert.equal(readdirSync(displaced).filter(name => name.endsWith('.json')).length, 1)
    assert.deepEqual(readdirSync(kindDirectory), [])
    assert.equal(existsSync(join(root, 'encephalon', 'architecture')), false)
    assert.equal(existsSync(join(root, 'encephalon', 'workflow')), false)
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('records package scripts as structured argv data instead of shell strings', () => {
    const root = createRoot()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        packageManager: 'yarn@1.22.22',
        scripts: {
          '--version': 'echo leading-option',
          '`tick`': 'echo backticks',
          '$(date)': 'echo command-substitution',
          'ci:unit': 'echo colon',
          'line\nbreak': 'echo control',
          'path/name': 'echo slash',
          'quote"key': 'echo quote',
          'semi;colon': 'echo semicolon',
          'space name': 'echo space',
          test: 'node --test',
          unicodé: 'echo unicode',
        },
      }),
    )

    api.initEncephalon({ root })

    const [workflow] = api
      .listRecords({ includeSuperseded: true, limit: 20, root })
      .filter(record => record.subject === 'encephalon:init/commands-ci')
    assert.ok(workflow)
    const payload = workflow.payload as {
      commands?: unknown
      scriptInvocations?: unknown
      scriptKeys?: unknown
    }
    assert.equal(payload.commands, undefined)
    assert.deepEqual(payload.scriptKeys, [
      '$(date)',
      '--version',
      '`tick`',
      'ci:unit',
      'path/name',
      'quote"key',
      'semi;colon',
      'space name',
      'test',
      'unicodé',
    ])
    assert.deepEqual(payload.scriptInvocations, [
      { arguments: ['run', '$(date)'], executable: 'yarn', scriptKey: '$(date)' },
      { arguments: ['run', '`tick`'], executable: 'yarn', scriptKey: '`tick`' },
      { arguments: ['run', 'ci:unit'], executable: 'yarn', scriptKey: 'ci:unit' },
      { arguments: ['run', 'path/name'], executable: 'yarn', scriptKey: 'path/name' },
      { arguments: ['run', 'quote"key'], executable: 'yarn', scriptKey: 'quote"key' },
      { arguments: ['run', 'semi;colon'], executable: 'yarn', scriptKey: 'semi;colon' },
      { arguments: ['run', 'space name'], executable: 'yarn', scriptKey: 'space name' },
      { arguments: ['run', 'test'], executable: 'yarn', scriptKey: 'test' },
      { arguments: ['run', 'unicodé'], executable: 'yarn', scriptKey: 'unicodé' },
    ])
  })

  test('refresh resolves equivalent generated baseline heads from branch merges', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const subject = 'encephalon:init/repository-overview'
    const { cloned, original } = cloneBaselineRecord(root, subject, 'parallel-overview')

    const refreshed = api.initEncephalon({ refreshBaseline: true, root })

    assert.equal(refreshed.recordsCreated.length, 1)
    const [resolver] = refreshed.recordsCreated
    assert.ok(resolver)
    assert.equal(resolver.subject, subject)
    assert.deepEqual(resolver.supersedes, [cloned.id, original.id].sort(ordinalStringCompare))
    assert.equal(api.validateRecords({ root }).valid, true)
    assert.equal(activeRecordsForSubject(root, subject).length, 1)
    assert.equal(recordsForSubject(root, subject).length, 3)
  })

  test('refresh resolves differing generated baseline heads', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const subject = 'encephalon:init/tooling-layout'
    const { cloned, original } = cloneBaselineRecord(root, subject, 'parallel-tooling', {
      payload: {
        summary: 'Branch-specific generated tooling payload.',
      },
    })

    const refreshed = api.initEncephalon({ refreshBaseline: true, root })

    assert.equal(refreshed.recordsCreated.length, 1)
    const [resolver] = refreshed.recordsCreated
    assert.ok(resolver)
    assert.equal(resolver.subject, subject)
    assert.deepEqual(resolver.supersedes, [cloned.id, original.id].sort(ordinalStringCompare))
    assert.equal(api.validateRecords({ root }).valid, true)
    assert.equal(activeRecordsForSubject(root, subject).length, 1)
  })

  test('refresh returns a structured conflict for a single human-owned baseline head', () => {
    const root = createRoot()
    api.addRecord({
      id: 'human-overview',
      kind: 'context',
      payload: { summary: 'Curated overview' },
      root,
      source: 'human',
      subject: 'encephalon:init/repository-overview',
    })

    const refreshed = api.initEncephalon({ refreshBaseline: true, root })

    assert.deepEqual(refreshed.recordsCreated.map(record => record.subject).sort(ordinalStringCompare), [
      'encephalon:init/commands-ci',
      'encephalon:init/tooling-layout',
    ])
    assert.deepEqual(refreshed.skippedConflicts, [
      {
        activeRecordIds: ['human-overview'],
        kind: 'context',
        subject: 'encephalon:init/repository-overview',
      },
    ])
  })

  test('refresh rejects mixed generated and human baseline heads without repairing them', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const subject = 'encephalon:init/repository-overview'
    cloneBaselineRecord(root, subject, 'human-parallel-overview', { source: 'human' })
    const before = rawRecordFilesForSubject(root, 'context', subject).length

    assert.throws(
      () => api.initEncephalon({ refreshBaseline: true, root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(rawRecordFilesForSubject(root, 'context', subject).length, before)
  })

  test('refresh rejects unrelated active-head conflicts while repairing no baseline subject', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    api.addRecord({
      id: 'custom-head-one',
      kind: 'decision',
      payload: { summary: 'One' },
      root,
      source: 'human',
      subject: 'custom.subject',
    })
    const [custom] = api
      .listRecords({ includeSuperseded: true, limit: 50, root })
      .filter(record => record.id === 'custom-head-one')
    assert.ok(custom)
    writeRecordFile(root, {
      ...readRecordFile(root, custom),
      id: 'custom-head-two',
    })

    assert.throws(
      () => api.initEncephalon({ refreshBaseline: true, root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(api.validateRecords({ root }).valid, false)
  })

  test('refresh rejects malformed supersession graphs while repairing no baseline subject', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const subject = 'encephalon:init/commands-ci'
    cloneBaselineRecord(root, subject, 'parallel-commands')
    writeRecordFile(root, {
      createdAt: '2026-08-08T00:00:00.000Z',
      id: 'missing-supersedes-target',
      kind: 'decision',
      payload: { summary: 'Broken graph' },
      source: 'human',
      subject: 'broken.graph',
      supersedes: ['does-not-exist'],
    })

    assert.throws(
      () => api.initEncephalon({ refreshBaseline: true, root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(rawRecordFilesForSubject(root, 'workflow', subject).length, 2)
  })

  test('skips a reserved subject owned by an agent-authored active record', () => {
    const root = createRoot()
    api.addRecord({
      id: 'agent-overview',
      kind: 'context',
      payload: { summary: 'Curated overview' },
      root,
      source: 'human',
      subject: 'encephalon:init/repository-overview',
    })

    const result = api.initEncephalon({ root })
    assert.deepEqual(result.skippedConflicts, [
      {
        activeRecordIds: ['agent-overview'],
        kind: 'context',
        subject: 'encephalon:init/repository-overview',
      },
    ])
    assert.equal(
      api
        .listRecords({ includeSuperseded: true, limit: 20, root })
        .filter(record => record.subject === 'encephalon:init/repository-overview').length,
      1,
    )
  })

  test('bounds baseline scanning and records deterministic truncation reasons', () => {
    const root = createRoot()
    for (let index = 0; index < 510; index += 1) {
      writeFileSync(join(root, `secret-${String(index).padStart(3, '0')}.ts`), 'export {}\n')
    }
    writeFileSync(join(root, 'package-lock.json'), '{}')

    api.initEncephalon({ root })
    const overview = generatedRecord(root, 'encephalon:init/repository-overview')

    assert.equal((overview.payload as { scannedRegularFiles?: unknown }).scannedRegularFiles, 0)
    assert.deepEqual((overview.payload as { recognisedTopLevelFiles?: unknown }).recognisedTopLevelFiles, [])
    assert.deepEqual((overview.payload as { topLevelDirectories?: unknown }).topLevelDirectories, [])
    assert.deepEqual((overview.payload as { scanTruncationReasons?: unknown }).scanTruncationReasons, [
      'directory-entry-limit',
      'top-level-entry-limit',
    ])
    assert.doesNotMatch(JSON.stringify(overview), /package-lock\.json|secret-/)
  })

  test('accepts exactly 512 raw entries from every baseline directory source', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'boundary-project' }))
    writeFileSync(join(root, 'keep.ts'), 'export {}\n')
    for (let index = 0; index < 507; index += 1) {
      writeFileSync(join(root, `secret-${String(index).padStart(3, '0')}`), '')
    }
    for (let index = 0; index < 511; index += 1) {
      const filler = join(root, '.github', 'workflows', `secret-${String(index).padStart(3, '0')}.txt`)
      ensureParent(filler)
      writeFileSync(filler, '')
    }
    writeFileSync(join(root, '.github', 'workflows', 'accepted.yml'), 'name: accepted\n')

    const baseline = scanBaseline(root)
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.equal(overview.scanTruncated, false)
    assert.deepEqual(overview.scanTruncationReasons, [])
    assert.deepEqual(overview.languageCounts, [{ files: 1, language: 'TypeScript' }])
    assert.equal(overview.scannedRegularFiles, 3)
    assert.deepEqual(overview.recognisedTopLevelFiles, ['package.json'])
    assert.deepEqual(overview.topLevelDirectories, ['.github'])
    assert.deepEqual(tooling.recognisedFiles, ['package.json'])
    assert.deepEqual(workflow.workflowFiles, ['.github/workflows/accepted.yml'])
  })

  test('omits top-level facts rejected at final directory revalidation', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package-lock.json'), '{}')

    const baseline = scanBaselineWithHooks(root, {
      beforeTopLevelRevalidation: () => {
        throw new DirectoryWitnessError()
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')

    assert.deepEqual(overview.recognisedTopLevelFiles, [])
    assert.deepEqual(overview.sources, [])
    assert.deepEqual(tooling.recognisedFiles, [])
    assert.deepEqual(tooling.sources, [])
    assert.deepEqual(overview.scanTruncationReasons, ['unreadable-directory'])
  })

  test('reserves the global language-directory budget before scheduling children', () => {
    const root = createRoot()
    for (const name of ['a', 'b', 'c']) {
      ensureParent(join(root, name, 'index.ts'))
      writeFileSync(join(root, name, 'index.ts'), 'export {}\n')
    }
    let scheduled = 0

    const baseline = scanBaselineWithHooks(root, {
      maximumScannedDirectories: 2,
      onLanguageDirectoryScheduled: () => {
        scheduled += 1
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')

    assert.equal(scheduled, 2)
    assert.deepEqual(overview.languageCounts, [{ files: 1, language: 'TypeScript' }])
    assert.deepEqual(overview.scanTruncationReasons, ['directory-limit'])
  })

  test('does not combine a queued parent generation with a replacement grandchild', () => {
    const root = createRoot()
    const parent = join(root, 'area')
    const child = join(parent, 'src')
    const moved = join(parent, 'moved-src')
    const replacement = join(parent, 'private-replacement-src')
    ensureParent(join(child, 'old.ts'))
    ensureParent(join(replacement, 'new.py'))
    writeFileSync(join(child, 'old.ts'), 'export {}\n')
    writeFileSync(join(replacement, 'new.py'), 'pass\n')

    const baseline = scanBaselineWithHooks(root, {
      beforeLanguageDirectoryCapture: path => {
        if (path === child) {
          renameSync(child, moved)
          renameSync(replacement, child)
        }
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')

    assert.deepEqual(overview.languageCounts, [])
    assert.equal(overview.scannedRegularFiles, 0)
    assert.deepEqual(overview.scanTruncationReasons, ['unreadable-directory'])
  })

  test('rejects a queued parent replaced after its child directory is captured', () => {
    const root = createRoot()
    const parent = join(root, 'area')
    const child = join(parent, 'src')
    const moved = join(parent, 'moved-src')
    const replacement = join(parent, 'private-replacement-src')
    ensureParent(join(child, 'old.ts'))
    ensureParent(join(replacement, 'new.py'))
    writeFileSync(join(child, 'old.ts'), 'export {}\n')
    writeFileSync(join(replacement, 'new.py'), 'pass\n')

    const baseline = scanBaselineWithHooks(root, {
      afterLanguageDirectoryCapture: path => {
        if (path === child) {
          renameSync(child, moved)
          renameSync(replacement, child)
        }
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')

    assert.deepEqual(overview.languageCounts, [])
    assert.equal(overview.scannedRegularFiles, 0)
    assert.deepEqual(overview.scanTruncationReasons, ['unreadable-directory'])
  })

  test('stops before reading one regular file beyond the global limit', () => {
    const root = createRoot()
    writeFileSync(join(root, 'a.ts'), 'export {}\n')
    writeFileSync(join(root, 'b.py'), 'pass\n')
    writeFileSync(join(root, 'c.js'), 'export {}\n')

    const baseline = scanBaselineWithHooks(root, { maximumScannedFiles: 2 })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')

    assert.deepEqual(overview.languageCounts, [
      { files: 1, language: 'Python' },
      { files: 1, language: 'TypeScript' },
    ])
    assert.equal(overview.scannedRegularFiles, 2)
    assert.equal(overview.scanTruncated, true)
    assert.deepEqual(overview.scanTruncationReasons, ['regular-file-limit'])
  })

  test('omits all sources when the repository generation changes across baseline passes', () => {
    const root = createRoot()
    const moved = `${root}-moved`
    roots.push(moved)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'private-project' }))
    writeFileSync(join(root, 'index.ts'), 'export {}\n')
    ensureParent(join(root, '.github', 'workflows', 'private.yml'))
    writeFileSync(join(root, '.github', 'workflows', 'private.yml'), 'name: private\n')

    const baseline = scanBaselineWithHooks(root, {
      afterBaselineSources: () => {
        renameSync(root, moved)
        mkdirSync(root)
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.deepEqual(overview.languageCounts, [])
    assert.deepEqual(overview.recognisedTopLevelFiles, [])
    assert.deepEqual(overview.sources, [])
    assert.deepEqual(overview.scanTruncationReasons, ['unreadable-directory'])
    assert.deepEqual(tooling.sources, [])
    assert.deepEqual(workflow.sources, [])
    assert.doesNotMatch(JSON.stringify(baseline), /private-project|index\.ts|private\.yml/)
  })

  test('propagates unexpected failures after collecting baseline sources', () => {
    const root = createRoot()
    const unexpected = new Error('unexpected test hook failure')

    assert.throws(
      () =>
        scanBaselineWithHooks(root, {
          afterBaselineSources: () => {
            throw unexpected
          },
        }),
      error => error === unexpected,
    )
  })

  test('omits an overflowing nested language directory without dropping sibling facts', () => {
    const root = createRoot()
    writeFileSync(join(root, 'keep.ts'), 'export {}\n')
    for (let index = 0; index < 512; index += 1) {
      const source = join(root, 'large', `secret-${String(index).padStart(3, '0')}.py`)
      ensureParent(source)
      writeFileSync(source, 'pass\n')
    }
    writeFileSync(join(root, 'large', 'visible-sentinel.py'), 'pass\n')

    const baseline = scanBaseline(root)
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')

    assert.deepEqual(overview.languageCounts, [{ files: 1, language: 'TypeScript' }])
    assert.equal(overview.scannedRegularFiles, 1)
    assert.deepEqual(overview.scanTruncationReasons, ['directory-entry-limit'])
    assert.doesNotMatch(JSON.stringify(overview), /Python|visible-sentinel|secret-/)
  })

  test('omits workflow facts when raw workflow enumeration overflows', () => {
    const root = createRoot()
    for (let index = 0; index < 512; index += 1) {
      const workflow = join(root, '.github', 'workflows', `customer-${String(index).padStart(3, '0')}.txt`)
      ensureParent(workflow)
      writeFileSync(workflow, 'name: check\n')
    }
    writeFileSync(join(root, '.github', 'workflows', 'visible-sentinel.yml'), 'name: visible\n')

    const baseline = scanBaseline(root)
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.deepEqual(workflow.workflowFiles, [])
    assert.deepEqual(workflow.sources, [])
    assert.equal(overview.scanTruncated, true)
    assert.deepEqual(overview.scanTruncationReasons, ['directory-entry-limit', 'workflow-entry-limit'])
    assert.doesNotMatch(JSON.stringify(baseline), /customer-|visible-sentinel/)
  })

  test('reports malformed package metadata without retaining partial package facts', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), '{"name":"private-project","scripts":')

    const baseline = scanBaseline(root)
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.equal(overview.scanTruncated, true)
    assert.deepEqual(overview.scanTruncationReasons, ['package-metadata-error'])
    assert.equal('packageName' in tooling, false)
    assert.deepEqual(tooling.workspacePatterns, [])
    assert.deepEqual(workflow.scriptKeys, [])
    assert.deepEqual(overview.sources, [])
    assert.deepEqual(tooling.sources, [])
    assert.deepEqual(workflow.sources, [])
    assert.doesNotMatch(JSON.stringify(baseline), /private-project/)
  })

  test('reports replaced package metadata without retaining the old or new facts', () => {
    const root = createRoot()
    const packagePath = join(root, 'package.json')
    const movedPath = join(root, 'moved-package.json')
    const replacementPath = join(root, 'replacement.json')
    writeFileSync(packagePath, JSON.stringify({ name: 'old-private-project' }))
    writeFileSync(replacementPath, JSON.stringify({ name: 'new-private-project' }))

    const baseline = scanBaselineWithHooks(root, {
      afterPackageMetadataLstat: () => {
        renameSync(packagePath, movedPath)
        renameSync(replacementPath, packagePath)
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assertPackageMetadataErrorReasons(overview.scanTruncationReasons)
    assert.equal('packageName' in tooling, false)
    assert.deepEqual(overview.sources, [])
    assert.deepEqual(tooling.sources, [])
    assert.deepEqual(workflow.sources, [])
    assert.doesNotMatch(JSON.stringify(baseline), /old-private-project|new-private-project/)
  })

  test('reports package metadata that disappears after validated top-level enumeration', () => {
    const root = createRoot()
    const packagePath = join(root, 'package.json')
    const movedPath = join(root, 'moved-package.json')
    writeFileSync(packagePath, JSON.stringify({ name: 'private-project' }))

    const baseline = scanBaselineWithHooks(root, {
      beforePackageMetadataRead: () => {
        renameSync(packagePath, movedPath)
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assertPackageMetadataErrorReasons(overview.scanTruncationReasons)
    assert.equal('packageName' in tooling, false)
    assert.deepEqual(overview.sources, [])
    assert.deepEqual(tooling.sources, [])
    assert.deepEqual(workflow.sources, [])
    assert.doesNotMatch(JSON.stringify(baseline), /private-project|moved-package/)
  })

  test('reports an operational package metadata read failure without source attribution', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'private-project' }))

    const baseline = scanBaselineWithHooks(root, {
      afterPackageMetadataLstat: () => {
        throw Object.assign(new Error('private path'), { code: 'EIO' })
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.deepEqual(overview.scanTruncationReasons, ['package-metadata-error'])
    assert.deepEqual(overview.sources, [])
    assert.deepEqual(tooling.sources, [])
    assert.deepEqual(workflow.sources, [])
    assert.equal('packageName' in tooling, false)
    assert.doesNotMatch(JSON.stringify(baseline), /private-project|private path/)
  })

  test('preserves the exact enumerated package source spelling on case-insensitive file systems', {
    skip: caseInsensitiveSkip,
  }, () => {
    const root = createRoot()
    writeFileSync(join(root, 'Package.json'), JSON.stringify({ name: 'sample-project', scripts: { test: 'private' } }))

    const baseline = scanBaseline(root)
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.equal(tooling.packageName, 'sample-project')
    assert.deepEqual(overview.sources, ['Package.json'])
    assert.deepEqual(tooling.sources, ['Package.json'])
    assert.deepEqual(workflow.sources, ['Package.json'])
    assert.doesNotMatch(JSON.stringify(baseline), /"package\.json"/)
  })

  test('reads the exact package.json when differently-cased aliases coexist', { skip: caseSensitiveSkip }, () => {
    const root = createRoot()
    writeFileSync(join(root, 'Package.json'), JSON.stringify({ name: 'alias-project', scripts: { alias: 'private' } }))
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'canonical-project', scripts: { test: 'private' } }),
    )

    const baseline = scanBaseline(root)
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.equal(tooling.packageName, 'canonical-project')
    assert.deepEqual(overview.sources, ['Package.json', 'package.json'])
    assert.deepEqual(tooling.sources, ['Package.json', 'package.json'])
    assert.deepEqual(workflow.sources, ['package.json'])
    assert.deepEqual(workflow.scriptKeys, ['test'])
    assert.doesNotMatch(JSON.stringify(baseline), /alias-project|"alias"/)
  })

  test('does not treat an uppercase-only alias as package metadata on a case-sensitive file system', {
    skip: caseSensitiveSkip,
  }, () => {
    const root = createRoot()
    writeFileSync(join(root, 'Package.json'), JSON.stringify({ name: 'alias-project', scripts: { alias: 'private' } }))

    const baseline = scanBaseline(root)
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const tooling = generatedPayload(baseline, 'encephalon:init/tooling-layout')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.equal('packageName' in tooling, false)
    assert.deepEqual(overview.sources, ['Package.json'])
    assert.deepEqual(tooling.sources, ['Package.json'])
    assert.deepEqual(workflow.sources, [])
    assert.deepEqual(workflow.scriptKeys, [])
    assert.doesNotMatch(JSON.stringify(baseline), /alias-project|"alias"/)
  })

  test('reports replaced workflow ancestry without retaining workflow facts', () => {
    const root = createRoot()
    const githubPath = join(root, '.github')
    const movedPath = join(root, 'moved-github')
    const replacementPath = join(root, 'replacement-github')
    ensureParent(join(githubPath, 'workflows', 'old-private.yml'))
    ensureParent(join(replacementPath, 'workflows', 'new-private.yml'))
    writeFileSync(join(githubPath, 'workflows', 'old-private.yml'), 'name: old\n')
    writeFileSync(join(replacementPath, 'workflows', 'new-private.yml'), 'name: new\n')

    const baseline = scanBaselineWithHooks(root, {
      afterWorkflowEnumeration: () => {
        renameSync(githubPath, movedPath)
        renameSync(replacementPath, githubPath)
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.deepEqual(overview.scanTruncationReasons, ['unreadable-directory', 'workflow-enumeration-error'])
    assert.deepEqual(workflow.workflowFiles, [])
    assert.deepEqual(workflow.sources, [])
    assert.doesNotMatch(JSON.stringify(workflow), /old-private|new-private|moved-github|replacement-github/)
  })

  test('reports workflow ancestry that disappears after its initial observation', () => {
    const root = createRoot()
    const githubPath = join(root, '.github')
    const movedPath = join(root, 'moved-github')
    ensureParent(join(githubPath, 'workflows', 'private.yml'))
    writeFileSync(join(githubPath, 'workflows', 'private.yml'), 'name: private\n')

    const baseline = scanBaselineWithHooks(root, {
      afterOptionalDirectoryLstat: path => {
        if (path === githubPath) {
          renameSync(githubPath, movedPath)
        }
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.deepEqual(overview.scanTruncationReasons, ['unreadable-directory', 'workflow-enumeration-error'])
    assert.deepEqual(workflow.workflowFiles, [])
    assert.deepEqual(workflow.sources, [])
    assert.doesNotMatch(JSON.stringify(baseline), /private\.yml|moved-github/)
  })

  test('reports workflow ancestry that disappears before its preliminary metadata check', () => {
    const root = createRoot()
    const githubPath = join(root, '.github')
    const movedPath = join(root, 'moved-github')
    ensureParent(join(githubPath, 'workflows', 'private.yml'))
    writeFileSync(join(githubPath, 'workflows', 'private.yml'), 'name: private\n')

    const baseline = scanBaselineWithHooks(root, {
      beforeWorkflowDirectoryCapture: () => {
        renameSync(githubPath, movedPath)
      },
    })
    const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')
    const workflow = generatedPayload(baseline, 'encephalon:init/commands-ci')

    assert.deepEqual(overview.scanTruncationReasons, ['unreadable-directory', 'workflow-enumeration-error'])
    assert.deepEqual(workflow.workflowFiles, [])
    assert.deepEqual(workflow.sources, [])
    assert.doesNotMatch(JSON.stringify(baseline), /private\.yml|moved-github/)
  })

  test('reports an unreadable language directory without retaining its names', {
    skip: unreadableDirectorySkip,
  }, () => {
    const root = createRoot()
    const directory = join(root, 'customer-project')
    ensureParent(join(directory, 'private-source.ts'))
    writeFileSync(join(directory, 'private-source.ts'), 'export {}\n')
    chmodSync(directory, 0o000)
    try {
      const baseline = scanBaseline(root)
      const overview = generatedPayload(baseline, 'encephalon:init/repository-overview')

      assert.equal(overview.scanTruncated, true)
      assert.deepEqual(overview.scanTruncationReasons, ['unreadable-directory'])
      assert.deepEqual(overview.languageCounts, [])
      assert.doesNotMatch(JSON.stringify(overview), /private-source/)
    } finally {
      chmodSync(directory, 0o700)
    }
  })

  test('bounds baseline scanner depth without following deep chains forever', () => {
    const root = createRoot()
    let current = root
    for (let index = 0; index < 30; index += 1) {
      current = join(current, `level-${String(index).padStart(2, '0')}`)
      ensureParent(join(current, 'placeholder'))
    }
    writeFileSync(join(current, 'deep.ts'), 'export {}\n')

    api.initEncephalon({ root })
    const overview = generatedRecord(root, 'encephalon:init/repository-overview')

    assert.deepEqual((overview.payload as { scanTruncationReasons?: unknown }).scanTruncationReasons, ['max-depth'])
  })

  test('does not enumerate workflows through a symlinked .github ancestor', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit directory symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const outside = createRoot()
    ensureParent(join(outside, '.github', 'workflows', 'leaked.yml'))
    writeFileSync(join(outside, '.github', 'workflows', 'leaked.yml'), 'name: leaked\n')
    symlinkSync(join(outside, '.github'), join(root, '.github'))

    api.initEncephalon({ root })
    const overview = generatedRecord(root, 'encephalon:init/repository-overview')
    const workflow = generatedRecord(root, 'encephalon:init/commands-ci')

    assert.deepEqual((workflow.payload as { workflowFiles?: unknown }).workflowFiles, [])
    assert.deepEqual((workflow.payload as { sources?: unknown }).sources, [])
    assert.equal((overview.payload as { scanTruncated?: unknown }).scanTruncated, true)
    assert.deepEqual((overview.payload as { scanTruncationReasons?: unknown }).scanTruncationReasons, [
      'workflow-enumeration-error',
    ])
    assert.doesNotMatch(JSON.stringify([overview, workflow]), /leaked\.yml/)
  })

  test('preflights both instruction files before writing anything', () => {
    const root = createRoot()
    const malformed = 'before\n<!-- encephalon:managed-instructions:start {} -->\nafter'
    writeFileSync(join(root, 'AGENTS.md'), malformed)
    writeFileSync(join(root, 'CLAUDE.md'), 'untouched')

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), malformed)
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), 'untouched')
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('rejects symlinked instruction files before changing records or link targets', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit file symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const target = join(root, 'outside-agents.md')
    const original = '# Outside guidance\n'
    writeFileSync(target, original)
    symlinkSync(target, join(root, 'AGENTS.md'))

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(readFileSync(target, 'utf8'), original)
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  const invalidUtf8Cases = [
    ['overlong sequence', Buffer.from([0xc0, 0xaf])],
    ['lone continuation byte', Buffer.from([0x80])],
    ['truncated multibyte sequence', Buffer.from([0xe2, 0x82])],
    ['malformed surrogate encoding', Buffer.from([0xed, 0xa0, 0x80])],
  ] as const

  for (const [name, bytes] of invalidUtf8Cases) {
    test(`rejects instruction files containing invalid UTF-8: ${name}`, () => {
      const root = createRoot()
      const agentsPath = join(root, 'AGENTS.md')
      const claudePath = join(root, 'CLAUDE.md')
      const originalAgents = Buffer.concat([Buffer.from('# Guidance\n'), bytes, Buffer.from('\n')])
      const originalClaude = Buffer.from('untouched')
      writeFileSync(agentsPath, originalAgents)
      writeFileSync(claudePath, originalClaude)

      assertErrorCode(() => api.initEncephalon({ root }), 'VALIDATION_FAILED')

      assert.deepEqual(readFileSync(agentsPath), originalAgents)
      assert.deepEqual(readFileSync(claudePath), originalClaude)
      assert.equal(existsSync(join(root, 'encephalon')), false)
    })
  }

  test('rejects embedded NUL bytes without changing either instruction file', () => {
    const root = createRoot()
    const agentsPath = join(root, 'AGENTS.md')
    const claudePath = join(root, 'CLAUDE.md')
    const originalAgents = Buffer.from('before\0after')
    const originalClaude = Buffer.from('untouched')
    writeFileSync(agentsPath, originalAgents)
    writeFileSync(claudePath, originalClaude)

    assertErrorCode(() => api.initEncephalon({ root }), 'VALIDATION_FAILED')

    assert.deepEqual(readFileSync(agentsPath), originalAgents)
    assert.deepEqual(readFileSync(claudePath), originalClaude)
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('rejects an instruction file that cannot fit the managed block without mutation', () => {
    const root = createRoot()
    const agentsPath = join(root, 'AGENTS.md')
    const claudePath = join(root, 'CLAUDE.md')
    const originalAgents = Buffer.alloc(MAX_INSTRUCTION_FILE_BYTES, 0x61)
    const originalClaude = Buffer.from('untouched')
    writeFileSync(agentsPath, originalAgents)
    writeFileSync(claudePath, originalClaude)

    assertErrorCode(
      () => api.initEncephalon({ root }),
      'VALIDATION_FAILED',
      /cannot fit the Encephalon managed block within the 1 MiB instruction-file limit/,
    )

    assert.deepEqual(readFileSync(agentsPath), originalAgents)
    assert.deepEqual(readFileSync(claudePath), originalClaude)
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('round-trips an instruction file whose managed bytes exactly reach the size limit', () => {
    const root = createRoot()
    const agentsPath = join(root, 'AGENTS.md')
    writeFileSync(agentsPath, Buffer.from('a'))
    const [samplePlan] = planInstructionChanges(root, false)
    if (samplePlan?.action !== 'write' || samplePlan.contentBytes === undefined) {
      assert.fail('Expected a write plan for a non-empty instruction file.')
    }
    const managedOverheadBytes = samplePlan.contentBytes.length - 1
    const originalAgents = Buffer.alloc(MAX_INSTRUCTION_FILE_BYTES - managedOverheadBytes, 0x61)
    writeFileSync(agentsPath, originalAgents)

    api.initEncephalon({ root })

    assert.equal(readFileSync(agentsPath).length, MAX_INSTRUCTION_FILE_BYTES)

    api.initEncephalon({ remove: true, root })

    assert.deepEqual(readFileSync(agentsPath), originalAgents)
  })

  test('rejects an instruction file over the preflight size limit without mutation', () => {
    const root = createRoot()
    const agentsPath = join(root, 'AGENTS.md')
    const claudePath = join(root, 'CLAUDE.md')
    const originalAgents = Buffer.alloc(MAX_INSTRUCTION_FILE_BYTES + 1, 0x61)
    const originalClaude = Buffer.from('untouched')
    writeFileSync(agentsPath, originalAgents)
    writeFileSync(claudePath, originalClaude)

    assertErrorCode(() => api.initEncephalon({ root }), 'VALIDATION_FAILED')

    assert.deepEqual(readFileSync(agentsPath), originalAgents)
    assert.deepEqual(readFileSync(claudePath), originalClaude)
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('rejects managed metadata containing a separator Encephalon never emits', () => {
    const root = createRoot()
    const separator = 'forged-separator'
    const metadata = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        lineEnding: 'LF',
        originalFileExisted: true,
        separatorBase64: Buffer.from(separator, 'utf8').toString('base64'),
      }),
      'utf8',
    ).toString('base64url')
    writeFileSync(
      join(root, 'AGENTS.md'),
      [
        `${separator}<!-- encephalon:managed-instructions:start ${metadata} -->`,
        '## Encephalon',
        'Read and follow the repository-memory skill before making repository assumptions or recording durable knowledge:',
        './node_modules/encephalon/skills/encephalon/SKILL.md',
        '<!-- encephalon:managed-instructions:end -->',
        '',
      ].join('\n'),
    )

    assert.throws(
      () => api.initEncephalon({ remove: true, root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
  })

  test('round-trips CRLF files byte-for-byte and preserves user content added after the block', () => {
    const root = createRoot()
    const original = '# Existing guidance\r\n\r\nKeep this exactly.\r\n'
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, original)
    api.initEncephalon({ root })
    const installed = readFileSync(path, 'utf8')
    assert.match(installed, /\r\n## Encephalon\r\n/)
    writeFileSync(path, `${installed}User addition.\r\n`)

    api.initEncephalon({ remove: true, root })
    assert.equal(readFileSync(path, 'utf8'), `${original}User addition.\r\n`)
  })

  test('round-trips mixed line endings and no-final-newline files byte-for-byte', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('\uFEFF# Existing guidance\r\nKeep café\nNo final newline')
    writeFileSync(path, original)

    api.initEncephalon({ root })
    api.initEncephalon({ remove: true, root })

    assert.deepEqual(readFileSync(path), original)
  })

  test('atomically publishes instruction replacements and preserves the existing file mode', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    chmodSync(path, 0o744)

    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)
    applyInstructionChanges(root, [agentsPlan])

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o744)
    }
    assert.deepEqual(
      readdirSync(root).filter(
        filename =>
          filename.startsWith('.AGENTS.md.') &&
          (filename.endsWith('.backup') || filename.endsWith('.delete') || filename.endsWith('.tmp')),
      ),
      [],
    )
  })

  test('instruction replacements preserve historical generated-looking aliases', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const historicalNames = [
      '.AGENTS.md.123.550e8400-e29b-41d4-a716-446655440002.tmp',
      '.AGENTS.md.123.550e8400-e29b-41d4-a716-446655440000.backup',
      '.AGENTS.md.123.550e8400-e29b-41d4-a716-446655440001.delete',
    ] as const
    writeFileSync(path, '# Existing guidance\n')
    const historical = historicalNames.map((name, index) => {
      const aliasPath = join(root, name)
      const bytes = Buffer.from(`historical-${index}`)
      writeFileSync(aliasPath, bytes)
      const metadata = statSync(aliasPath, { bigint: true })
      return { bytes, dev: metadata.dev, ino: metadata.ino, name }
    })
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    applyInstructionChanges(root, [agentsPlan])

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(
      historical.map(entry => {
        const metadata = statSync(join(root, entry.name), { bigint: true })
        return {
          bytes: readFileSync(join(root, entry.name)),
          dev: metadata.dev,
          ino: metadata.ino,
          name: entry.name,
        }
      }),
      historical,
    )
    assert.deepEqual(
      readdirSync(root)
        .filter(
          filename =>
            filename.startsWith('.AGENTS.md.') &&
            (filename.endsWith('.backup') || filename.endsWith('.delete') || filename.endsWith('.tmp')),
        )
        .sort(ordinalStringCompare),
      [...historicalNames].sort(ordinalStringCompare),
    )
  })

  test('instruction backup creation preserves an exact destination collision', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Existing guidance\n')
    const collisionBytes = Buffer.from('historical backup collision')
    let collisionPath: string | undefined
    let collisionIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, original)
    chmodSync(path, 0o741)
    const originalMetadata = statSync(path, { bigint: true })
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point, generatedPath) => {
            if (point === 'before-backup-create') {
              assert.ok(generatedPath)
              collisionPath = generatedPath
              writeFileSync(generatedPath, collisionBytes)
              const metadata = statSync(generatedPath, { bigint: true })
              collisionIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    const finalCanonicalMetadata = statSync(path, { bigint: true })
    assert.deepEqual(
      { dev: finalCanonicalMetadata.dev, ino: finalCanonicalMetadata.ino },
      { dev: originalMetadata.dev, ino: originalMetadata.ino },
    )
    if (process.platform !== 'win32') {
      assert.equal(finalCanonicalMetadata.mode & 0o777n, originalMetadata.mode & 0o777n)
    }
    assert.ok(collisionPath)
    assert.deepEqual(readFileSync(collisionPath), collisionBytes)
    const finalMetadata = statSync(collisionPath, { bigint: true })
    assert.deepEqual({ dev: finalMetadata.dev, ino: finalMetadata.ino }, collisionIdentity)
    assert.equal(
      readdirSync(root).some(name => name.startsWith('.AGENTS.md.') && name.endsWith('.tmp')),
      false,
    )
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('keeps a held canonical predecessor when backup creation fails before linking', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Existing guidance\n')
    writeFileSync(path, original)
    chmodSync(path, 0o741)
    const originalMetadata = statSync(path, { bigint: true })
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point: string) => {
            if (point === 'before-backup-create') {
              throw Object.assign(new Error('Injected pre-link backup failure'), { code: 'EIO' })
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        assert.deepEqual((error as { details?: unknown }).details, {})
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    const finalMetadata = statSync(path, { bigint: true })
    assert.deepEqual(
      { dev: finalMetadata.dev, ino: finalMetadata.ino },
      { dev: originalMetadata.dev, ino: originalMetadata.ino },
    )
    if (process.platform !== 'win32') {
      assert.equal(finalMetadata.mode & 0o777n, 0o741n)
    }
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  const instructionRecoveryAction = {
    backupCleanup:
      'Inspect the repository root and remove only a confirmed backup left by this operation before retrying.',
    publicationFlush:
      'Repeat the same init operation with the same options to revalidate the unchanged canonical instruction file and sync its containing directory.',
    publicationVerification:
      'Inspect the canonical instruction file before retrying; the linked replacement may have been displaced by a concurrent change.',
    resourceCleanup:
      'No instruction alias requires removal. If using the API, end the current process before retrying to release any descriptor that may remain.',
    temporaryCleanup:
      'Inspect the repository root and remove only a confirmed temporary file left by this operation before retrying.',
  } as const

  const instructionAliasSuffixes = (root: string) =>
    readdirSync(root)
      .filter(
        filename =>
          filename.startsWith('.AGENTS.md.') &&
          (filename.endsWith('.backup') || filename.endsWith('.delete') || filename.endsWith('.tmp')),
      )
      .map(filename => filename.slice(filename.lastIndexOf('.')))
      .sort(ordinalStringCompare)

  const assertCommittedInstructionError = (
    error: unknown,
    code: 'INTERNAL_ERROR' | 'IO_ERROR' | 'REPOSITORY_CHANGED',
    postCommitPhase: keyof typeof instructionRecoveryAction,
    postCommitPhases: readonly (keyof typeof instructionRecoveryAction)[] = [postCommitPhase],
  ) => {
    const actual = error as { code?: unknown; details?: Record<string, unknown> }
    assert.equal(actual.code, code)
    const { recoveryPaths, ...details } = actual.details ?? {}
    assert.ok(Array.isArray(recoveryPaths))
    assert.equal(recoveryPaths.length <= 4, true)
    assert.deepEqual(recoveryPaths, [...recoveryPaths].sort(ordinalStringCompare))
    for (const recoveryPath of recoveryPaths) {
      assert.equal(typeof recoveryPath, 'string')
      assert.equal(dirname(recoveryPath), '.')
    }
    assert.deepEqual(details, {
      filename: 'AGENTS.md',
      instructionCommitted: true,
      postCommitFailures: postCommitPhases.map(phase => ({
        postCommitPhase: phase,
        recoveryAction: instructionRecoveryAction[phase],
      })),
      postCommitPhase,
      recoveryAction: instructionRecoveryAction[postCommitPhase],
    })
    return true
  }

  test('classifies instruction authority identity failures at every apply boundary', () => {
    for (const boundary of ['construction', 'plan-validation', 'unchanged-flush'] as const) {
      const root = createRoot()
      const displacedRoot = `${root}-${boundary}`
      roots.push(displacedRoot)
      let plans = planInstructionChanges(root, false)
      if (boundary === 'unchanged-flush') {
        applyInstructionChanges(root, plans)
        plans = planInstructionChanges(root, false)
        assert.equal(
          plans.every(plan => plan.action === 'none'),
          true,
        )
      }
      let replaced = false
      const replaceRoot = () => {
        replaced = true
        renameSync(root, displacedRoot)
        writeFileSync(root, 'replacement root')
      }
      if (boundary === 'construction') {
        replaceRoot()
      }

      assert.throws(
        () =>
          applyInstructionChanges(root, plans, {
            fault: (point: string) => {
              if (
                (boundary === 'plan-validation' && point === 'before-plan-validation') ||
                (boundary === 'unchanged-flush' && point === 'during-publication-flush')
              ) {
                replaceRoot()
              }
            },
          } as never),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED', boundary)
          return true
        },
      )
      assert.equal(replaced, true, boundary)
      assert.equal(readFileSync(root, 'utf8'), 'replacement root')
    }
  })

  test('reports a post-link authority failure even when final authority checks recover', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point: string) => {
            if (point === 'after-publication-link') {
              throw Object.assign(new Error('Injected post-link authority failure'), {
                code: 'EIO',
              })
            }
          },
        } as never),
      (error: unknown) => assertCommittedInstructionError(error, 'IO_ERROR', 'publicationVerification'),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('aggregates root authority close failure with a structured committed failure', {
    skip: process.platform === 'win32' ? 'Windows does not hold a repository-root directory descriptor.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point: string) => {
            if (point === 'after-publication') {
              throw Object.assign(new Error('Injected committed publication failure'), {
                code: 'EIO',
              })
            }
          },
          rootClose: (descriptor: number) => {
            closeSync(descriptor)
            throw Object.assign(new Error('Injected root descriptor close failure'), {
              code: 'EIO',
            })
          },
        } as never),
      (error: unknown) =>
        assertCommittedInstructionError(error, 'IO_ERROR', 'publicationVerification', [
          'publicationVerification',
          'resourceCleanup',
        ]),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('reports repository-root descriptor close failure as committed resource cleanup', {
    skip: process.platform === 'win32' ? 'Windows does not hold a repository-root directory descriptor.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          rootClose: (descriptor: number) => {
            closeSync(descriptor)
            throw Object.assign(new Error('Injected root descriptor close failure'), {
              code: 'EIO',
            })
          },
        } as never),
      (error: unknown) => assertCommittedInstructionError(error, 'IO_ERROR', 'resourceCleanup'),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('classifies an undurable fallback recovery alias and reports only its exact path', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedPredecessor = join(root, 'retained-undurable-predecessor')
    const original = Buffer.from('# Existing guidance\n')
    let backupPath: string | undefined
    let recoveryFlushes = 0
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point: string) => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
              throw Object.assign(new Error('Injected precommit failure'), { code: 'EIO' })
            }
            if (point === 'during-backup-restore') {
              assert.ok(backupPath)
              renameSync(backupPath, retainedPredecessor)
            }
            if (point === 'during-recovery-alias-flush') {
              recoveryFlushes += 1
              throw Object.assign(new Error('Injected recovery alias durability failure'), {
                code: 'EIO',
              })
            }
          },
        } as never),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: Record<string, unknown> }
        assert.equal(actual.code, 'IO_ERROR')
        const recoveryPaths = actual.details?.recoveryPaths
        assert.ok(Array.isArray(recoveryPaths))
        assert.equal(recoveryPaths.length, 1)
        assert.match(recoveryPaths[0] as string, /^\.AGENTS\.md\..+\.backup$/u)
        return true
      },
    )

    assert.equal(recoveryFlushes, 1)
    assert.equal(existsSync(path), false)
    assert.deepEqual(readFileSync(retainedPredecessor), original)
    const [recoveryName] = readdirSync(root).filter(name => name.endsWith('.backup'))
    assert.ok(recoveryName)
    assert.deepEqual(readFileSync(join(root, recoveryName)), original)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('binds deletion-only plans to the fixed repository root authority', () => {
    const root = createRoot()
    const displacedRoot = `${root}-delete-root-authority`
    const path = join(root, 'AGENTS.md')
    roots.push(displacedRoot)
    const agentsPlan = createDeletePlan(root)
    const original = readFileSync(path)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point: string) => {
            if (point === 'before-delete-move') {
              renameSync(root, displacedRoot)
              mkdirSync(root)
              linkSync(join(displacedRoot, 'AGENTS.md'), path)
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    assert.deepEqual(readFileSync(join(displacedRoot, 'AGENTS.md')), original)
  })

  test('classifies predecessor disappearance at descriptor open as repository change', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point: string) => {
            if (point === 'before-predecessor-open') {
              rmSync(path)
            }
          },
        } as never),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.equal(existsSync(path), false)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('reports and retains an alias linked through the documented root-path syscall window', {
    skip: renameParentWithOpenChildSkip,
  }, () => {
    const root = createRoot()
    const displacedRoot = `${root}-alias-link-window`
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Existing guidance\n')
    let backupPath: string | undefined
    roots.push(displacedRoot)
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point: string, generatedPath?: string) => {
            if (point === 'before-alias-link') {
              assert.ok(generatedPath)
              backupPath = generatedPath
              renameSync(root, displacedRoot)
              mkdirSync(root)
              linkSync(join(displacedRoot, 'AGENTS.md'), path)
            }
          },
        } as never),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: Record<string, unknown> }
        assert.equal(actual.code, 'REPOSITORY_CHANGED')
        assert.ok(backupPath)
        assert.deepEqual(actual.details?.recoveryPaths, [backupPath.slice(root.length + 1)])
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    assert.ok(backupPath)
    assert.deepEqual(readFileSync(backupPath), original)
    assert.deepEqual(readFileSync(join(displacedRoot, 'AGENTS.md')), original)
  })

  test('reports recovery paths in explicit ordinal order', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)
    const expectedPaths = ['.AGENTS.md.Z.backup', '.AGENTS.md.a.tmp'] as const

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point: string) => {
            if (point === 'during-publication-flush') {
              throw Object.assign(new Error('Injected persistent publication flush failure'), {
                code: 'EIO',
              })
            }
          },
          generatedPath: (_canonicalPath: string, suffix: string) =>
            join(root, suffix === 'backup' ? expectedPaths[0] : expectedPaths[1]),
        } as never),
      (error: unknown) => {
        const actual = error as { details?: Record<string, unknown> }
        assert.deepEqual(actual.details?.recoveryPaths, expectedPaths)
        return true
      },
    )
  })

  test('accepts only documented unsupported directory sync errors', {
    skip: process.platform === 'win32' ? 'Windows does not expose a directory descriptor to sync.' : false,
  }, () => {
    for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']) {
      const root = createRoot()
      const [agentsPlan] = planInstructionChanges(root, false)
      assert.ok(agentsPlan)
      let syncAttempts = 0

      assert.deepEqual(
        applyInstructionChanges(root, [agentsPlan], {
          syncDirectory: () => {
            syncAttempts += 1
            throw Object.assign(new Error(`Injected unsupported directory sync ${code}`), {
              code,
            })
          },
        } as never),
        [{ action: 'updated', file: 'AGENTS.md' }],
      )
      assert.equal(syncAttempts >= 2, true)
      assert.deepEqual(instructionAliasSuffixes(root), [])
    }
  })

  test('closes an owned staged descriptor when root validation fails after its open', {
    skip: renameParentWithOpenChildSkip,
  }, () => {
    const root = createRoot()
    const displacedRoot = `${root}-staged-open-authority`
    let createdDescriptor: number | undefined
    let createdEntry: string | undefined
    let createdIdentity: { dev: bigint; ino: bigint; mode: bigint } | undefined
    roots.push(displacedRoot)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: ((point: string, generatedPath?: string, descriptor?: number) => {
            if (point === 'after-temp-create') {
              assert.ok(generatedPath)
              assert.equal(typeof descriptor, 'number')
              createdEntry = generatedPath.slice(root.length + 1)
              createdDescriptor = descriptor
              const metadata = statSync(generatedPath, { bigint: true })
              createdIdentity = {
                dev: metadata.dev,
                ino: metadata.ino,
                mode: metadata.mode & 0o777n,
              }
              renameSync(root, displacedRoot)
              mkdirSync(root)
              writeFileSync(join(root, 'successor-sentinel'), 'replacement root')
            }
          }) as never,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.equal(readFileSync(join(root, 'successor-sentinel'), 'utf8'), 'replacement root')
    assert.ok(createdDescriptor)
    assert.throws(
      () => fstatSync(createdDescriptor as number),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF',
    )
    assert.ok(createdEntry)
    const retainedMetadata = statSync(join(displacedRoot, createdEntry), { bigint: true })
    assert.deepEqual(
      {
        dev: retainedMetadata.dev,
        ino: retainedMetadata.ino,
        mode: retainedMetadata.mode & 0o777n,
      },
      createdIdentity,
    )
    assert.equal(retainedMetadata.mode & 0o777n, 0o600n)
  })

  test('writes and verifies staged instruction bytes while the temporary file is private', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Existing guidance\n')
    let privateMode: number | undefined
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-temp-write') {
              const [tempName] = readdirSync(root).filter(name => name.endsWith('.tmp'))
              assert.ok(tempName)
              privateMode = statSync(join(root, tempName)).mode & 0o777
            }
            if (point === 'during-file-flush') {
              const [tempName] = readdirSync(root).filter(name => name.endsWith('.tmp'))
              assert.ok(tempName)
              writeFileSync(
                join(root, tempName),
                Buffer.concat([agentsPlan.contentBytes ?? Buffer.alloc(0), Buffer.from('tamper')]),
              )
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.equal(typeof privateMode, 'number')
    if (process.platform !== 'win32') {
      assert.equal(privateMode, 0o600)
    }
    assert.deepEqual(readFileSync(path), original)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('replaces a readable predecessor without requiring write access to hold it', { skip: readOnlyHoldSkip }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Read-only predecessor\n')
    chmodSync(path, 0o444)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)
    assert.deepEqual(applyInstructionChanges(root, [agentsPlan]), [{ action: 'updated', file: 'AGENTS.md' }])
    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.equal(statSync(path).mode & 0o777, 0o444)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('closes an owned recovery descriptor when root validation fails after its open', {
    skip: renameParentWithOpenChildSkip,
  }, () => {
    const root = createRoot()
    const displacedRoot = `${root}-recovery-open-authority`
    const path = join(root, 'AGENTS.md')
    const retainedPredecessor = join(root, 'retained-recovery-open-predecessor')
    let createdDescriptor: number | undefined
    let createdEntry: string | undefined
    let createdIdentity: { dev: bigint; ino: bigint; mode: bigint } | undefined
    roots.push(displacedRoot)
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: ((point: string, generatedPath?: string, descriptor?: number) => {
            if (point === 'before-backup-create') {
              renameSync(path, retainedPredecessor)
              writeFileSync(path, '# Concurrent successor\n')
            }
            if (point === 'after-recovery-open') {
              assert.ok(generatedPath)
              assert.equal(typeof descriptor, 'number')
              createdEntry = generatedPath.slice(root.length + 1)
              createdDescriptor = descriptor
              const metadata = statSync(generatedPath, { bigint: true })
              createdIdentity = {
                dev: metadata.dev,
                ino: metadata.ino,
                mode: metadata.mode & 0o777n,
              }
              renameSync(root, displacedRoot)
              mkdirSync(root)
              writeFileSync(join(root, 'successor-sentinel'), 'replacement root')
            }
          }) as never,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.equal(readFileSync(join(root, 'successor-sentinel'), 'utf8'), 'replacement root')
    assert.ok(createdDescriptor)
    assert.throws(
      () => fstatSync(createdDescriptor as number),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF',
    )
    assert.ok(createdEntry)
    const retainedMetadata = statSync(join(displacedRoot, createdEntry), { bigint: true })
    assert.deepEqual(
      {
        dev: retainedMetadata.dev,
        ino: retainedMetadata.ino,
        mode: retainedMetadata.mode & 0o777n,
      },
      createdIdentity,
    )
    assert.equal(retainedMetadata.mode & 0o777n, 0o600n)
  })

  test('restores through a verified descriptor copy when the durable backup is displaced', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedPredecessor = join(root, 'retained-copy-predecessor')
    const original = Buffer.from('# Copy-restored predecessor\r\n')
    const successor = Buffer.from('concurrent backup successor')
    let backupPath: string | undefined
    let copyIdentity: { dev: bigint; ino: bigint } | undefined
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, original)
    chmodSync(path, 0o741)
    const predecessorIdentity = statSync(path, { bigint: true })
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point, generatedPath) => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
              throw Object.assign(new Error('Injected precommit failure'), { code: 'EIO' })
            }
            if (point === 'during-backup-restore') {
              assert.ok(backupPath)
              renameSync(backupPath, retainedPredecessor)
              writeFileSync(backupPath, successor)
              const metadata = statSync(backupPath, { bigint: true })
              successorIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
            if (point === 'after-recovery-create') {
              assert.ok(generatedPath)
              const metadata = statSync(generatedPath, { bigint: true })
              copyIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    const canonical = statSync(path, { bigint: true })
    assert.deepEqual({ dev: canonical.dev, ino: canonical.ino }, copyIdentity)
    assert.notDeepEqual(
      { dev: canonical.dev, ino: canonical.ino },
      { dev: predecessorIdentity.dev, ino: predecessorIdentity.ino },
    )
    assert.equal(canonical.mode & 0o777n, 0o741n)
    assert.ok(backupPath)
    assert.deepEqual(readFileSync(backupPath), successor)
    const finalSuccessor = statSync(backupPath, { bigint: true })
    assert.deepEqual({ dev: finalSuccessor.dev, ino: finalSuccessor.ino }, successorIdentity)
    assert.deepEqual(readFileSync(retainedPredecessor), original)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('rejects a descriptor recovery copy whose private bytes are altered', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedPredecessor = join(root, 'retained-private-copy-predecessor')
    const original = Buffer.from('# Exact private recovery bytes\n')
    let tampered = false
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: ((point: string, generatedPath?: string) => {
            if (point === 'before-backup-create') {
              renameSync(path, retainedPredecessor)
              writeFileSync(path, '# Concurrent successor\n')
            }
            if (point === 'after-recovery-private-flush' && !tampered) {
              assert.ok(generatedPath)
              tampered = true
              writeFileSync(generatedPath, Buffer.concat([original, Buffer.from('tamper')]))
            }
          }) as never,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.equal(readFileSync(path, 'utf8'), '# Concurrent successor\n')
    assert.deepEqual(readFileSync(retainedPredecessor), original)
    const exactRecoveryAliases = readdirSync(root)
      .filter(name => name.endsWith('.backup'))
      .filter(name => readFileSync(join(root, name)).equals(original))
    assert.equal(exactRecoveryAliases.length, 1)
  })

  test('allows unrelated repository-root entries while exact instruction entries remain bound', () => {
    const root = createRoot()
    const unrelatedPath = join(root, 'unrelated-concurrent-entry')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.deepEqual(
      applyInstructionChanges(root, [agentsPlan], {
        fault: point => {
          if (point === 'during-temp-write') {
            writeFileSync(unrelatedPath, 'unrelated')
          }
        },
      }),
      [{ action: 'updated', file: 'AGENTS.md' }],
    )

    assert.deepEqual(readFileSync(join(root, 'AGENTS.md')), agentsPlan.contentBytes)
    assert.equal(readFileSync(unrelatedPath, 'utf8'), 'unrelated')
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('flushes a restored canonical predecessor before unlinking its durable recovery source', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Durable restored predecessor\n')
    let backupPath: string | undefined
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: ((point: string) => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
              throw Object.assign(new Error('Injected precommit failure'), { code: 'EIO' })
            }
            if (point === 'during-restore-flush') {
              assert.ok(backupPath)
              const canonical = statSync(path, { bigint: true })
              const backup = statSync(backupPath, { bigint: true })
              assert.deepEqual({ dev: canonical.dev, ino: canonical.ino }, { dev: backup.dev, ino: backup.ino })
              throw Object.assign(new Error('Injected restore durability failure'), {
                code: 'EIO',
              })
            }
          }) as never,
        }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: Record<string, unknown> }
        assert.equal(actual.code, 'IO_ERROR')
        assert.ok(backupPath)
        assert.deepEqual(actual.details?.recoveryPaths, [backupPath.slice(root.length + 1)])
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    assert.ok(backupPath)
    assert.deepEqual(readFileSync(backupPath), original)
    const canonical = statSync(path, { bigint: true })
    const backup = statSync(backupPath, { bigint: true })
    assert.deepEqual({ dev: canonical.dev, ino: canonical.ino }, { dev: backup.dev, ino: backup.ino })
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('retains a private staged recovery alias when temporary unlink loses the canonical target', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const successor = Buffer.from('# Concurrent post-temp-unlink successor\n')
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: ((point: string) => {
            if (point === 'after-temp-unlink') {
              rmSync(path)
              writeFileSync(path, successor)
              const metadata = statSync(path, { bigint: true })
              successorIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          }) as never,
        }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: Record<string, unknown> }
        assert.equal(actual.code, 'REPOSITORY_CHANGED')
        assert.equal(actual.details?.postCommitPhase, 'publicationVerification')
        const recoveryPaths = actual.details?.recoveryPaths
        assert.ok(Array.isArray(recoveryPaths))
        assert.equal(recoveryPaths.length, 1)
        assert.match(recoveryPaths[0] as string, /^\.AGENTS\.md\..+\.tmp$/u)
        return true
      },
    )

    assert.deepEqual(readFileSync(path), successor)
    const finalSuccessor = statSync(path, { bigint: true })
    assert.deepEqual({ dev: finalSuccessor.dev, ino: finalSuccessor.ino }, successorIdentity)
    const [recoveryName] = readdirSync(root).filter(name => name.endsWith('.tmp'))
    assert.ok(recoveryName)
    assert.deepEqual(readFileSync(join(root, recoveryName)), agentsPlan.contentBytes)
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(root, recoveryName)).mode & 0o777, 0o600)
    }
    assert.deepEqual(instructionAliasSuffixes(root), ['.tmp'])
  })

  test('classifies the aggregate as repository change when any committed failure is identity-uncertain', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-publication') {
              throw Object.assign(new Error('Injected verification I/O failure'), { code: 'EIO' })
            }
            if (point === 'during-backup-cleanup') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              rmSync(join(root, backupName))
            }
          },
        }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: Record<string, unknown> }
        assert.equal(actual.code, 'REPOSITORY_CHANGED')
        assert.equal(actual.details?.postCommitPhase, 'publicationVerification')
        const postCommitFailures = actual.details?.postCommitFailures
        assert.ok(Array.isArray(postCommitFailures))
        assert.deepEqual(
          postCommitFailures.map(failure => failure.postCommitPhase),
          ['publicationVerification', 'backupCleanup'],
        )
        return true
      },
    )
  })

  test('reports descriptor-close failures as resource cleanup without inventing aliases', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)
    let injected = false

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          close: ((descriptor: number) => {
            closeSync(descriptor)
            if (!injected) {
              injected = true
              throw Object.assign(new Error('Injected descriptor close failure'), { code: 'EIO' })
            }
          }) as never,
        } as never),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: Record<string, unknown> }
        assert.equal(actual.code, 'IO_ERROR')
        assert.equal(actual.details?.postCommitPhase, 'resourceCleanup')
        assert.deepEqual(actual.details?.recoveryPaths, [])
        return true
      },
    )

    assert.equal(injected, true)
    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('rejects an instruction write when the repository root generation is replaced', () => {
    const root = createRoot()
    const displacedRoot = `${root}-instruction-generation`
    roots.push(displacedRoot)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-plan-validation') {
              renameSync(root, displacedRoot)
              mkdirSync(root)
              writeFileSync(join(root, 'successor-sentinel'), 'replacement root')
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.equal(readFileSync(join(root, 'successor-sentinel'), 'utf8'), 'replacement root')
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(displacedRoot, 'AGENTS.md')), false)
  })

  test('does not redirect committed cleanup into a replacement repository root generation', {
    skip: renameParentWithOpenChildSkip,
  }, () => {
    const root = createRoot()
    const displacedRoot = `${root}-committed-instruction-generation`
    const path = join(root, 'AGENTS.md')
    roots.push(displacedRoot)
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-backup-cleanup') {
              renameSync(root, displacedRoot)
              mkdirSync(root)
              writeFileSync(join(root, 'successor-sentinel'), 'replacement root')
            }
          },
        }),
      (error: unknown) =>
        assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'publicationVerification', [
          'publicationVerification',
          'publicationFlush',
          'backupCleanup',
          'temporaryCleanup',
        ]),
    )

    assert.equal(readFileSync(join(root, 'successor-sentinel'), 'utf8'), 'replacement root')
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.deepEqual(instructionAliasSuffixes(root), [])
    assert.deepEqual(readFileSync(join(displacedRoot, 'AGENTS.md')), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(displacedRoot), ['.backup', '.tmp'])
  })

  test('rejects a byte-identical replacement instruction predecessor', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedOriginal = join(root, 'retained-byte-identical-original')
    const original = Buffer.from('# Existing guidance\n')
    let replacementIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, original)
    const originalMetadata = statSync(path, { bigint: true })
    const originalIdentity = { dev: originalMetadata.dev, ino: originalMetadata.ino }
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-plan-validation') {
              renameSync(path, retainedOriginal)
              writeFileSync(path, original)
              const replacementMetadata = statSync(path, { bigint: true })
              replacementIdentity = { dev: replacementMetadata.dev, ino: replacementMetadata.ino }
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    const finalMetadata = statSync(path, { bigint: true })
    assert.deepEqual({ dev: finalMetadata.dev, ino: finalMetadata.ino }, replacementIdentity)
    assert.notDeepEqual(replacementIdentity, originalIdentity)
    assert.deepEqual(readFileSync(retainedOriginal), original)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('preserves an instruction successor swapped in before predecessor backup creation', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedPredecessor = join(root, 'retained-instruction-predecessor')
    const original = Buffer.from('# Existing guidance\n')
    const successor = Buffer.from('# Concurrent source successor\n')
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    let recoveryCreateMode: bigint | undefined
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point, generatedPath) => {
            if (point === 'before-backup-create') {
              renameSync(path, retainedPredecessor)
              writeFileSync(path, successor)
              const metadata = statSync(path, { bigint: true })
              successorIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
            if (point === 'after-recovery-create') {
              assert.ok(generatedPath)
              recoveryCreateMode = statSync(generatedPath, { bigint: true }).mode & 0o777n
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.deepEqual(readFileSync(path), successor)
    const finalMetadata = statSync(path, { bigint: true })
    assert.deepEqual({ dev: finalMetadata.dev, ino: finalMetadata.ino }, successorIdentity)
    assert.deepEqual(readFileSync(retainedPredecessor), original)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
    if (process.platform !== 'win32') {
      assert.equal(recoveryCreateMode, 0o600n)
      const [recoveryName] = readdirSync(root).filter(name => name.endsWith('.backup'))
      assert.ok(recoveryName)
      assert.equal(statSync(join(root, recoveryName)).mode & 0o777, 0o644)
    }
  })

  test('preserves a swapped backup source before committed cleanup linking', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedPredecessor = join(root, 'retained-cleanup-predecessor')
    const original = Buffer.from('# Existing guidance\n')
    const successor = Buffer.from('concurrent backup source successor')
    let backupPath: string | undefined
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
            }
            if (point === 'before-backup-cleanup-create') {
              assert.ok(backupPath)
              renameSync(backupPath, retainedPredecessor)
              writeFileSync(backupPath, successor)
              const metadata = statSync(backupPath, { bigint: true })
              successorIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          },
        }),
      (error: unknown) => assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'backupCleanup'),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.ok(backupPath)
    assert.deepEqual(readFileSync(backupPath), successor)
    const finalMetadata = statSync(backupPath, { bigint: true })
    assert.deepEqual({ dev: finalMetadata.dev, ino: finalMetadata.ino }, successorIdentity)
    assert.deepEqual(readFileSync(retainedPredecessor), original)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.backup'])
  })

  test('preserves backup source and cleanup successor on final destination replacement', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Existing guidance\n')
    const successor = Buffer.from('concurrent cleanup destination successor')
    let backupPath: string | undefined
    let cleanupPath: string | undefined
    let recoveryPaths: unknown
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point, generatedPath) => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
            }
            if (point === 'before-final-backup-validation') {
              assert.ok(generatedPath)
              cleanupPath = generatedPath
              rmSync(cleanupPath)
              writeFileSync(cleanupPath, successor)
              const metadata = statSync(cleanupPath, { bigint: true })
              successorIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          },
        }),
      (error: unknown) => {
        recoveryPaths = (error as { details?: Record<string, unknown> }).details?.recoveryPaths
        return assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'backupCleanup')
      },
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.ok(backupPath)
    assert.equal(existsSync(backupPath), false)
    assert.ok(cleanupPath)
    assert.deepEqual(readFileSync(cleanupPath), successor)
    const finalMetadata = statSync(cleanupPath, { bigint: true })
    assert.deepEqual({ dev: finalMetadata.dev, ino: finalMetadata.ino }, successorIdentity)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.backup'])
    const [recoveryName] = readdirSync(root).filter(
      name => name.endsWith('.backup') && join(root, name) !== cleanupPath,
    )
    assert.ok(recoveryName)
    assert.deepEqual(readFileSync(join(root, recoveryName)), original)
    assert.deepEqual(recoveryPaths, [recoveryName])
  })

  test('reports identity uncertainty while preserving a recovery source successor', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Existing guidance\n')
    const successor = Buffer.from('concurrent recovery source successor')
    let backupPath: string | undefined
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, original)
    const originalMetadata = statSync(path, { bigint: true })
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
              throw Object.assign(new Error('Injected precommit failure'), { code: 'EIO' })
            }
            if (point === 'during-backup-restore') {
              assert.ok(backupPath)
              renameSync(backupPath, path)
              writeFileSync(backupPath, successor)
              const metadata = statSync(backupPath, { bigint: true })
              successorIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    const finalCanonicalMetadata = statSync(path, { bigint: true })
    assert.deepEqual(
      { dev: finalCanonicalMetadata.dev, ino: finalCanonicalMetadata.ino },
      { dev: originalMetadata.dev, ino: originalMetadata.ino },
    )
    assert.ok(backupPath)
    assert.deepEqual(readFileSync(backupPath), successor)
    const finalSuccessorMetadata = statSync(backupPath, { bigint: true })
    assert.deepEqual({ dev: finalSuccessorMetadata.dev, ino: finalSuccessorMetadata.ino }, successorIdentity)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('classifies a vanished witnessed backup alias as repository change', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedPredecessor = join(root, 'retained-vanished-backup')
    const original = Buffer.from('# Existing guidance\n')
    let backupPath: string | undefined
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
            }
            if (point === 'during-backup-cleanup') {
              assert.ok(backupPath)
              renameSync(backupPath, retainedPredecessor)
            }
          },
        }),
      (error: unknown) => assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'backupCleanup'),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(readFileSync(retainedPredecessor), original)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
    const [recoveryName] = readdirSync(root).filter(name => name.endsWith('.backup'))
    assert.ok(recoveryName)
    assert.deepEqual(readFileSync(join(root, recoveryName)), original)
  })

  test('preserves a successor that replaces the held temporary alias', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const successor = Buffer.from('concurrent temporary successor')
    let tempPath: string | undefined
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point, generatedPath) => {
            if (point === 'during-temp-cleanup') {
              assert.ok(generatedPath)
              tempPath = generatedPath
              rmSync(tempPath)
              writeFileSync(tempPath, successor)
              const metadata = statSync(tempPath, { bigint: true })
              successorIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          },
        }),
      (error: unknown) => assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'temporaryCleanup'),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.ok(tempPath)
    assert.deepEqual(readFileSync(tempPath), successor)
    const finalMetadata = statSync(tempPath, { bigint: true })
    assert.deepEqual({ dev: finalMetadata.dev, ino: finalMetadata.ino }, successorIdentity)
    assert.deepEqual(instructionAliasSuffixes(root), ['.tmp'])
  })

  test('excludes a byte-identical replacement inode from exact recovery paths', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const retainedStaged = join(root, 'retained-staged-inode')
    let replacedTemp = false
    let replacementName: string | undefined
    let retainedIdentity: { dev: bigint; ino: bigint } | undefined
    let replacementIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-publication-flush') {
              if (!replacedTemp) {
                const [tempName] = readdirSync(root).filter(name => name.endsWith('.tmp'))
                assert.ok(tempName)
                replacementName = tempName
                const tempPath = join(root, tempName)
                const bytes = readFileSync(tempPath)
                const mode = statSync(tempPath).mode & 0o777
                renameSync(tempPath, retainedStaged)
                const retainedMetadata = statSync(retainedStaged, { bigint: true })
                retainedIdentity = { dev: retainedMetadata.dev, ino: retainedMetadata.ino }
                writeFileSync(tempPath, bytes)
                chmodSync(tempPath, mode)
                const replacementMetadata = statSync(tempPath, { bigint: true })
                replacementIdentity = {
                  dev: replacementMetadata.dev,
                  ino: replacementMetadata.ino,
                }
                replacedTemp = true
              }
              throw Object.assign(new Error('Injected persistent publication flush failure'), {
                code: 'EIO',
              })
            }
          },
        }),
      (error: unknown) => {
        const actual = error as { details?: Record<string, unknown> }
        const recoveryPaths = actual.details?.recoveryPaths
        assert.ok(Array.isArray(recoveryPaths))
        assert.equal(recoveryPaths.includes(replacementName), false)
        assert.equal(recoveryPaths.length, 1)
        assert.match(recoveryPaths[0] as string, /^\.AGENTS\.md\..+\.backup$/u)
        return true
      },
    )

    assert.ok(replacementName)
    assert.notDeepEqual(replacementIdentity, retainedIdentity)
    assert.deepEqual(readFileSync(retainedStaged), agentsPlan.contentBytes)
    assert.deepEqual(readFileSync(join(root, replacementName)), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.tmp'])
  })

  test('retries a transient publication directory flush before destructive cleanup', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    let flushAttempts = 0
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    applyInstructionChanges(root, [agentsPlan], {
      fault: point => {
        if (point === 'during-publication-flush') {
          flushAttempts += 1
          assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.tmp'])
          if (flushAttempts === 1) {
            throw Object.assign(new Error('Injected transient directory flush failure'), {
              code: 'EIO',
            })
          }
        }
      },
    })

    assert.equal(flushAttempts, 2)
    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  test('an idempotent instruction retry verifies publication durability and preserves exact recovery aliases', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const historicalPath = join(root, '.AGENTS.md.1.00000000-0000-4000-8000-000000000099.backup')
    writeFileSync(path, '# Existing guidance\n')
    writeFileSync(historicalPath, 'historical')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)
    let initialRecoveryPaths: string[] = []

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-publication-flush') {
              throw Object.assign(new Error('Injected persistent publication flush failure'), {
                code: 'EIO',
              })
            }
          },
        }),
      (error: unknown) => {
        const actual = error as { code?: unknown; details?: Record<string, unknown> }
        assert.equal(actual.code, 'IO_ERROR')
        initialRecoveryPaths = actual.details?.recoveryPaths as string[]
        assert.equal(initialRecoveryPaths.length, 2)
        assert.equal(initialRecoveryPaths.includes(historicalPath.slice(root.length + 1)), false)
        return true
      },
    )

    const initialRecoveryState = initialRecoveryPaths.map(recoveryPath => {
      const absolutePath = join(root, recoveryPath)
      const metadata = statSync(absolutePath, { bigint: true })
      return {
        bytes: readFileSync(absolutePath),
        dev: metadata.dev,
        ino: metadata.ino,
        mode: metadata.mode,
        recoveryPath,
      }
    })
    const [retryPlan] = planInstructionChanges(root, false)
    assert.equal(retryPlan?.action, 'none')
    let retryFlushes = 0

    assert.deepEqual(
      applyInstructionChanges(root, [retryPlan], {
        fault: point => {
          if (point === 'during-publication-flush') {
            retryFlushes += 1
          }
        },
      }),
      [],
    )

    assert.equal(retryFlushes, 1)
    for (const expected of initialRecoveryState) {
      const absolutePath = join(root, expected.recoveryPath)
      const metadata = statSync(absolutePath, { bigint: true })
      assert.deepEqual(
        {
          bytes: readFileSync(absolutePath),
          dev: metadata.dev,
          ino: metadata.ino,
          mode: metadata.mode,
        },
        { bytes: expected.bytes, dev: expected.dev, ino: expected.ino, mode: expected.mode },
      )
    }
    assert.equal(readFileSync(path, 'utf8').match(/encephalon:managed-instructions:start/g)?.length, 1)
    assert.equal(readFileSync(historicalPath, 'utf8'), 'historical')
  })

  test('flushes a validated backup alias before removing the predecessor pathname', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Existing guidance\n')
    let observedLinkedAliases = false
    writeFileSync(path, original)
    const originalMetadata = statSync(path, { bigint: true })
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-backup-flush') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              const backupMetadata = statSync(join(root, backupName), { bigint: true })
              const canonicalMetadata = statSync(path, { bigint: true })
              assert.deepEqual(
                { dev: backupMetadata.dev, ino: backupMetadata.ino },
                { dev: originalMetadata.dev, ino: originalMetadata.ino },
              )
              assert.deepEqual(
                { dev: canonicalMetadata.dev, ino: canonicalMetadata.ino },
                { dev: originalMetadata.dev, ino: originalMetadata.ino },
              )
              observedLinkedAliases = true
              throw Object.assign(new Error('Injected backup durability failure'), { code: 'EIO' })
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        return true
      },
    )

    assert.equal(observedLinkedAliases, true)
    assert.deepEqual(readFileSync(path), original)
    const finalMetadata = statSync(path, { bigint: true })
    assert.deepEqual(
      { dev: finalMetadata.dev, ino: finalMetadata.ino },
      { dev: originalMetadata.dev, ino: originalMetadata.ino },
    )
    assert.deepEqual(instructionAliasSuffixes(root), [])
  })

  const committedFailureCases = [
    {
      expectedAliasSuffixes: ['.backup'],
      faultPoint: 'during-backup-cleanup',
      name: 'backup cleanup',
      postCommitPhase: 'backupCleanup',
    },
    {
      expectedAliasSuffixes: ['.backup', '.tmp'],
      faultPoint: 'during-publication-flush',
      name: 'publication flush',
      postCommitPhase: 'publicationFlush',
      postCommitPhases: ['publicationFlush', 'backupCleanup', 'temporaryCleanup'],
    },
    {
      expectedAliasSuffixes: ['.tmp'],
      faultPoint: 'during-temp-cleanup',
      name: 'temporary cleanup',
      postCommitPhase: 'temporaryCleanup',
      postCommitPhases: ['temporaryCleanup'],
    },
  ] as const

  for (const failureCase of committedFailureCases) {
    test(`reports structured committed instruction ${failureCase.name} failures`, () => {
      const root = createRoot()
      const path = join(root, 'AGENTS.md')
      writeFileSync(path, '# Existing guidance\n')
      const [agentsPlan] = planInstructionChanges(root, false)
      assert.ok(agentsPlan?.contentBytes)

      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === failureCase.faultPoint) {
                throw Object.assign(new Error(`Injected ${point}`), { code: 'EIO' })
              }
            },
          }),
        (error: unknown) =>
          assertCommittedInstructionError(
            error,
            'IO_ERROR',
            failureCase.postCommitPhase,
            'postCommitPhases' in failureCase ? failureCase.postCommitPhases : [failureCase.postCommitPhase],
          ),
      )

      assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
      assert.deepEqual(instructionAliasSuffixes(root), failureCase.expectedAliasSuffixes)
    })
  }

  test('reports instruction publication verification ahead of independent lower-priority failures', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (
              point === 'after-publication' ||
              point === 'during-backup-cleanup' ||
              point === 'during-publication-flush' ||
              point === 'during-temp-cleanup'
            ) {
              throw Object.assign(new Error(`Injected ${point}`), { code: 'EIO' })
            }
          },
        }),
      (error: unknown) =>
        assertCommittedInstructionError(error, 'IO_ERROR', 'publicationVerification', [
          'publicationVerification',
          'publicationFlush',
          'backupCleanup',
          'temporaryCleanup',
        ]),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.tmp'])
  })

  test('keeps unexpected committed instruction temporary cleanup faults internal', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-temp-cleanup') {
              throw new Error('Injected unexpected cleanup fault')
            }
          },
        }),
      (error: unknown) => assertCommittedInstructionError(error, 'INTERNAL_ERROR', 'temporaryCleanup'),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.deepEqual(instructionAliasSuffixes(root), ['.tmp'])
  })

  test('reports a committed instruction publication replacement without restoring predecessor bytes', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const replacement = '# Concurrent post-commit guidance\n'
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-publication') {
              rmSync(path)
              writeFileSync(path, replacement)
            }
          },
        }),
      (error: unknown) =>
        assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'publicationVerification', [
          'publicationVerification',
          'backupCleanup',
          'temporaryCleanup',
        ]),
    )

    assert.equal(readFileSync(path, 'utf8'), replacement)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.tmp'])
  })

  test('reports and preserves a replacement installed at the instruction backup pathname after quarantine', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const replacement = Buffer.from('concurrent backup successor')
    let backupPath: string | undefined
    let replacementIdentity: { dev: bigint; ino: bigint } | undefined
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
            }
            if (point === 'before-final-backup-validation') {
              assert.ok(backupPath)
              rmSync(backupPath, { force: true })
              writeFileSync(backupPath, replacement)
              const metadata = statSync(backupPath, { bigint: true })
              replacementIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          },
        }),
      (error: unknown) => assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'backupCleanup'),
    )

    assert.ok(backupPath)
    assert.deepEqual(readFileSync(backupPath), replacement)
    const finalMetadata = statSync(backupPath, { bigint: true })
    assert.deepEqual({ dev: finalMetadata.dev, ino: finalMetadata.ino }, replacementIdentity)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.backup'])
  })

  test('instruction backup cleanup preserves an exact quarantine destination collision', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const collisionBytes = Buffer.from('historical cleanup collision')
    let collisionPath: string | undefined
    let collisionIdentity: { dev: bigint; ino: bigint } | undefined
    let predecessorPath: string | undefined
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: (point, generatedPath) => {
            if (point === 'after-backup-validation') {
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              predecessorPath = join(root, backupName)
            }
            if (point === 'before-backup-cleanup-create') {
              assert.ok(generatedPath)
              collisionPath = generatedPath
              writeFileSync(generatedPath, collisionBytes)
              const metadata = statSync(generatedPath, { bigint: true })
              collisionIdentity = { dev: metadata.dev, ino: metadata.ino }
            }
          },
        }),
      (error: unknown) => assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'backupCleanup'),
    )

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.ok(collisionPath)
    assert.deepEqual(readFileSync(collisionPath), collisionBytes)
    const finalMetadata = statSync(collisionPath, { bigint: true })
    assert.deepEqual({ dev: finalMetadata.dev, ino: finalMetadata.ino }, collisionIdentity)
    assert.ok(predecessorPath)
    assert.equal(readFileSync(predecessorPath, 'utf8'), '# Existing guidance\n')
    assert.equal(
      readdirSync(root).some(name => name.startsWith('.AGENTS.md.') && name.endsWith('.tmp')),
      false,
    )
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.backup'])
  })

  test('reports old-descriptor mutation during instruction backup cleanup', {
    skip: process.platform === 'win32' ? 'Windows does not allow this POSIX descriptor race.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const changed = '# Descriptor edit after commit\n'
    let recoveryPaths: unknown
    writeFileSync(path, '# Existing guidance\n')
    const descriptor = openSync(path, 'r+')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    try {
      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'before-final-backup-validation') {
                ftruncateSync(descriptor, 0)
                writeSync(descriptor, changed, 0, 'utf8')
              }
            },
          }),
        (error: unknown) => {
          recoveryPaths = (error as { details?: Record<string, unknown> }).details?.recoveryPaths
          return assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'backupCleanup')
        },
      )
    } finally {
      closeSync(descriptor)
    }

    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    const backupNames = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    const changedName = backupNames.find(name => readFileSync(join(root, name), 'utf8') === changed)
    const recoveryName = backupNames.find(name => readFileSync(join(root, name), 'utf8') === '# Existing guidance\n')
    assert.ok(changedName)
    assert.ok(recoveryName)
    assert.deepEqual(recoveryPaths, [recoveryName])
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.backup'])
  })

  test('restores exact bytes and mode before instruction publication commits', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Exact predecessor bytes\r\n')
    writeFileSync(path, original)
    chmodSync(path, 0o741)
    const originalMetadata = statSync(path, { bigint: true })
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-validation') {
              throw Object.assign(new Error('Injected pre-publication failure'), { code: 'EIO' })
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        assert.deepEqual((error as { details?: unknown }).details, {})
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    const finalMetadata = statSync(path, { bigint: true })
    assert.deepEqual(
      { dev: finalMetadata.dev, ino: finalMetadata.ino, mode: finalMetadata.mode & 0o777n },
      {
        dev: originalMetadata.dev,
        ino: originalMetadata.ino,
        mode: originalMetadata.mode & 0o777n,
      },
    )
    assert.deepEqual(
      readdirSync(root).filter(name => name.startsWith('.AGENTS.md.')),
      [],
    )
  })

  test('restores exact predecessor state after the instruction backup move cannot continue', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Exact predecessor after move\r\n')
    writeFileSync(path, original)
    chmodSync(path, 0o741)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-unlink') {
              throw Object.assign(new Error('Injected post-move descriptor failure'), {
                code: 'EIO',
              })
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        return true
      },
    )

    assert.deepEqual(readFileSync(path), original)
    assert.equal(statSync(path).mode & 0o777, 0o741)
    assert.deepEqual(
      readdirSync(root).filter(name => name.startsWith('.AGENTS.md.')),
      [],
    )
  })

  test('instruction backup recovery does not overwrite a post-move canonical successor', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('# Existing guidance\n')
    const successor = Buffer.from('# Concurrent successor\n')
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    let backupPath: string | undefined
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-unlink') {
              writeFileSync(path, successor)
              const metadata = statSync(path, { bigint: true })
              successorIdentity = { dev: metadata.dev, ino: metadata.ino }
              const [backupName] = readdirSync(root).filter(name => name.endsWith('.backup'))
              assert.ok(backupName)
              backupPath = join(root, backupName)
              throw Object.assign(new Error('Injected post-move descriptor failure'), {
                code: 'EIO',
              })
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    assert.deepEqual(readFileSync(path), successor)
    const finalSuccessorMetadata = statSync(path, { bigint: true })
    assert.deepEqual({ dev: finalSuccessorMetadata.dev, ino: finalSuccessorMetadata.ino }, successorIdentity)
    assert.ok(backupPath)
    assert.deepEqual(readFileSync(backupPath), original)
    assert.equal(
      readdirSync(root).some(name => name.startsWith('.AGENTS.md.') && name.endsWith('.tmp')),
      false,
    )
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('instruction backup cleanup failure retries deterministically with one managed block', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-backup-cleanup') {
              throw Object.assign(new Error('Injected backup cleanup failure'), { code: 'EIO' })
            }
          },
        }),
      (error: unknown) => assertCommittedInstructionError(error, 'IO_ERROR', 'backupCleanup'),
    )

    const [retryPlan] = planInstructionChanges(root, false)
    assert.ok(retryPlan)
    assert.deepEqual(applyInstructionChanges(root, [retryPlan]), [])
    assert.equal(readFileSync(path, 'utf8').match(/encephalon:managed-instructions:start/g)?.length, 1)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('preserves instruction-file mode changes made after planning', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    chmodSync(path, 0o600)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)
    chmodSync(path, 0o744)

    applyInstructionChanges(root, [agentsPlan])

    assert.match(readFileSync(path, 'utf8'), /## Encephalon/)
    assert.equal(statSync(path).mode & 0o777, 0o744)
  })

  test('detects instruction-file changes observed before atomic publication', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = '# Existing guidance\n'
    const changed = '# Concurrent guidance\n'
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)
    writeFileSync(path, changed)

    assert.throws(
      () => applyInstructionChanges(root, [agentsPlan]),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(readFileSync(path, 'utf8'), changed)
  })

  test('does not overwrite instruction-file changes made during atomic publication', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = '# Existing guidance\n'
    const changed = '# Concurrent guidance during publication\n'
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-publication') {
              writeFileSync(path, changed)
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(readFileSync(path, 'utf8'), changed)
  })

  test('does not delete an instruction file replaced after global plan validation', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const replacement = '# Replacement guidance\n'

    assertErrorCode(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-plan-validation') {
              writeFileSync(path, replacement)
            }
          },
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(readFileSync(path, 'utf8'), replacement)
  })

  const preDeletionReplacementCases = [
    {
      assertReplacement: (path: string, replacement: string) => assert.equal(readFileSync(path, 'utf8'), replacement),
      name: 'regular file',
      replace: (path: string, replacement: string) => writeFileSync(path, replacement),
      skip: false,
    },
    {
      assertReplacement: (path: string, replacement: string) => assert.equal(readFileSync(path, 'utf8'), replacement),
      name: 'different file containing identical bytes',
      replace: (path: string, replacement: string) => {
        rmSync(path)
        writeFileSync(path, replacement)
      },
      skip: false,
    },
    {
      assertReplacement: (path: string, replacement: string) => assert.equal(readFileSync(path, 'utf8'), replacement),
      name: 'symlink',
      replace: (path: string, replacement: string) => {
        const target = join(dirname(path), 'replacement-target.md')
        rmSync(path)
        writeFileSync(target, replacement)
        symlinkSync(target, path)
      },
      skip: process.platform === 'win32',
    },
    {
      assertReplacement: (path: string) => assert.equal(statSync(path).isDirectory(), true),
      name: 'directory',
      replace: (path: string) => {
        rmSync(path)
        mkdirSync(path)
      },
      skip: false,
    },
  ] as const

  for (const replacementCase of preDeletionReplacementCases) {
    test(`does not delete a ${replacementCase.name} replacement immediately before deletion`, {
      skip: replacementCase.skip ? 'Windows runners may not permit file symlink creation.' : false,
    }, () => {
      const root = createRoot()
      const path = join(root, 'AGENTS.md')
      const agentsPlan = createDeletePlan(root)
      const replacement =
        replacementCase.name === 'regular file' ? '# Replacement guidance\n' : readFileSync(path, 'utf8')

      assertErrorCode(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'before-deletion') {
                replacementCase.replace(path, replacement)
              }
            },
          }),
        'REPOSITORY_CHANGED',
      )
      replacementCase.assertReplacement(path, replacement)
    })
  }

  test('detects byte-identical instruction replacement when inode identity is reused', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const originalTime = new Date('2000-01-01T00:00:00.000Z')
    const replacementTime = new Date('2001-01-01T00:00:00.000Z')
    api.initEncephalon({ root })
    utimesSync(path, originalTime, originalTime)
    const [agentsPlan] = planInstructionChanges(root, true)
    assert.equal(agentsPlan?.action, 'delete')
    type LegacyInstructionIdentity = { dev: number; ino: number }
    type StrengthenedInstructionIdentity = {
      birthtimeNs: bigint
      ctimeNs: bigint
      dev: bigint
      ino: bigint
      mode: bigint
      mtimeNs: bigint
      size: bigint
    }
    type TestInstructionIdentity = LegacyInstructionIdentity | StrengthenedInstructionIdentity
    const isStrengthenedIdentity = (identity: TestInstructionIdentity): identity is StrengthenedInstructionIdentity =>
      typeof identity.dev === 'bigint'
    const mutablePlan = agentsPlan as { originalIdentity?: TestInstructionIdentity }
    const plannedIdentity = mutablePlan.originalIdentity
    assert.ok(plannedIdentity)
    const replacement = readFileSync(path)
    rmSync(path)
    writeFileSync(path, replacement)
    utimesSync(path, replacementTime, replacementTime)
    if (isStrengthenedIdentity(plannedIdentity)) {
      const replacementMetadata = statSync(path, { bigint: true })
      mutablePlan.originalIdentity = {
        birthtimeNs: plannedIdentity.birthtimeNs,
        ctimeNs: plannedIdentity.ctimeNs,
        dev: replacementMetadata.dev,
        ino: replacementMetadata.ino,
        mode: plannedIdentity.mode,
        mtimeNs: plannedIdentity.mtimeNs,
        size: plannedIdentity.size,
      }
    } else {
      const replacementMetadata = statSync(path)
      mutablePlan.originalIdentity = {
        dev: replacementMetadata.dev,
        ino: replacementMetadata.ino,
      }
    }

    assertErrorCode(() => applyInstructionChanges(root, [agentsPlan]), 'REPOSITORY_CHANGED')
    assert.deepEqual(readFileSync(path), replacement)
  })

  test('does not delete a replacement created after deletion quarantine', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const replacement = '# Replacement after quarantine\n'

    applyInstructionChanges(root, [agentsPlan], {
      fault: point => {
        if (point === 'after-delete-quarantine') {
          writeFileSync(path, replacement)
        }
      },
    })

    assert.equal(readFileSync(path, 'utf8'), replacement)
  })

  test('does not restore a replacement installed at the deletion quarantine path', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const quarantinePath = join(root, '.AGENTS.md.controlled.delete')
    const displacedPath = join(root, '.AGENTS.md.displaced.delete')
    const agentsPlan = createDeletePlan(root)
    const original = readFileSync(path)
    const replacement = Buffer.from(original)

    assertErrorCode(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-delete-quarantine') {
              renameSync(quarantinePath, displacedPath)
              writeFileSync(quarantinePath, replacement)
            }
          },
          generatedPath: (_canonicalPath, suffix) => {
            assert.equal(suffix, 'delete')
            return quarantinePath
          },
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(existsSync(path), false)
    assert.deepEqual(readFileSync(quarantinePath), replacement)
    assert.deepEqual(readFileSync(displacedPath), original)
  })

  test('accepts a ctime-only retained-metadata change after deletion quarantine', {
    skip: process.platform === 'win32' ? 'Windows does not expose portable hard-link ctime semantics.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    let witnessedCtimeChange = false

    applyInstructionChanges(root, [agentsPlan], {
      fault: point => {
        if (point === 'after-delete-quarantine') {
          const [quarantineName] = readdirSync(root).filter(
            filename => filename.startsWith('.AGENTS.md.') && filename.endsWith('.delete'),
          )
          assert.ok(quarantineName)
          const quarantinePath = join(root, quarantineName)
          const ctimeLinkPath = join(root, '.AGENTS.md.ctime-link')
          const before = statSync(quarantinePath, { bigint: true })
          linkSync(quarantinePath, ctimeLinkPath)
          unlinkSync(ctimeLinkPath)
          const after = statSync(quarantinePath, { bigint: true })

          assert.deepEqual(
            {
              birthtimeNs: after.birthtimeNs,
              dev: after.dev,
              ino: after.ino,
              mode: after.mode,
              mtimeNs: after.mtimeNs,
              size: after.size,
            },
            {
              birthtimeNs: before.birthtimeNs,
              dev: before.dev,
              ino: before.ino,
              mode: before.mode,
              mtimeNs: before.mtimeNs,
              size: before.size,
            },
          )
          assert.notEqual(after.ctimeNs, before.ctimeNs)
          witnessedCtimeChange = true
        }
      },
    })

    assert.equal(witnessedCtimeChange, true)
    assert.equal(existsSync(path), false)
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.startsWith('.AGENTS.md.') && filename.endsWith('.delete')),
      [],
    )
  })

  test('rejects a mode change after deletion quarantine', {
    skip: process.platform === 'win32' ? 'Windows does not expose portable POSIX mode changes.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const originalMode = statSync(path, { bigint: true }).mode & 0o7777n
    const changedMode = originalMode === 0o600n ? 0o644 : 0o600

    assertErrorCode(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-delete-quarantine') {
              const [quarantineName] = readdirSync(root).filter(
                filename => filename.startsWith('.AGENTS.md.') && filename.endsWith('.delete'),
              )
              assert.ok(quarantineName)
              chmodSync(join(root, quarantineName), changedMode)
            }
          },
        }),
      'REPOSITORY_CHANGED',
    )

    assert.equal(statSync(path, { bigint: true }).mode & 0o7777n, BigInt(changedMode))
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.startsWith('.AGENTS.md.') && filename.endsWith('.delete')),
      [],
    )
  })

  test('does not delete a replacement created after deletion verification', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const replacement = '# Replacement after verification\n'

    applyInstructionChanges(root, [agentsPlan], {
      fault: point => {
        if (point === 'after-delete-verification') {
          writeFileSync(path, replacement)
        }
      },
    })

    assert.equal(readFileSync(path, 'utf8'), replacement)
  })

  test('restores the quarantined instruction file when final unlink fails', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const original = readFileSync(path, 'utf8')

    assertErrorCode(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-delete-verification') {
              throw new Error('Injected final unlink failure')
            }
          },
        }),
      'INTERNAL_ERROR',
    )

    assert.equal(readFileSync(path, 'utf8'), original)
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.includes('.AGENTS.md.') && filename.endsWith('.delete')),
      [],
    )
  })

  test('keeps old-descriptor writes recoverable after delete verification', {
    skip: process.platform === 'win32' ? 'Windows does not allow this POSIX descriptor race.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const changed = '# Descriptor delete edit\n'
    const descriptor = openSync(path, 'r+')

    try {
      assertErrorCode(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'after-delete-verification') {
                ftruncateSync(descriptor, 0)
                writeSync(descriptor, changed, 0, 'utf8')
              }
            },
          }),
        'REPOSITORY_CHANGED',
      )
    } finally {
      closeSync(descriptor)
    }

    assert.equal(readFileSync(path, 'utf8'), changed)
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.includes('.AGENTS.md.') && filename.endsWith('.delete')),
      [],
    )
  })

  test('does not misreport directory flush failure after committed delete', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)

    applyInstructionChanges(root, [agentsPlan], {
      fault: point => {
        if (point === 'during-delete-flush') {
          throw new Error('Injected delete flush failure')
        }
      },
    })

    assert.equal(existsSync(path), false)
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.includes('.AGENTS.md.') && filename.endsWith('.delete')),
      [],
    )
  })

  test('restores frozen predecessor bytes without overwriting an old-descriptor successor', {
    skip: process.platform === 'win32' ? 'Windows does not allow this POSIX descriptor race.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = '# Existing guidance\n'
    const changed = '# Descriptor edit\n'
    writeFileSync(path, original)
    const descriptor = openSync(path, 'r+')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)

    try {
      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'after-backup-validation') {
                ftruncateSync(descriptor, 0)
                writeSync(descriptor, changed, 0, 'utf8')
              }
            },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
    } finally {
      closeSync(descriptor)
    }

    assert.equal(readFileSync(path, 'utf8'), original)
    const [successorName] = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    assert.ok(successorName)
    assert.equal(readFileSync(join(root, successorName), 'utf8'), changed)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('does not overwrite files created while restoring a backup', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = '# Existing guidance\n'
    const changed = '# Concurrent restore guidance\n'
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-validation') {
              throw Object.assign(new Error('Injected publication failure'), { code: 'EIO' })
            }
            if (point === 'during-backup-restore') {
              writeFileSync(path, changed)
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    const [backupName] = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    assert.ok(backupName)
    assert.equal(readFileSync(path, 'utf8'), changed)
    assert.equal(readFileSync(join(root, backupName), 'utf8'), original)
  })

  test('does not overwrite files created while restoring a quarantined delete', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const original = readFileSync(path, 'utf8')
    const replacement = '# Concurrent delete restore guidance\n'

    assertErrorCode(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-delete-verification') {
              throw new Error('Injected deletion failure')
            }
            if (point === 'during-quarantine-restore') {
              writeFileSync(path, replacement)
            }
          },
        }),
      'INTERNAL_ERROR',
    )

    const [quarantineName] = readdirSync(root).filter(
      name => name.startsWith('.AGENTS.md.') && name.endsWith('.delete'),
    )
    assert.ok(quarantineName)
    assert.equal(readFileSync(path, 'utf8'), replacement)
    assert.equal(readFileSync(join(root, quarantineName), 'utf8'), original)
  })

  test('reports old-descriptor mode changes after backup validation', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    chmodSync(path, 0o600)
    const descriptor = openSync(path, 'r+')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    try {
      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'after-backup-validation') {
                fchmodSync(descriptor, 0o744)
              }
            },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
    } finally {
      closeSync(descriptor)
    }

    assert.equal(readFileSync(path, 'utf8'), '# Existing guidance\n')
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const [successorName] = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    assert.ok(successorName)
    assert.equal(statSync(join(root, successorName)).mode & 0o777, 0o744)
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup'])
  })

  test('does not overwrite mode changes after final backup validation', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    chmodSync(path, 0o600)
    const descriptor = openSync(path, 'r+')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan?.contentBytes)
    let recoveryPaths: unknown

    try {
      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'before-final-backup-validation') {
                fchmodSync(descriptor, 0o744)
              }
            },
          }),
        (error: unknown) => {
          recoveryPaths = (error as { details?: Record<string, unknown> }).details?.recoveryPaths
          return assertCommittedInstructionError(error, 'REPOSITORY_CHANGED', 'backupCleanup')
        },
      )
    } finally {
      closeSync(descriptor)
    }

    const backupNames = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    const successorName = backupNames.find(name => (statSync(join(root, name)).mode & 0o777) === 0o744)
    const recoveryName = backupNames.find(name => (statSync(join(root, name)).mode & 0o777) === 0o600)
    assert.ok(successorName)
    assert.ok(recoveryName)
    assert.deepEqual(readFileSync(path), agentsPlan.contentBytes)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(recoveryPaths, [recoveryName])
    assert.deepEqual(instructionAliasSuffixes(root), ['.backup', '.backup'])
  })

  const faultPoints = [
    ['before-temp-create', 'old', []],
    ['during-temp-write', 'old', []],
    ['during-file-flush', 'old', []],
    ['during-publication', 'old', []],
    ['after-publication', 'new', []],
    ['during-temp-cleanup', 'new', ['.tmp']],
  ] as const

  for (const [faultPoint, expectedContent, expectedAliasSuffixes] of faultPoints) {
    test(`keeps instruction writes whole when fault injection fails ${faultPoint}`, () => {
      const root = createRoot()
      const path = join(root, 'AGENTS.md')
      const original = '# Existing guidance\n'
      writeFileSync(path, original)
      const [agentsPlan] = planInstructionChanges(root, false)
      assert.ok(agentsPlan?.content)

      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === faultPoint) {
                throw Object.assign(new Error(`Injected ${point}`), { code: 'EIO' })
              }
            },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
          return true
        },
      )

      const content = readFileSync(path, 'utf8')
      assert.equal(content, expectedContent === 'old' ? original : agentsPlan.content)
      assert.notEqual(content, '')
      assert.notEqual(content, original.slice(0, 4))
      assert.deepEqual(instructionAliasSuffixes(root), expectedAliasSuffixes)
    })
  }
})
