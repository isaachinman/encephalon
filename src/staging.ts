import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  captureCanonicalDirectory,
  collectBoundedDirectoryEntries,
  isCanonicalDirectoryReplacementError,
  STAGING_DIRECTORY_NAME,
} from './canonical-layout.ts'
import {
  captureDirectoryWitness,
  type DirectoryWitness,
  DirectoryWitnessError,
  revalidateDirectoryWitness,
} from './directory-witness.ts'
import { fail } from './errors.ts'
import { sameEntryIdentity, sameStableEntryMetadata } from './filesystem-entry.ts'

/** @internal */
export const MAX_STAGING_DIRECTORY_ENTRIES = 1000

const STAGING_RELATIVE_PATH = `encephalon/${STAGING_DIRECTORY_NAME}`
const OWNED_STAGING_NAME =
  /^record-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u
const directoryFlag = constants.O_DIRECTORY ?? 0
const noFollowFlag = constants.O_NOFOLLOW ?? 0

type StagingCleanupHooks = {
  afterQuarantine?: (() => void) | undefined
  afterPreflight?: (() => void) | undefined
  beforeEntryLstat?: (() => void) | undefined
  beforeFlush?: (() => void) | undefined
  beforeQuarantine?: (() => void) | undefined
}

type StagingEntry = {
  metadata: BigIntStats
  name: string
}

/** @internal */
export const parseOwnedStagingName = (name: string) => {
  const match = OWNED_STAGING_NAME.exec(name)
  if (match === null) {
    return
  }
  const pid = Number(match[1])
  if (!(Number.isSafeInteger(pid) && String(pid) === match[1])) {
    return
  }
  return { pid, uuid: match[2] as string }
}

/** @internal */
export const createOwnedStagingName = (pid: number, uuid: string) => `record-${pid}-${uuid}.tmp`

/** @internal */
export const stagingTestHooks: { fsyncDirectory?: ((descriptor: number) => void) | undefined } = {}

const stagingValidationFailure = (code: string, message: string): never =>
  fail('VALIDATION_FAILED', 'Staging recovery requires manual intervention.', {
    errors: [{ code, message, path: STAGING_RELATIVE_PATH }],
  })

const invalidStagingLayout = (): never =>
  stagingValidationFailure(
    'INVALID_STAGING_LAYOUT',
    `Encephalon cannot safely recover every entry in ${STAGING_RELATIVE_PATH}. Remove unrecognised entries from ${STAGING_RELATIVE_PATH} and retry.`,
  )

const stagingEntryLimit = (): never =>
  stagingValidationFailure(
    'STAGING_DIRECTORY_ENTRY_LIMIT',
    `${STAGING_RELATIVE_PATH} may contain at most ${MAX_STAGING_DIRECTORY_ENTRIES} entries. Remove excess or unrecognised entries from ${STAGING_RELATIVE_PATH} and retry.`,
  )

const repositoryChanged = (): never => fail('REPOSITORY_CHANGED', 'Canonical layout changed before publication.')

const isPermittedStagingType = (metadata: BigIntStats) => metadata.isFile() || metadata.isSymbolicLink()

const mapReplacement = <Value>(operation: () => Value): Value => {
  try {
    return operation()
  } catch (error) {
    if (error instanceof DirectoryWitnessError || isCanonicalDirectoryReplacementError(error)) {
      return repositoryChanged()
    }
    throw error
  }
}

const sameDirectoryIdentity = (first: DirectoryWitness, second: DirectoryWitness) =>
  first.path === second.path &&
  first.canonicalPath === second.canonicalPath &&
  sameEntryIdentity(first.pathMetadata, second.pathMetadata) &&
  sameEntryIdentity(first.canonicalMetadata, second.canonicalMetadata)

const captureNextGeneration = (current: DirectoryWitness) => {
  const next = mapReplacement(() => captureDirectoryWitness(current.path, { allowLink: false }))
  if (!sameDirectoryIdentity(current, next)) {
    return repositoryChanged()
  }
  return next
}

const inspectStagingEntry = (stagingDirectory: string, name: string): StagingEntry => {
  if (parseOwnedStagingName(name) === undefined) {
    return invalidStagingLayout()
  }
  const metadata = mapReplacement(() => lstatSync(resolve(stagingDirectory, name), { bigint: true }))
  if (!isPermittedStagingType(metadata)) {
    return invalidStagingLayout()
  }
  return { metadata, name }
}

