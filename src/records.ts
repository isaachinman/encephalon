import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats, Dirent } from 'node:fs'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { parseAddRecordInput, parseRootInput } from './api-input.ts'
import {
  ArtifactChangedError,
  type ArtifactInspectionResult,
  type ArtifactObservation,
  inspectArtifactFiles,
  sameArtifactInspectionResult,
} from './artifact-inspection.ts'
import { hydrateResolvedCanonicalSnapshot } from './cache.ts'
import { assertCacheLocation, type CacheLocation, inspectCacheLocation } from './cache-location.ts'
import { CANONICAL_BUDGETS } from './canonical-budgets.ts'
import {
  CanonicalDirectoryChangedError,
  type CanonicalDirectorySnapshot,
  captureCanonicalDirectory,
  isCanonicalDirectoryReplacementError,
  isCanonicalKindDirectoryEntry,
  isCanonicalReservedDirectory,
  MAX_CANONICAL_BRAIN_ROOT_ENTRIES,
  MAX_CANONICAL_KIND_DIRECTORIES,
  MAX_CANONICAL_KIND_ENTRIES,
  recaptureCanonicalDirectoryGeneration,
  revalidateCanonicalDirectory,
  STAGING_DIRECTORY_NAME,
  sameCanonicalDirectoryGeneration,
} from './canonical-layout.ts'
import {
  captureDirectoryWitness,
  type DirectoryWitness,
  DirectoryWitnessError,
  revalidateDirectoryWitness,
} from './directory-witness.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import {
  type EntryIdentity,
  entryIdentityFrom,
  manifestEntryMetadataFrom,
  sameEntryIdentity,
  sameStableEntryMetadata,
  sameStableEntryMetadataExceptCtime,
} from './filesystem-entry.ts'
import { withOperationLock } from './lock.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import { ordinalStringCompare } from './order.ts'
import { resolveRepository } from './repository.ts'
import {
  createRecordFile,
  formatRecordFile,
  MAX_RECORD_BYTES,
  parseRecordFile,
  type ValidatedAddRecordInput,
  validateAddRecordInput,
  validateKind,
} from './schema.ts'
import {
  assertStagingEmpty,
  cleanupOwnedStagingEntry,
  cleanupStaleStagingEntries,
  createOwnedStagingName,
  inspectCurrentStagingFile,
  StagingLayoutChangedError,
} from './staging.ts'
import type {
  AddRecordInput,
  BrainRecord,
  BrainRecordFile,
  RootInput,
  ValidateResult,
  ValidationIssue,
} from './types.ts'
import { observedArray, observedSet, observeWork, reportWork, rethrowWorkObserverError } from './work-observer.ts'

type RecordScan = {
  records: BrainRecord[]
  errors: ValidationIssue[]
  bytes: number
  layout?: CanonicalLayoutWitness
  observations: RecordObservation[]
  rejections: RecordRejectionEvidence[]
  rootObservation?: PathObservation
}

type RecordObservation = {
  digest: string
  metadata: BigIntStats
  path: string
}

type PathObservation = {
  metadata: BigIntStats
  path: string
}

type RecordRejectionEvidence = PathObservation & {
  kindIdentity: EntryIdentity
  kindPath: string
  reason: 'metadata' | 'unreadable'
}

type ValidatedRecordScan = {
  artifactEvidence: readonly ArtifactInspectionResult[]
  artifacts: readonly ArtifactObservation[]
  result: ValidateResult
}

class CanonicalGenerationChanged extends Error {}

class CanonicalRepositoryChangedError extends EncephalonError {}

type CanonicalSnapshotRetryLedger = {
  readonly deadline: number
  readonly maximumAttempts: number
  readonly now: () => number
  attempt: number
  repositoryChanged: boolean
}

type StableCanonicalSnapshot = {
  scan: RecordScan
  validation: ValidatedRecordScan
}

/** @internal */
export type CanonicalCacheManifestEntry = Readonly<{
  ctimeNanoseconds?: string
  mtimeNanoseconds?: string
  path: string
  size?: string
  type: 'directory' | 'file' | 'missing' | 'other' | 'symlink'
}>

/** @internal */
export type ValidatedCanonicalSnapshot = Readonly<{
  artifacts: readonly ArtifactObservation[]
  assertCurrent: () => void
  manifest: string
  records: readonly BrainRecord[]
  repositoryRealpath: string
}>

type CanonicalLayoutWitness = {
  kinds: Map<string, CanonicalDirectorySnapshot>
  root: CanonicalDirectorySnapshot | null
}

type CanonicalPublicationAuthority = {
  assertCurrent: () => void
  acceptStagingCleanup: () => void
  acceptPreparation: (
    kind: string,
    rootSnapshot: CanonicalDirectorySnapshot,
    kindSnapshot: CanonicalDirectorySnapshot,
  ) => void
  acceptPublication: (
    kind: string,
    recordName: string,
    rootSnapshot: CanonicalDirectorySnapshot,
    kindSnapshot: CanonicalDirectorySnapshot,
    digest: string,
    metadata: BigIntStats,
  ) => void
  changed: () => never
  projection: () => {
    kindCount: number
    kindEntryCounts: ReadonlyMap<string, number>
    rootExists: boolean
    rootNames: ReadonlySet<string>
  }
  sealCacheSnapshot: (
    records: readonly BrainRecord[],
    artifacts: readonly ArtifactObservation[],
    repositoryRealpath: string,
  ) => ValidatedCanonicalSnapshot
}

type RecordWriteFault =
  | 'after-scan-validation'
  | 'after-publication'
  | 'after-publication-accept'
  | 'after-canonical-link'
  | 'after-staging-cleanup-quarantine'
  | 'after-staging-cleanup-preflight'
  | 'before-directory-preparation'
  | 'before-canonical-link'
  | 'before-final-publication-revalidation'
  | 'before-publication-directory-capture'
  | 'before-publication'
  | 'before-staging-cleanup-empty-probe'
  | 'before-staging-cleanup-entry-lstat'
  | 'before-staging-cleanup-quarantine'
  | 'during-cleanup'
  | 'during-hydration'
  | 'during-publication-flush'
  | 'during-staging-cleanup-flush'
  | 'during-staging-write'

/** @internal */
export type RecordWriteHooks = {
  fault?: ((point: RecordWriteFault) => void) | undefined
}

type AddRecordTestHooks = RecordWriteHooks & {
  afterOperationLock?: (() => void) | undefined
  beforeOperationLock?: (() => void) | undefined
  readHooks?: RecordReadHooks | undefined
}

/** @internal */
export const recordWriteTestHooks: AddRecordTestHooks = {}

type RecordReadFault =
  | 'after-record-fstat'
  | 'after-record-lstat'
  | 'after-record-open'
  | 'after-record-read'
  | 'before-rejected-record-read'
  | 'before-kind-lstat'

type RecordWork =
  | 'active-group-read'
  | 'active-group-write'
  | 'active-issue-read'
  | 'active-issue-write'
  | 'allowed-group-write'
  | 'allowed-id-write'
  | 'canonical-entry'
  | 'cycle-edge'
  | 'duplicate-issue-read'
  | 'duplicate-issue-write'
  | 'duplicate-record'
  | 'edge-validation'
  | 'superseded-edge'

/** @internal */
export type RecordReadHooks = {
  afterBrainRootEnumeration?: (() => void) | undefined
  afterBrainRootSnapshot?: (() => void) | undefined
  afterKindEnumeration?: ((path: string) => void) | undefined
  afterKindSnapshot?: ((path: string) => void) | undefined
  canonicalScan?: () => void
  beforeFinalWitnessValidation?: (() => void) | undefined
  fault?: (point: RecordReadFault, path: string) => void
  graphValidation?: () => void
  now?: (() => number) | undefined
  onWork?: ((operation: RecordWork) => void) | undefined
}

type AddRecordOptions = {
  cacheLocation?: CacheLocation
  hooks?: RecordWriteHooks
  hydrate?: boolean
  readHooks?: RecordReadHooks | undefined
}

type PlannedRecord = {
  formatted: string
  path: string
  record: BrainRecord
  recordFile: BrainRecordFile
  relativePath: string
}

type ValidateRecordsOptions = {
  hooks?: RecordReadHooks
}

const preserveWorkObserverFailure = <Result>(operation: () => Result) => {
  try {
    return operation()
  } catch (error) {
    rethrowWorkObserverError(error)
    throw error
  }
}

type AllowedMultiHead = {
  kind: string
  source: string
  subject: string
}

type RecordPlanningSnapshot = Readonly<{
  authority: () => CanonicalPublicationAuthority
  bytes: number
  errors: readonly ValidationIssue[]
  records: readonly BrainRecord[]
  sealCacheSnapshot: (
    records: readonly BrainRecord[],
    artifacts: readonly ArtifactObservation[],
    repositoryRealpath: string,
  ) => ValidatedCanonicalSnapshot
  validateFinal: (
    records: readonly BrainRecord[],
    message?: string,
    bytes?: number,
    allowed?: readonly AllowedMultiHead[],
  ) => readonly ArtifactObservation[]
}>

type PostCommitPhase = 'cacheHydration' | 'publicationFlush' | 'publicationVerification' | 'stagingCleanup'

const postCommitRecoveryAction = {
  cacheHydration: 'Run prepare to rebuild disposable cache state, then validate before retrying this add.',
  publicationFlush:
    'Confirm the canonical record file is present; prepare does not re-fsync the kind directory, so treat durability as unverified until that sync succeeds.',
  publicationVerification:
    'Inspect the canonical directory generation before retrying; the linked record may have been displaced by a concurrent replacement.',
  stagingCleanup: 'Inspect encephalon/_staging and remove only a confirmed leftover from this operation.',
} as const satisfies Record<PostCommitPhase, string>

const canonicalRaceRecoveryAction = 'Run validate and reconcile the canonical repository before retrying the operation.'

const postCommitPriority: Record<PostCommitPhase, number> = {
  cacheHydration: 2,
  publicationFlush: 3,
  publicationVerification: 4,
  stagingCleanup: 1,
}

const postCommitMessage = (recordId: string, phase: PostCommitPhase) =>
  `Record ${recordId} was committed, but the ${phase} post-commit phase failed. ${postCommitRecoveryAction[phase]}`

const postCommitError = (record: BrainRecord, phase: PostCommitPhase, cause: unknown) =>
  new EncephalonError(
    'IO_ERROR',
    postCommitMessage(record.id, phase),
    {
      canonicalCommitted: true,
      path: record.path,
      postCommitPhase: phase,
      recordId: record.id,
      recoveryAction: postCommitRecoveryAction[phase],
    },
    { cause },
  )

const frozenCommittedRecordIds = (records: readonly Pick<BrainRecord, 'id'>[]): string[] => {
  const committedRecordIds = records.slice(0, MAX_CANONICAL_RECORDS).map(record => record.id)
  Object.freeze(committedRecordIds)
  return committedRecordIds
}

const publicationVerificationError = (record: BrainRecord) =>
  new EncephalonError(
    'REPOSITORY_CHANGED',
    `Record ${record.id} was linked, but its canonical directory generation changed before verification. ${canonicalRaceRecoveryAction}`,
    {
      canonicalCommitted: true,
      committedRecordIds: frozenCommittedRecordIds([record]),
      path: record.path,
      postCommitPhase: 'publicationVerification',
      recordId: record.id,
      recoveryAction: canonicalRaceRecoveryAction,
      repositoryChanged: true,
    },
    { cause: repositoryChangedBeforePublicationError() },
  )

class CanonicalPublicationIdentityError extends Error {}

const assertCanonicalPublicationIdentity = (path: string, descriptor: number) => {
  const descriptorMetadata = fstatSync(descriptor, { bigint: true })
  const pathMetadata = lstatSync(path, { bigint: true })
  if (!(pathMetadata.isFile() && sameStableEntryMetadata(descriptorMetadata, pathMetadata))) {
    throw new CanonicalPublicationIdentityError('The canonical path does not identify the staged descriptor.')
  }
}

