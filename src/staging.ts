import { lstatSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  collectBoundedDirectoryEntries,
  isCanonicalDirectoryReplacementError,
  STAGING_DIRECTORY_NAME,
} from './canonical-layout.ts'
import { fail } from './errors.ts'

/** @internal */
export const MAX_STAGING_DIRECTORY_ENTRIES = 1000

const STAGING_RELATIVE_PATH = `encephalon/${STAGING_DIRECTORY_NAME}`
const UUID_V4_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const OWNED_STAGING_NAME = new RegExp(`^record-([1-9]\\d*)-(${UUID_V4_PATTERN})\\.tmp$`, 'u')
const OWNED_STAGING_QUARANTINE_NAME = new RegExp(`^\\.(.+)\\.(${UUID_V4_PATTERN})\\.quarantine$`, 'u')

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

const isRecognisedStagingName = (name: string) =>
  parseOwnedStagingName(name) !== undefined || parseOwnedStagingQuarantineName(name) !== undefined

/**
 * Writers publish only while holding the operation lock, so any staging entry seen by the next holder was left by an
 * interrupted writer. Returns whether anything was removed, because removing a hard-linked leftover changes the
 * linked canonical record's ctime.
 * @internal
 */
export const removeStagingLeftovers = (stagingDirectory: string) => {
  try {
    const listing = collectBoundedDirectoryEntries(stagingDirectory, MAX_STAGING_DIRECTORY_ENTRIES)
    if (listing.overflow) {
      return stagingEntryLimit()
    }
    const paths = listing.entries.map(({ name }) => {
      const path = resolve(stagingDirectory, name)
      const metadata = lstatSync(path, { bigint: true })
      return isRecognisedStagingName(name) && (metadata.isFile() || metadata.isSymbolicLink())
        ? path
        : invalidStagingLayout()
    })
    for (const path of paths) {
      unlinkSync(path)
    }
    return paths.length > 0
  } catch (error) {
    if (isCanonicalDirectoryReplacementError(error)) {
      return repositoryChanged()
    }
    throw error
  }
}