const sameRecoveredRegularEntry = (expected: BigIntStats, current: BigIntStats) =>
  expected.isFile() &&
  current.isFile() &&
  sameEntryIdentity(expected, current) &&
  expected.size === current.size &&
  expected.mode === current.mode &&
  expected.birthtimeNs === current.birthtimeNs &&
  expected.mtimeNs === current.mtimeNs

const sameRecoveredSymbolicLink = (expected: BigIntStats, current: BigIntStats) =>
  expected.isSymbolicLink() &&
  current.isSymbolicLink() &&
  sameEntryIdentity(expected, current) &&
  expected.size === current.size &&
  expected.mode === current.mode &&
  expected.birthtimeNs === current.birthtimeNs &&
  expected.mtimeNs === current.mtimeNs

const lstatIfExists = (path: string) => {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
}

const restoreQuarantinedEntry = (
  sourcePath: string,
  quarantinePath: string,
  witness: DirectoryWitness,
  quarantineMetadata: BigIntStats,
) => {
  try {
    revalidateDirectoryWitness(witness)
    const source = lstatIfExists(sourcePath)
    const quarantine = lstatIfExists(quarantinePath)
    if (source === undefined && quarantine !== undefined && sameStableEntryMetadata(quarantineMetadata, quarantine)) {
      renameSync(quarantinePath, sourcePath)
    }
  } catch {
    // Keep the verified quarantine entry recoverable rather than deleting an uncertain path.
  }
}

const quarantineStagingEntry = (
  stagingDirectory: string,
  entry: StagingEntry,
  witness: DirectoryWitness,
  hooks: StagingCleanupHooks,
) => {
  const sourcePath = resolve(stagingDirectory, entry.name)
  let descriptor: number | undefined
  let result: DirectoryWitness | undefined
  let primaryError: unknown
  try {
    mapReplacement(() => revalidateDirectoryWitness(witness))
    hooks.beforeEntryLstat?.()
    const current = mapReplacement(() => lstatSync(sourcePath, { bigint: true }))
    const regular = current.isFile()
    if (regular) {
      descriptor = mapReplacement(() => openSync(sourcePath, constants.O_RDONLY | noFollowFlag))
      const descriptorMetadata = fstatSync(descriptor, { bigint: true })
      if (
        !(
          sameRecoveredRegularEntry(entry.metadata, descriptorMetadata) &&
          sameStableEntryMetadata(current, descriptorMetadata)
        )
      ) {
        return repositoryChanged()
      }
    } else if (!(current.isSymbolicLink() && sameStableEntryMetadata(entry.metadata, current))) {
      return repositoryChanged()
    }
    mapReplacement(() => revalidateDirectoryWitness(witness))
    hooks.beforeQuarantine?.()
    const afterHook = mapReplacement(() => lstatSync(sourcePath, { bigint: true }))
    const sourceAccepted = regular
      ? descriptor !== undefined && sameStableEntryMetadata(afterHook, fstatSync(descriptor, { bigint: true }))
      : sameStableEntryMetadata(current, afterHook)
    if (!sourceAccepted) {
      return repositoryChanged()
    }
    mapReplacement(() => revalidateDirectoryWitness(witness))
    const quarantinePath = resolve(stagingDirectory, `.${entry.name}.${randomUUID()}.quarantine`)
    mapReplacement(() => renameSync(sourcePath, quarantinePath))
    const nextWitness = captureNextGeneration(witness)
    const moved = mapReplacement(() => lstatSync(quarantinePath, { bigint: true }))
    const movedAccepted = regular
      ? descriptor !== undefined &&
        sameRecoveredRegularEntry(entry.metadata, moved) &&
        sameStableEntryMetadata(moved, fstatSync(descriptor, { bigint: true }))
      : sameRecoveredSymbolicLink(entry.metadata, moved)
    if (!movedAccepted) {
      restoreQuarantinedEntry(sourcePath, quarantinePath, nextWitness, moved)
      return repositoryChanged()
    }
    hooks.afterQuarantine?.()
    mapReplacement(() => revalidateDirectoryWitness(nextWitness))
    const currentQuarantine = mapReplacement(() => lstatSync(quarantinePath, { bigint: true }))
    const quarantineAccepted = regular
      ? descriptor !== undefined && sameStableEntryMetadata(currentQuarantine, fstatSync(descriptor, { bigint: true }))
      : currentQuarantine.isSymbolicLink() && sameStableEntryMetadata(moved, currentQuarantine)
    if (!quarantineAccepted) {
      return repositoryChanged()
    }
    mapReplacement(() => revalidateDirectoryWitness(nextWitness))
    mapReplacement(() => unlinkSync(quarantinePath))
    result = captureNextGeneration(nextWitness)
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
    throw primaryError
  }
  if (closeError !== undefined) {
    throw closeError
  }
  return result as DirectoryWitness
}