const classifyPublicationVerificationError = (record: BrainRecord, error: unknown) => {
  if (error instanceof CanonicalGenerationChanged) {
    return publicationVerificationError(record)
  }
  if (
    error instanceof CanonicalRepositoryChangedError ||
    error instanceof CanonicalPublicationIdentityError ||
    error instanceof DirectoryWitnessError ||
    error instanceof StagingLayoutChangedError ||
    isCanonicalDirectoryReplacementError(error)
  ) {
    return publicationVerificationError(record)
  }
  if (error instanceof EncephalonError && error.code === 'REPOSITORY_CHANGED') {
    return error
  }
  return postCommitError(record, 'publicationVerification', error)
}

const committedCanonicalGenerationError = (records: readonly BrainRecord[]) => {
  const committedRecordIds = frozenCommittedRecordIds(records)
  const noun = committedRecordIds.length === 1 ? 'record was' : 'records were'
  return new EncephalonError(
    'REPOSITORY_CHANGED',
    `The canonical repository changed after ${committedRecordIds.length} ${noun} committed. ${canonicalRaceRecoveryAction}`,
    {
      canonicalCommitted: true,
      committedRecordIds,
      postCommitPhase: 'publicationVerification',
      recoveryAction: canonicalRaceRecoveryAction,
      repositoryChanged: true,
    },
    { cause: repositoryChangedBeforePublicationError() },
  )
}

/** @internal */
export const rethrowCanonicalGenerationChangeAfterCommit = (
  error: unknown,
  committedRecords: readonly BrainRecord[],
): never => {
  if (error instanceof CanonicalGenerationChanged && committedRecords.length > 0) {
    throw committedCanonicalGenerationError(committedRecords)
  }
  throw error
}

/** @internal */
export const committedCanonicalRecordPrefixError = (
  error: EncephalonError,
  committedRecords: readonly BrainRecord[],
): EncephalonError => {
  let result = error
  if (
    error.code === 'REPOSITORY_CHANGED' &&
    error.details.canonicalCommitted === true &&
    error.details.repositoryChanged === true
  ) {
    const cause =
      error.cause instanceof EncephalonError && error.cause.code === 'REPOSITORY_CHANGED'
        ? error.cause
        : repositoryChangedBeforePublicationError()
    result = new EncephalonError(
      error.code,
      error.message,
      {
        ...error.details,
        committedRecordIds: frozenCommittedRecordIds(committedRecords),
      },
      { cause },
    )
  }
  return result
}

const canonicalRecordBytes = (record: BrainRecord) => {
  const { path: _path, ...recordFile } = record
  return Buffer.byteLength(formatRecordFile(recordFile), 'utf8')
}

const directoryFlag = constants.O_DIRECTORY ?? 0
const noFollowFlag = constants.O_NOFOLLOW ?? 0
const nonBlockFlag = constants.O_NONBLOCK ?? 0
const noControllingTerminalFlag = constants.O_NOCTTY ?? 0
const recordOpenFlags = constants.O_RDONLY | noFollowFlag | nonBlockFlag | noControllingTerminalFlag
/** @internal */
export const MAX_CANONICAL_RECORDS = CANONICAL_BUDGETS.records
/** @internal */
export const MAX_CANONICAL_RECORD_BYTES = CANONICAL_BUDGETS.recordJsonBytes
/** @internal */
export const MAX_SUPERSESSION_EDGES = OPERATION_BUDGETS.supersessionEdges.maximum
/** @internal */
export const MAX_ARTIFACT_REFERENCES = 1000
/** @internal */
export const MAX_VALIDATION_ISSUES = 100
const decoder = new TextDecoder('utf-8', { fatal: true })

const posixRelative = (root: string, path: string) => relative(root, path).replaceAll('\\', '/')

const cacheManifestEntry = (path: string, metadata: BigIntStats): CanonicalCacheManifestEntry => {
  const { ctimeNanoseconds, mtimeNanoseconds, size, type } = manifestEntryMetadataFrom(metadata)
  return {
    ctimeNanoseconds,
    mtimeNanoseconds,
    path,
    size,
    type,
  }
}

const artifactCacheManifestEntry = (artifact: ArtifactObservation): CanonicalCacheManifestEntry =>
  cacheManifestEntry(`encephalon/${artifact.path}`, artifact.metadata)

/** @internal */
export const canonicalCacheManifest = (
  recordEntries: readonly CanonicalCacheManifestEntry[],
  artifacts: readonly ArtifactObservation[],
) => {
  const entries = [
    ...recordEntries,
    ...[...artifacts]
      .sort((first, second) => ordinalStringCompare(first.path, second.path))
      .map(artifactCacheManifestEntry),
  ]
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

const canonicalRecordCacheManifestEntries = (
  root: string,
  layout: CanonicalLayoutWitness,
  observations: readonly RecordObservation[],
  directoryMetadata: ReadonlyMap<string, BigIntStats>,
): readonly CanonicalCacheManifestEntry[] => {
  const rootSnapshot = layout.root
  if (rootSnapshot !== null) {
    const observationsByPath = new Map(observations.map(observation => [observation.path, observation]))
    const cacheDirectoryEntry = (path: string) => {
      const metadata = directoryMetadata.get(path)
      if (metadata === undefined) {
        throw new Error('Validated canonical directory evidence is missing.')
      }
      return cacheManifestEntry(posixRelative(root, path), metadata)
    }
    const children = rootSnapshot.entries
      .filter(entry => !isCanonicalReservedDirectory(entry.name))
      .flatMap(kindEntry => {
        const kindSnapshot = layout.kinds.get(kindEntry.name)
        if (kindSnapshot === undefined) {
          throw new Error('Validated canonical kind evidence is missing.')
        }
        const records = kindSnapshot.entries.map(recordEntry => {
          const path = resolve(kindSnapshot.witness.path, recordEntry.name)
          const observation = observationsByPath.get(path)
          if (observation === undefined) {
            throw new Error('Validated canonical record evidence is missing.')
          }
          return cacheManifestEntry(posixRelative(root, path), observation.metadata)
        })
        return [cacheDirectoryEntry(kindSnapshot.witness.path), ...records]
      })
    return [cacheDirectoryEntry(rootSnapshot.witness.path), ...children]
  }
  return [{ path: 'encephalon', type: 'missing' }]
}

const issue = (code: string, message: string, path?: string, recordId?: string): ValidationIssue => ({
  code,
  message,
  ...(path === undefined ? {} : { path }),
  ...(recordId === undefined ? {} : { recordId }),
})

const corpusIssue = (code: string, message: string, path = 'encephalon') => issue(code, message, path)

const directoryEntryLimitIssue = (path: string, maximum: number, entryKind = 'directory entries') =>
  corpusIssue('CORPUS_DIRECTORY_ENTRY_LIMIT', `${path} may contain at most ${maximum} ${entryKind}.`, path)

const fault = (hooks: RecordWriteHooks | undefined, point: RecordWriteFault) => hooks?.fault?.(point)

const readFault = (hooks: RecordReadHooks | undefined, point: RecordReadFault, path: string) => {
  hooks?.fault?.(point, path)
}

const recordDigest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

const assertRealDirectory = (root: string, path: string) => {
  const metadata = lstatSync(path, { bigint: true })
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    return
  }
  return fail('VALIDATION_FAILED', `${posixRelative(root, path)} must be a real non-symlink directory.`)
}

const assertPreparedPublicationDirectory = (root: string, path: string, changed: () => never) => {
  try {
    assertRealDirectory(root, path)
  } catch (error) {
    if (
      isCanonicalDirectoryReplacementError(error) ||
      (error instanceof EncephalonError && error.code === 'VALIDATION_FAILED')
    ) {
      return changed()
    }
    throw error
  }
}

const ensurePublicationDirectory = (root: string, path: string, existed: boolean, changed: () => never) => {
  if (existed) {
    assertPreparedPublicationDirectory(root, path, changed)
    return
  }
  try {
    mkdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return changed()
    }
    throw error
  }
  try {
    return captureDirectoryWitness(path, { allowLink: false })
  } catch (error) {
    if (error instanceof DirectoryWitnessError || isCanonicalDirectoryReplacementError(error)) {
      return changed()
    }
    throw error
  }
}

const capturePreparedPublicationDirectory = (path: string, maximum: number, changed: () => never) => {
  try {
    return captureCanonicalDirectory(path, maximum)
  } catch (error) {
    if (isCanonicalDirectoryReplacementError(error)) {
      return changed()
    }
    throw error
  }
}

const capturePreparedPublicationDirectoryWitness = (path: string, changed: () => never) => {
  try {
    return captureDirectoryWitness(path, { allowLink: false })
  } catch (error) {
    if (error instanceof DirectoryWitnessError || isCanonicalDirectoryReplacementError(error)) {
      return changed()
    }
    throw error
  }
}

const samePublicationDirectoryIdentity = (first: DirectoryWitness, second: DirectoryWitness) =>
  first.path === second.path &&
  first.canonicalPath === second.canonicalPath &&
  sameEntryIdentity(first.pathMetadata, second.pathMetadata) &&
  sameEntryIdentity(first.canonicalMetadata, second.canonicalMetadata)

const assertCreatedPublicationDirectory = (
  created: DirectoryWitness | undefined,
  prepared: DirectoryWitness,
  changed: () => never,
) => {
  if (created !== undefined && !samePublicationDirectoryIdentity(created, prepared)) {
    return changed()
  }
}

const fsyncDirectory = (path: string) => {
  if (process.platform !== 'win32') {
    let descriptor: number | undefined
    try {
      descriptor = openSync(path, constants.O_RDONLY | directoryFlag)
      fsyncSync(descriptor)
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM') {
        throw error
      }
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor)
      }
    }
  }
}

const assertParentIdentity = (path: string, expected: EntryIdentity) => {
  const metadata = lstatSync(path, { bigint: true })
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !sameEntryIdentity(metadata, expected)) {
    canonicalGenerationChanged()
  }
}

const invalidRecordReadChange = (): never => fail('INVALID_ARGUMENT', 'Record file changed while it was being read.')

const readBoundedDescriptor = (descriptor: number, size: bigint, changed: () => never = invalidRecordReadChange) => {
  const boundedSize = Number(size)
  const buffer = Buffer.alloc(boundedSize)
  let offset = 0
  while (offset < boundedSize) {
    const bytesRead = readSync(descriptor, buffer, offset, boundedSize - offset, offset)
    if (bytesRead === 0) {
      return changed()
    }
    offset += bytesRead
  }
  const extra = Buffer.alloc(1)
  if (readSync(descriptor, extra, 0, 1, boundedSize) > 0) {
    return changed()
  }
  return buffer
}

const currentRecordPathMetadata = (path: string, changed: () => never) => {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if (isCanonicalDirectoryReplacementError(error)) {
      return changed()
    }
    throw error
  }
}

const isRecordReadabilityError = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return code === 'EACCES' || code === 'EPERM'
}

const pathSafeRecordOperationalError = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return typeof code === 'string' ? Object.assign(new Error('A record filesystem operation failed.'), { code }) : error
}

const openObservedRecordDescriptor = (path: string, expected: BigIntStats, changed: () => never) => {
  let descriptor: number
  try {
    descriptor = openSync(path, recordOpenFlags)
  } catch (error) {
    const current = currentRecordPathMetadata(path, changed)
    if (!sameStableEntryMetadata(expected, current)) {
      return changed()
    }
    throw error
  }
  let metadata: BigIntStats
  try {
    metadata = fstatSync(descriptor, { bigint: true })
  } catch (error) {
    try {
      closeSync(descriptor)
    } catch {}
    throw error
  }
  if (!(metadata.isFile() && sameStableEntryMetadata(expected, metadata))) {
    try {
      closeSync(descriptor)
    } catch {}
    return changed()
  }
  return { descriptor, metadata }
}

const decodeRecordBytes = (bytes: Buffer) => {
  try {
    return decoder.decode(bytes)
  } catch {
    return fail('INVALID_ARGUMENT', 'Record file is not valid UTF-8.')
  }
}

const parseRecordJson = (content: string) => {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return fail('INVALID_ARGUMENT', 'Record file contains invalid JSON.')
  }
}

