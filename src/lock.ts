import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  assertCacheLockCandidates,
  CacheDatabaseFailure,
  type CacheLocation,
  type CacheOwnedDirectory,
  cacheOwnedDirectoryIsCurrent,
  cacheOwnedDirectoryMtimeMilliseconds,
  createCacheOwnedDirectory,
  inspectCacheLocation,
  inspectCacheOwnedDirectory,
  observeCacheOwnedDirectory,
  openVerifiedCacheDatabase,
  promoteCacheOwnedDirectory,
  quarantineCacheDatabase,
  quarantineCacheOwnedDirectory,
  readCacheOwner,
  writeCacheOwner,
} from './cache-location.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { classifySQLiteError, type SQLiteErrorCategory } from './sqlite-error.ts'

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

type OwnedRecoveryMarker = {
  directory: CacheOwnedDirectory
  token: string
}

const MAX_OWNER_BYTES = 4096
const MAX_OWNER_TIMESTAMP_LENGTH = 64
const MAX_OWNER_TOKEN_LENGTH = 128

const readOwner = (location: CacheLocation, directory: CacheOwnedDirectory): LockOwner | undefined => {
  try {
    const contents = readCacheOwner(location, directory, MAX_OWNER_BYTES)
    const value = JSON.parse(contents ?? '') as Partial<LockOwner>
    if (
      typeof value.token === 'string' &&
      value.token.length > 0 &&
      value.token.length <= MAX_OWNER_TOKEN_LENGTH &&
      Number.isSafeInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.acquiredAt === 'string' &&
      value.acquiredAt.length > 0 &&
      value.acquiredAt.length <= MAX_OWNER_TIMESTAMP_LENGTH
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
    quarantineCacheOwnedDirectory(location, directory, () => readOwner(location, directory)?.token === token)
  }
}

const processIsRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const sqliteFailureCategory = (error: unknown): SQLiteErrorCategory =>
  classifySQLiteError(error instanceof CacheDatabaseFailure ? error.failure : error)

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
  let gateTransaction = false
  let candidateDirectory: CacheOwnedDirectory | undefined
  let ownedLockDirectory: CacheOwnedDirectory | undefined

  const remainingMilliseconds = () => Math.max(0, LOCK_WAIT_MILLISECONDS - (Date.now() - startedAt))

  const wait = (milliseconds: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  }

  const recoveryMarkerObservation = (): RecoveryMarkerObservation => {
    const directoryObservation = observeCacheOwnedDirectory(location, recoveryName)
    if (directoryObservation.kind === 'missing') {
      return { kind: 'absent' }
    }
    if (directoryObservation.kind === 'changed') {
      return { kind: 'retry' }
    }
    const recoveryDirectory = directoryObservation.directory
    testHooks.duringRecoveryObservation?.()
    try {
      const owner = readOwner(location, recoveryDirectory)
      if (owner !== undefined) {
        return {
          directory: recoveryDirectory,
          kind: 'observed',
          stale: !processIsRunning(owner.pid),
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

  const recoveryMarkerIsOwned = (marker: OwnedRecoveryMarker) => {
    try {
      if (cacheOwnedDirectoryIsCurrent(location, marker.directory)) {
        return readOwner(location, marker.directory)?.token === marker.token
      }
      return false
    } catch (error) {
      if (cacheOwnedDirectoryIsCurrent(location, marker.directory)) {
        throw error
      }
      return false
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
    gate = openVerifiedCacheDatabase({
      afterVerifiedOpen: database => {
        database.exec('BEGIN IMMEDIATE')
      },
      create: true,
      DatabaseConstructor: DatabaseSync,
      location,
      name: 'operation-lock.sqlite',
      openOptions: { timeout: remainingMilliseconds() },
      preserveDatabaseLocksAfterInitialisation: true,
    })
    gateTransaction = true
  }

  const acquireRecoveryMarker = (): OwnedRecoveryMarker => {
    let ownedMarker: OwnedRecoveryMarker | undefined
    while (ownedMarker === undefined) {
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
        testHooks.afterRecoveryCreation?.()
        const candidate = { directory: recoveryDirectory, token }
        if (recoveryMarkerIsOwned(candidate)) {
          ownedMarker = candidate
        }
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
    return ownedMarker
  }

  const recoverGateWhileOwned = (ownedMarker: OwnedRecoveryMarker) => {
    let recovered = false
    if (recoveryMarkerIsOwned(ownedMarker)) {
      try {
        beginGateTransaction(true)
        recovered = true
      } catch (error) {
        const category = sqliteFailureCategory(error)
        if (category === 'busy' || category === 'locked') {
          return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
            timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
          })
        }
        if (category === 'corrupt' || category === 'notadb') {
          if (recoveryMarkerIsOwned(ownedMarker)) {
            quarantineCorruptGate(error)
            if (recoveryMarkerIsOwned(ownedMarker)) {
              beginGateTransaction(true)
              recovered = true
            }
          }
        } else {
          throw error
        }
      }
    }
    return recovered
  }

  const recoverCorruptGate = () => {
    let recovered = false
    while (!recovered) {
      const ownedMarker = acquireRecoveryMarker()
      try {
        recovered = recoverGateWhileOwned(ownedMarker)
      } finally {
        try {
          releaseOwnedLock(location, ownedMarker.directory, ownedMarker.token)
        } catch {
          // Recovery-marker cleanup cannot replace the gate recovery result.
        }
      }
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
      const category = sqliteFailureCategory(error)
      if (category === 'busy' || category === 'locked') {
        return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
      if (category === 'corrupt' || category === 'notadb') {
        recoverCorruptGate()
      } else {
        throw error
      }
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
