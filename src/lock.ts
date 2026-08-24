import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  type CacheDatabase,
  CacheDatabaseCreationConflict,
  CacheDatabaseFailure,
  type CacheLocation,
  type CacheOwnedDirectory,
  type CacheOwnedFileObservation,
  cacheOwnedDirectoryIsCurrent,
  cacheOwnedDirectoryMtimeMilliseconds,
  createCacheOwnedDirectory,
  inspectCacheLocation,
  inspectCacheOwnedDirectory,
  observeCacheOwnedDirectory,
  observeCacheOwner,
  observeCacheRecoveryWitness,
  observeExactCacheOwnedDirectoryChildren,
  openVerifiedCacheDatabase,
  promoteCacheOwnedDirectory,
  publishCacheOwnerRecovery,
  quarantineCacheDatabase,
  quarantineCacheOwnedDirectory,
  sameCacheEntryIdentity,
  sameCacheOwnedFileObservation,
  writeCacheOwner,
} from './cache-location.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { sameStableEntryMetadata } from './filesystem-entry.ts'
import {
  type LockCandidateDirectoryReader,
  type LockCandidateMaintenanceStats,
  maintainLockCandidates,
} from './lock-candidates.ts'
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

type RecoveryPhase = 'recovered' | 'recovering'

type RecoveryOwner = LockOwner & {
  phase: RecoveryPhase
}

type CacheOwnedFileContents = Extract<CacheOwnedFileObservation, { kind: 'contents' }>

type ObservedOwner = {
  bytes: Uint8Array
  contents: string
  file: CacheOwnedFileContents['file']
  metadata: CacheOwnedFileContents['metadata']
  owner: RecoveryOwner
  phased: boolean
}

type RecoveryWitnessObservation = ReturnType<typeof observeCacheRecoveryWitness>

type LockTestHooks = {
  afterCandidateCreation?: ((path: string) => void) | undefined
  afterCandidateMaintenance?: ((stats: LockCandidateMaintenanceStats) => void) | undefined
  afterCandidateOwnerPublication?: ((path: string) => void) | undefined
  afterRecoveryCreation?: (() => void) | undefined
  afterRecoveryStaleObservation?: (() => void) | undefined
  afterStaleObservation?: (() => void) | undefined
  duringRecoveryObservation?: (() => void) | undefined
  gateClose?: ((database: DatabaseSync) => void) | undefined
  now?: (() => number) | undefined
  openCandidateDirectory?: ((path: string) => LockCandidateDirectoryReader) | undefined
}

type RecoveryMarkerObservation =
  | { kind: 'absent' }
  | {
      kind: 'observed'
      directory: CacheOwnedDirectory
      owner: ObservedOwner | undefined
      ownerFile: CacheOwnedFileObservation
      stale: boolean
      witness: RecoveryWitnessObservation
    }
  | { kind: 'retry' }

type OwnedRecoveryMarker = {
  directory: CacheOwnedDirectory
  contents: string
  owner: RecoveryOwner
  ownerFile: CacheOwnedFileContents
  recovered?: CacheOwnedFileContents | undefined
}

type RecoveryPublicationResult = {
  cleanupMarker: OwnedRecoveryMarker
  error?: unknown
  publishedMarker?: OwnedRecoveryMarker
  recoveryComplete?: true
}

type RecoveryPublicationState = {
  result?: RecoveryPublicationResult
}

type AcquiredRecoveryMarker = {
  marker: OwnedRecoveryMarker
  setupError?: unknown
}

type GatePrimary =
  | { kind: 'create-exclusive' }
  | { kind: 'create-if-missing' }
  | { database: CacheDatabase; kind: 'expected-owned' }

const MAX_OWNER_PID = 2_147_483_647
const MAX_OWNER_TIMESTAMP_LENGTH = 64
const MAX_OWNER_TOKEN_LENGTH = 128

const sameLockOwner = (first: RecoveryOwner, second: RecoveryOwner) =>
  first.acquiredAt === second.acquiredAt &&
  first.phase === second.phase &&
  first.pid === second.pid &&
  first.token === second.token

const canonicalOwnerTimestamp = (value: string) => {
  let canonical = false
  try {
    canonical = new Date(value).toISOString() === value
  } catch {
    canonical = false
  }
  return canonical
}

const canonicalRecoveryOwnerContents = (owner: RecoveryOwner) =>
  `${JSON.stringify({
    acquiredAt: owner.acquiredAt,
    phase: owner.phase,
    pid: owner.pid,
    token: owner.token,
  })}\n`

