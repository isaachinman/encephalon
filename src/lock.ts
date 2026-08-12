import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  assertCacheDatabase,
  assertCacheLockCandidates,
  type CacheDatabase,
  CacheDatabaseFailure,
  CacheDatabaseSidecarChanged,
  type CacheLocation,
  type CacheOwnedDirectory,
  cacheDatabaseDidOpen,
  cacheDatabaseWillOpen,
  cacheOwnedDirectoryIsCurrent,
  cacheOwnedDirectoryMtimeMilliseconds,
  createCacheOwnedDirectory,
  failCacheDatabase,
  inspectCacheLocation,
  inspectCacheOwnedDirectory,
  MAX_CACHE_DATABASE_OPEN_ATTEMPTS,
  prepareCacheDatabase,
  promoteCacheOwnedDirectory,
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
  afterRecoveryCreation?: (() => void) | undefined
  afterRecoveryStaleObservation?: (() => void) | undefined
  afterStaleObservation?: (() => void) | undefined
  duringRecoveryObservation?: (() => void) | undefined
}

type RecoveryMarkerObservation =
  | { kind: 'absent' }
  | { kind: 'observed'; directory: CacheOwnedDirectory; stale: boolean }
  | { kind: 'retry' }

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
  const candidate = (error instanceof CacheDatabaseFailure ? error.failure : error) as {
    errcode?: unknown
    message?: unknown
  }
  return (
    candidate.errcode === 5 ||
    candidate.errcode === 6 ||
    (typeof candidate.message === 'string' &&
      /(?:database is locked|SQLITE_BUSY|SQLITE_LOCKED)/i.test(candidate.message))
  )
}

const sqliteCorrupt = (error: unknown) => {
  const candidate = (error instanceof CacheDatabaseFailure ? error.failure : error) as {
    errcode?: unknown
    message?: unknown
  }
  return (
    candidate.errcode === 11 ||
    candidate.errcode === 26 ||
    (typeof candidate.message === 'string' &&
      /database disk image is malformed|file is not a database|malformed database schema/i.test(candidate.message))
  )
}