const readRecord = (
  path: string,
  kindPath: string,
  kindIdentity: EntryIdentity,
  hooks?: RecordReadHooks,
):
  | { bytes: Buffer; kind: 'accepted'; observation: RecordObservation }
  | { evidence: RecordRejectionEvidence; kind: 'rejected'; message: string } => {
  let pathMetadata: BigIntStats
  try {
    pathMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isCanonicalDirectoryReplacementError(error)) {
      return canonicalGenerationChanged()
    }
    throw error
  }
  readFault(hooks, 'after-record-lstat', path)
  let descriptor: number | undefined
  let descriptorMetadata: BigIntStats | undefined
  try {
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      return canonicalGenerationChanged()
    }
    const { descriptor: openedDescriptor, metadata: openedMetadata } = openObservedRecordDescriptor(
      path,
      pathMetadata,
      canonicalGenerationChanged,
    )
    descriptor = openedDescriptor
    descriptorMetadata = openedMetadata
    readFault(hooks, 'after-record-open', path)
    assertParentIdentity(kindPath, kindIdentity)
    if (descriptorMetadata.size > BigInt(MAX_RECORD_BYTES)) {
      return {
        evidence: {
          kindIdentity,
          kindPath,
          metadata: Object.freeze(descriptorMetadata),
          path,
          reason: 'metadata',
        },
        kind: 'rejected',
        message: 'Record file exceeds the 1 MiB limit.',
      }
    }
    readFault(hooks, 'after-record-fstat', path)
    const bytes = readBoundedDescriptor(descriptor, descriptorMetadata.size, canonicalGenerationChanged)
    const finalMetadata = fstatSync(descriptor, { bigint: true })
    if (!sameStableEntryMetadata(descriptorMetadata, finalMetadata)) {
      return canonicalGenerationChanged()
    }
    return {
      bytes,
      kind: 'accepted',
      observation: Object.freeze({
        digest: recordDigest(bytes),
        metadata: Object.freeze(finalMetadata),
        path,
      }),
    }
  } catch (error) {
    if (error instanceof CanonicalGenerationChanged) {
      throw error
    }
    if (error instanceof EncephalonError) {
      throw error
    }
    if (isCanonicalDirectoryReplacementError(error)) {
      return canonicalGenerationChanged()
    }
    const current = currentRecordPathMetadata(path, canonicalGenerationChanged)
    assertParentIdentity(kindPath, kindIdentity)
    if (!sameStableEntryMetadata(pathMetadata, current)) {
      return canonicalGenerationChanged()
    }
    if (!isRecordReadabilityError(error)) {
      throw pathSafeRecordOperationalError(error)
    }
    return {
      evidence: {
        kindIdentity,
        kindPath,
        metadata: Object.freeze(descriptorMetadata ?? current),
        path,
        reason: 'unreadable',
      },
      kind: 'rejected',
      message: 'Record file must be a readable regular non-symlink JSON file.',
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}

const parseObservedRecord = (root: string, path: string, bytes: Buffer): BrainRecord => {
  const parsed = parseRecordJson(decodeRecordBytes(bytes))
  return { ...parseRecordFile(parsed), path: posixRelative(root, path) }
}

const kindDirectoryIssue = (name: string, path: string) => {
  try {
    validateKind(name)
    return null
  } catch {
    return issue('INVALID_KIND_DIRECTORY', 'Kind directory name is not a portable kind.', path)
  }
}

const scanCanonicalRecords = (root: string, options: ValidateRecordsOptions = {}): RecordScan => {
  const brainDirectory = resolve(root, 'encephalon')
  let rootMetadata: BigIntStats | undefined
  try {
    rootMetadata = lstatSync(brainDirectory, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  if (rootMetadata !== undefined) {
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return {
        bytes: 0,
        errors: [issue('INVALID_RECORD_LAYOUT', 'encephalon must be a real directory.', 'encephalon')],
        observations: [],
        records: [],
        rejections: [],
        rootObservation: { metadata: Object.freeze(rootMetadata), path: brainDirectory },
      }
    }

    let rootEntries: CanonicalDirectorySnapshot
    try {
      rootEntries = captureCanonicalDirectory(brainDirectory, MAX_CANONICAL_BRAIN_ROOT_ENTRIES, () =>
        options.hooks?.afterBrainRootEnumeration?.(),
      )
    } catch (error) {
      if (error instanceof CanonicalDirectoryChangedError) {
        return canonicalGenerationChanged()
      }
      throw error
    }
    if (rootEntries.overflow) {
      return {
        bytes: 0,
        errors: [directoryEntryLimitIssue('encephalon', MAX_CANONICAL_BRAIN_ROOT_ENTRIES)],
        layout: { kinds: new Map(), root: rootEntries },
        observations: [],
        records: [],
        rejections: [],
      }
    }
    const kindEntries = rootEntries.entries.filter(isCanonicalKindDirectoryEntry)
    if (kindEntries.length > MAX_CANONICAL_KIND_DIRECTORIES) {
      return {
        bytes: 0,
        errors: [directoryEntryLimitIssue('encephalon', MAX_CANONICAL_KIND_DIRECTORIES, 'kind directories')],
        layout: { kinds: new Map(), root: rootEntries },
        observations: [],
        records: [],
        rejections: [],
      }
    }
    const kindSnapshots = new Map<string, CanonicalDirectorySnapshot>()
    for (const kindEntry of kindEntries) {
      const relativeKindPath = `encephalon/${kindEntry.name}`
      const kindPath = join(brainDirectory, kindEntry.name)
      let snapshot: CanonicalDirectorySnapshot
      try {
        snapshot = captureCanonicalDirectory(kindPath, MAX_CANONICAL_KIND_ENTRIES, options.hooks?.afterKindEnumeration)
      } catch (error) {
        if (error instanceof CanonicalDirectoryChangedError) {
          return canonicalGenerationChanged()
        }
        throw error
      }
      kindSnapshots.set(kindEntry.name, snapshot)
      if (snapshot.overflow) {
        return {
          bytes: 0,
          errors: [directoryEntryLimitIssue(relativeKindPath, MAX_CANONICAL_KIND_ENTRIES)],
          layout: { kinds: kindSnapshots, root: rootEntries },
          observations: [],
          records: [],
          rejections: [],
        }
      }
    }

    const kindDirectoryNames = new Map<string, string>()
    const scanned: RecordScan = {
      bytes: 0,
      errors: [],
      observations: [],
      records: [],
      rejections: [],
    }
    const onWork = options.hooks?.onWork
    let recordBytes = 0n
    let stopScanning = false
    const addScanError = (validationIssue: ValidationIssue) => {
      scanned.errors.push(validationIssue)
      if (scanned.errors.length >= MAX_VALIDATION_ISSUES) {
        stopScanning = true
      }
    }
    for (const kindEntry of rootEntries.entries) {
      if (stopScanning) {
        break
      }
      if (isCanonicalReservedDirectory(kindEntry.name)) {
        if (!(kindEntry.isDirectory() && !kindEntry.isSymbolicLink())) {
          addScanError(
            issue(
              'INVALID_RECORD_LAYOUT',
              `${kindEntry.name} must be a real directory.`,
              `encephalon/${kindEntry.name}`,
            ),
          )
        }
      } else {
        const kindPath = join(brainDirectory, kindEntry.name)
        if (isCanonicalKindDirectoryEntry(kindEntry)) {
          let kindMetadata: BigIntStats
          try {
            readFault(options.hooks, 'before-kind-lstat', kindPath)
            kindMetadata = lstatSync(kindPath, { bigint: true })
          } catch (error) {
            if (isCanonicalDirectoryReplacementError(error)) {
              return canonicalGenerationChanged()
            }
            throw error
          }
          if (!kindMetadata.isDirectory() || kindMetadata.isSymbolicLink()) {
            addScanError(
              issue(
                'INVALID_RECORD_LAYOUT',
                'The brain root may contain only kind directories and reserved internal directories.',
                posixRelative(root, kindPath),
              ),
            )
            continue
          }
          const relativeKindPath = posixRelative(root, kindPath)
          const invalidKindDirectory = kindDirectoryIssue(kindEntry.name, relativeKindPath)
          if (invalidKindDirectory !== null) {
            addScanError(invalidKindDirectory)
          }
          const collisionKey = kindEntry.name.normalize('NFC').toLowerCase()
          const collision = kindDirectoryNames.get(collisionKey)
          if (collision === undefined) {
            kindDirectoryNames.set(collisionKey, kindEntry.name)
          } else if (collision !== kindEntry.name) {
            addScanError(
              issue(
                'KIND_DIRECTORY_COLLISION',
                'Kind directory names collide after portable normalization.',
                relativeKindPath,
              ),
            )
          }
          const kindIdentity = entryIdentityFrom(kindMetadata)
          const recordEntries = kindSnapshots.get(kindEntry.name)
          if (recordEntries === undefined) {
            throw new Error('Canonical kind snapshot is missing.')
          }
          for (const recordEntry of recordEntries.entries) {
            if (stopScanning) {
              break
            }
            if (onWork !== undefined) {
              reportWork(onWork, 'canonical-entry')
            }
            const recordPath = join(kindPath, recordEntry.name)
            const relativePath = posixRelative(root, recordPath)
            if (recordEntry.isFile() && !recordEntry.isSymbolicLink() && recordEntry.name.endsWith('.json')) {
              if (scanned.records.length >= MAX_CANONICAL_RECORDS) {
                addScanError(
                  corpusIssue(
                    'CORPUS_RECORD_LIMIT',
                    `Canonical corpus may contain at most ${MAX_CANONICAL_RECORDS} records.`,
                    relativePath,
                  ),
                )
                stopScanning = true
                break
              }
              try {
                const observed = readRecord(recordPath, kindPath, kindIdentity, options.hooks)
                if (observed.kind === 'rejected') {
                  scanned.rejections.push(observed.evidence)
                  addScanError(issue('INVALID_RECORD', observed.message, relativePath))
                  continue
                }
                scanned.observations.push(observed.observation)
                if (recordBytes + observed.observation.metadata.size > BigInt(MAX_CANONICAL_RECORD_BYTES)) {
                  addScanError(
                    corpusIssue(
                      'CORPUS_BYTE_LIMIT',
                      `Canonical corpus may contain at most ${MAX_CANONICAL_RECORD_BYTES} bytes of record JSON.`,
                      relativePath,
                    ),
                  )
                  stopScanning = true
                  break
                }
                recordBytes += observed.observation.metadata.size
                const record = parseObservedRecord(root, recordPath, observed.bytes)
                const expectedName = `${record.id}.json`
                if (!(recordEntry.name === expectedName && record.kind === kindEntry.name)) {
                  addScanError(
                    issue(
                      'RECORD_PATH_MISMATCH',
                      'Record filename and parent kind must match its envelope.',
                      relativePath,
                      record.id,
                    ),
                  )
                }
                scanned.records.push(record)
              } catch (error) {
                if (error instanceof CanonicalGenerationChanged) {
                  throw error
                }
                if (error instanceof EncephalonError && error.code === 'INVALID_ARGUMENT') {
                  addScanError(issue('INVALID_RECORD', error.message, relativePath))
                } else {
                  throw error
                }
              }
            } else {
              addScanError(
                issue(
                  'INVALID_RECORD_LAYOUT',
                  'Kind directories may contain only direct regular JSON files.',
                  relativePath,
                ),
              )
            }
          }
        } else {
          addScanError(
            issue(
              'INVALID_RECORD_LAYOUT',
              'The brain root may contain only kind directories and reserved internal directories.',
              posixRelative(root, kindPath),
            ),
          )
        }
      }
    }
    try {
      options.hooks?.beforeFinalWitnessValidation?.()
      for (const snapshot of kindSnapshots.values()) {
        revalidateCanonicalDirectory(snapshot)
      }
      revalidateCanonicalDirectory(rootEntries)
    } catch (error) {
      if (error instanceof CanonicalDirectoryChangedError) {
        return canonicalGenerationChanged()
      }
      throw error
    }
    options.hooks?.afterBrainRootSnapshot?.()
    ;[...kindSnapshots.values()].reduce<undefined>((verified, snapshot) => {
      options.hooks?.afterKindSnapshot?.(snapshot.witness.path)
      return verified
    }, undefined)
    scanned.observations.reduce<undefined>((verified, observation) => {
      readFault(options.hooks, 'after-record-read', observation.path)
      return verified
    }, undefined)
    return {
      bytes: Number(recordBytes),
      errors: scanned.errors,
      layout: { kinds: kindSnapshots, root: rootEntries },
      observations: scanned.observations,
      records: scanned.records.sort(
        (first, second) =>
          ordinalStringCompare(first.createdAt, second.createdAt) || ordinalStringCompare(first.id, second.id),
      ),
      rejections: scanned.rejections,
    }
  }
  return {
    bytes: 0,
    errors: [],
    layout: { kinds: new Map(), root: null },
    observations: [],
    records: [],
    rejections: [],
  }
}

const duplicateAndCaseIssues = (records: BrainRecord[], hooks: RecordReadHooks) => {
  const ids = new Map<string, BrainRecord>()
  const paths = new Map<string, BrainRecord>()
  const { onWork } = hooks
  const errors = observedArray<ValidationIssue>(
    observeWork(hooks.onWork, 'duplicate-issue-read'),
    observeWork(hooks.onWork, 'duplicate-issue-write'),
  )
  for (const record of records) {
    if (onWork !== undefined) {
      reportWork(onWork, 'duplicate-record')
    }
    const idCollision = ids.get(record.id)
    const pathCollision = paths.get(record.path.normalize('NFC').toLowerCase())
    ids.set(record.id, record)
    paths.set(record.path.normalize('NFC').toLowerCase(), record)
    if (idCollision !== undefined) {
      errors.push(issue('DUPLICATE_RECORD_ID', `Duplicate record id ${record.id}.`, record.path, record.id))
    }
    if (pathCollision !== undefined && pathCollision.path !== record.path) {
      errors.push(
        issue('CASE_COLLISION', 'Record paths collide on case-insensitive filesystems.', record.path, record.id),
      )
    }
  }
  return errors
}

const supersessionIssues = (records: BrainRecord[], hooks: RecordReadHooks) => {
  const byId = new Map(records.map(record => [record.id, record]))
  const { onWork } = hooks
  const edgeCount = records.reduce((count, record) => count + (record.supersedes?.length ?? 0), 0)
  if (edgeCount > MAX_SUPERSESSION_EDGES) {
    return [
      corpusIssue(
        'CORPUS_SUPERSEDES_LIMIT',
        `Canonical corpus may contain at most ${MAX_SUPERSESSION_EDGES} supersession edges.`,
      ),
    ]
  }
  const edgeIssues: ValidationIssue[] = []
  for (const record of records) {
    for (const targetId of record.supersedes ?? []) {
      if (onWork !== undefined) {
        reportWork(onWork, 'edge-validation')
      }
      const target = byId.get(targetId)
      if (target === undefined) {
        edgeIssues.push(
          issue('MISSING_SUPERSEDES', `Record supersedes missing record ${targetId}.`, record.path, record.id),
        )
      } else if (targetId === record.id) {
        edgeIssues.push(issue('SELF_SUPERSEDES', 'A record may not supersede itself.', record.path, record.id))
      } else if (target.kind !== record.kind || target.subject !== record.subject) {
        edgeIssues.push(
          issue(
            'CROSS_SUBJECT_SUPERSEDES',
            'Superseded records must have the same kind and subject.',
            record.path,
            record.id,
          ),
        )
      }
    }
  }

  const cycleIssues: ValidationIssue[] = []
  const state = new Map<string, 'visited' | 'visiting'>()
  for (const record of records) {
    if (state.has(record.id)) {
      continue
    }
    const stack = [{ index: 0, record }]
    state.set(record.id, 'visiting')
    while (stack.length > 0) {
      const frame = stack.at(-1)
      if (frame !== undefined) {
        const targets = frame.record.supersedes ?? []
        if (frame.index >= targets.length) {
          state.set(frame.record.id, 'visited')
          stack.pop()
        } else {
          const targetId = targets[frame.index] ?? ''
          frame.index += 1
          if (onWork !== undefined) {
            reportWork(onWork, 'cycle-edge')
          }
          const target = byId.get(targetId)
          if (target !== undefined) {
            const targetState = state.get(target.id)
            if (targetState === 'visiting') {
              cycleIssues.push(
                issue(
                  'SUPERSEDES_CYCLE',
                  'The supersession graph contains a cycle.',
                  frame.record.path,
                  frame.record.id,
                ),
              )
            } else if (targetState !== 'visited') {
              state.set(target.id, 'visiting')
              stack.push({ index: 0, record: target })
            }
          }
        }
      }
    }
  }

  const superseded = new Set<string>()
  for (const record of records) {
    for (const targetId of record.supersedes ?? []) {
      if (onWork !== undefined) {
        reportWork(onWork, 'superseded-edge')
      }
      superseded.add(targetId)
    }
  }
  const activeGroups = new Map<string, BrainRecord[]>()
  for (const record of records) {
    if (!superseded.has(record.id)) {
      const key = `${record.kind}\0${record.subject}`
      const group = activeGroups.get(key)
      if (group === undefined) {
        const firstGroup = observedArray<BrainRecord>(
          observeWork(hooks.onWork, 'active-group-read'),
          observeWork(hooks.onWork, 'active-group-write'),
        )
        firstGroup.push(record)
        activeGroups.set(key, firstGroup)
      } else {
        group.push(record)
      }
    }
  }
  const activeIssues = observedArray<ValidationIssue>(
    observeWork(hooks.onWork, 'active-issue-read'),
    observeWork(hooks.onWork, 'active-issue-write'),
  )
  for (const group of activeGroups.values()) {
    if (group.length > 1) {
      for (const record of group) {
        activeIssues.push(
          issue(
            'MULTIPLE_ACTIVE_HEADS',
            `Multiple active records exist for ${record.kind}/${record.subject}.`,
            record.path,
            record.id,
          ),
        )
      }
    }
  }
  return [...edgeIssues, ...cycleIssues, ...activeIssues]
}

const artifactIssues = (root: string, records: BrainRecord[]) => {
  const artifactCount = records.reduce((count, record) => count + (record.artifacts?.length ?? 0), 0)
  if (artifactCount > MAX_ARTIFACT_REFERENCES) {
    return {
      errors: [
        corpusIssue(
          'CORPUS_ARTIFACT_LIMIT',
          `Canonical corpus may contain at most ${MAX_ARTIFACT_REFERENCES} artifact references.`,
        ),
      ],
      evidence: Object.freeze([] as ArtifactInspectionResult[]),
      observations: [] as readonly ArtifactObservation[],
    }
  }
  const brainDirectory = resolve(root, 'encephalon')
  const paths = new Map<string, string>()
  const errors: ValidationIssue[] = []
  const artifactPaths = [...new Set(records.flatMap(record => record.artifacts ?? []))].sort(ordinalStringCompare)
  const evidence =
    artifactPaths.length === 0
      ? Object.freeze([] as ArtifactInspectionResult[])
      : inspectArtifactFiles(brainDirectory, artifactPaths)
  const inspectionResults = new Map(
    evidence.map(result => [result.kind === 'stable' ? result.observation.path : result.path, result]),
  )
  for (const record of records) {
    for (const artifact of record.artifacts ?? []) {
      const collisionKey = artifact.normalize('NFC').toLowerCase()
      const collision = paths.get(collisionKey)
      paths.set(collisionKey, artifact)
      if (collision !== undefined && collision !== artifact) {
        errors.push(
          issue('CASE_COLLISION', 'Artifact paths collide on case-insensitive filesystems.', record.path, record.id),
        )
      }
      const inspection = inspectionResults.get(artifact)
      if (inspection?.kind === 'invalid') {
        errors.push(issue('INVALID_ARTIFACT', inspection.error.message, record.path, record.id))
      }
    }
  }
  return {
    errors,
    evidence,
    observations: Object.freeze(evidence.flatMap(result => (result.kind === 'stable' ? [result.observation] : []))),
  }
}

const truncateValidationIssues = (errors: ValidationIssue[]) => {
  if (errors.length < MAX_VALIDATION_ISSUES) {
    return { errors, truncated: false }
  }
  return {
    errors: [
      ...errors.slice(0, MAX_VALIDATION_ISSUES - 1),
      issue(
        'VALIDATION_ISSUES_TRUNCATED',
        `Validation stopped reporting after ${MAX_VALIDATION_ISSUES - 1} concrete issues.`,
        'encephalon',
      ),
    ],
    truncated: true,
  }
}

const corpusBudgetIssues = (scan: RecordScan) => {
  const path = scan.records.at(-1)?.path ?? 'encephalon'
  return [
    ...(scan.records.length > MAX_CANONICAL_RECORDS
      ? [
          corpusIssue(
            'CORPUS_RECORD_LIMIT',
            `Canonical corpus may contain at most ${MAX_CANONICAL_RECORDS} records.`,
            path,
          ),
        ]
      : []),
    ...(scan.bytes > MAX_CANONICAL_RECORD_BYTES
      ? [
          corpusIssue(
            'CORPUS_BYTE_LIMIT',
            `Canonical corpus may contain at most ${MAX_CANONICAL_RECORD_BYTES} bytes of record JSON.`,
            path,
          ),
        ]
      : []),
  ]
}

const validatedArtifactIssues = (root: string, records: BrainRecord[], changed?: (() => never) | undefined) => {
  try {
    return artifactIssues(root, records)
  } catch (error) {
    if (error instanceof ArtifactChangedError) {
      if (changed !== undefined) {
        return changed()
      }
      return fail('REPOSITORY_CHANGED', 'An artifact changed while canonical records were being validated.')
    }
    throw error
  }
}

const validateScannedSnapshot = (
  root: string,
  scan: RecordScan,
  hooks: RecordReadHooks = {},
  changed?: (() => never) | undefined,
): ValidatedRecordScan => {
  hooks.graphValidation?.()
  const artifactValidation = validatedArtifactIssues(root, scan.records, changed)
  const collectedErrors = [
    ...scan.errors,
    ...corpusBudgetIssues(scan),
    ...duplicateAndCaseIssues(scan.records, hooks),
    ...supersessionIssues(scan.records, hooks),
    ...artifactValidation.errors,
  ]
  const { errors, truncated } = truncateValidationIssues(collectedErrors)
  return {
    artifactEvidence: artifactValidation.evidence,
    artifacts: artifactValidation.observations,
    result: {
      errors,
      recordsChecked: scan.records.length,
      truncated,
      valid: errors.length === 0,
    },
  }
}

const validateScanned = (root: string, scan: RecordScan, hooks: RecordReadHooks = {}): ValidateResult =>
  validateScannedSnapshot(root, scan, hooks).result

const canonicalGenerationChanged = (): never => {
  throw new CanonicalGenerationChanged()
}

const canonicalSnapshotRetryExhausted = (): never =>
  fail('REPOSITORY_CHANGED', 'The canonical repository changed repeatedly during the operation.')

const createCanonicalSnapshotRetryLedger = (now: () => number = Date.now): CanonicalSnapshotRetryLedger => ({
  attempt: 0,
  deadline: now() + OPERATION_BUDGETS.canonicalSnapshotRetryMilliseconds.maximum,
  maximumAttempts: OPERATION_BUDGETS.canonicalSnapshotAttempts.maximum,
  now,
  repositoryChanged: false,
})

const canonicalRootMissing = (root: string) => {
  let missing = false
  try {
    lstatSync(resolve(root, 'encephalon'), { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      missing = true
    } else {
      throw error
    }
  }
  return missing
}

const sameCanonicalLayoutGeneration = (root: string, layout: CanonicalLayoutWitness) => {
  let current = true
  try {
    if (layout.root === null) {
      current = canonicalRootMissing(root)
    } else {
      current = [layout.root, ...layout.kinds.values()].every(snapshot =>
        sameCanonicalDirectoryGeneration(snapshot, recaptureCanonicalDirectoryGeneration(snapshot)),
      )
    }
  } catch (error) {
    if (isCanonicalDirectoryReplacementError(error)) {
      current = false
    } else {
      throw error
    }
  }
  return current
}

const reinspectRecordObservation = (observation: RecordObservation, changed: () => never): RecordObservation => {
  let descriptor: number | undefined
  let primaryError: unknown
  let result: RecordObservation | undefined
  try {
    const pathMetadata = currentRecordPathMetadata(observation.path, changed)
    if (
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      !sameStableEntryMetadata(observation.metadata, pathMetadata)
    ) {
      changed()
    }
    const { descriptor: openedDescriptor } = openObservedRecordDescriptor(observation.path, pathMetadata, changed)
    descriptor = openedDescriptor
    const bytes = readBoundedDescriptor(descriptor, observation.metadata.size, changed)
    const finalDescriptorMetadata = fstatSync(descriptor, { bigint: true })
    const finalPathMetadata = currentRecordPathMetadata(observation.path, changed)
    if (
      !(
        sameStableEntryMetadata(observation.metadata, finalDescriptorMetadata) &&
        sameStableEntryMetadata(finalDescriptorMetadata, finalPathMetadata)
      ) ||
      recordDigest(bytes) !== observation.digest
    ) {
      changed()
    }
    result = Object.freeze({
      digest: observation.digest,
      metadata: Object.freeze(finalDescriptorMetadata),
      path: observation.path,
    })
  } catch (error) {
    primaryError = error
  }
  let closeError: unknown
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor)
    } catch (error) {
      closeError = error
    }
  }
  if (primaryError !== undefined) {
    if (isCanonicalDirectoryReplacementError(primaryError)) {
      return changed()
    }
    throw primaryError
  }
  if (closeError !== undefined) {
    throw closeError
  }
  return result ?? changed()
}

