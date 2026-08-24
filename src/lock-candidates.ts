import { type Dirent, lstatSync, opendirSync } from 'node:fs'
import type { DirectoryReader } from './bounded-directory.ts'
import {
  assertCacheLocation,
  type CacheLocation,
  type CacheOwnedDirectory,
  type CacheOwnedFileObservation,
  cacheOwnedDirectoryMtimeMilliseconds,
  observeCacheOwnedDirectoryForMaintenance,
  observeCacheOwner,
  observeCacheRecoveryWitness,
  observeExactCacheOwnedDirectoryChildren,
  quarantineCacheOwnedDirectory,
  sameCacheEntryIdentity,
  sameCacheOwnedFileObservation,
} from './cache-location.ts'

const MAXIMUM_DIRECTORY_ENTRIES = 64
const MAXIMUM_CANDIDATE_INSPECTIONS = 16
const MAXIMUM_RECLAMATION_ATTEMPTS = 4
const MAXIMUM_RETAINED_CURSORS = 8
const CANDIDATE_GRACE_MILLISECONDS = 5000
const MAXIMUM_OWNER_PID = 2_147_483_647
const MAXIMUM_OWNER_TIMESTAMP_LENGTH = 64
const MAXIMUM_OWNER_TOKEN_LENGTH = 128
const LOCK_CANDIDATE_PATTERN =
  /^operation\.lock\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u

type CandidateEntry = Readonly<{ name: string }>
export type LockCandidateDirectoryReader = DirectoryReader<CandidateEntry>
export type OpenLockCandidateDirectory = (path: string) => LockCandidateDirectoryReader

export type LockCandidateMaintenanceStats = Readonly<{
  candidatesInspected: number
  candidatesReclaimed: number
  cursorExhausted: boolean
  directoryEntriesVisited: number
  reclamationAttempts: number
}>

type CandidateOwner = Readonly<{
  acquiredAt: string
  pid: number
  token: string
}>

type CandidateEvidence = Readonly<{
  children: readonly string[]
  directory: CacheOwnedDirectory
  owner: CacheOwnedFileObservation
  recoveryWitness: CacheOwnedFileObservation
}>

type CandidateCursor = Readonly<{
  dev: bigint
  ino: bigint
  openDirectory: OpenLockCandidateDirectory
  reader: LockCandidateDirectoryReader
}>

const candidateCursors = new Map<string, CandidateCursor>()

const defaultOpenDirectory: OpenLockCandidateDirectory = path => opendirSync(path) as DirectoryReader<Dirent>

const closeCursor = (path: string, cursor: CandidateCursor) => {
  candidateCursors.delete(path)
  try {
    cursor.reader.closeSync()
  } catch {
    // Candidate maintenance is best effort; cache-location checks remain authoritative.
  }
}

const cursorFor = (location: CacheLocation, openDirectory: OpenLockCandidateDirectory) => {
  const metadata = lstatSync(location.directory, { bigint: true })
  const existing = candidateCursors.get(location.directory)
  const reusable =
    existing !== undefined &&
    existing.dev === metadata.dev &&
    existing.ino === metadata.ino &&
    existing.openDirectory === openDirectory
  if (existing !== undefined && !reusable) {
    closeCursor(location.directory, existing)
  }
  let cursor = reusable ? existing : undefined
  if (cursor === undefined) {
    cursor = {
      dev: metadata.dev,
      ino: metadata.ino,
      openDirectory,
      reader: openDirectory(location.directory),
    }
  }
  candidateCursors.delete(location.directory)
  candidateCursors.set(location.directory, cursor)
  while (candidateCursors.size > MAXIMUM_RETAINED_CURSORS) {
    const oldest = candidateCursors.entries().next().value as [string, CandidateCursor] | undefined
    if (oldest !== undefined) {
      closeCursor(oldest[0], oldest[1])
    }
  }
  return cursor
}

const canonicalTimestamp = (value: string) => {
  let canonical = false
  try {
    canonical = new Date(value).toISOString() === value
  } catch {
    canonical = false
  }
  return canonical
}

const parseCandidateOwner = (contents: string, expectedToken: string): CandidateOwner | undefined => {
  try {
    const parsed: unknown = JSON.parse(contents)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const value = parsed as Partial<CandidateOwner>
      const keys = Object.keys(value).sort()
      const exactShape = keys.length === 3 && keys[0] === 'acquiredAt' && keys[1] === 'pid' && keys[2] === 'token'
      if (
        exactShape &&
        typeof value.acquiredAt === 'string' &&
        value.acquiredAt.length > 0 &&
        value.acquiredAt.length <= MAXIMUM_OWNER_TIMESTAMP_LENGTH &&
        canonicalTimestamp(value.acquiredAt) &&
        Number.isSafeInteger(value.pid) &&
        (value.pid ?? 0) > 0 &&
        (value.pid ?? 0) <= MAXIMUM_OWNER_PID &&
        typeof value.token === 'string' &&
        value.token.length > 0 &&
        value.token.length <= MAXIMUM_OWNER_TOKEN_LENGTH &&
        value.token === expectedToken
      ) {
        const owner = { acquiredAt: value.acquiredAt, pid: value.pid as number, token: value.token }
        if (contents === `${JSON.stringify(owner)}\n`) {
          return owner
        }
      }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }
}