export const withOperationLock = <Result>(
  root: string,
  operation: (location: CacheLocation) => Result,
  testHooks: LockTestHooks = {},
  capturedLocation?: CacheLocation,
): Result => {
  const location = capturedLocation ?? inspectCacheLocation(root)
  assertCacheLockCandidates(location)
  const lockName = 'operation.lock'
  const recoveryName = 'operation-lock.recovery'
  const token = randomUUID()
  const candidateName = `operation.lock.${token}`
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

  const recoveryMarkerObservation = (): RecoveryMarkerObservation => {
    const recoveryDirectory = inspectCacheOwnedDirectory(location, recoveryName)
    if (recoveryDirectory === undefined) {
      return { kind: 'absent' }
    }
    testHooks.duringRecoveryObservation?.()
    try {
      const owner = readOwner(location, recoveryDirectory)
      if (owner !== undefined) {
        const acquiredAt = Date.parse(owner.acquiredAt)
        const age = Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : RECOVERY_STALE_MILLISECONDS + 1
        return {
          directory: recoveryDirectory,
          kind: 'observed',
          stale: !processIsRunning(owner.pid) || age > RECOVERY_STALE_MILLISECONDS,
        }
      }
      return {
        directory: recoveryDirectory,
        kind: 'observed',
        stale:
          Date.now() - cacheOwnedDirectoryMtimeMilliseconds(location, recoveryDirectory) > RECOVERY_STALE_MILLISECONDS,
      }
    } catch (error) {
      if (cacheOwnedDirectoryIsCurrent(location, recoveryDirectory)) {
        throw error
      }
      return { kind: 'retry' }
    }
  }

  const reclaimRecoveryMarker = (recoveryDirectory: CacheOwnedDirectory) => {
    testHooks.afterRecoveryStaleObservation?.()
    if (cacheOwnedDirectoryIsCurrent(location, recoveryDirectory)) {
      quarantineCacheOwnedDirectory(location, recoveryDirectory)
    }
  }

  const waitForGateRecovery = () => {
    let observation = recoveryMarkerObservation()
    while (observation.kind !== 'absent') {
      if (remainingMilliseconds() === 0) {
        return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
      if (observation.kind === 'observed' && observation.stale) {
        reclaimRecoveryMarker(observation.directory)
      }
      if (observation.kind === 'observed') {
        wait(Math.min(RECOVERY_POLL_MILLISECONDS, remainingMilliseconds()))
      }
      observation = recoveryMarkerObservation()
    }
  }

  const quarantineCorruptGate = (error: unknown) => {
    if (error instanceof CacheDatabaseFailure) {
      return quarantineCacheDatabase(location, error.database)
    }
    throw error
  }

  const beginGateTransaction = (recoveryLockHeld = false) => {
    if (!recoveryLockHeld) {
      waitForGateRecovery()
    }
    gateDatabase = prepareCacheDatabase(location, 'operation-lock.sqlite')
    const attempts = Array.from({ length: MAX_CACHE_DATABASE_OPEN_ATTEMPTS }, (_, index) => index)
    for (const attempt of attempts) {
      cacheDatabaseWillOpen(gateDatabase)
      gateDatabase = assertCacheDatabase(location, gateDatabase)
      try {
        gate = new DatabaseSync(gateDatabase.path, { timeout: remainingMilliseconds() })
      } catch (error) {
        return failCacheDatabase(error, gateDatabase)
      }
      try {
        cacheDatabaseDidOpen(gateDatabase)
        // Node's SQLite API accepts only pathnames, leaving a narrow replacement race
        // between this identity check and SQLite's internal open.
        gateDatabase = assertCacheDatabase(location, gateDatabase)
        gate.exec('BEGIN IMMEDIATE')
        gateTransaction = true
        return
      } catch (error) {
        if (error instanceof CacheDatabaseSidecarChanged) {
          gate.close()
          gate = undefined
          gateDatabase = error.database
          if (attempt === MAX_CACHE_DATABASE_OPEN_ATTEMPTS - 1) {
            throw error
          }
        } else {
          let validationError: unknown
          try {
            gateDatabase = assertCacheDatabase(location, gateDatabase)
          } catch (candidate) {
            validationError = candidate
          }
          gate.close()
          gate = undefined
          if (validationError !== undefined) {
            throw validationError
          }
          if (error instanceof EncephalonError) {
            throw error
          }
          return failCacheDatabase(error, gateDatabase)
        }
      }
    }
    return fail('INTERNAL_ERROR', 'The Encephalon gate database open ended unexpectedly.')
  }

  const recoverCorruptGate = () => {
    let recoveryLockHeld = false
    let ownedRecoveryDirectory: CacheOwnedDirectory | undefined
    let recoveryError: unknown
    while (!recoveryLockHeld) {
      try {
        const recoveryDirectory = createCacheOwnedDirectory(location, recoveryName)
        ownedRecoveryDirectory = recoveryDirectory
        writeCacheOwner(
          location,
          recoveryDirectory,
          `${JSON.stringify({
            acquiredAt: new Date().toISOString(),
            pid: process.pid,
            token,
          })}\n`,
        )
        testHooks.afterRecoveryCreation?.()
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
        const observation = recoveryMarkerObservation()
        if (observation.kind === 'observed' && observation.stale) {
          reclaimRecoveryMarker(observation.directory)
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
        quarantineCorruptGate(error)
        beginGateTransaction(true)
      }
    } catch (error) {
      recoveryError = error
    }
    let cleanupError: unknown
    try {
      if (ownedRecoveryDirectory !== undefined) {
        quarantineCacheOwnedDirectory(location, ownedRecoveryDirectory)
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
    candidateDirectory = createCacheOwnedDirectory(location, candidateName)
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

    ownedLockDirectory = promoteCacheOwnedDirectory(location, candidateDirectory, lockName)
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
      const remainingCandidate = candidateDirectory ?? inspectCacheOwnedDirectory(location, candidateName)
      if (remainingCandidate !== undefined) {
        quarantineCacheOwnedDirectory(location, remainingCandidate)
      }
    } catch {
      // Candidate cleanup must not mask the operation outcome.
    }
  }
}
