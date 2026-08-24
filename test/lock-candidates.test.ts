import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, test } from 'node:test'
import type { DirectoryReader } from '../src/bounded-directory.ts'
import {
  cacheLocationTestHooks,
  inspectCacheLocation,
  observeCacheOwnedDirectoryForMaintenance,
  observeCacheOwner,
} from '../src/cache-location.ts'
import { withOperationLock } from '../src/lock.ts'
import { maintainLockCandidates } from '../src/lock-candidates.ts'
import { classifySQLiteError, type SQLiteErrorCategory } from '../src/sqlite-error.ts'
import { createTestRepository, removeTestRepository } from './helpers.ts'

type Entry = Readonly<{ name: string }>

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const cacheDirectory = (root: string) => join(root, 'node_modules', '.cache', 'encephalon')
const candidatePath = (root: string, token: string) => join(cacheDirectory(root), `operation.lock.${token}`)
const tokenFor = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
const entryFor = (token: string) => ({ name: `operation.lock.${token}` })
const identityOf = (path: string) => {
  const metadata = lstatSync(path, { bigint: true })
  return { dev: metadata.dev, ino: metadata.ino }
}
const age = (path: string) => utimesSync(path, new Date(0), new Date(0))

afterEach(() => {
  cacheLocationTestHooks.beforeCacheLocationAssertion = undefined
  cacheLocationTestHooks.beforeCacheOwnerOpen = undefined
  cacheLocationTestHooks.beforeQuarantineRename = undefined
  cacheLocationTestHooks.beforeQuarantinedFileCleanup = undefined
  roots.splice(0).forEach(removeTestRepository)
})

const waitForPath = (path: string, child: ReturnType<typeof spawn>) => {
  const deadline = Date.now() + 5000
  while (!existsSync(path) && child.exitCode === null && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  assert.equal(existsSync(path), true)
}

const stopChild = async (child: ReturnType<typeof spawn>) => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill()
  }
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, 'exit')
  }
}

const assertAbandonedCandidateConverges = async (mode: 'after-owner' | 'before-owner') => {
  const root = createRoot()
  const barrier = join(root, `${mode}.barrier`)
  const child = spawn(process.execPath, ['test/fixtures/abandon-lock-candidate.ts', root, mode, barrier], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })
  try {
    waitForPath(barrier, child)
    const abandoned = join(cacheDirectory(root), readFileSync(barrier, 'utf8'))
    await stopChild(child)
    assert.equal(existsSync(abandoned), true)
    if (mode === 'before-owner') {
      assert.equal(
        withOperationLock(root, () => 'fresh'),
        'fresh',
      )
      assert.equal(existsSync(abandoned), true)
      utimesSync(abandoned, new Date(0), new Date(0))
    }
    assert.equal(
      withOperationLock(root, () => 'reclaimed'),
      'reclaimed',
    )
    assert.equal(existsSync(abandoned), false)
  } finally {
    await stopChild(child)
  }
}