const parseOwner = (contents: string): { owner: RecoveryOwner; phased: boolean } | undefined => {
  try {
    const parsed: unknown = JSON.parse(contents)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const value = parsed as Partial<RecoveryOwner>
      const keys = Object.keys(value).sort()
      const legacyShape = keys.length === 3 && keys[0] === 'acquiredAt' && keys[1] === 'pid' && keys[2] === 'token'
      const phasedShape =
        keys.length === 4 && keys[0] === 'acquiredAt' && keys[1] === 'phase' && keys[2] === 'pid' && keys[3] === 'token'
      const phase = legacyShape ? 'recovering' : value.phase
      if (
        (legacyShape || phasedShape) &&
        (phase === 'recovering' || phase === 'recovered') &&
        typeof value.token === 'string' &&
        value.token.length > 0 &&
        value.token.length <= MAX_OWNER_TOKEN_LENGTH &&
        Number.isSafeInteger(value.pid) &&
        (value.pid ?? 0) > 0 &&
        (value.pid ?? 0) <= MAX_OWNER_PID &&
        typeof value.acquiredAt === 'string' &&
        value.acquiredAt.length > 0 &&
        value.acquiredAt.length <= MAX_OWNER_TIMESTAMP_LENGTH &&
        canonicalOwnerTimestamp(value.acquiredAt)
      ) {
        const owner = {
          acquiredAt: value.acquiredAt,
          phase,
          pid: value.pid as number,
          token: value.token,
        }
        if (legacyShape || contents === canonicalRecoveryOwnerContents(owner)) {
          return { owner, phased: phasedShape }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }
}

const ownerFromObservation = (observation: CacheOwnedFileObservation): ObservedOwner | undefined => {
  if (observation.kind === 'contents') {
    const parsed = parseOwner(observation.contents)
    if (parsed !== undefined) {
      return {
        bytes: observation.bytes,
        contents: observation.contents,
        file: observation.file,
        metadata: observation.metadata,
        ...parsed,
      }
    }
  }
}

const observeOwner = (location: CacheLocation, directory: CacheOwnedDirectory): ObservedOwner | undefined =>
  ownerFromObservation(observeCacheOwner(location, directory))

const sameObservedOwner = (first: ObservedOwner, second: ObservedOwner) =>
  Buffer.compare(first.bytes, second.bytes) === 0 &&
  first.contents === second.contents &&
  first.phased === second.phased &&
  sameLockOwner(first.owner, second.owner) &&
  sameCacheEntryIdentity(first.file, second.file) &&
  sameStableEntryMetadata(first.metadata, second.metadata)

const recoveredWitnessMatchesOwner = (owner: ObservedOwner, witness: RecoveryWitnessObservation) => {
  if (owner.phased && owner.owner.phase === 'recovering' && witness.kind === 'contents') {
    const recovered = parseOwner(witness.contents)
    return (
      recovered?.phased === true &&
      recovered.owner.phase === 'recovered' &&
      recovered.owner.acquiredAt === owner.owner.acquiredAt &&
      recovered.owner.pid === owner.owner.pid &&
      recovered.owner.token === owner.owner.token
    )
  }
  return false
}

const recoveryMarkerMatchesObservations = (
  marker: OwnedRecoveryMarker,
  owner: ObservedOwner | undefined,
  witness: RecoveryWitnessObservation,
) => {
  const ownerMatches =
    owner !== undefined &&
    owner.contents === marker.contents &&
    owner.phased &&
    sameLockOwner(owner.owner, marker.owner) &&
    sameCacheEntryIdentity(owner.file, marker.ownerFile.file) &&
    sameStableEntryMetadata(owner.metadata, marker.ownerFile.metadata)
  const witnessMatches =
    marker.recovered === undefined
      ? witness.kind === 'missing'
      : witness.kind === 'contents' &&
        witness.contents === marker.recovered.contents &&
        sameCacheEntryIdentity(witness.file, marker.recovered.file) &&
        sameStableEntryMetadata(witness.metadata, marker.recovered.metadata)
  return ownerMatches && witnessMatches
}

const transientSharingViolation = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

const releaseOwnedLock = (
  location: CacheLocation,
  directory: CacheOwnedDirectory,
  owner: CacheOwnedFileObservation,
  recoveryWitness: CacheOwnedFileObservation,
) => {
  const exactOwnership = () => {
    const children = observeExactCacheOwnedDirectoryChildren(location, directory, 2)
    return (
      cacheOwnedDirectoryIsCurrent(location, directory) &&
      sameCacheOwnedFileObservation(observeCacheOwner(location, directory), owner) &&
      sameCacheOwnedFileObservation(observeCacheRecoveryWitness(location, directory), recoveryWitness) &&
      children.length === 1 &&
      children[0] === 'owner.json'
    )
  }
  if (exactOwnership()) {
    quarantineCacheOwnedDirectory(location, directory, exactOwnership, {
      expectedChildren: ['owner.json'],
      expectedFiles: { owner, recoveryWitness },
    })
  }
}

const releaseOwnedRecoveryMarker = (
  location: CacheLocation,
  marker: OwnedRecoveryMarker,
  retrySharingViolations: boolean,
) => {
  const maximumAttempts = retrySharingViolations ? RECOVERY_RELEASE_ATTEMPTS : 1
  let complete = false
  const markerRemainsCurrent = () => {
    let matches = false
    if (cacheOwnedDirectoryIsCurrent(location, marker.directory)) {
      try {
        const owner = observeOwner(location, marker.directory)
        const witness = observeCacheRecoveryWitness(location, marker.directory)
        matches = recoveryMarkerMatchesObservations(marker, owner, witness)
      } catch (error) {
        if (cacheOwnedDirectoryIsCurrent(location, marker.directory)) {
          throw error
        }
      }
    }
    return matches
  }
  for (const attempt of Array.from({ length: maximumAttempts }, (_, index) => index)) {
    let movedByThisAttempt = false
    if (markerRemainsCurrent()) {
      try {
        const expectedOwner: CacheOwnedFileObservation = marker.ownerFile
        const expectedWitness: CacheOwnedFileObservation = marker.recovered ?? { kind: 'missing' }
        quarantineCacheOwnedDirectory(location, marker.directory, markerRemainsCurrent, {
          expectedFiles: {
            owner: expectedOwner,
            recoveryWitness: expectedWitness,
          },
          onMove: () => {
            movedByThisAttempt = true
          },
        })
        complete = true
      } catch (error) {
        if (movedByThisAttempt) {
          throw error
        }
        if (cacheOwnedDirectoryIsCurrent(location, marker.directory)) {
          const canRetry = retrySharingViolations && transientSharingViolation(error) && attempt < maximumAttempts - 1
          if (canRetry) {
            const stillOwned = markerRemainsCurrent()
            if (stillOwned) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECOVERY_POLL_MILLISECONDS)
            } else {
              complete = true
            }
          } else {
            throw error
          }
        } else {
          complete = true
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
  const lockName = 'operation.lock'
  const recoveryName = 'operation-lock.recovery'
  const token = randomUUID()
  const candidateName = `operation.lock.${token}`
  const now = testHooks.now ?? Date.now
  const startedAt = now()
  let gate: DatabaseSync | undefined
  let gateTransaction = false
  let candidateDirectory: CacheOwnedDirectory | undefined
  let candidateOwnerFile: CacheOwnedFileObservation | undefined
  let candidateRecoveryWitness: CacheOwnedFileObservation | undefined
  let ownedLockDirectory: CacheOwnedDirectory | undefined

  const remainingMilliseconds = () => Math.max(0, LOCK_WAIT_MILLISECONDS - (now() - startedAt))

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
      const ownerFile = observeCacheOwner(location, recoveryDirectory)
      const owner = ownerFromObservation(ownerFile)
      const witness = observeCacheRecoveryWitness(location, recoveryDirectory)
      if (owner !== undefined) {
        return {
          directory: recoveryDirectory,
          kind: 'observed',
          owner,
          ownerFile,
          stale: recoveredWitnessMatchesOwner(owner, witness) || !processIsRunning(owner.owner.pid),
          witness,
        }
      }
      return {
        directory: recoveryDirectory,
        kind: 'observed',
        owner: undefined,
        ownerFile,
        stale: now() - cacheOwnedDirectoryMtimeMilliseconds(location, recoveryDirectory) > RECOVERY_STALE_MILLISECONDS,
        witness,
      }
    } catch (error) {
      if (cacheOwnedDirectoryIsCurrent(location, recoveryDirectory)) {
        throw error
      }
      return { kind: 'retry' }
    }
  }

  const recoveryMarkerRemainsStale = (observation: Extract<RecoveryMarkerObservation, { kind: 'observed' }>) => {
    const currentOwnerFile = observeCacheOwner(location, observation.directory)
    const currentOwner = ownerFromObservation(currentOwnerFile)
    const currentWitness = observeCacheRecoveryWitness(location, observation.directory)
    if (observation.owner !== undefined) {
      return (
        currentOwner !== undefined &&
        sameCacheOwnedFileObservation(currentOwnerFile, observation.ownerFile) &&
        sameObservedOwner(currentOwner, observation.owner) &&
        sameCacheOwnedFileObservation(currentWitness, observation.witness) &&
        (recoveredWitnessMatchesOwner(currentOwner, currentWitness) || !processIsRunning(currentOwner.owner.pid))
      )
    }
    return (
      currentOwner === undefined &&
      sameCacheOwnedFileObservation(currentOwnerFile, observation.ownerFile) &&
      sameCacheOwnedFileObservation(currentWitness, observation.witness) &&
      now() - cacheOwnedDirectoryMtimeMilliseconds(location, observation.directory) > RECOVERY_STALE_MILLISECONDS
    )
  }

  const reclaimRecoveryMarker = (observation: Extract<RecoveryMarkerObservation, { kind: 'observed' }>) => {
    testHooks.afterRecoveryStaleObservation?.()
    if (cacheOwnedDirectoryIsCurrent(location, observation.directory)) {
      const reclaimed = quarantineCacheOwnedDirectory(
        location,
        observation.directory,
        () => recoveryMarkerRemainsStale(observation),
        {
          expectedFiles: {
            owner: observation.ownerFile,
            recoveryWitness: observation.witness,
          },
        },
      )
      return reclaimed
    }
  }

  const recoveryMarkerIsOwned = (marker: OwnedRecoveryMarker) => {
    try {
      if (cacheOwnedDirectoryIsCurrent(location, marker.directory)) {
        const owner = observeOwner(location, marker.directory)
        const witness = observeCacheRecoveryWitness(location, marker.directory)
        return recoveryMarkerMatchesObservations(marker, owner, witness)
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

  const beginGateTransaction = (
    primary: GatePrimary,
    ownedMarker: OwnedRecoveryMarker,
    publicationState: RecoveryPublicationState,
  ) => {
    try {
      const opened = openVerifiedCacheDatabase({
        afterVerifiedOpen: database => {
          database.exec('BEGIN IMMEDIATE')
          if (recoveryMarkerIsOwned(ownedMarker)) {
            publicationState.result = publishRecoveredMarker(ownedMarker)
          }
        },
        DatabaseConstructor: DatabaseSync,
        location,
        name: 'operation-lock.sqlite',
        openOptions: { timeout: remainingMilliseconds() },
        preserveDatabaseLocksAfterInitialisation: true,
        primary,
      })
      gate = opened.database
      gateTransaction = true
      return opened.identity
    } catch (error) {
      if (error instanceof CacheDatabaseCreationConflict) {
        return operationGateChanged()
      }
      throw error
    }
  }

  const releaseGate = () => {
    if (gateTransaction) {
      try {
        gate?.exec('ROLLBACK')
      } catch {
        // Closing the connection below releases its operating-system lock.
      }
    }
    gateTransaction = false
    const database = gate
    gate = undefined
    if (database !== undefined) {
      const close = testHooks.gateClose ?? ((current: DatabaseSync) => current.close())
      close(database)
    }
  }

  const beginGateWhileRecoveryOwned = (
    ownedMarker: OwnedRecoveryMarker,
    primary: GatePrimary,
    publicationState: RecoveryPublicationState,
  ) => {
    let owned = false
    const database = beginGateTransaction(primary, ownedMarker, publicationState)
    const publishedMarker = publicationState.result?.publishedMarker
    const recoveryComplete = publicationState.result?.recoveryComplete === true
    const publishedMarkerCurrent = publishedMarker !== undefined && recoveryMarkerIsOwned(publishedMarker)
    const publishedMarkerReclaimed =
      publishedMarker !== undefined && !cacheOwnedDirectoryIsCurrent(location, publishedMarker.directory)
    if (recoveryComplete || publishedMarkerCurrent || publishedMarkerReclaimed) {
      owned = true
    } else {
      releaseGate()
    }
    return { acquired: owned, database }
  }

  const attemptGateWhileOwned = (
    ownedMarker: OwnedRecoveryMarker,
    primary: GatePrimary,
    publicationState: RecoveryPublicationState,
  ) => {
    try {
      return { ...beginGateWhileRecoveryOwned(ownedMarker, primary, publicationState), category: undefined }
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

  const acquireRecoveryMarker = (): AcquiredRecoveryMarker => {
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
        const owner: RecoveryOwner = {
          acquiredAt: new Date().toISOString(),
          phase: 'recovering',
          pid: process.pid,
          token,
        }
        const contents = canonicalRecoveryOwnerContents(owner)
        const ownerFile = writeCacheOwner(location, recoveryDirectory, contents)
        const candidate = { contents, directory: recoveryDirectory, owner, ownerFile }
        createdMarker = candidate
        testHooks.afterRecoveryCreation?.()
        if (recoveryMarkerIsOwned(candidate)) {
          ownedMarker = candidate
        } else {
          wait(Math.min(RECOVERY_POLL_MILLISECONDS, remainingMilliseconds()))
        }
      } catch (error) {
        if (createdMarker !== undefined) {
          let cleanupFailed = false
          try {
            releaseOwnedRecoveryMarker(location, createdMarker, true)
          } catch {
            cleanupFailed = true
          }
          if (cleanupFailed) {
            return { marker: createdMarker, setupError: error }
          }
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
    return { marker: ownedMarker }
  }

  const publishRecoveredMarker = (marker: OwnedRecoveryMarker) => {
    const recoveredOwner: RecoveryOwner = { ...marker.owner, phase: 'recovered' }
    const recoveredContents = canonicalRecoveryOwnerContents(recoveredOwner)
    const publication = publishCacheOwnerRecovery(location, marker.directory, marker.ownerFile, recoveredContents)
    if (publication.kind === 'published') {
      const publishedMarker = {
        ...marker,
        recovered: {
          bytes: publication.bytes,
          contents: recoveredContents,
          file: publication.file,
          kind: 'contents' as const,
          metadata: publication.metadata,
        },
      }
      return {
        cleanupMarker: publishedMarker,
        ...(publication.durabilityError === undefined ? {} : { error: publication.durabilityError }),
        publishedMarker,
      }
    }
    if (publication.kind === 'failed') {
      return {
        cleanupMarker: { ...marker, recovered: publication.witness },
        error: publication.error,
      }
    }
    if (publication.kind === 'released') {
      return {
        cleanupMarker: marker,
        ...(publication.error === undefined ? {} : { error: publication.error }),
        recoveryComplete: true as const,
      }
    }
    return {
      cleanupMarker: publication.witness === undefined ? marker : { ...marker, recovered: publication.witness },
    }
  }

  const acquireGateWhileOwned = (ownedMarker: OwnedRecoveryMarker, publicationState: RecoveryPublicationState) => {
    let acquired = false
    const currentMarker = () => publicationState.result?.publishedMarker ?? ownedMarker
    if (recoveryMarkerIsOwned(ownedMarker)) {
      const initial = attemptGateWhileOwned(ownedMarker, nextGatePrimary, publicationState)
      if ('database' in initial) {
        nextGatePrimary = { database: initial.database, kind: 'expected-owned' }
        ;({ acquired } = initial)
      } else {
        const recoverable = initial.category === 'corrupt' || initial.category === 'notadb'
        if (recoverable && initial.error instanceof CacheDatabaseFailure) {
          if (recoveryMarkerIsOwned(currentMarker())) {
            const confirmed = attemptGateWhileOwned(
              currentMarker(),
              {
                database: initial.error.database,
                kind: 'expected-owned',
              },
              publicationState,
            )
            if ('database' in confirmed) {
              nextGatePrimary = { database: confirmed.database, kind: 'expected-owned' }
              ;({ acquired } = confirmed)
            } else {
              const confirmedRecoverable = confirmed.category === 'corrupt' || confirmed.category === 'notadb'
              if (confirmedRecoverable) {
                if (recoveryMarkerIsOwned(currentMarker())) {
                  quarantineCorruptGate(confirmed.error)
                  nextGatePrimary = { kind: 'create-exclusive' }
                  if (recoveryMarkerIsOwned(currentMarker())) {
                    const retried = attemptGateWhileOwned(currentMarker(), nextGatePrimary, publicationState)
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
      const recovery = acquireRecoveryMarker()
      const { marker: ownedMarker } = recovery
      const publicationState: RecoveryPublicationState = {}
      let acquisitionError = recovery.setupError
      let cleanupMarker = ownedMarker
      try {
        acquired = acquireGateWhileOwned(ownedMarker, publicationState)
      } catch (error) {
        if (acquisitionError === undefined) {
          acquisitionError = publicationState.result?.error ?? error
        }
      }
      const publication = publicationState.result
      if (publication !== undefined) {
        ;({ cleanupMarker } = publication)
        if (publication.error !== undefined && acquisitionError === undefined) {
          acquisitionError = publication.error
        }
        if (
          acquired &&
          publication.publishedMarker !== undefined &&
          !recoveryMarkerIsOwned(publication.publishedMarker) &&
          cacheOwnedDirectoryIsCurrent(location, publication.publishedMarker.directory)
        ) {
          acquired = false
          releaseGate()
        }
      }
      let cleanupError: unknown
      try {
        releaseOwnedRecoveryMarker(location, cleanupMarker, true)
      } catch (error) {
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
    candidateRecoveryWitness = observeCacheRecoveryWitness(location, candidateDirectory)
    const missingCandidateOwner = observeCacheOwner(location, candidateDirectory)
    testHooks.afterCandidateCreation?.(candidateDirectory.path)
    if (missingCandidateOwner.kind !== 'missing' || candidateRecoveryWitness.kind !== 'missing') {
      return fail('REPOSITORY_CHANGED', 'The Encephalon cache layout changed during the operation.', {
        entry: 'node_modules/.cache/encephalon/operation.lock',
        invariant: 'stable-owner-evidence',
      })
    }
    const candidateOwner: LockOwner = {
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
      token,
    }
    candidateOwnerFile = writeCacheOwner(location, candidateDirectory, `${JSON.stringify(candidateOwner)}\n`)
    testHooks.afterCandidateOwnerPublication?.(candidateDirectory.path)

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

    const expectedOwner = candidateOwnerFile
    const expectedWitness = candidateRecoveryWitness
    const candidateRemainsExact = () => {
      if (candidateDirectory !== undefined) {
        const children = observeExactCacheOwnedDirectoryChildren(location, candidateDirectory, 2)
        return (
          cacheOwnedDirectoryIsCurrent(location, candidateDirectory) &&
          sameCacheOwnedFileObservation(observeCacheOwner(location, candidateDirectory), expectedOwner) &&
          sameCacheOwnedFileObservation(observeCacheRecoveryWitness(location, candidateDirectory), expectedWitness) &&
          children.length === 1 &&
          children[0] === 'owner.json'
        )
      }
      return false
    }
    ownedLockDirectory = promoteCacheOwnedDirectory(location, candidateDirectory, lockName, {
      expectedChildren: ['owner.json'],
      expectedFiles: { owner: expectedOwner, recoveryWitness: expectedWitness },
      ownershipIsCurrent: candidateRemainsExact,
    })
    const currentLock = ownedLockDirectory
    candidateDirectory = undefined
    const assertCurrentLock = () => {
      const children = observeExactCacheOwnedDirectoryChildren(location, currentLock, 2)
      const current =
        children.length === 1 &&
        children[0] === 'owner.json' &&
        sameCacheOwnedFileObservation(observeCacheOwner(location, currentLock), expectedOwner) &&
        sameCacheOwnedFileObservation(observeCacheRecoveryWitness(location, currentLock), expectedWitness)
      if (current) {
        return
      }
      return fail('REPOSITORY_CHANGED', 'The Encephalon cache layout changed during the operation.', {
        entry: 'node_modules/.cache/encephalon/operation.lock',
        invariant: 'stable-owner-evidence',
      })
    }
    const maintenanceStats = maintainLockCandidates(location, {
      assertCurrentLock,
      now,
      openDirectory: testHooks.openCandidateDirectory,
    })
    testHooks.afterCandidateMaintenance?.(maintenanceStats)
    assertCurrentLock()
    try {
      operationOutcome = { value: operation(location) }
    } finally {
      try {
        releaseOwnedLock(location, ownedLockDirectory, expectedOwner, expectedWitness)
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
    if (candidateDirectory !== undefined) {
      const owner = candidateOwnerFile ?? { kind: 'missing' as const }
      const witness = candidateRecoveryWitness ?? { kind: 'missing' as const }
      const children = candidateOwnerFile === undefined ? [] : ['owner.json']
      quarantineCacheOwnedDirectory(location, candidateDirectory, undefined, {
        expectedChildren: children,
        expectedFiles: { owner, recoveryWitness: witness },
      })
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