const assertPathObservationCurrent = (observation: PathObservation, changed: () => never) => {
  const current = currentRecordPathMetadata(observation.path, changed)
  if (!sameStableEntryMetadata(observation.metadata, current)) {
    return changed()
  }
}

const assertRejectedRecordEvidenceCurrent = (
  evidence: RecordRejectionEvidence,
  changed: () => never,
  hooks: RecordReadHooks,
) => {
  assertPathObservationCurrent(evidence, changed)
  assertParentIdentity(evidence.kindPath, evidence.kindIdentity)
  if (evidence.reason === 'metadata') {
    return
  }
  let descriptor: number | undefined
  let primaryError: unknown
  let becameReadable = false
  try {
    const { descriptor: openedDescriptor, metadata } = openObservedRecordDescriptor(
      evidence.path,
      evidence.metadata,
      changed,
    )
    descriptor = openedDescriptor
    if (metadata.size > BigInt(MAX_RECORD_BYTES)) {
      return changed()
    }
    readFault(hooks, 'before-rejected-record-read', evidence.path)
    readBoundedDescriptor(descriptor, metadata.size, changed)
    becameReadable = true
  } catch (error) {
    if (error instanceof CanonicalGenerationChanged) {
      throw error
    }
    primaryError = error
  }
  let closeError: unknown
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor)
    } catch (error) {
      closeError = error
    }
  }
  if (primaryError !== undefined) {
    assertPathObservationCurrent(evidence, changed)
    assertParentIdentity(evidence.kindPath, evidence.kindIdentity)
    return
  }
  if (closeError !== undefined) {
    throw closeError
  }
  if (becameReadable) {
    return changed()
  }
}

