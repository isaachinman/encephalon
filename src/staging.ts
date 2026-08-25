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
import { sameEntryIdentity, sameStableEntryMetadata, sameStableEntryMetadataExceptCtime } from './filesystem-entry.ts'

/** @internal */
export const MAX_STAGING_DIRECTORY_ENTRIES = 1000

const STAGING_RELATIVE_PATH = `encephalon/${STAGING_DIRECTORY_NAME}`
const UUID_V4_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const OWNED_STAGING_NAME = new RegExp(`^record-([1-9]\\d*)-(${UUID_V4_PATTERN})\\.tmp$`, 'u')
const OWNED_STAGING_QUARANTINE_NAME = new RegExp(`^\\.(.+)\\.(${UUID_V4_PATTERN})\\.quarantine$`, 'u')
const directoryFlag = constants.O_DIRECTORY ?? 0
const noFollowFlag = constants.O_NOFOLLOW ?? 0

type StagingCleanupHooks = {
  afterQuarantine?: (() => void) | undefined
  afterPreflight?: (() => void) | undefined
  beforeEntryLstat?: (() => void) | undefined
  beforeEmptyProbe?: (() => void) | undefined
  beforeFlush?: (() => void) | undefined
  beforeQuarantine?: (() => void) | undefined
}

type StagingEntry = {
  metadata: BigIntStats
  name: string
  writerName: string
}

const sameRegularEntryApartFromCtime = (expected: BigIntStats, current: BigIntStats) =>
  expected.isFile() && current.isFile() && sameStableEntryMetadataExceptCtime(expected, current)

/** @internal */
export const advanceRegularStagingIncarnation = (
  expected: BigIntStats,
  deletedDescriptor: BigIntStats,
  survivingPath: BigIntStats,
  survivingDescriptor: BigIntStats,
) => {
  if (
    sameRegularEntryApartFromCtime(expected, deletedDescriptor) &&
    sameRegularEntryApartFromCtime(expected, survivingDescriptor) &&
    sameStableEntryMetadata(survivingPath, survivingDescriptor)
  ) {
    return survivingDescriptor
  }
}

/** @internal */
export const parseOwnedStagingName = (name: string): { pid: number; uuid: string } | undefined => {
  const match = name.match(OWNED_STAGING_NAME)
  if (match !== null) {
    const [, pidText, uuid] = match
    const pid = Number(pidText)
    if (pidText !== undefined && uuid !== undefined && Number.isSafeInteger(pid) && String(pid) === pidText) {
      return { pid, uuid }
    }
  }
}

/** @internal */
export const createOwnedStagingName = (pid: number, uuid: string) => `record-${pid}-${uuid}.tmp`

/** @internal */
export const parseOwnedStagingQuarantineName = (name: string): { writerName: string } | undefined => {
  const match = name.match(OWNED_STAGING_QUARANTINE_NAME)
  if (match !== null) {
    const [, writerName] = match
    if (writerName !== undefined) {
      const parsedWriter = parseOwnedStagingName(writerName)
      if (parsedWriter !== undefined) {
        return { writerName }
      }
    }
  }
}

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

const repositoryChanged = (): never =>
  fail('REPOSITORY_CHANGED', 'Staging layout changed before publication.', {
    action: 'Inspect the staging directory and retry.',
    path: STAGING_RELATIVE_PATH,
  })

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
  const quarantine = parseOwnedStagingQuarantineName(name)
  const writerName = quarantine === undefined ? name : quarantine.writerName
  if (parseOwnedStagingName(writerName) === undefined) {
    return invalidStagingLayout()
  }
  const metadata = mapReplacement(() => lstatSync(resolve(stagingDirectory, name), { bigint: true }))
  if (!isPermittedStagingType(metadata)) {
    return invalidStagingLayout()
  }
  return { metadata, name, writerName }
}

const sameRecoveredSymbolicLink = (expected: BigIntStats, current: BigIntStats) =>
  expected.isSymbolicLink() && current.isSymbolicLink() && sameStableEntryMetadataExceptCtime(expected, current)

