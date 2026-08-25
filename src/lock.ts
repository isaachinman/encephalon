import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  assertCacheLockCandidates,
  type CacheDatabase,
  CacheDatabaseCreationConflict,
  CacheDatabaseFailure,
  type CacheLocation,
  type CacheOwnedDirectory,
  cacheOwnedDirectoryIsCurrent,
  cacheOwnedDirectoryMtimeMilliseconds,
  closeCacheDatabaseWithMetadataAuthority,
  createCacheOwnedDirectory,
  inspectCacheLocation,
  inspectCacheOwnedDirectory,
  observeCacheOwnedDirectory,
  openVerifiedCacheDatabase,
  promoteCacheOwnedDirectory,
  quarantineCacheDatabase,
  quarantineCacheOwnedDirectory,
  readCacheOwner,
  sameCacheEntryIdentity,
  writeCacheOwner,
} from './cache-location.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { classifySQLiteError, type SQLiteErrorCategory } from './sqlite-error.ts'

const LOCK_WAIT_MILLISECONDS = 60_000
const RECOVERY_POLL_MILLISECONDS = 50
const RECOVERY_STALE_MILLISECONDS = 5000
const RECOVERY_RELEASE_ATTEMPTS = 3

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
  gateClose?: ((database: DatabaseSync) => void) | undefined
  now?: (() => number) | undefined
}

type RecoveryMarkerObservation =
  | { kind: 'absent' }
  | {
      kind: 'observed'
      directory: CacheOwnedDirectory
      owner: Pick<LockOwner, 'pid' | 'token'> | undefined
      stale: boolean
    }
  | { kind: 'retry' }

type OwnedRecoveryMarker = {
  directory: CacheOwnedDirectory
  token: string
}

type GatePrimary =
  | { kind: 'create-exclusive' }
  | { kind: 'create-if-missing' }
  | { database: CacheDatabase; kind: 'expected-owned' }

type HeldGate = {
  database: DatabaseSync
  identity: CacheDatabase
}

const abandonedRecoveryMarkers = new Map<string, OwnedRecoveryMarker>()
const MAX_ABANDONED_RECOVERY_MARKERS = 64

const MAX_OWNER_BYTES = 4096
const MAX_OWNER_PID = 2_147_483_647
const MAX_OWNER_TIMESTAMP_LENGTH = 64
const MAX_OWNER_TOKEN_LENGTH = 128

const rememberAbandonedRecoveryMarker = (marker: OwnedRecoveryMarker) => {
  abandonedRecoveryMarkers.delete(marker.directory.path)
  abandonedRecoveryMarkers.set(marker.directory.path, marker)
  if (abandonedRecoveryMarkers.size > MAX_ABANDONED_RECOVERY_MARKERS) {
    const oldestPath = abandonedRecoveryMarkers.keys().next().value
    if (oldestPath !== undefined) {
      abandonedRecoveryMarkers.delete(oldestPath)
    }
  }
}

const readOwner = (location: CacheLocation, directory: CacheOwnedDirectory): LockOwner | undefined => {
  try {
    const contents = readCacheOwner(location, directory, MAX_OWNER_BYTES)
    const parsed: unknown = JSON.parse(contents ?? '')
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const value = parsed as Partial<LockOwner>
      if (
        typeof value.token === 'string' &&
        value.token.length > 0 &&
        value.token.length <= MAX_OWNER_TOKEN_LENGTH &&
        Number.isSafeInteger(value.pid) &&
        (value.pid ?? 0) > 0 &&
        (value.pid ?? 0) <= MAX_OWNER_PID &&
        typeof value.acquiredAt === 'string' &&
        value.acquiredAt.length > 0 &&
        value.acquiredAt.length <= MAX_OWNER_TIMESTAMP_LENGTH
      ) {
        return value as LockOwner
      }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }
}

const transientSharingViolation = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