const artifactEvidencePath = (evidence: ArtifactInspectionResult) =>
  evidence.kind === 'stable' ? evidence.observation.path : evidence.path

const assertArtifactEvidenceCurrent = (
  root: string,
  evidence: readonly ArtifactInspectionResult[],
  changed: () => never,
) => {
  if (evidence.length > 0) {
    try {
      const current = inspectArtifactFiles(resolve(root, 'encephalon'), evidence.map(artifactEvidencePath))
      if (
        current.length !== evidence.length ||
        !evidence.every(
          (expected, index) => current[index] !== undefined && sameArtifactInspectionResult(expected, current[index]),
        )
      ) {
        changed()
      }
    } catch (error) {
      if (error instanceof ArtifactChangedError) {
        return changed()
      }
      throw error
    }
  }
}

const assertCanonicalSnapshotCurrent = (
  root: string,
  scan: RecordScan,
  artifactEvidence: readonly ArtifactInspectionResult[],
  changed: () => never,
  hooks: RecordReadHooks = {},
) => {
  if (scan.rootObservation !== undefined) {
    assertPathObservationCurrent(scan.rootObservation, changed)
  }
  if (scan.layout !== undefined) {
    if (!sameCanonicalLayoutGeneration(root, scan.layout)) {
      changed()
    }
    scan.observations.reduce<undefined>((verified, observation) => {
      reinspectRecordObservation(observation, changed)
      return verified
    }, undefined)
    scan.rejections.reduce<undefined>((verified, evidence) => {
      assertRejectedRecordEvidenceCurrent(evidence, changed, hooks)
      return verified
    }, undefined)
    assertArtifactEvidenceCurrent(root, artifactEvidence, changed)
    if (!sameCanonicalLayoutGeneration(root, scan.layout)) {
      changed()
    }
  }
}

const withCanonicalSnapshotRetry = <Result>(
  operation: () => Result,
  ledger: CanonicalSnapshotRetryLedger = createCanonicalSnapshotRetryLedger(),
): Result => {
  if (ledger.attempt >= ledger.maximumAttempts || (ledger.attempt > 0 && ledger.now() >= ledger.deadline)) {
    return canonicalSnapshotRetryExhausted()
  }
  ledger.attempt += 1
  try {
    return operation()
  } catch (error) {
    if (error instanceof CanonicalGenerationChanged) {
      ledger.repositoryChanged = true
      if (ledger.attempt < ledger.maximumAttempts) {
        return withCanonicalSnapshotRetry(operation, ledger)
      }
      return canonicalSnapshotRetryExhausted()
    }
    throw error
  }
}

const readStableCanonicalSnapshot = (root: string, hooks: RecordReadHooks = {}): StableCanonicalSnapshot =>
  withCanonicalSnapshotRetry(() => {
    hooks.canonicalScan?.()
    const scan = scanCanonicalRecords(root, { hooks })
    const validation = validateScannedSnapshot(root, scan, hooks, canonicalGenerationChanged)
    assertCanonicalSnapshotCurrent(root, scan, validation.artifactEvidence, canonicalGenerationChanged, hooks)
    return { scan, validation }
  }, createCanonicalSnapshotRetryLedger(hooks.now))

const readCanonicalPlanningScanAttempt = (root: string, hooks: RecordReadHooks = {}) => {
  hooks.canonicalScan?.()
  const scan = scanCanonicalRecords(root, { hooks })
  assertCanonicalSnapshotCurrent(root, scan, [], canonicalGenerationChanged, hooks)
  return scan
}

const allowedMultiHeadRecordIds = (
  records: readonly BrainRecord[],
  allowed: readonly AllowedMultiHead[],
  hooks: RecordReadHooks,
) => {
  const allowedKeys = new Set(allowed.map(candidate => `${candidate.kind} ${candidate.subject} ${candidate.source}`))
  const superseded = new Set<string>()
  for (const record of records) {
    for (const targetId of record.supersedes ?? []) {
      superseded.add(targetId)
    }
  }
  const activeGroups = new Map<string, BrainRecord[]>()
  for (const record of records) {
    if (!superseded.has(record.id)) {
      const key = `${record.kind} ${record.subject}`
      const group = activeGroups.get(key)
      if (group === undefined) {
        const firstGroup = observedArray<BrainRecord>(undefined, observeWork(hooks.onWork, 'allowed-group-write'))
        firstGroup.push(record)
        activeGroups.set(key, firstGroup)
      } else {
        group.push(record)
      }
    }
  }
  const ids = observedSet<string>(observeWork(hooks.onWork, 'allowed-id-write'))
  for (const group of activeGroups.values()) {
    const [first] = group
    if (
      first !== undefined &&
      group.length > 1 &&
      group.every(record => allowedKeys.has(`${record.kind} ${record.subject} ${record.source}`))
    ) {
      for (const record of group) {
        ids.add(record.id)
      }
    }
  }
  return ids
}

/** @internal */
export const validateRecordsResolved = (root: string, options: ValidateRecordsOptions = {}): ValidateResult => {
  try {
    return readStableCanonicalSnapshot(root, options.hooks).validation.result
  } catch (error) {
    rethrowWorkObserverError(error)
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to validate Encephalon records.', error)
  }
}

export const validateRecords = (input: RootInput = {}): ValidateResult => {
  const root = resolveRepository(parseRootInput(input, 'validateRecords'))
  return validateRecordsResolved(root)
}

const readRecordScanResolvedUnchecked = (root: string, hooks: RecordReadHooks = {}, allowed?: AllowedMultiHead[]) => {
  const { scan, validation } = readStableCanonicalSnapshot(root, hooks)
  const { result } = validation
  if (allowed === undefined) {
    if (result.valid) {
      return { artifactEvidence: validation.artifactEvidence, artifacts: validation.artifacts, scan }
    }
    return fail('VALIDATION_FAILED', 'Canonical records are invalid.', {
      errors: result.errors.map(error => ({
        code: error.code,
        message: error.message,
      })),
    })
  }
  const allowedIds = allowedMultiHeadRecordIds(scan.records, allowed, hooks)
  const blockingErrors = result.errors.filter(
    error =>
      !(error.code === 'MULTIPLE_ACTIVE_HEADS' && error.recordId !== undefined && allowedIds.has(error.recordId)),
  )
  if (blockingErrors.length === 0) {
    return { artifactEvidence: validation.artifactEvidence, artifacts: validation.artifacts, scan }
  }
  return fail('VALIDATION_FAILED', 'Canonical records are invalid.', {
    errors: blockingErrors.map(error => ({
      code: error.code,
      message: error.message,
    })),
  })
}

const readRecordScanResolved = (root: string, hooks: RecordReadHooks = {}, allowed?: AllowedMultiHead[]) =>
  preserveWorkObserverFailure(() => readRecordScanResolvedUnchecked(root, hooks, allowed))

const freezeAcceptedRecords = (records: readonly BrainRecord[]): BrainRecord[] => {
  const accepted = records.map(record => Object.freeze(record))
  Object.freeze(accepted)
  return accepted
}