describe('lock candidate maintenance', () => {
  test('asserts the current lock before opening the maintenance cursor', () => {
    const root = createRoot()
    const location = inspectCacheLocation(root)
    let opens = 0
    const authorityFailure = Object.assign(new Error('current lock failed before maintenance'), { code: 'EIO' })

    assert.throws(
      () =>
        maintainLockCandidates(location, {
          assertCurrentLock: () => {
            throw authorityFailure
          },
          openDirectory: () => {
            opens += 1
            return { closeSync: () => undefined, readSync: () => null }
          },
        }),
      error => error === authorityFailure,
    )
    assert.equal(opens, 0)
  })

  test('preserves the first one-shot current-lock failure at a candidate suppression boundary', () => {
    const root = createRoot()
    const token = tokenFor(0x0_10)
    const path = candidatePath(root, token)
    let candidateFailureReached = false
    let currentFailures = 0
    let operationEntered = false
    mkdirSync(path, { recursive: true })
    age(path)
    cacheLocationTestHooks.beforeQuarantineRename = current => {
      if (basename(current) === basename(path)) {
        candidateFailureReached = true
        throw Object.assign(new Error('candidate quarantine failed'), { code: 'EIO' })
      }
    }
    cacheLocationTestHooks.beforeCacheOwnerOpen = current => {
      if (candidateFailureReached && basename(dirname(current)) === 'operation.lock' && currentFailures === 0) {
        currentFailures += 1
        throw Object.assign(new Error('one-shot current lock failure'), { code: 'EIO' })
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        return true
      },
    )
    assert.equal(currentFailures, 1)
    assert.equal(operationEntered, false)
  })

  test('preserves the first one-shot cache-location failure at a candidate suppression boundary', () => {
    const root = createRoot()
    const token = tokenFor(0x0_11)
    const path = candidatePath(root, token)
    const location = inspectCacheLocation(root)
    const cacheFailure = Object.assign(new Error('one-shot cache location failure'), { code: 'EIO' })
    let candidateFailureReached = false
    let cacheFailures = 0
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'owner.json'), '{malformed')
    age(join(path, 'owner.json'))
    age(path)
    cacheLocationTestHooks.beforeCacheOwnerOpen = current => {
      if (basename(dirname(current)) === basename(path)) {
        candidateFailureReached = true
        throw Object.assign(new Error('candidate owner failed'), { code: 'EBUSY' })
      }
    }
    cacheLocationTestHooks.beforeCacheLocationAssertion = () => {
      if (candidateFailureReached && cacheFailures === 0) {
        cacheFailures += 1
        throw cacheFailure
      }
    }

    assert.throws(
      () =>
        maintainLockCandidates(location, {
          assertCurrentLock: () => undefined,
          openDirectory: () => {
            let read = false
            return {
              closeSync: () => undefined,
              readSync: () => {
                const entry = read ? null : entryFor(token)
                read = true
                return entry
              },
            }
          },
        }),
      error => error === cacheFailure,
    )
    assert.equal(cacheFailures, 1)
  })

  test('runs under the gate and visits at most 64 lazy entries without private diagnostics', () => {
    const root = createRoot()
    const gatePath = join(cacheDirectory(root), 'operation-lock.sqlite')
    let gateProbes = 0
    let gateProbeCategory: SQLiteErrorCategory | 'acquired' | undefined
    let reads = 0
    let closes = 0
    let reported: Readonly<Record<string, unknown>> | undefined
    const reader: DirectoryReader<Entry> = {
      closeSync: () => {
        closes += 1
      },
      readSync: () => {
        if (gateProbes === 0) {
          const contender = new DatabaseSync(gatePath, { timeout: 0 })
          try {
            try {
              contender.exec('BEGIN IMMEDIATE')
              gateProbeCategory = 'acquired'
              contender.exec('ROLLBACK')
            } catch (error) {
              gateProbeCategory = classifySQLiteError(error)
            }
          } finally {
            contender.close()
          }
          gateProbes += 1
        }
        reads += 1
        if (reads === 65) {
          throw new Error('candidate discovery crossed its raw-entry budget')
        }
        return { name: `inert-${reads}` }
      },
    }

    const result = withOperationLock(root, () => 'entered', {
      afterCandidateMaintenance: stats => {
        reported = stats
      },
      openCandidateDirectory: () => reader,
    })

    assert.equal(result, 'entered')
    assert.equal(reads, 64)
    assert.equal(closes, 0)
    assert.equal(gateProbes, 1)
    assert.equal(gateProbeCategory === 'busy' || gateProbeCategory === 'locked', true)
    assert.ok(reported)
    assert.equal(Number(reported.directoryEntriesVisited) <= 64, true)
    assert.equal(Number(reported.candidatesInspected) <= 16, true)
    assert.equal(Number(reported.reclamationAttempts) <= 4, true)
    assert.equal(
      Object.values(reported).some(value => typeof value === 'string'),
      false,
    )
  })

  test('enforces exact inspection and reclamation-attempt budgets', () => {
    const inspectionRoot = createRoot()
    const inspectionEntries = Array.from({ length: 17 }, (_, index) => entryFor(tokenFor(0x1_00 + index)))
    let inspectionIndex = 0
    let inspectionStats: Readonly<Record<string, unknown>> | undefined
    withOperationLock(inspectionRoot, () => 'entered', {
      afterCandidateMaintenance: stats => {
        inspectionStats = stats
      },
      openCandidateDirectory: () => ({
        closeSync: () => undefined,
        readSync: () => {
          const entry = inspectionEntries[inspectionIndex] ?? null
          inspectionIndex += 1
          return entry
        },
      }),
    })
    assert.deepEqual(inspectionStats, {
      candidatesInspected: 16,
      candidatesReclaimed: 0,
      cursorExhausted: false,
      directoryEntriesVisited: 16,
      reclamationAttempts: 0,
    })

    const attemptRoot = createRoot()
    const attemptTokens = Array.from({ length: 5 }, (_, index) => tokenFor(0x2_00 + index))
    for (const token of attemptTokens) {
      const path = candidatePath(attemptRoot, token)
      mkdirSync(path, { recursive: true })
      age(path)
    }
    let attemptIndex = 0
    let attemptStats: Readonly<Record<string, unknown>> | undefined
    withOperationLock(attemptRoot, () => 'entered', {
      afterCandidateMaintenance: stats => {
        attemptStats = stats
      },
      openCandidateDirectory: () => ({
        closeSync: () => undefined,
        readSync: () => {
          const token = attemptTokens[attemptIndex]
          attemptIndex += 1
          return token === undefined ? null : entryFor(token)
        },
      }),
    })
    assert.deepEqual(attemptStats, {
      candidatesInspected: 4,
      candidatesReclaimed: 4,
      cursorExhausted: false,
      directoryEntriesVisited: 4,
      reclamationAttempts: 4,
    })
    assert.equal(existsSync(candidatePath(attemptRoot, attemptTokens[4] as string)), true)
  })

  test('rejects exact current-lock replacements during maintenance and at its reporting boundary', () => {
    const boundaries = ['reader failure', 'statistics hook'] as const
    for (const boundary of boundaries) {
      const root = createRoot()
      const lockPath = join(cacheDirectory(root), 'operation.lock')
      const displaced = join(root, `displaced-${boundary.replace(' ', '-')}`)
      const successorBytes = `successor at ${boundary}`
      let successorIdentity: Readonly<{ dev: bigint; ino: bigint }> | undefined
      let operationEntered = false
      const replaceCurrentLock = () => {
        renameSync(lockPath, displaced)
        mkdirSync(lockPath)
        writeFileSync(join(lockPath, 'successor'), successorBytes)
        successorIdentity = identityOf(lockPath)
      }

      assert.throws(
        () =>
          withOperationLock(
            root,
            () => {
              operationEntered = true
            },
            boundary === 'reader failure'
              ? {
                  openCandidateDirectory: () => ({
                    closeSync: () => undefined,
                    readSync: () => {
                      replaceCurrentLock()
                      throw Object.assign(new Error('candidate reader failed after lock replacement'), { code: 'EIO' })
                    },
                  }),
                }
              : {
                  afterCandidateMaintenance: replaceCurrentLock,
                  openCandidateDirectory: () => ({ closeSync: () => undefined, readSync: () => null }),
                },
          ),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
      assert.equal(operationEntered, false)
      assert.deepEqual(identityOf(lockPath), successorIdentity)
      assert.equal(readFileSync(join(lockPath, 'successor'), 'utf8'), successorBytes)
    }
  })

  test('stops maintenance when candidate quarantine failure reveals current-lock replacement', () => {
    const root = createRoot()
    const token = tokenFor(0x2_10)
    const path = candidatePath(root, token)
    const lockPath = join(cacheDirectory(root), 'operation.lock')
    const displaced = join(root, 'displaced-quarantine-failure-lock')
    const successorBytes = 'successor installed during candidate quarantine'
    const entries = [entryFor(token), entryFor(tokenFor(0x2_11))]
    let operationEntered = false
    let reads = 0
    let successorIdentity: Readonly<{ dev: bigint; ino: bigint }> | undefined
    mkdirSync(path, { recursive: true })
    age(path)
    cacheLocationTestHooks.beforeQuarantineRename = current => {
      if (basename(current) === basename(path)) {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        renameSync(lockPath, displaced)
        mkdirSync(lockPath)
        writeFileSync(join(lockPath, 'successor'), successorBytes)
        successorIdentity = identityOf(lockPath)
        throw Object.assign(new Error('candidate quarantine failed after lock replacement'), { code: 'EIO' })
      }
    }

    assert.throws(
      () =>
        withOperationLock(
          root,
          () => {
            operationEntered = true
          },
          {
            openCandidateDirectory: () => ({
              closeSync: () => undefined,
              readSync: () => {
                const entry = entries[reads] ?? null
                reads += 1
                return entry
              },
            }),
          },
        ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(reads, 1)
    assert.equal(operationEntered, false)
    assert.deepEqual(identityOf(lockPath), successorIdentity)
    assert.equal(readFileSync(join(lockPath, 'successor'), 'utf8'), successorBytes)
  })

  test('asserts the current lock in the final candidate ownership callback before rename', () => {
    const root = createRoot()
    const token = tokenFor(0x2_12)
    const path = candidatePath(root, token)
    const lockPath = join(cacheDirectory(root), 'operation.lock')
    const displaced = join(root, 'displaced-final-ownership-lock')
    let operationEntered = false
    mkdirSync(path, { recursive: true })
    age(path)
    cacheLocationTestHooks.beforeQuarantineRename = current => {
      if (basename(current) === basename(path)) {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        renameSync(lockPath, displaced)
        mkdirSync(lockPath)
        writeFileSync(join(lockPath, 'successor'), 'replacement current lock')
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(existsSync(path), true)
  })

  test('resumes a retained reader until a reclaimable suffix is reached', () => {
    const root = createRoot()
    const token = '00000000-0000-4000-8000-000000000001'
    const entries = [
      ...Array.from({ length: 70 }, (_, entryIndex) => ({ name: `inert-${entryIndex}` })),
      { name: `operation.lock.${token}` },
    ]
    let readerIndex = 0
    let opens = 0
    const reader: DirectoryReader<Entry> = {
      closeSync: () => undefined,
      readSync: () => {
        const entry = entries[readerIndex] ?? null
        readerIndex += 1
        return entry
      },
    }
    const directory = candidatePath(root, token)
    mkdirSync(directory, { recursive: true })
    utimesSync(directory, new Date(0), new Date(0))
    const hooks = {
      openCandidateDirectory: () => {
        opens += 1
        return reader
      },
    }

    assert.equal(
      withOperationLock(root, () => 'first', hooks),
      'first',
    )
    assert.equal(existsSync(directory), true)
    assert.equal(
      withOperationLock(root, () => 'second', hooks),
      'second',
    )
    assert.equal(existsSync(directory), false)
    assert.equal(opens, 1)
  })

  test('closes cursors on EOF, reader failure, injected-reader change, and cache identity replacement', () => {
    const eofRoot = createRoot()
    let eofOpens = 0
    let eofCloses = 0
    const openExhausting = (): DirectoryReader<Entry> => {
      eofOpens += 1
      let read = false
      return {
        closeSync: () => {
          eofCloses += 1
        },
        readSync: () => {
          const entry = read ? null : { name: 'inert' }
          read = true
          return entry
        },
      }
    }
    withOperationLock(eofRoot, () => 'first', { openCandidateDirectory: openExhausting })
    withOperationLock(eofRoot, () => 'second', { openCandidateDirectory: openExhausting })
    assert.deepEqual({ closes: eofCloses, opens: eofOpens }, { closes: 2, opens: 2 })

    const failureRoot = createRoot()
    let failureCloses = 0
    assert.equal(
      withOperationLock(failureRoot, () => 'entered', {
        openCandidateDirectory: () => ({
          closeSync: () => {
            failureCloses += 1
          },
          readSync: () => {
            throw new Error('injected candidate reader failure')
          },
        }),
      }),
      'entered',
    )
    assert.equal(failureCloses, 1)

    const replacementRoot = createRoot()
    const cachePath = cacheDirectory(replacementRoot)
    const displaced = join(replacementRoot, 'displaced-cache')
    let retainedCloses = 0
    const firstReader = () => ({
      closeSync: () => {
        retainedCloses += 1
      },
      readSync: () => ({ name: 'inert' }),
    })
    withOperationLock(replacementRoot, () => 'first', { openCandidateDirectory: firstReader })
    const changedReader = () => ({ closeSync: () => undefined, readSync: () => ({ name: 'inert' }) })
    withOperationLock(replacementRoot, () => 'second', { openCandidateDirectory: changedReader })
    assert.equal(retainedCloses, 1)

    let identityCloses = 0
    const identityReaders = () => ({
      closeSync: () => {
        identityCloses += 1
      },
      readSync: () => ({ name: 'inert' }),
    })
    withOperationLock(replacementRoot, () => 'third', { openCandidateDirectory: identityReaders })
    renameSync(cachePath, displaced)
    mkdirSync(cachePath)
    withOperationLock(replacementRoot, () => 'fourth', { openCandidateDirectory: identityReaders })
    assert.equal(identityCloses, 1)
  })

  test('refreshes cursor recency and evicts the true least-recently-used repository', () => {
    const closes = new Map<string, number>()
    const openedPaths: string[] = []
    const openDirectory = (path: string): DirectoryReader<Entry> => {
      openedPaths.push(path)
      return {
        closeSync: () => {
          closes.set(path, (closes.get(path) ?? 0) + 1)
        },
        readSync: () => ({ name: 'inert' }),
      }
    }
    const repositories = Array.from({ length: 9 }, () => createRoot())
    for (const root of repositories.slice(0, 8)) {
      withOperationLock(root, () => 'entered', { openCandidateDirectory: openDirectory })
    }
    withOperationLock(repositories[0] as string, () => 'refreshed', { openCandidateDirectory: openDirectory })
    withOperationLock(repositories[8] as string, () => 'entered', { openCandidateDirectory: openDirectory })

    assert.equal(closes.get(openedPaths[0] as string), undefined)
    assert.equal(closes.get(openedPaths[1] as string), 1)
  })

  test('reclaims only exact abandoned candidates and preserves live or ambiguous evidence', () => {
    const root = createRoot()
    mkdirSync(cacheDirectory(root), { recursive: true })
    const agedOwnerless = '00000000-0000-4000-8000-000000000002'
    const deadOwner = '00000000-0000-4000-8000-000000000003'
    const liveOwner = '00000000-0000-4000-8000-000000000004'
    const malformed = '00000000-0000-4000-8000-000000000005'
    const extraChild = '00000000-0000-4000-8000-000000000006'
    for (const token of [agedOwnerless, deadOwner, liveOwner, malformed, extraChild]) {
      mkdirSync(candidatePath(root, token))
    }
    utimesSync(candidatePath(root, agedOwnerless), new Date(0), new Date(0))
    writeFileSync(
      join(candidatePath(root, deadOwner), 'owner.json'),
      `${JSON.stringify({ acquiredAt: '2026-08-24T10:00:00.000Z', pid: 2_147_483_647, token: deadOwner })}\n`,
    )
    const liveBytes = `${JSON.stringify({
      acquiredAt: '2026-08-24T10:00:00.000Z',
      pid: process.pid,
      token: liveOwner,
    })}\n`
    writeFileSync(join(candidatePath(root, liveOwner), 'owner.json'), liveBytes)
    age(join(candidatePath(root, liveOwner), 'owner.json'))
    age(candidatePath(root, liveOwner))
    writeFileSync(join(candidatePath(root, malformed), 'owner.json'), '{malformed')
    writeFileSync(join(candidatePath(root, extraChild), 'extra'), 'preserve')

    for (const _ of Array.from({ length: 3 })) {
      withOperationLock(root, () => 'entered')
    }

    assert.equal(existsSync(candidatePath(root, agedOwnerless)), false)
    assert.equal(existsSync(candidatePath(root, deadOwner)), false)
    assert.equal(readFileSync(join(candidatePath(root, liveOwner), 'owner.json'), 'utf8'), liveBytes)
    assert.equal(existsSync(candidatePath(root, malformed)), true)
    assert.equal(readFileSync(join(candidatePath(root, extraChild), 'extra'), 'utf8'), 'preserve')
  })

  test('uses a strict malformed-owner grace boundary and preserves oversized owners without exact bytes', () => {
    const root = createRoot()
    const cases = [
      { bytes: '{exactly-grace', mtime: 5000, present: true, token: tokenFor(0x3_00) },
      { bytes: '{older-than-grace', mtime: 4999, present: false, token: tokenFor(0x3_01) },
      { bytes: 'x'.repeat(4097), mtime: 5000, present: true, token: tokenFor(0x3_02) },
      { bytes: 'y'.repeat(4097), mtime: 4999, present: true, token: tokenFor(0x3_03) },
    ] as const
    for (const ownerCase of cases) {
      const path = candidatePath(root, ownerCase.token)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'owner.json'), ownerCase.bytes)
      utimesSync(join(path, 'owner.json'), new Date(ownerCase.mtime), new Date(ownerCase.mtime))
      utimesSync(path, new Date(ownerCase.mtime), new Date(ownerCase.mtime))
    }
    let index = 0
    withOperationLock(root, () => 'entered', {
      now: () => 10_000,
      openCandidateDirectory: () => ({
        closeSync: () => undefined,
        readSync: () => {
          const ownerCase = cases[index]
          index += 1
          return ownerCase === undefined ? null : entryFor(ownerCase.token)
        },
      }),
    })

    for (const ownerCase of cases) {
      assert.equal(existsSync(candidatePath(root, ownerCase.token)), ownerCase.present)
    }
  })

  test('retains exact raw bytes for bounded owner evidence', () => {
    const root = createRoot()
    const token = tokenFor(0x3_10)
    const path = candidatePath(root, token)
    const bytes = Buffer.from([0x7b, 0x22, 0x80, 0xff, 0x22, 0x7d])
    const location = inspectCacheLocation(root)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'owner.json'), bytes)
    const observed = observeCacheOwnedDirectoryForMaintenance(location, basename(path))
    assert.equal(observed.kind, 'stable')
    if (observed.kind === 'stable') {
      const owner = observeCacheOwner(location, observed.directory)
      assert.equal(owner.kind, 'contents')
      if (owner.kind === 'contents') {
        assert.deepEqual(owner.bytes, bytes)
      }
    }
  })

  test('preserves a candidate when its captured directory mtime changes before quarantine', () => {
    const root = createRoot()
    const token = tokenFor(0x3_11)
    const path = candidatePath(root, token)
    mkdirSync(path, { recursive: true })
    age(path)
    cacheLocationTestHooks.beforeQuarantineRename = current => {
      if (basename(current) === basename(path)) {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        utimesSync(path, new Date(1000), new Date(1000))
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered', { now: () => 10_000 }),
      'entered',
    )
    assert.equal(existsSync(path), true)
  })

  test('routes unsupported candidate observations through the current-lock authority boundary', () => {
    const root = createRoot()
    const token = tokenFor(0x3_12)
    const location = inspectCacheLocation(root)
    let assertions = 0
    writeFileSync(candidatePath(root, token), 'unsupported candidate file')

    maintainLockCandidates(location, {
      assertCurrentLock: () => {
        assertions += 1
      },
      openDirectory: () => {
        let read = false
        return {
          closeSync: () => undefined,
          readSync: () => {
            const entry = read ? null : entryFor(token)
            read = true
            return entry
          },
        }
      },
    })
    assert.equal(assertions, 2)
  })

  test('reports current-candidate promotion failures with the fixed public lock entry', () => {
    const root = createRoot()

    assert.throws(
      () =>
        withOperationLock(root, () => 'entered', {
          afterCandidateOwnerPublication: path => {
            writeFileSync(join(path, 'unexpected'), 'preserve')
          },
        }),
      (error: unknown) => {
        const candidate = error as { details?: { entry?: unknown } }
        assert.equal(candidate.details?.entry, 'node_modules/.cache/encephalon/operation.lock')
        assert.equal(String(candidate.details?.entry).includes('operation.lock.'), false)
        return true
      },
    )
  })

  test('never unlinks post-validation file successor inodes from candidate quarantine', () => {
    const cases = [
      { bytes: undefined, successorName: 'owner.json', token: tokenFor(0x3_20) },
      { bytes: undefined, successorName: 'owner.recovered.json', token: tokenFor(0x3_21) },
      { bytes: '{malformed', successorName: 'owner.json', token: tokenFor(0x3_22) },
    ] as const
    for (const ownerCase of cases) {
      const root = createRoot()
      const path = candidatePath(root, ownerCase.token)
      let successorIdentity: Readonly<{ dev: bigint; ino: bigint }> | undefined
      let successorPath: string | undefined
      mkdirSync(path, { recursive: true })
      if (ownerCase.bytes !== undefined) {
        writeFileSync(join(path, 'owner.json'), ownerCase.bytes)
        age(join(path, 'owner.json'))
      }
      age(path)
      cacheLocationTestHooks.beforeQuarantinedFileCleanup = quarantinePath => {
        if (quarantinePath.includes(`.operation.lock.${ownerCase.token}.`)) {
          const successor = join(quarantinePath, ownerCase.successorName)
          if (existsSync(successor)) {
            renameSync(successor, join(quarantinePath, `original-${ownerCase.successorName}`))
          }
          writeFileSync(successor, 'successor owner bytes')
          successorIdentity = identityOf(successor)
          successorPath = successor
        }
      }

      assert.equal(
        withOperationLock(root, () => 'entered'),
        'entered',
      )
      assert.ok(successorPath !== undefined)
      assert.equal(existsSync(successorPath), true)
      assert.deepEqual(identityOf(successorPath), successorIdentity)
      assert.equal(readFileSync(successorPath, 'utf8'), 'successor owner bytes')
      cacheLocationTestHooks.beforeQuarantinedFileCleanup = undefined
    }
  })

  test('preserves unsupported and ambiguous candidates with exact evidence', () => {
    const root = createRoot()
    const regularToken = tokenFor(0x4_00)
    const hardLinkToken = tokenFor(0x4_01)
    const witnessToken = tokenFor(0x4_02)
    const sharingToken = tokenFor(0x4_03)
    const regularPath = candidatePath(root, regularToken)
    mkdirSync(cacheDirectory(root), { recursive: true })
    writeFileSync(regularPath, 'candidate file bytes')

    const hardLinkPath = candidatePath(root, hardLinkToken)
    mkdirSync(hardLinkPath)
    const hardLinkOwner = join(hardLinkPath, 'owner.json')
    writeFileSync(hardLinkOwner, '{hard-linked malformed owner')
    const hardLinkAlias = join(root, 'hard-linked-owner.alias')
    linkSync(hardLinkOwner, hardLinkAlias)
    age(hardLinkOwner)
    age(hardLinkPath)

    const witnessPath = candidatePath(root, witnessToken)
    mkdirSync(witnessPath)
    writeFileSync(join(witnessPath, 'owner.recovered.json'), 'recovery witness bytes')
    age(witnessPath)

    const sharingPath = candidatePath(root, sharingToken)
    mkdirSync(sharingPath)
    const sharingOwner = join(sharingPath, 'owner.json')
    writeFileSync(sharingOwner, '{sharing failure owner')
    age(sharingOwner)
    age(sharingPath)

    const preserved = [
      { bytes: readFileSync(regularPath), identity: identityOf(regularPath), path: regularPath },
      { bytes: readFileSync(hardLinkOwner), identity: identityOf(hardLinkOwner), path: hardLinkOwner },
      {
        bytes: readFileSync(join(witnessPath, 'owner.recovered.json')),
        identity: identityOf(join(witnessPath, 'owner.recovered.json')),
        path: join(witnessPath, 'owner.recovered.json'),
      },
      { bytes: readFileSync(sharingOwner), identity: identityOf(sharingOwner), path: sharingOwner },
    ]
    cacheLocationTestHooks.beforeCacheOwnerOpen = path => {
      if (basename(dirname(path)) === `operation.lock.${sharingToken}`) {
        throw Object.assign(new Error('persistent candidate sharing failure'), { code: 'EBUSY' })
      }
    }
    const entries = [regularToken, hardLinkToken, witnessToken, sharingToken].map(entryFor)
    for (const _ of Array.from({ length: 2 })) {
      let index = 0
      withOperationLock(root, () => 'entered', {
        openCandidateDirectory: () => ({
          closeSync: () => undefined,
          readSync: () => {
            const entry = entries[index] ?? null
            index += 1
            return entry
          },
        }),
      })
    }

    for (const evidence of preserved) {
      assert.deepEqual(identityOf(evidence.path), evidence.identity)
      assert.deepEqual(readFileSync(evidence.path), evidence.bytes)
    }
    assert.equal(existsSync(hardLinkAlias), true)
  })

  test('converges after a transient candidate sharing failure', () => {
    const root = createRoot()
    const token = tokenFor(0x5_00)
    const path = candidatePath(root, token)
    const ownerPath = join(path, 'owner.json')
    mkdirSync(path, { recursive: true })
    writeFileSync(ownerPath, '{transient sharing owner')
    age(ownerPath)
    age(path)
    const originalIdentity = identityOf(ownerPath)
    const originalBytes = readFileSync(ownerPath)
    let failures = 0
    cacheLocationTestHooks.beforeCacheOwnerOpen = current => {
      if (basename(dirname(current)) === `operation.lock.${token}` && failures === 0) {
        failures += 1
        throw Object.assign(new Error('transient candidate sharing failure'), { code: 'EBUSY' })
      }
    }
    const hooks = {
      openCandidateDirectory: () => {
        let read = false
        return {
          closeSync: () => undefined,
          readSync: () => {
            const entry = read ? null : entryFor(token)
            read = true
            return entry
          },
        }
      },
    }

    withOperationLock(root, () => 'first', hooks)
    assert.deepEqual(identityOf(ownerPath), originalIdentity)
    assert.deepEqual(readFileSync(ownerPath), originalBytes)
    withOperationLock(root, () => 'second', hooks)
    assert.equal(existsSync(path), false)
  })

  test('preserves candidate symlinks and their external targets', () => {
    const root = createRoot()
    const outside = createRoot()
    const token = '00000000-0000-4000-8000-000000000007'
    mkdirSync(cacheDirectory(root), { recursive: true })
    writeFileSync(join(outside, 'sentinel'), 'outside')
    symlinkSync(outside, candidatePath(root, token), process.platform === 'win32' ? 'junction' : 'dir')

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside')
  })

  test('converges candidates abandoned before and after owner publication', async () => {
    await assertAbandonedCandidateConverges('before-owner')
    await assertAbandonedCandidateConverges('after-owner')
  })

  test('preserves exact owner and directory replacements before candidate quarantine', () => {
    const cases = [
      {
        mutate: (path: string) => {
          const ownerPath = join(path, 'owner.json')
          renameSync(ownerPath, join(path, 'original-owner.json'))
          writeFileSync(ownerPath, '{malformed')
          return ownerPath
        },
        name: 'owner replacement',
      },
      {
        mutate: (path: string) => {
          renameSync(path, `${path}.displaced`)
          mkdirSync(path)
          const ownerPath = join(path, 'owner.json')
          writeFileSync(ownerPath, '{malformed')
          return ownerPath
        },
        name: 'directory replacement',
      },
    ] as const

    for (const fixture of cases) {
      const root = createRoot()
      const token =
        fixture.name === 'owner replacement'
          ? '00000000-0000-4000-8000-000000000008'
          : '00000000-0000-4000-8000-000000000009'
      const path = candidatePath(root, token)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'owner.json'), '{malformed')
      utimesSync(join(path, 'owner.json'), new Date(0), new Date(0))
      utimesSync(path, new Date(0), new Date(0))
      let successorIdentity: Readonly<{ dev: bigint; ino: bigint }> | undefined
      cacheLocationTestHooks.beforeQuarantineRename = current => {
        if (basename(current) === basename(path)) {
          cacheLocationTestHooks.beforeQuarantineRename = undefined
          successorIdentity = identityOf(fixture.mutate(path))
        }
      }

      assert.equal(
        withOperationLock(root, () => 'entered'),
        'entered',
      )
      assert.equal(existsSync(path), true, fixture.name)
      assert.deepEqual(identityOf(join(path, 'owner.json')), successorIdentity, fixture.name)
      assert.equal(readFileSync(join(path, 'owner.json'), 'utf8'), '{malformed', fixture.name)
    }
  })
})
