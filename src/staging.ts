import type { BigIntStats } from 'node:fs'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  captureCanonicalDirectory,
  collectBoundedDirectoryEntries,
  isCanonicalDirectoryReplacementError,
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

const STAGING_RELATIVE_PATH = 'encephalon/_staging'
const OWNED_STAGING_NAME =
  /^record-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u
const directoryFlag = constants.O_DIRECTORY ?? 0
const noFollowFlag = constants.O_NOFOLLOW ?? 0

type StagingCleanupHooks = {
  afterPreflight?: (() => void) | undefined
  beforeEntryLstat?: (() => void) | undefined
  beforeFlush?: (() => void) | undefined
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
      fsyncSync(descriptor)
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
    mapReplacement(() => revalidateDirectoryWitness(witness))
    hooks.beforeEntryLstat?.()
    const current = mapReplacement(() => lstatSync(resolve(stagingDirectory, entry.name), { bigint: true }))
    if (!(isPermittedStagingType(current) && sameStableEntryMetadata(entry.metadata, current))) {
      return repositoryChanged()
    }
    mapReplacement(() => revalidateDirectoryWitness(witness))
    mapReplacement(() => unlinkSync(resolve(stagingDirectory, entry.name)))
    witness = captureNextGeneration(witness)
  }
  assertStagingEmpty(witness)
  if (entries.length > 0) {
    hooks.beforeFlush?.()
    mapReplacement(() => revalidateDirectoryWitness(witness))
    mapReplacement(() => fsyncDirectory(witness))
  }
}