const canonicalPublicationAuthority = (
  root: string,
  initialLayout: CanonicalLayoutWitness,
  initialObservations: readonly RecordObservation[],
  initialArtifactEvidence: readonly ArtifactInspectionResult[],
  cacheLocation?: CacheLocation,
  changed: () => never = repositoryChangedBeforePublication,
  hooks: RecordReadHooks = {},
): CanonicalPublicationAuthority => {
  let layout = initialLayout
  let observations = [...initialObservations]
  const artifactEvidence = [...initialArtifactEvidence]
  const currentObservationMetadata = (path: string) => currentRecordPathMetadata(path, changed)
  const inspectObservation = (observation: RecordObservation): RecordObservation => {
    let descriptor: number | undefined
    let primaryError: unknown
    let result: RecordObservation | undefined
    try {
      const pathMetadata = currentObservationMetadata(observation.path)
      if (!sameStableEntryMetadataExceptCtime(observation.metadata, pathMetadata)) {
        changed()
      }
      const { descriptor: openedDescriptor, metadata: descriptorMetadata } = openObservedRecordDescriptor(
        observation.path,
        pathMetadata,
        changed,
      )
      descriptor = openedDescriptor
      readFault(hooks, 'after-record-fstat', observation.path)
      const bytes = readBoundedDescriptor(descriptor, descriptorMetadata.size, changed)
      const finalDescriptorMetadata = fstatSync(descriptor, { bigint: true })
      const finalPathMetadata = currentObservationMetadata(observation.path)
      if (
        !(
          sameStableEntryMetadata(descriptorMetadata, finalDescriptorMetadata) &&
          sameStableEntryMetadata(finalDescriptorMetadata, finalPathMetadata)
        ) ||
        recordDigest(bytes) !== observation.digest
      ) {
        changed()
      }
      result = { digest: observation.digest, metadata: finalDescriptorMetadata, path: observation.path }
    } catch (error) {
      primaryError = error
    }
    let closeError: unknown
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch (error) {
        closeError = error
      }
    }
    if (primaryError !== undefined) {
      const { code } = primaryError as NodeJS.ErrnoException
      if (code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR') {
        return changed()
      }
      throw primaryError
    }
    if (closeError !== undefined) {
      throw closeError
    }
    if (result === undefined) {
      return changed()
    }
    return result
  }
  const projection = () => {
    const rootEntries = layout.root === null ? [] : layout.root.entries
    return {
      kindCount: rootEntries.filter(isCanonicalKindDirectoryEntry).length,
      kindEntryCounts: new Map([...layout.kinds.entries()].map(([kind, snapshot]) => [kind, snapshot.entries.length])),
      rootExists: layout.root !== null,
      rootNames: new Set(rootEntries.map(entry => entry.name)),
    }
  }
  const sameDirectoryGeneration = (expected: CanonicalDirectorySnapshot, current: CanonicalDirectorySnapshot) =>
    expected.witness.path === current.witness.path &&
    expected.witness.canonicalPath === current.witness.canonicalPath &&
    sameEntryIdentity(expected.witness.pathMetadata, current.witness.pathMetadata) &&
    sameEntryIdentity(expected.witness.canonicalMetadata, current.witness.canonicalMetadata)
  const sameEntryNames = (first: readonly { name: string }[], second: readonly { name: string }[]) =>
    first.length === second.length && first.every((entry, index) => entry.name === second[index]?.name)
  const sameEntryType = (first: Dirent, second: Dirent) =>
    first.isSymbolicLink() === second.isSymbolicLink() &&
    first.isDirectory() === second.isDirectory() &&
    first.isFile() === second.isFile()
  const sameEntryNamesAndTypes = (first: readonly Dirent[], second: readonly Dirent[]) =>
    first.length === second.length &&
    first.every((entry, index) => {
      const other = second[index]
      return other !== undefined && entry.name === other.name && sameEntryType(entry, other)
    })
  const captureCacheDirectoryMetadata = () => {
    const snapshots = layout.root === null ? [] : [layout.root, ...layout.kinds.values()]
    return new Map(
      snapshots.map(snapshot => {
        const metadata = currentObservationMetadata(snapshot.witness.path)
        if (
          metadata.isSymbolicLink() ||
          !metadata.isDirectory() ||
          !sameEntryIdentity(snapshot.witness.pathMetadata, metadata)
        ) {
          return changed()
        }
        return [snapshot.witness.path, metadata] as const
      }),
    )
  }
  const assertCacheDirectoryMetadataCurrent = (expected: ReadonlyMap<string, BigIntStats>) => {
    for (const [path, metadata] of expected) {
      if (!sameStableEntryMetadata(metadata, currentObservationMetadata(path))) {
        return changed()
      }
    }
  }
  const authority: CanonicalPublicationAuthority = {
    acceptPreparation: (kind, rootSnapshot, kindSnapshot) => {
      const currentProjection = projection()
      const plannedRootAdditions = new Set(
        [STAGING_DIRECTORY_NAME, kind].filter(name => !currentProjection.rootNames.has(name)),
      )
      const retainedRootEntries = rootSnapshot.entries.filter(entry => !plannedRootAdditions.has(entry.name))
      const plannedRootEntries = rootSnapshot.entries.filter(entry => plannedRootAdditions.has(entry.name))
      const rootGenerationAccepted =
        layout.root === null || (layout.root !== null && sameDirectoryGeneration(layout.root, rootSnapshot))
      const rootEntriesAccepted =
        !rootSnapshot.overflow &&
        sameEntryNamesAndTypes(layout.root?.entries ?? [], retainedRootEntries) &&
        plannedRootEntries.length === plannedRootAdditions.size &&
        plannedRootEntries.every(entry => entry.isDirectory() && !entry.isSymbolicLink())
      const previousKind = layout.kinds.get(kind)
      const kindGenerationAccepted =
        previousKind === undefined
          ? !kindSnapshot.overflow && kindSnapshot.entries.length === 0
          : sameCanonicalDirectoryGeneration(previousKind, kindSnapshot)
      if (!(rootGenerationAccepted && rootEntriesAccepted && kindGenerationAccepted)) {
        return changed()
      }
      try {
        for (const snapshot of layout.kinds.values()) {
          revalidateCanonicalDirectory(snapshot)
        }
      } catch (error) {
        if (error instanceof CanonicalDirectoryChangedError || isCanonicalDirectoryReplacementError(error)) {
          return changed()
        }
        throw error
      }
      layout = {
        kinds: new Map(layout.kinds).set(kind, kindSnapshot),
        root: rootSnapshot,
      }
      authority.assertCurrent()
    },
    acceptPublication: (kind, recordName, rootSnapshot, kindSnapshot, digest, metadata) => {
      try {
        if (layout.root !== rootSnapshot || layout.kinds.get(kind) !== kindSnapshot) {
          return changed()
        }
        revalidateCanonicalDirectory(rootSnapshot)
        const nextKind = captureCanonicalDirectory(kindSnapshot.witness.path, MAX_CANONICAL_KIND_ENTRIES)
        const expectedEntries = [...kindSnapshot.entries, { name: recordName }].sort((first, second) =>
          ordinalStringCompare(first.name, second.name),
        )
        if (!(sameDirectoryGeneration(kindSnapshot, nextKind) && sameEntryNames(expectedEntries, nextKind.entries))) {
          return changed()
        }
        const recordPath = resolve(root, 'encephalon', kind, recordName)
        const pathMetadata = lstatSync(recordPath, { bigint: true })
        if (!sameStableEntryMetadata(metadata, pathMetadata)) {
          return changed()
        }
        observations = [
          ...observations,
          {
            digest,
            metadata: pathMetadata,
            path: recordPath,
          },
        ]
        layout = { kinds: new Map(layout.kinds).set(kind, nextKind), root: rootSnapshot }
        authority.assertCurrent()
      } catch (error) {
        if (isCanonicalDirectoryReplacementError(error)) {
          return changed()
        }
        throw error
      }
    },
    acceptStagingCleanup: () => {
      observations = observations.map(inspectObservation)
      authority.assertCurrent()
    },
    assertCurrent: () => {
      if (cacheLocation !== undefined) {
        assertCacheLocation(cacheLocation)
      }
      assertCanonicalSnapshotCurrent(
        root,
        { bytes: 0, errors: [], layout, observations, records: [], rejections: [] },
        artifactEvidence,
        changed,
        hooks,
      )
      if (cacheLocation !== undefined) {
        assertCacheLocation(cacheLocation)
      }
    },
    changed,
    projection,
    sealCacheSnapshot: (records, artifacts, repositoryRealpath) => {
      authority.assertCurrent()
      const cacheDirectoryMetadata = captureCacheDirectoryMetadata()
      const assertCurrent = () => {
        authority.assertCurrent()
        assertCacheDirectoryMetadataCurrent(cacheDirectoryMetadata)
        authority.assertCurrent()
        assertCacheDirectoryMetadataCurrent(cacheDirectoryMetadata)
      }
      assertCurrent()
      const acceptedArtifacts = [...artifacts]
      const acceptedRecords = [...records]
      Object.freeze(acceptedArtifacts)
      Object.freeze(acceptedRecords)
      return Object.freeze({
        artifacts: acceptedArtifacts,
        assertCurrent,
        manifest: canonicalCacheManifest(
          canonicalRecordCacheManifestEntries(root, layout, observations, cacheDirectoryMetadata),
          acceptedArtifacts,
        ),
        records: acceptedRecords,
        repositoryRealpath,
      })
    },
  }
  return authority
}

const recordPlanningSnapshot = (
  root: string,
  scan: RecordScan,
  hooks: RecordReadHooks = {},
  cacheLocation?: CacheLocation,
  changed: () => never = repositoryChangedBeforePublication,
): RecordPlanningSnapshot => {
  let artifactEvidence: readonly ArtifactInspectionResult[] = []
  let publicationAuthority: CanonicalPublicationAuthority | undefined
  const authority = () => {
    if (scan.layout === undefined) {
      return fail('REPOSITORY_CHANGED', 'Canonical records changed after validation.')
    }
    publicationAuthority ??= canonicalPublicationAuthority(
      root,
      scan.layout,
      scan.observations,
      artifactEvidence,
      cacheLocation,
      changed,
      hooks,
    )
    return publicationAuthority
  }
  const validateFinal = (
    records: readonly BrainRecord[],
    message = 'Canonical records are invalid.',
    bytes?: number,
    allowed?: readonly AllowedMultiHead[],
  ) => {
    const validation = validateScannedSnapshot(
      root,
      {
        ...scan,
        bytes: bytes ?? records.reduce((total, record) => total + canonicalRecordBytes(record), 0),
        records: [...records],
      },
      hooks,
      changed,
    )
    const { artifactEvidence: validatedArtifactEvidence, artifacts: validatedArtifacts } = validation
    assertCanonicalSnapshotCurrent(root, scan, validatedArtifactEvidence, changed, hooks)
    const blockingErrors = (() => {
      if (allowed === undefined) {
        return validation.result.errors
      }
      const allowedIds = allowedMultiHeadRecordIds(records, allowed, hooks)
      return validation.result.errors.filter(
        error =>
          !(error.code === 'MULTIPLE_ACTIVE_HEADS' && error.recordId !== undefined && allowedIds.has(error.recordId)),
      )
    })()
    if (blockingErrors.length === 0) {
      artifactEvidence = validatedArtifactEvidence
      return validatedArtifacts
    }
    return fail('VALIDATION_FAILED', message, {
      errors: blockingErrors.map(error => ({
        code: error.code,
        message: error.message,
      })),
    })
  }
  return Object.freeze({
    authority,
    bytes: scan.bytes,
    errors: Object.freeze([...scan.errors]),
    records: freezeAcceptedRecords(scan.records),
    sealCacheSnapshot: (records, artifacts, repositoryRealpath) =>
      authority().sealCacheSnapshot(records, artifacts, repositoryRealpath),
    validateFinal,
  })
}

/** @internal */
type RecordPlanningSnapshotRetryRunner = Readonly<{
  close: () => void
  run: <Result>(operation: (planning: RecordPlanningSnapshot, repositoryChanged: boolean) => Result) => Result
}>

const createRecordPlanningSnapshotRetryResolved = (
  root: string,
  hooks: RecordReadHooks = {},
  cacheLocation?: CacheLocation,
): RecordPlanningSnapshotRetryRunner => {
  let ledger: CanonicalSnapshotRetryLedger | undefined
  let retryable = true
  const changed = (): never => {
    if (retryable) {
      return canonicalGenerationChanged()
    }
    return repositoryChangedBeforePublication()
  }
  const close = () => {
    retryable = false
  }
  const run = <Result>(operation: (planning: RecordPlanningSnapshot, repositoryChanged: boolean) => Result) => {
    const currentLedger = ledger ?? createCanonicalSnapshotRetryLedger(hooks.now)
    ledger = currentLedger
    return withCanonicalSnapshotRetry(
      () =>
        operation(
          recordPlanningSnapshot(root, readCanonicalPlanningScanAttempt(root, hooks), hooks, cacheLocation, changed),
          currentLedger.repositoryChanged,
        ),
      currentLedger,
    )
  }
  return Object.freeze({ close, run })
}

/** @internal */
export const withRecordPlanningSnapshotRetryResolved = <Result>(
  root: string,
  operation: (planning: RecordPlanningSnapshot, repositoryChanged: boolean) => Result,
  hooks: RecordReadHooks = {},
  cacheLocation?: CacheLocation,
): Result => {
  const runner = createRecordPlanningSnapshotRetryResolved(root, hooks, cacheLocation)
  try {
    return runner.run(operation)
  } finally {
    runner.close()
  }
}

/** @internal */
export type ValidatedCanonicalSnapshotRetryRunner = Readonly<{
  close: () => void
  run: <Result>(operation: (snapshot: ValidatedCanonicalSnapshot) => Result) => Result
}>

/** @internal */
export const createValidatedCanonicalSnapshotRetryResolved = (
  root: string,
  cacheLocation: CacheLocation,
  hooks: RecordReadHooks = {},
): ValidatedCanonicalSnapshotRetryRunner => {
  const runner = createRecordPlanningSnapshotRetryResolved(root, hooks, cacheLocation)
  const run = <Result>(operation: (snapshot: ValidatedCanonicalSnapshot) => Result) =>
    runner.run(planning => {
      const artifacts = planning.validateFinal(planning.records, 'Canonical records are invalid.', planning.bytes)
      return operation(planning.sealCacheSnapshot(planning.records, artifacts, cacheLocation.repository))
    })
  return Object.freeze({ close: runner.close, run })
}