const quarantineStagingEntry = (
  stagingDirectory: string,
  entry: StagingEntry,
  witness: DirectoryWitness,
  hooks: StagingCleanupHooks,
) => {
  const sourcePath = resolve(stagingDirectory, entry.name)
  let descriptor: number | undefined
  let result: { metadata?: BigIntStats; witness: DirectoryWitness } | undefined
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
          sameStableEntryMetadata(entry.metadata, descriptorMetadata) &&
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
    const quarantinePath = resolve(stagingDirectory, `.${entry.writerName}.${randomUUID()}.quarantine`)
    mapReplacement(() => renameSync(sourcePath, quarantinePath))
    const nextWitness = captureNextGeneration(witness)
    const moved = mapReplacement(() => lstatSync(quarantinePath, { bigint: true }))
    const movedAccepted = regular
      ? descriptor !== undefined && sameStableEntryMetadata(moved, fstatSync(descriptor, { bigint: true }))
      : sameRecoveredSymbolicLink(entry.metadata, moved)
    if (!movedAccepted) {
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
    mapReplacement(() => unlinkSync(quarantinePath))
    const metadata = descriptor === undefined ? undefined : fstatSync(descriptor, { bigint: true })
    result = {
      ...(metadata === undefined ? {} : { metadata }),
      witness: captureNextGeneration(nextWitness),
    }
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
  return result as { metadata?: BigIntStats; witness: DirectoryWitness }
}

const captureSurvivingRegularIncarnation = (
  stagingDirectory: string,
  entry: StagingEntry,
  expected: BigIntStats,
  deletedDescriptor: BigIntStats,
  witness: DirectoryWitness,
) => {
  const path = resolve(stagingDirectory, entry.name)
  let descriptor: number | undefined
  let result: BigIntStats | undefined
  let primaryError: unknown
  try {
    mapReplacement(() => revalidateDirectoryWitness(witness))
    const pathMetadata = mapReplacement(() => lstatSync(path, { bigint: true }))
    descriptor = mapReplacement(() => openSync(path, constants.O_RDONLY | noFollowFlag))
    const descriptorMetadata = fstatSync(descriptor, { bigint: true })
    result = advanceRegularStagingIncarnation(expected, deletedDescriptor, pathMetadata, descriptorMetadata)
    if (result === undefined) {
      return repositoryChanged()
    }
    mapReplacement(() => revalidateDirectoryWitness(witness))
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
  return result as BigIntStats
}

/** @internal */
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
  const { witness: nextWitness } = quarantineStagingEntry(
    stagingDirectory,
    { metadata, name, writerName: name },
    witness,
    hooks,
  )
  assertStagingEmpty(nextWitness, hooks)
  hooks.beforeFlush?.()
  mapReplacement(() => revalidateDirectoryWitness(nextWitness))
  mapReplacement(() => fsyncDirectory(nextWitness))
  return nextWitness
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
      try {
        if (stagingTestHooks.fsyncDirectory === undefined) {
          fsyncSync(descriptor)
        } else {
          stagingTestHooks.fsyncDirectory(descriptor)
        }
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM') {
          throw error
        }
      }
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
  }
}

/** @internal */
export const assertStagingEmpty = (witness: DirectoryWitness, hooks: StagingCleanupHooks = {}) => {
  hooks.beforeEmptyProbe?.()
  mapReplacement(() => revalidateDirectoryWitness(witness))
  const remaining = mapReplacement(() => collectBoundedDirectoryEntries(witness.canonicalPath, 0))
  mapReplacement(() => revalidateDirectoryWitness(witness))
  if (remaining.overflow) {
    return repositoryChanged()
  }
  return witness
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
  const regularIncarnations = new Map<string, BigIntStats>()
  const regularAliases = new Map<string, StagingEntry[]>()
  for (const entry of entries) {
    if (entry.metadata.isFile()) {
      const key = `${entry.metadata.dev}:${entry.metadata.ino}`
      const expected = regularIncarnations.get(key)
      if (expected !== undefined && !sameStableEntryMetadata(expected, entry.metadata)) {
        return repositoryChanged()
      }
      regularIncarnations.set(key, entry.metadata)
      const aliases = regularAliases.get(key)
      if (aliases === undefined) {
        regularAliases.set(key, [entry])
      } else {
        aliases.push(entry)
      }
    }
  }
  const regularAliasPositions = new Map<string, number>()
  let witness = initialWitness
  for (const entry of entries) {
    const key = `${entry.metadata.dev}:${entry.metadata.ino}`
    const expected = entry.metadata.isFile() ? (regularIncarnations.get(key) ?? entry.metadata) : entry.metadata
    const { metadata, witness: nextWitness } = quarantineStagingEntry(
      stagingDirectory,
      { ...entry, metadata: expected },
      witness,
      hooks,
    )
    witness = nextWitness
    if (metadata !== undefined) {
      const position = (regularAliasPositions.get(key) ?? 0) + 1
      regularAliasPositions.set(key, position)
      const nextAlias = regularAliases.get(key)?.[position]
      if (nextAlias === undefined) {
        regularIncarnations.set(key, metadata)
      } else {
        regularIncarnations.set(
          key,
          captureSurvivingRegularIncarnation(stagingDirectory, nextAlias, expected, metadata, witness),
        )
      }
    }
  }
  assertStagingEmpty(witness, hooks)
  hooks.beforeFlush?.()
  mapReplacement(() => revalidateDirectoryWitness(witness))
  mapReplacement(() => fsyncDirectory(witness))
}