export const inspectCurrentStagingFile = (stagingDirectory: string, name: string, descriptorMetadata: BigIntStats) => {
  const snapshot = mapReplacement(() => captureCanonicalDirectory(stagingDirectory, 1))
  if (snapshot.overflow || snapshot.entries.length !== 1 || snapshot.entries[0]?.name !== name) {
    return repositoryChanged()
  }
  const pathMetadata = mapReplacement(() => lstatSync(resolve(stagingDirectory, name), { bigint: true }))
  if (!(pathMetadata.isFile() && sameStableEntryMetadata(pathMetadata, descriptorMetadata))) {
    return repositoryChanged()
  }
  return snapshot.witness
}

/** @internal */
export const cleanupOwnedStagingEntry = (
  stagingDirectory: string,
  name: string,
  metadata: BigIntStats,
  hooks: StagingCleanupHooks = {},
) => {
  const witness = mapReplacement(() => captureDirectoryWitness(stagingDirectory, { allowLink: false }))
  const nextWitness = quarantineStagingEntry(stagingDirectory, { metadata, name }, witness, hooks)
  hooks.beforeFlush?.()
  mapReplacement(() => revalidateDirectoryWitness(nextWitness))
  mapReplacement(() => fsyncDirectory(nextWitness))
}

const fsyncDirectory = (witness: DirectoryWitness) => {
  if (process.platform !== 'win32') {
    let descriptor: number | undefined
    let primaryError: unknown
    try {
      descriptor = openSync(witness.canonicalPath, constants.O_RDONLY | directoryFlag | noFollowFlag)
      const metadata = fstatSync(descriptor, { bigint: true })
      if (!sameStableEntryMetadata(metadata, witness.canonicalMetadata)) {
        return repositoryChanged()
      }
      if (stagingTestHooks.fsyncDirectory === undefined) {
        fsyncSync(descriptor)
      } else {
        stagingTestHooks.fsyncDirectory(descriptor)
      }
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM') {
        primaryError = error
      }
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
      throw primaryError
    }
    if (closeError !== undefined) {
      throw closeError
    }
  }
}

const assertStagingEmpty = (witness: DirectoryWitness) => {
  mapReplacement(() => revalidateDirectoryWitness(witness))
  const remaining = mapReplacement(() => collectBoundedDirectoryEntries(witness.canonicalPath, 0))
  mapReplacement(() => revalidateDirectoryWitness(witness))
  if (remaining.overflow) {
    return repositoryChanged()
  }
}

/** @internal */
export const cleanupStaleStagingEntries = (stagingDirectory: string, hooks: StagingCleanupHooks = {}) => {
  const snapshot = mapReplacement(() => captureCanonicalDirectory(stagingDirectory, MAX_STAGING_DIRECTORY_ENTRIES))
  if (snapshot.overflow) {
    return stagingEntryLimit()
  }
  const entries = snapshot.entries.map(entry => inspectStagingEntry(stagingDirectory, entry.name))
  const { witness: initialWitness } = snapshot
  mapReplacement(() => revalidateDirectoryWitness(initialWitness))
  hooks.afterPreflight?.()
  let witness = initialWitness
  for (const entry of entries) {
    witness = quarantineStagingEntry(stagingDirectory, entry, witness, hooks)
  }
  assertStagingEmpty(witness)
  hooks.beforeFlush?.()
  mapReplacement(() => revalidateDirectoryWitness(witness))
  mapReplacement(() => fsyncDirectory(witness))
}