/** @internal */
export const readValidatedCanonicalSnapshotAttemptResolved = (
  root: string,
  cacheLocation: CacheLocation,
  assertExpectedCurrent: () => void,
  hooks: RecordReadHooks = {},
) => {
  assertExpectedCurrent()
  const scan = readCanonicalPlanningScanAttempt(root, hooks)
  assertExpectedCurrent()
  const planning = recordPlanningSnapshot(root, scan, hooks, cacheLocation, canonicalGenerationChanged)
  const artifacts = planning.validateFinal(planning.records, 'Canonical records are invalid.', planning.bytes)
  return planning.sealCacheSnapshot(planning.records, artifacts, cacheLocation.repository)
}

/** @internal */
export const readRecordsResolved = (root: string, hooks: RecordReadHooks = {}, allowed?: AllowedMultiHead[]) =>
  freezeAcceptedRecords(readRecordScanResolved(root, hooks, allowed).scan.records)

/** @internal */
export const readValidatedRecordSnapshotResolved = (
  root: string,
  hooks: RecordReadHooks = {},
  allowed?: AllowedMultiHead[],
) => {
  const validated = readRecordScanResolved(root, hooks, allowed)
  return Object.freeze({
    artifacts: validated.artifacts,
    records: freezeAcceptedRecords(validated.scan.records),
  })
}

/** @internal */
export const readRecordSnapshotResolved = (
  root: string,
  hooks: RecordReadHooks = {},
  allowed?: AllowedMultiHead[],
  cacheLocation?: CacheLocation,
) => {
  const { artifactEvidence, scan } = readRecordScanResolved(root, hooks, allowed)
  if (scan.layout === undefined) {
    return fail('REPOSITORY_CHANGED', 'Canonical records changed after validation.')
  }
  return {
    authority: canonicalPublicationAuthority(root, scan.layout, scan.observations, artifactEvidence, cacheLocation),
    records: freezeAcceptedRecords(scan.records),
  }
}

/** @internal */
export const readRecords = (input: RootInput = {}) => readRecordsResolved(resolveRepository(input))

/** @internal */
export const readRecordsAllowingGeneratedMultiHeads = (input: RootInput, allowed: AllowedMultiHead[]) =>
  readRecordsResolved(resolveRepository(input), {}, allowed)

/** @internal */
export const planRecordAddition = (root: string, recordFile: BrainRecordFile): PlannedRecord => {
  const relativePath = `encephalon/${recordFile.kind}/${recordFile.id}.json`
  const path = resolve(root, ...relativePath.split('/'))
  if (existsSync(path)) {
    return fail('RECORD_EXISTS', `Record ${recordFile.id} already exists.`, {
      path: relativePath,
    })
  }
  const record: BrainRecord = { ...recordFile, path: relativePath }
  return {
    formatted: formatRecordFile(recordFile),
    path,
    record,
    recordFile,
    relativePath,
  }
}

const MAX_CREATED_AT_MILLISECONDS = Date.parse('9999-12-31T23:59:59.999Z')

/** @internal */
export const nextRecordCreatedAt = (records: readonly Pick<BrainRecordFile, 'createdAt'>[], now = Date.now()) => {
  const latest = records.reduce(
    (maximum, record) => Math.max(maximum, Date.parse(record.createdAt)),
    Number.NEGATIVE_INFINITY,
  )
  const next = Math.max(now, latest + 1)
  if (next > MAX_CREATED_AT_MILLISECONDS) {
    return fail('VALIDATION_FAILED', 'Canonical record history has no later representable creation timestamp.')
  }
  return new Date(next).toISOString()
}

/** @internal */
export const assertRecordGraph = (
  root: string,
  records: BrainRecord[],
  message = 'Canonical records are invalid.',
  hooks: RecordReadHooks = {},
  bytes?: number,
) => {
  const result = preserveWorkObserverFailure(() =>
    validateScanned(
      root,
      {
        bytes: bytes ?? records.reduce((total, record) => total + canonicalRecordBytes(record), 0),
        errors: [],
        observations: [],
        records,
        rejections: [],
      },
      hooks,
    ),
  )
  if (result.valid) {
    return
  }
  return fail('VALIDATION_FAILED', message, {
    errors: result.errors.map(error => ({
      code: error.code,
      message: error.message,
    })),
  })
}

const repositoryChangedBeforePublicationError = () =>
  new CanonicalRepositoryChangedError('REPOSITORY_CHANGED', 'Canonical layout changed before publication.')

const repositoryChangedBeforePublication = (): never => {
  throw repositoryChangedBeforePublicationError()
}

/** @internal */
export const rethrowInvalidatedCandidateError = (error: unknown, repositoryChanged: boolean): never => {
  if (repositoryChanged && error instanceof EncephalonError && error.code === 'VALIDATION_FAILED') {
    return repositoryChangedBeforePublication()
  }
  throw error
}

/** @internal */
export const projectedKindDirectoryOverflow = (
  witnessedEntryCounts: ReadonlyMap<string, number>,
  plannedKinds: readonly string[],
) => {
  const plannedEntryCounts = plannedKinds.reduce((counts, kind) => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    return counts
  }, new Map<string, number>())
  return (
    [...plannedEntryCounts.entries()]
      .sort(([first], [second]) => ordinalStringCompare(first, second))
      .find(
        ([kind, additions]) => (witnessedEntryCounts.get(kind) ?? 0) + additions > MAX_CANONICAL_KIND_ENTRIES,
      )?.[0] ?? null
  )
}

/** @internal */
export const assertCanonicalLayoutAdditions = (
  kinds: readonly string[],
  authority: CanonicalPublicationAuthority,
): CanonicalPublicationAuthority => {
  authority.assertCurrent()
  const current = authority.projection()
  const additions = new Set([STAGING_DIRECTORY_NAME, ...kinds].filter(name => !current.rootNames.has(name)))
  if (current.rootNames.size + additions.size > MAX_CANONICAL_BRAIN_ROOT_ENTRIES) {
    return fail('VALIDATION_FAILED', 'Canonical layout additions would exceed directory limits.', {
      errors: [directoryEntryLimitIssue('encephalon', MAX_CANONICAL_BRAIN_ROOT_ENTRIES)],
    })
  }
  const addedKinds = [...new Set(kinds)].filter(kind => !current.rootNames.has(kind)).length
  if (current.kindCount + addedKinds > MAX_CANONICAL_KIND_DIRECTORIES) {
    return fail('VALIDATION_FAILED', 'Canonical layout additions would exceed directory limits.', {
      errors: [directoryEntryLimitIssue('encephalon', MAX_CANONICAL_KIND_DIRECTORIES, 'kind directories')],
    })
  }
  const overflowingKind = projectedKindDirectoryOverflow(current.kindEntryCounts, kinds)
  if (overflowingKind !== null) {
    return fail('VALIDATION_FAILED', 'Canonical layout additions would exceed directory limits.', {
      errors: [directoryEntryLimitIssue(`encephalon/${overflowingKind}`, MAX_CANONICAL_KIND_ENTRIES)],
    })
  }
  authority.assertCurrent()
  return authority
}

type PublishResult = {
  assertCommittedCurrent: () => void
  committedError?: EncephalonError
  committedErrorPhase?: PostCommitPhase
  record: BrainRecord
}

const revalidatePublicationDirectories = (
  directories: readonly DirectoryWitness[],
  changed: () => never = repositoryChangedBeforePublication,
) => {
  try {
    for (const directory of directories) {
      revalidateDirectoryWitness(directory)
    }
  } catch (error) {
    if (error instanceof DirectoryWitnessError || isCanonicalDirectoryReplacementError(error)) {
      return changed()
    }
    throw error
  }
}

