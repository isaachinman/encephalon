import { randomUUID } from 'node:crypto'
import { renameSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  assertCacheDatabase,
  assertCacheOwnedEntries,
  type CacheDatabase,
  type CacheLocation,
  type CacheOwnedDirectory,
  createCacheOwnedDirectory,
  inspectCacheLocation,
  inspectCacheOwnedDirectory,
  prepareCacheDatabase,
  quarantineCacheDatabase,
  quarantineCacheOwnedDirectory,
  readCacheOwner,
  writeCacheOwner,
} from './cache-location.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'

const LOCK_WAIT_MILLISECONDS = 60_000
const RECOVERY_POLL_MILLISECONDS = 50
const RECOVERY_STALE_MILLISECONDS = 5000

type LockOwner = {
  token: string
  pid: number
  acquiredAt: string
}

type LockTestHooks = {
  afterStaleObservation?: () => void
}

const MAX_OWNER_BYTES = 4096

const readOwner = (location: CacheLocation, directory: CacheOwnedDirectory): LockOwner | undefined => {
  try {
    const contents = readCacheOwner(location, directory, MAX_OWNER_BYTES)
    const value = JSON.parse(contents ?? '') as Partial<LockOwner>
    if (
      typeof value.token === 'string' &&
      Number.isInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.acquiredAt === 'string'
    ) {
      return value as LockOwner
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }
}

const releaseOwnedLock = (location: CacheLocation, directory: CacheOwnedDirectory, token: string) => {
  const owner = readOwner(location, directory)
  if (owner?.token === token) {
    quarantineCacheOwnedDirectory(location, directory)
  }
}

const processIsRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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
  operation: (location: CacheLocation) => Result,
  testHooks: LockTestHooks = {},
  capturedLocation?: CacheLocation,
): Result => {
  const location = capturedLocation ?? inspectCacheLocation(root)
  assertCacheOwnedEntries(location)
  const { directory } = location
  const lockName = 'operation.lock'
  const lockPath = resolve(directory, lockName)
  const recoveryName = 'operation-lock.recovery'
  const token = randomUUID()
  const candidatePath = resolve(directory, `operation.lock.${token}`)
  const startedAt = Date.now()
  let gate: DatabaseSync | undefined
  let gateDatabase: CacheDatabase | undefined
  let gateTransaction = false
  let candidateDirectory: CacheOwnedDirectory | undefined
  let ownedLockDirectory: CacheOwnedDirectory | undefined

  const remainingMilliseconds = () => Math.max(0, LOCK_WAIT_MILLISECONDS - (Date.now() - startedAt))

  const wait = (milliseconds: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  }

  const missingPath = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

  const recoveryMarkerIsStale = () => {
    const recoveryDirectory = inspectCacheOwnedDirectory(location, recoveryName)
    if (recoveryDirectory === undefined) {
      return false
    }
    const owner = readOwner(location, recoveryDirectory)
    if (owner !== undefined) {
      const acquiredAt = Date.parse(owner.acquiredAt)
      const age = Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : RECOVERY_STALE_MILLISECONDS + 1
      return !processIsRunning(owner.pid) || age > RECOVERY_STALE_MILLISECONDS
    }
    try {
      return Date.now() - statSync(recoveryDirectory.path).mtimeMs > RECOVERY_STALE_MILLISECONDS
    } catch (error) {
      if (missingPath(error)) {
        return false
      }
      throw error
    }
  }

  const reclaimRecoveryMarker = () => {
    const recoveryDirectory = inspectCacheOwnedDirectory(location, recoveryName)
    if (recoveryDirectory !== undefined) {
      quarantineCacheOwnedDirectory(location, recoveryDirectory)
    }
  }

  const waitForGateRecovery = () => {
    while (inspectCacheOwnedDirectory(location, recoveryName) !== undefined) {
      if (remainingMilliseconds() === 0) {
        return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
      if (recoveryMarkerIsStale()) {
        reclaimRecoveryMarker()
      }
      wait(Math.min(RECOVERY_POLL_MILLISECONDS, remainingMilliseconds()))
    }
  }

  const quarantineCorruptGate = () => {
    quarantineCacheDatabase(location, 'operation-lock.sqlite')
  }

  const beginGateTransaction = (recoveryLockHeld = false) => {
    if (!recoveryLockHeld) {
      waitForGateRecovery()
    }
    gateDatabase = prepareCacheDatabase(location, 'operation-lock.sqlite')
    gate = new DatabaseSync(gateDatabase.path, { timeout: remainingMilliseconds() })
    try {
      // Node's SQLite API accepts only pathnames, leaving a narrow replacement race
      // between this identity check and SQLite's internal open.
      assertCacheDatabase(location, gateDatabase)
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
    let recoveryError: unknown
    while (!recoveryLockHeld) {
      try {
        const recoveryDirectory = createCacheOwnedDirectory(location, recoveryName)
        writeCacheOwner(
          location,
          recoveryDirectory,
          `${JSON.stringify({
            acquiredAt: new Date().toISOString(),
            pid: process.pid,
            token,
          })}\n`,
        )
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
        if (recoveryMarkerIsStale()) {
          reclaimRecoveryMarker()
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
    } catch (error) {
      recoveryError = error
    }
    let cleanupError: unknown
    try {
      const recoveryDirectory = inspectCacheOwnedDirectory(location, recoveryName)
      if (recoveryDirectory !== undefined && readOwner(location, recoveryDirectory)?.token === token) {
        quarantineCacheOwnedDirectory(location, recoveryDirectory)
      }
    } catch (error) {
      cleanupError = error
    }
    if (recoveryError !== undefined) {
      throw recoveryError
    }
    if (cleanupError !== undefined) {
      throw cleanupError
    }
  }

  try {
    candidateDirectory = createCacheOwnedDirectory(location, `operation.lock.${token}`)
    const candidateOwner: LockOwner = {
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
      token,
    }
    writeCacheOwner(location, candidateDirectory, `${JSON.stringify(candidateOwner)}\n`)

    const observedLock = inspectCacheOwnedDirectory(location, lockName)
    if (observedLock !== undefined) {
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
    const staleLock = inspectCacheOwnedDirectory(location, lockName)
    if (staleLock !== undefined) {
      quarantineCacheOwnedDirectory(location, staleLock)
    }

    renameSync(candidatePath, lockPath)
    ownedLockDirectory = { ...candidateDirectory, name: lockName, path: lockPath }
    candidateDirectory = undefined
    try {
      return operation(location)
    } finally {
      try {
        releaseOwnedLock(location, ownedLockDirectory, token)
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
      const remainingCandidate = candidateDirectory ?? inspectCacheOwnedDirectory(location, `operation.lock.${token}`)
      if (remainingCandidate !== undefined) {
        quarantineCacheOwnedDirectory(location, remainingCandidate)
      }
    } catch {
      // Candidate cleanup must not mask the operation outcome.
    }
  }
}