const releaseOwnedLock = (
  location: CacheLocation,
  directory: CacheOwnedDirectory,
  token: string,
  retrySharingViolations = false,
) => {
  const maximumAttempts = retrySharingViolations ? RECOVERY_RELEASE_ATTEMPTS : 1
  let complete = false
  for (const attempt of Array.from({ length: maximumAttempts }, (_, index) => index)) {
    const owner = readOwner(location, directory)
    if (owner?.token === token) {
      try {
        quarantineCacheOwnedDirectory(location, directory, () => readOwner(location, directory)?.token === token)
        complete = true
      } catch (error) {
        const canRetry = retrySharingViolations && transientSharingViolation(error) && attempt < maximumAttempts - 1
        if (canRetry) {
          const stillOwned =
            cacheOwnedDirectoryIsCurrent(location, directory) && readOwner(location, directory)?.token === token
          if (stillOwned) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECOVERY_POLL_MILLISECONDS)
          } else {
            complete = true
          }
        } else {
          throw error
        }
      }
    } else {
      complete = true
    }
    if (complete) {
      break
    }
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

const operationGateChanged = () =>
  fail('REPOSITORY_CHANGED', 'The Encephalon cache layout changed during the operation.', {
    entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
    invariant: 'stable-identity',
  })

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
  const now = testHooks.now ?? Date.now
  const startedAt = now()
  let gate: HeldGate | undefined
  let candidateDirectory: CacheOwnedDirectory | undefined
  let ownedLockDirectory: CacheOwnedDirectory | undefined

  const recoveryMarkerWasAbandoned = (directory: CacheOwnedDirectory, owner: LockOwner | undefined) => {
    const abandoned = abandonedRecoveryMarkers.get(directory.path)
    if (abandoned !== undefined) {
      const matches =
        abandoned.directory.path === directory.path &&
        abandoned.directory.name === directory.name &&
        sameCacheEntryIdentity(abandoned.directory, directory) &&
        (owner === undefined || owner.token === abandoned.token)
      if (!matches) {
        abandonedRecoveryMarkers.delete(directory.path)
      }
      return matches
    }
    return false
  }

  const remainingMilliseconds = () => Math.max(0, LOCK_WAIT_MILLISECONDS - (now() - startedAt))

  const wait = (milliseconds: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  }

  const recoveryMarkerObservation = (): RecoveryMarkerObservation => {
    const directoryObservation = observeCacheOwnedDirectory(location, recoveryName)
    if (directoryObservation.kind === 'missing') {
      abandonedRecoveryMarkers.delete(resolve(location.directory, recoveryName))
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
        const abandoned = recoveryMarkerWasAbandoned(recoveryDirectory, owner)
        return {
          directory: recoveryDirectory,
          kind: 'observed',
          owner: { pid: owner.pid, token: owner.token },
          stale: abandoned || !processIsRunning(owner.pid),
        }
      }
      const abandoned = recoveryMarkerWasAbandoned(recoveryDirectory, owner)
      return {
        directory: recoveryDirectory,
        kind: 'observed',
        owner: undefined,
        stale:
          abandoned ||
          now() - cacheOwnedDirectoryMtimeMilliseconds(location, recoveryDirectory) > RECOVERY_STALE_MILLISECONDS,
      }
    } catch (error) {
      if (cacheOwnedDirectoryIsCurrent(location, recoveryDirectory)) {
        throw error
      }
      return { kind: 'retry' }
    }
  }

  const recoveryMarkerRemainsStale = (observation: Extract<RecoveryMarkerObservation, { kind: 'observed' }>) => {
    const currentOwner = readOwner(location, observation.directory)
    if (observation.owner !== undefined) {
      return (
        currentOwner?.token === observation.owner.token &&
        currentOwner.pid === observation.owner.pid &&
        (recoveryMarkerWasAbandoned(observation.directory, currentOwner) || !processIsRunning(currentOwner.pid))
      )
    }
    const abandoned = recoveryMarkerWasAbandoned(observation.directory, currentOwner)
    return (
      currentOwner === undefined &&
      (abandoned ||
        now() - cacheOwnedDirectoryMtimeMilliseconds(location, observation.directory) > RECOVERY_STALE_MILLISECONDS)
    )
  }

  const reclaimRecoveryMarker = (observation: Extract<RecoveryMarkerObservation, { kind: 'observed' }>) => {
    testHooks.afterRecoveryStaleObservation?.()
    if (cacheOwnedDirectoryIsCurrent(location, observation.directory)) {
      const reclaimed = quarantineCacheOwnedDirectory(location, observation.directory, () =>
        recoveryMarkerRemainsStale(observation),
      )
      if (reclaimed) {
        abandonedRecoveryMarkers.delete(observation.directory.path)
      }
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

  const quarantineCorruptGate = (error: unknown) => {
    if (error instanceof CacheDatabaseFailure) {
      return quarantineCacheDatabase(location, error.database)
    }
    throw error
  }

  const beginGateTransaction = (primary: GatePrimary) => {
    try {
      const opened = openVerifiedCacheDatabase({
        afterVerifiedOpen: database => {
          database.exec('BEGIN IMMEDIATE')
        },
        DatabaseConstructor: DatabaseSync,
        location,
        name: 'operation-lock.sqlite',
        openOptions: { timeout: remainingMilliseconds() },
        preserveDatabaseLocksAfterInitialisation: true,
        primary,
      })
      gate = { database: opened.database, identity: opened.identity }
      return opened.identity
    } catch (error) {
      if (error instanceof CacheDatabaseCreationConflict) {
        return operationGateChanged()
      }
      throw error
    }
  }

  const releaseGate = () => {
    const heldGate = gate
    gate = undefined
    if (heldGate !== undefined) {
      const { database, identity } = heldGate
      const close = testHooks.gateClose ?? ((current: DatabaseSync) => current.close())
      const { closeFailure, closeProofFailure, closeSuppressed, validationFailure } =
        closeCacheDatabaseWithMetadataAuthority(location, identity, {
          close: () => {
            try {
              database.exec('ROLLBACK')
            } catch {
              // Closing the connection below releases its operating-system lock.
            }
            close(database)
          },
        })
      const metadataAuthorityFailure = validationFailure ?? closeProofFailure
      if (metadataAuthorityFailure !== undefined) {
        if (metadataAuthorityFailure instanceof EncephalonError) {
          throw metadataAuthorityFailure
        }
        return wrapIo('Unable to validate the Encephalon operation gate before cleanup.', metadataAuthorityFailure)
      }
      if (closeFailure !== undefined) {
        throw closeFailure
      }
      if (closeSuppressed) {
        return fail('INTERNAL_ERROR', 'The Encephalon operation gate could not be proven safe to close.')
      }
    }
  }

  const beginGateWhileRecoveryOwned = (ownedMarker: OwnedRecoveryMarker, primary: GatePrimary) => {
    let owned = false
    const database = beginGateTransaction(primary)
    if (recoveryMarkerIsOwned(ownedMarker)) {
      owned = true
    } else {
      releaseGate()
    }
    return { acquired: owned, database }
  }

  const attemptGateWhileOwned = (ownedMarker: OwnedRecoveryMarker, primary: GatePrimary) => {
    try {
      return { ...beginGateWhileRecoveryOwned(ownedMarker, primary), category: undefined }
    } catch (error) {
      const category = sqliteFailureCategory(error)
      if (category === 'busy' || category === 'locked') {
        return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
      return { acquired: false, category, error }
    }
  }

  let nextGatePrimary: GatePrimary = { kind: 'create-if-missing' }

  const acquireRecoveryMarker = (): OwnedRecoveryMarker => {
    let ownedMarker: OwnedRecoveryMarker | undefined
    while (ownedMarker === undefined) {
      if (remainingMilliseconds() === 0) {
        return fail('CACHE_BUSY', 'Timed out waiting for the Encephalon operation lock.', {
          timeoutMilliseconds: LOCK_WAIT_MILLISECONDS,
        })
      }
      let createdMarker: OwnedRecoveryMarker | undefined
      try {
        const recoveryDirectory = createCacheOwnedDirectory(location, recoveryName)
        const candidate = { directory: recoveryDirectory, token }
        createdMarker = candidate
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
        if (recoveryMarkerIsOwned(candidate)) {
          ownedMarker = candidate
        } else {
          wait(Math.min(RECOVERY_POLL_MILLISECONDS, remainingMilliseconds()))
        }
      } catch (error) {
        if (createdMarker !== undefined) {
          rememberAbandonedRecoveryMarker(createdMarker)
          throw error
        }
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
          reclaimRecoveryMarker(observation)
        }
        wait(Math.min(RECOVERY_POLL_MILLISECONDS, remainingMilliseconds()))
      }
    }
    return ownedMarker
  }

  const acquireGateWhileOwned = (ownedMarker: OwnedRecoveryMarker) => {
    let acquired = false
    if (recoveryMarkerIsOwned(ownedMarker)) {
      const initial = attemptGateWhileOwned(ownedMarker, nextGatePrimary)
      if ('database' in initial) {
        nextGatePrimary = { database: initial.database, kind: 'expected-owned' }
        ;({ acquired } = initial)
      } else {
        const recoverable = initial.category === 'corrupt' || initial.category === 'notadb'
        if (recoverable && initial.error instanceof CacheDatabaseFailure) {
          if (recoveryMarkerIsOwned(ownedMarker)) {
            const confirmed = attemptGateWhileOwned(ownedMarker, {
              database: initial.error.database,
              kind: 'expected-owned',
            })
            if ('database' in confirmed) {
              nextGatePrimary = { database: confirmed.database, kind: 'expected-owned' }
              ;({ acquired } = confirmed)
            } else {
              const confirmedRecoverable = confirmed.category === 'corrupt' || confirmed.category === 'notadb'
              if (confirmedRecoverable) {
                if (recoveryMarkerIsOwned(ownedMarker)) {
                  quarantineCorruptGate(confirmed.error)
                  nextGatePrimary = { kind: 'create-exclusive' }
                  if (recoveryMarkerIsOwned(ownedMarker)) {
                    const retried = attemptGateWhileOwned(ownedMarker, nextGatePrimary)
                    if ('database' in retried) {
                      nextGatePrimary = { database: retried.database, kind: 'expected-owned' }
                      ;({ acquired } = retried)
                    } else {
                      throw retried.error
                    }
                  }
                }
              } else {
                throw confirmed.error
              }
            }
          }
        } else {
          throw initial.error
        }
      }
    }
    return acquired
  }

  const acquireGateTransaction = () => {
    let acquired = false
    while (!acquired) {
      const ownedMarker = acquireRecoveryMarker()
      let acquisitionError: unknown
      try {
        acquired = acquireGateWhileOwned(ownedMarker)
      } catch (error) {
        acquisitionError = error
      }
      let cleanupError: unknown
      try {
        releaseOwnedLock(location, ownedMarker.directory, ownedMarker.token, true)
        abandonedRecoveryMarkers.delete(ownedMarker.directory.path)
      } catch (error) {
        rememberAbandonedRecoveryMarker(ownedMarker)
        cleanupError = error
      }
      if (acquisitionError !== undefined) {
        throw acquisitionError
      }
      if (cleanupError !== undefined) {
        throw cleanupError
      }
    }
  }

  let operationError: unknown
  let operationOutcome: { value: Result } | undefined
  try {
    candidateDirectory = createCacheOwnedDirectory(location, candidateName)
    const candidateOwner: LockOwner = {
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
      token,
    }
    writeCacheOwner(location, candidateDirectory, `${JSON.stringify(candidateOwner)}\n`)

    const observedLock = observeCacheOwnedDirectory(location, lockName)
    if (observedLock.kind === 'stable') {
      testHooks.afterStaleObservation?.()
    }

    acquireGateTransaction()

    // The SQLite transaction is the authoritative operation lock. A valid owner
    // must still hold that gate, so any directory metadata seen here is orphaned.
    const staleLock = inspectCacheOwnedDirectory(location, lockName)
    if (staleLock !== undefined) {
      quarantineCacheOwnedDirectory(location, staleLock)
    }

    ownedLockDirectory = promoteCacheOwnedDirectory(location, candidateDirectory, lockName)
    candidateDirectory = undefined
    try {
      operationOutcome = { value: operation(location) }
    } finally {
      try {
        releaseOwnedLock(location, ownedLockDirectory, token)
      } catch {
        // The SQLite gate is authoritative; stale metadata is removed by the next holder.
      }
    }
  } catch (error) {
    if (error instanceof EncephalonError) {
      operationError = error
    } else {
      try {
        wrapIo('Unable to coordinate Encephalon cache access.', error)
      } catch (wrappedError) {
        operationError = wrappedError
      }
    }
  }
  let gateCleanupError: unknown
  try {
    releaseGate()
  } catch (error) {
    gateCleanupError = error
  }
  try {
    const remainingCandidate = candidateDirectory ?? inspectCacheOwnedDirectory(location, candidateName)
    if (remainingCandidate !== undefined) {
      quarantineCacheOwnedDirectory(location, remainingCandidate)
    }
  } catch {
    // Candidate cleanup must not mask the operation outcome.
  }
  if (operationError !== undefined) {
    throw operationError
  }
  if (gateCleanupError !== undefined) {
    throw gateCleanupError
  }
  if (operationOutcome === undefined) {
    return fail('INTERNAL_ERROR', 'The Encephalon operation lock ended without an outcome.')
  }
  return operationOutcome.value
}