const publishPlannedRecordInternal = (
  root: string,
  plan: PlannedRecord,
  options: { authority: CanonicalPublicationAuthority; hooks?: RecordWriteHooks },
): PublishResult => {
  options.authority.assertCurrent()
  fault(options.hooks, 'before-directory-preparation')
  options.authority.assertCurrent()
  const { formatted, path, record, recordFile, relativePath } = plan
  const brainDirectory = resolve(root, 'encephalon')
  const projection = options.authority.projection()
  if (projection.rootNames.has(STAGING_DIRECTORY_NAME)) {
    cleanupStaleStagingEntries(resolve(brainDirectory, STAGING_DIRECTORY_NAME), {
      afterPreflight: () => fault(options.hooks, 'after-staging-cleanup-preflight'),
      afterQuarantine: () => fault(options.hooks, 'after-staging-cleanup-quarantine'),
      beforeEmptyProbe: () => fault(options.hooks, 'before-staging-cleanup-empty-probe'),
      beforeEntryLstat: () => fault(options.hooks, 'before-staging-cleanup-entry-lstat'),
      beforeFlush: () => fault(options.hooks, 'during-staging-cleanup-flush'),
      beforeQuarantine: () => fault(options.hooks, 'before-staging-cleanup-quarantine'),
    })
    options.authority.acceptStagingCleanup()
    options.authority.assertCurrent()
  }
  options.authority.assertCurrent()
  const createdRoot = ensurePublicationDirectory(root, brainDirectory, projection.rootExists, options.authority.changed)
  const kindDirectory = resolve(brainDirectory, recordFile.kind)
  const createdKind = ensurePublicationDirectory(
    root,
    kindDirectory,
    projection.rootNames.has(recordFile.kind),
    options.authority.changed,
  )
  const stagingDirectory = resolve(brainDirectory, STAGING_DIRECTORY_NAME)
  const createdStaging = ensurePublicationDirectory(
    root,
    stagingDirectory,
    projection.rootNames.has(STAGING_DIRECTORY_NAME),
    options.authority.changed,
  )
  fault(options.hooks, 'before-publication-directory-capture')
  const publicationRoot = capturePreparedPublicationDirectory(
    resolve(root, 'encephalon'),
    MAX_CANONICAL_BRAIN_ROOT_ENTRIES,
    options.authority.changed,
  )
  const publicationKind = capturePreparedPublicationDirectory(
    kindDirectory,
    MAX_CANONICAL_KIND_ENTRIES,
    options.authority.changed,
  )
  const publicationStaging = capturePreparedPublicationDirectoryWitness(stagingDirectory, options.authority.changed)
  assertCreatedPublicationDirectory(createdRoot, publicationRoot.witness, options.authority.changed)
  assertCreatedPublicationDirectory(createdKind, publicationKind.witness, options.authority.changed)
  assertCreatedPublicationDirectory(createdStaging, publicationStaging, options.authority.changed)
  options.authority.acceptPreparation(recordFile.kind, publicationRoot, publicationKind)
  const stagingName = createOwnedStagingName(process.pid, randomUUID())
  const stagingPath = resolve(stagingDirectory, stagingName)
  let published = false
  let operationFailed = false
  let cleanupError: unknown
  let committedError: EncephalonError | undefined
  let committedErrorPhase: PostCommitPhase | undefined
  let descriptor: number | undefined
  let descriptorMetadata: BigIntStats | undefined
  let finalStagingRevalidationSucceeded = false
  let postCleanupStagingWitness: DirectoryWitness | undefined
  let publicationAccepted = false
  let publicationAcceptanceAttempted = false
  let stagingWitness: DirectoryWitness | undefined
  const capturePostCommitError = (phase: PostCommitPhase, error: unknown) => {
    if (committedErrorPhase === undefined || postCommitPriority[phase] > postCommitPriority[committedErrorPhase]) {
      committedError = postCommitError(record, phase, error)
      committedErrorPhase = phase
    }
  }
  const capturePublicationVerificationError = (error: unknown) => {
    if (
      committedErrorPhase === undefined ||
      postCommitPriority.publicationVerification > postCommitPriority[committedErrorPhase]
    ) {
      committedError = classifyPublicationVerificationError(record, error)
      committedErrorPhase = 'publicationVerification'
    }
  }
  const acceptCurrentPublication = (currentDescriptor: number) => {
    assertCanonicalPublicationIdentity(path, currentDescriptor)
    options.authority.acceptPublication(
      recordFile.kind,
      `${recordFile.id}.json`,
      publicationRoot,
      publicationKind,
      recordDigest(formatted),
      fstatSync(currentDescriptor, { bigint: true }),
    )
    publicationAccepted = true
    fault(options.hooks, 'after-publication-accept')
    assertCanonicalPublicationIdentity(path, currentDescriptor)
  }
  try {
    revalidatePublicationDirectories([publicationStaging], options.authority.changed)
    assertPreparedPublicationDirectory(root, stagingDirectory, options.authority.changed)
    descriptor = openSync(stagingPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag, 0o644)
    fault(options.hooks, 'during-staging-write')
    writeFileSync(descriptor, formatted, 'utf8')
    fsyncSync(descriptor)
    descriptorMetadata = fstatSync(descriptor, { bigint: true })
    if (!descriptorMetadata.isFile()) {
      return options.authority.changed()
    }
    stagingWitness = inspectCurrentStagingFile(stagingDirectory, stagingName, descriptorMetadata)
    if (!samePublicationDirectoryIdentity(publicationStaging, stagingWitness)) {
      return options.authority.changed()
    }
    fault(options.hooks, 'before-publication')
    options.authority.assertCurrent()
    revalidatePublicationDirectories([stagingWitness], options.authority.changed)
    assertPreparedPublicationDirectory(root, kindDirectory, options.authority.changed)
    assertPreparedPublicationDirectory(root, stagingDirectory, options.authority.changed)
    try {
      fault(options.hooks, 'before-canonical-link')
      linkSync(stagingPath, path)
      published = true
      try {
        fault(options.hooks, 'after-canonical-link')
        revalidatePublicationDirectories([stagingWitness], options.authority.changed)
        const linkedStagingMetadata = lstatSync(stagingPath, { bigint: true })
        const linkedDescriptorMetadata = fstatSync(descriptor, { bigint: true })
        if (!sameStableEntryMetadata(linkedDescriptorMetadata, linkedStagingMetadata)) {
          throw new CanonicalPublicationIdentityError('The staged path does not identify the staged descriptor.')
        }
        assertCanonicalPublicationIdentity(path, descriptor)
      } catch (error) {
        throw classifyPublicationVerificationError(record, error)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail('RECORD_EXISTS', `Record ${recordFile.id} already exists.`, {
          path: relativePath,
        })
      }
      if (isCanonicalDirectoryReplacementError(error)) {
        return options.authority.changed()
      }
      throw error
    }
    try {
      fault(options.hooks, 'after-publication')
      fault(options.hooks, 'during-publication-flush')
      fsyncDirectory(kindDirectory)
    } catch (error) {
      capturePostCommitError('publicationFlush', error)
    }
  } catch (error) {
    if (published) {
      if (error instanceof EncephalonError && error.details.canonicalCommitted === true) {
        if (
          committedErrorPhase === undefined ||
          postCommitPriority.publicationVerification > postCommitPriority[committedErrorPhase]
        ) {
          committedError = error
          committedErrorPhase = 'publicationVerification'
        }
      } else {
        capturePublicationVerificationError(error)
      }
    } else {
      operationFailed = true
      throw error
    }
  } finally {
    let descriptorCloseError: unknown
    if (descriptor !== undefined && (operationFailed || !published)) {
      try {
        closeSync(descriptor)
      } catch (error) {
        descriptorCloseError = error
      }
      descriptor = undefined
    }
    let stagingCleanupFault: unknown
    if (published && committedErrorPhase !== 'publicationVerification' && descriptor !== undefined) {
      publicationAcceptanceAttempted = true
      try {
        acceptCurrentPublication(descriptor)
      } catch (error) {
        capturePublicationVerificationError(error)
      }
    }
    try {
      fault(options.hooks, 'during-cleanup')
    } catch (error) {
      stagingCleanupFault = error
    }
    if (descriptorCloseError !== undefined && !operationFailed) {
      cleanupError = descriptorCloseError
    }
    if (stagingCleanupFault === undefined && descriptorCloseError === undefined) {
      try {
        fault(options.hooks, 'before-final-publication-revalidation')
        revalidateCanonicalDirectory(publicationRoot)
        if (stagingWitness !== undefined) {
          revalidatePublicationDirectories([stagingWitness], options.authority.changed)
        }
        if (
          published &&
          committedErrorPhase === 'publicationVerification' &&
          descriptor !== undefined &&
          !publicationAcceptanceAttempted
        ) {
          publicationAcceptanceAttempted = true
          acceptCurrentPublication(descriptor)
          if (stagingWitness !== undefined) {
            revalidatePublicationDirectories([stagingWitness], options.authority.changed)
          }
        }
        finalStagingRevalidationSucceeded = committedErrorPhase !== 'publicationVerification' || publicationAccepted
      } catch (error) {
        if (published) {
          capturePublicationVerificationError(error)
        } else if (!operationFailed) {
          cleanupError = error
        }
      }
    } else if (published) {
      capturePostCommitError('stagingCleanup', stagingCleanupFault)
    } else if (!operationFailed) {
      cleanupError = stagingCleanupFault
    }
    if (
      stagingCleanupFault === undefined &&
      (committedErrorPhase !== 'publicationVerification' || finalStagingRevalidationSucceeded) &&
      cleanupError === undefined
    ) {
      try {
        if (descriptorMetadata !== undefined) {
          const cleanupMetadata =
            descriptor === undefined ? descriptorMetadata : fstatSync(descriptor, { bigint: true })
          postCleanupStagingWitness = cleanupOwnedStagingEntry(stagingDirectory, stagingName, cleanupMetadata, {
            afterQuarantine: () => fault(options.hooks, 'after-staging-cleanup-quarantine'),
            beforeEmptyProbe: () => fault(options.hooks, 'before-staging-cleanup-empty-probe'),
            beforeEntryLstat: () => fault(options.hooks, 'before-staging-cleanup-entry-lstat'),
            beforeFlush: () => fault(options.hooks, 'during-staging-cleanup-flush'),
            beforeQuarantine: () => fault(options.hooks, 'before-staging-cleanup-quarantine'),
          })
        }
      } catch (error) {
        if (published) {
          if (error instanceof EncephalonError && error.code === 'REPOSITORY_CHANGED') {
            capturePublicationVerificationError(error)
          } else {
            capturePostCommitError('stagingCleanup', error)
          }
        } else if (!operationFailed) {
          cleanupError = error
        }
      }
    }
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  if (publicationAccepted && descriptor !== undefined && postCleanupStagingWitness !== undefined) {
    try {
      assertCanonicalPublicationIdentity(path, descriptor)
      assertStagingEmpty(postCleanupStagingWitness)
    } catch (error) {
      capturePublicationVerificationError(error)
    }
  } else if (
    committedErrorPhase !== 'publicationVerification' &&
    descriptor !== undefined &&
    postCleanupStagingWitness !== undefined
  ) {
    try {
      assertStagingEmpty(postCleanupStagingWitness)
      publicationAcceptanceAttempted = true
      acceptCurrentPublication(descriptor)
      assertStagingEmpty(postCleanupStagingWitness)
    } catch (error) {
      capturePublicationVerificationError(error)
    }
  } else if (committedErrorPhase === undefined && descriptor !== undefined) {
    committedError = publicationVerificationError(record)
    committedErrorPhase = 'publicationVerification'
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor)
    } catch (error) {
      capturePostCommitError('publicationVerification', error)
    }
    descriptor = undefined
  }
  if (publicationAccepted) {
    try {
      options.authority.acceptStagingCleanup()
    } catch (error) {
      capturePublicationVerificationError(error)
    }
  }
  const assertCommittedCurrent = () => {
    options.authority.assertCurrent()
  }
  return {
    assertCommittedCurrent,
    record,
    ...(committedError === undefined ? {} : { committedError }),
    ...(committedErrorPhase === undefined ? {} : { committedErrorPhase }),
  }
}

/** @internal */
export const publishPlannedRecordOutcome = (
  root: string,
  plan: PlannedRecord,
  options: { authority: CanonicalPublicationAuthority; hooks?: RecordWriteHooks },
): PublishResult => publishPlannedRecordInternal(root, plan, options)

const addRecordFileResolved = (
  root: string,
  recordDraft: ValidatedAddRecordInput,
  options: AddRecordOptions = {},
): BrainRecord => {
  if (options.cacheLocation !== undefined) {
    assertCacheLocation(options.cacheLocation)
  }
  const relativePath = `encephalon/${recordDraft.kind}/${recordDraft.id}.json`
  const path = resolve(root, ...relativePath.split('/'))
  if (existsSync(path)) {
    return fail('RECORD_EXISTS', `Record ${recordDraft.id} already exists.`, {
      path: relativePath,
    })
  }

  return withRecordPlanningSnapshotRetryResolved(
    root,
    (planning, repositoryChanged) => {
      if (planning.errors.length > 0) {
        return rethrowInvalidatedCandidateError(
          new EncephalonError('VALIDATION_FAILED', 'Existing canonical records are invalid.', {
            errors: planning.errors.map(error => ({
              code: error.code,
              message: error.message,
            })),
          }),
          repositoryChanged,
        )
      }
      const validationPlan = planRecordAddition(root, createRecordFile(recordDraft, '2000-01-01T00:00:00.000Z'))
      const artifacts = (() => {
        try {
          return planning.validateFinal(
            [...planning.records, validationPlan.record],
            'The new record would make canonical records invalid.',
            planning.bytes + Buffer.byteLength(validationPlan.formatted, 'utf8'),
          )
        } catch (error) {
          return rethrowInvalidatedCandidateError(error, repositoryChanged)
        }
      })()
      if (options.cacheLocation !== undefined) {
        assertCacheLocation(options.cacheLocation)
      }
      const plan = planRecordAddition(root, createRecordFile(recordDraft, nextRecordCreatedAt(planning.records)))
      fault(options.hooks, 'after-scan-validation')
      const authority = (() => {
        try {
          return assertCanonicalLayoutAdditions([plan.record.kind], planning.authority())
        } catch (error) {
          return rethrowInvalidatedCandidateError(error, repositoryChanged)
        }
      })()

      const publishOptions = {
        authority,
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      }
      const published = publishPlannedRecordInternal(root, plan, publishOptions)
      let { committedError, committedErrorPhase } = published
      const capturePostCommitError = (phase: PostCommitPhase, error: unknown) => {
        const capturedPhase = error instanceof CanonicalGenerationChanged ? 'publicationVerification' : phase
        if (
          committedErrorPhase === undefined ||
          postCommitPriority[capturedPhase] > postCommitPriority[committedErrorPhase]
        ) {
          committedError =
            error instanceof CanonicalGenerationChanged
              ? publicationVerificationError(published.record)
              : postCommitError(published.record, capturedPhase, error)
          committedErrorPhase = capturedPhase
        }
      }
      if (committedErrorPhase !== 'publicationFlush' && options.hydrate !== false) {
        try {
          fault(options.hooks, 'during-hydration')
          if (options.cacheLocation === undefined || committedErrorPhase !== undefined) {
            const cacheLocation = options.cacheLocation ?? inspectCacheLocation(root)
            const snapshot = readValidatedCanonicalSnapshotAttemptResolved(
              root,
              cacheLocation,
              published.assertCommittedCurrent,
              options.readHooks,
            )
            hydrateResolvedCanonicalSnapshot(root, snapshot, 'held', cacheLocation)
          } else {
            const snapshot = planning.sealCacheSnapshot(
              [...planning.records, published.record],
              artifacts,
              options.cacheLocation.repository,
            )
            hydrateResolvedCanonicalSnapshot(root, snapshot, 'held', options.cacheLocation)
          }
        } catch (error) {
          capturePostCommitError('cacheHydration', error)
        }
      }
      if (committedError !== undefined) {
        throw committedError
      }
      return published.record
    },
    options.readHooks,
    options.cacheLocation,
  )
}

/** @internal */
export const addRecordResolved = (root: string, input: AddRecordInput, options: AddRecordOptions = {}): BrainRecord =>
  addRecordFileResolved(root, validateAddRecordInput(input), options)

export const addRecord = (input: AddRecordInput): BrainRecord => {
  const parsed = parseAddRecordInput(input)
  const root = resolveRepository(parsed)
  try {
    recordWriteTestHooks.beforeOperationLock?.()
    return withOperationLock(root, cacheLocation => {
      recordWriteTestHooks.afterOperationLock?.()
      return addRecordFileResolved(root, parsed.recordDraft, {
        cacheLocation,
        hooks: recordWriteTestHooks,
        readHooks: recordWriteTestHooks.readHooks,
      })
    })
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to add the Encephalon record.', error)
  }
}

/** @internal */
export const canonicalRecordPath = (record: BrainRecordFile) =>
  join('encephalon', record.kind, `${basename(record.id)}.json`).replaceAll('\\', '/')