const processIsDefinitelyDead = (pid: number) => {
  let dead = false
  try {
    process.kill(pid, 0)
  } catch (error) {
    dead = (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  return dead
}

const candidateIsAbandoned = (location: CacheLocation, evidence: CandidateEvidence, token: string, now: number) => {
  let abandoned = false
  if (evidence.recoveryWitness.kind === 'missing') {
    const directoryMtime = cacheOwnedDirectoryMtimeMilliseconds(location, evidence.directory)
    if (evidence.owner.kind === 'missing') {
      abandoned = now - directoryMtime > CANDIDATE_GRACE_MILLISECONDS
    } else if (evidence.owner.kind === 'contents') {
      const owner = parseCandidateOwner(evidence.owner.contents, token)
      abandoned =
        owner === undefined
          ? now - Math.max(directoryMtime, Number(evidence.owner.metadata.mtimeNs) / 1_000_000) >
            CANDIDATE_GRACE_MILLISECONDS
          : processIsDefinitelyDead(owner.pid)
    } else {
      abandoned =
        now - Math.max(directoryMtime, Number(evidence.owner.metadata.mtimeNs) / 1_000_000) >
        CANDIDATE_GRACE_MILLISECONDS
    }
  }
  return abandoned
}

const captureCandidateEvidence = (location: CacheLocation, name: string): CandidateEvidence | undefined => {
  const observation = observeCacheOwnedDirectoryForMaintenance(location, name)
  let evidence: CandidateEvidence | undefined
  if (observation.kind === 'stable') {
    const children = observeExactCacheOwnedDirectoryChildren(location, observation.directory, 3)
    const supportedChildren = children.length <= 1 && (children.length === 0 || children[0] === 'owner.json')
    if (supportedChildren) {
      evidence = {
        children,
        directory: observation.directory,
        owner: observeCacheOwner(location, observation.directory),
        recoveryWitness: observeCacheRecoveryWitness(location, observation.directory),
      }
    }
  }
  return evidence
}

const sameEvidence = (first: CandidateEvidence, second: CandidateEvidence) =>
  sameCacheEntryIdentity(first.directory, second.directory) &&
  first.children.length === second.children.length &&
  first.children.every((name, index) => name === second.children[index]) &&
  sameCacheOwnedFileObservation(first.owner, second.owner) &&
  sameCacheOwnedFileObservation(first.recoveryWitness, second.recoveryWitness)

const reclaimCandidate = (
  location: CacheLocation,
  name: string,
  token: string,
  evidence: CandidateEvidence,
  now: number,
) => {
  let moved = false
  const remainsAbandoned = () => {
    const current = captureCandidateEvidence(location, name)
    return (
      current !== undefined && sameEvidence(evidence, current) && candidateIsAbandoned(location, current, token, now)
    )
  }
  try {
    quarantineCacheOwnedDirectory(location, evidence.directory, remainsAbandoned, {
      expectedChildren: evidence.children,
      expectedFiles: { owner: evidence.owner, recoveryWitness: evidence.recoveryWitness },
      onMove: () => {
        moved = true
      },
    })
  } catch {
    assertCacheLocation(location)
  }
  return moved
}

export type LockCandidateMaintenanceOptions = Readonly<{
  now?: (() => number) | undefined
  openDirectory?: OpenLockCandidateDirectory | undefined
}>

/** @internal */
export const maintainLockCandidates = (
  location: CacheLocation,
  options: LockCandidateMaintenanceOptions = {},
): LockCandidateMaintenanceStats => {
  const stats = {
    candidatesInspected: 0,
    candidatesReclaimed: 0,
    cursorExhausted: false,
    directoryEntriesVisited: 0,
    reclamationAttempts: 0,
  }
  const openDirectory = options.openDirectory ?? defaultOpenDirectory
  let cursor: CandidateCursor | undefined
  try {
    assertCacheLocation(location)
    cursor = cursorFor(location, openDirectory)
    while (
      stats.directoryEntriesVisited < MAXIMUM_DIRECTORY_ENTRIES &&
      stats.candidatesInspected < MAXIMUM_CANDIDATE_INSPECTIONS &&
      stats.reclamationAttempts < MAXIMUM_RECLAMATION_ATTEMPTS
    ) {
      const entry = cursor.reader.readSync()
      if (entry === null) {
        stats.cursorExhausted = true
        closeCursor(location.directory, cursor)
        break
      }
      stats.directoryEntriesVisited += 1
      const match = LOCK_CANDIDATE_PATTERN.exec(entry.name)
      if (match !== null) {
        stats.candidatesInspected += 1
        try {
          const evidence = captureCandidateEvidence(location, entry.name)
          const token = match[1] as string
          if (evidence !== undefined && candidateIsAbandoned(location, evidence, token, (options.now ?? Date.now)())) {
            stats.reclamationAttempts += 1
            if (reclaimCandidate(location, entry.name, token, evidence, (options.now ?? Date.now)())) {
              stats.candidatesReclaimed += 1
            }
          }
        } catch {
          assertCacheLocation(location)
        }
      }
    }
  } catch {
    if (cursor !== undefined) {
      closeCursor(location.directory, cursor)
    }
    assertCacheLocation(location)
  }
  return Object.freeze({ ...stats })
}
