import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import type { DirectoryReader } from '../src/bounded-directory.ts'
import { cacheLocationTestHooks } from '../src/cache-location.ts'
import { withOperationLock } from '../src/lock.ts'
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

afterEach(() => {
  cacheLocationTestHooks.beforeQuarantineRename = undefined
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
  test('runs under the gate and visits at most 64 lazy entries without private diagnostics', () => {
    const root = createRoot()
    let gateHeld = false
    let reads = 0
    let closes = 0
    let reported: Readonly<Record<string, unknown>> | undefined
    const reader: DirectoryReader<Entry> = {
      closeSync: () => {
        closes += 1
      },
      readSync: () => {
        assert.equal(gateHeld, true)
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
      beforeCandidateMaintenance: () => {
        gateHeld = true
      },
      openCandidateDirectory: () => reader,
    })

    assert.equal(result, 'entered')
    assert.equal(reads, 64)
    assert.equal(closes, 0)
    assert.ok(reported)
    assert.equal(Number(reported.directoryEntriesVisited) <= 64, true)
    assert.equal(Number(reported.candidatesInspected) <= 16, true)
    assert.equal(Number(reported.reclamationAttempts) <= 4, true)
    assert.equal(
      Object.values(reported).some(value => typeof value === 'string'),
      false,
    )
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

  test('evicts the least-recently-used cursor after the ninth repository', () => {
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
    for (const root of repositories) {
      withOperationLock(root, () => 'entered', { openCandidateDirectory: openDirectory })
    }

    assert.equal(closes.get(openedPaths[0] as string), 1)
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
          writeFileSync(join(path, 'owner.json'), 'replacement owner bytes')
        },
        name: 'owner replacement',
      },
      {
        mutate: (path: string) => {
          renameSync(path, `${path}.displaced`)
          mkdirSync(path)
          writeFileSync(join(path, 'successor'), 'replacement directory')
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
      cacheLocationTestHooks.beforeQuarantineRename = current => {
        if (basename(current) === basename(path)) {
          cacheLocationTestHooks.beforeQuarantineRename = undefined
          fixture.mutate(path)
        }
      }

      assert.equal(
        withOperationLock(root, () => 'entered'),
        'entered',
      )
      assert.equal(existsSync(path), true, fixture.name)
    }
  })
})
