import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EncephalonError, fail, wrapIo } from './errors.ts'

const LOCK_WAIT_MILLISECONDS = 60_000
const RECOVERY_POLL_MILLISECONDS = 50

type LockOwner = {
  token: string
  pid: number
  acquiredAt: string
}

type LockTestHooks = {
  afterStaleObservation?: () => void
}

const readOwner = (path: string): LockOwner | undefined => {
  try {
    const value = JSON.parse(readFileSync(resolve(path, 'owner.json'), 'utf8')) as Partial<LockOwner>
    if (
      typeof value.token === 'string' &&
      Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.acquiredAt === 'string'
    ) {
      return value as LockOwner
    }
  } catch {}
}

const releaseOwnedLock = (path: string, token: string) => {
  const owner = readOwner(path)
  if (owner?.token === token) {
    rmSync(path, { force: true, recursive: true })
  }
}

const sqliteBusy = (error: unknown) => {
  const candidate = error as { errcode?: unknown; message?: unknown }
  return (
    candidate.errcode === 5 ||
    candidate.errcode === 6 ||
    (typeof candidate.message === 'string' &&
      /(?:database is locked|SQLITE_BUSY|SQLITE_LOCKED)/i.test(candidate.message))
  )
}

const sqliteCorrupt = (error: unknown) => {
  const candidate = error as { errcode?: unknown; message?: unknown }
  return (
    candidate.errcode === 11 ||
    candidate.errcode === 26 ||
    (typeof candidate.message === 'string' &&
      /database disk image is malformed|file is not a database|malformed database schema/i.test(candidate.message))
  )
}

export const cacheDirectory = (root: string) => resolve(root, 'node_modules', '.cache', 'encephalon')

export const withOperationLock = <Result>(
  root: string,
  operation: () => Result,
  testHooks: LockTestHooks = {},
): Result => {
  const directory = cacheDirectory(root)
  const lockPath = resolve(directory, 'operation.lock')
  const gatePath = resolve(directory, 'operation-lock.sqlite')
  const gateRecoveryPath = resolve(directory, 'operation-lock.recovery')
  const token = randomUUID()
  const candidatePath = resolve(directory, `operation.lock.${token}`)
  const startedAt = Date.now()
  let gate: DatabaseSync | undefined
  let gateTransaction = false

  const remainingMilliseconds = () => Math.max(0, LOCK_WAIT_MILLISECONDS - (Date.now() - startedAt))

  const wait = (milliseconds: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  }

  const missingPath = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

  const quarantineGateCandidate = (path: string) => {
    const quarantinePath = `${path}.corrupt-${token}`
    try {
      renameSync(path, quarantinePath)
      rmSync(quarantinePath, { force: true })
    } catch (error) {
      if (!missingPath(error)) {
        throw error
      }
    }
  }

  const waitForGateRecovery = () => {
    while (existsSync(gateRecoveryPath)) {
      if (remainingMilliseconds() === 0) {
        return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
      wait(Math.min(RECOVERY_POLL_MILLISECONDS, remainingMilliseconds()))
    }
  }

  const quarantineCorruptGate = () => {
    for (const candidate of [`${gatePath}-wal`, `${gatePath}-shm`, `${gatePath}-journal`, gatePath]) {
      quarantineGateCandidate(candidate)
    }
  }

  const beginGateTransaction = (recoveryLockHeld = false) => {
    if (!recoveryLockHeld) {
      waitForGateRecovery()
    }
    gate = new DatabaseSync(gatePath, { timeout: remainingMilliseconds() })
    try {
      gate.exec('BEGIN IMMEDIATE')
      gateTransaction = true
    } catch (error) {
      gate.close()
      gate = undefined
      throw error
    }
  }

  const recoverCorruptGate = () => {
    let recoveryLockHeld = false
    while (!recoveryLockHeld) {
      try {
        mkdirSync(gateRecoveryPath)
        recoveryLockHeld = true
      } catch (error) {
        const existingRecovery = (error as NodeJS.ErrnoException).code === 'EEXIST'
        if (!existingRecovery) {
          throw error
        }
        if (remainingMilliseconds() === 0) {
          return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
            timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
          })
        }
        wait(Math.min(RECOVERY_POLL_MILLISECONDS, remainingMilliseconds()))
      }
    }
    try {
      try {
        beginGateTransaction(true)
      } catch (error) {
        if (sqliteBusy(error)) {
          return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
            timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
          })
        }
        if (!sqliteCorrupt(error)) {
          throw error
        }
        quarantineCorruptGate()
        beginGateTransaction(true)
      }
    } finally {
      rmSync(gateRecoveryPath, { force: true, recursive: true })
    }
  }

  try {
    mkdirSync(directory, { recursive: true })
    mkdirSync(candidatePath)
    const candidateOwner: LockOwner = {
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
      token,
    }
    writeFileSync(resolve(candidatePath, 'owner.json'), `${JSON.stringify(candidateOwner)}\n`, { flag: 'wx' })

    if (existsSync(lockPath)) {
      testHooks.afterStaleObservation?.()
    }

    try {
      beginGateTransaction()
    } catch (error) {
      if (sqliteBusy(error)) {
        return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
      if (!sqliteCorrupt(error)) {
        throw error
      }
      recoverCorruptGate()
    }

    // The SQLite transaction is the authoritative operation lock. A valid owner
    // must still hold that gate, so any directory metadata seen here is orphaned.
    if (existsSync(lockPath)) {
      rmSync(lockPath, { force: true, recursive: true })
    }

    renameSync(candidatePath, lockPath)
    try {
      return operation()
    } finally {
      try {
        releaseOwnedLock(lockPath, token)
      } catch {
        // The SQLite gate is authoritative; stale metadata is removed by the next holder.
      }
    }
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to coordinate Encephalon cache access.', error)
  } finally {
    if (gateTransaction) {
      try {
        gate?.exec('ROLLBACK')
      } catch {
        // Closing the connection below releases its operating-system lock.
      }
    }
    gate?.close()
    try {
      rmSync(candidatePath, { force: true, recursive: true })
    } catch {
      // Candidate cleanup must not mask the operation outcome.
    }
  }
}
