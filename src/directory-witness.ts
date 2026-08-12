import type { BigIntStats } from 'node:fs'
import { lstatSync, realpathSync } from 'node:fs'
import { sameStableEntryMetadata } from './filesystem-entry.ts'

type CaptureDirectoryOptions = {
  afterCanonicalisation?: (() => void) | undefined
  allowLink: boolean
}

type RevalidateDirectoryOptions = {
  afterCanonicalisation?: (() => void) | undefined
}

export type DirectoryWitness = {
  allowLink: boolean
  canonicalMetadata: BigIntStats
  canonicalPath: string
  path: string
  pathMetadata: BigIntStats
}

export class DirectoryWitnessError extends Error {
  constructor() {
    super('The directory changed while it was being verified.')
    this.name = 'DirectoryWitnessError'
  }
}

const validPathEntry = (metadata: BigIntStats, allowLink: boolean) =>
  metadata.isDirectory() || (allowLink && metadata.isSymbolicLink())

const changed = (): never => {
  throw new DirectoryWitnessError()
}

const witnessMatches = (expected: DirectoryWitness, current: DirectoryWitness) =>
  expected.allowLink === current.allowLink &&
  expected.canonicalPath === current.canonicalPath &&
  sameStableEntryMetadata(expected.pathMetadata, current.pathMetadata) &&
  sameStableEntryMetadata(expected.canonicalMetadata, current.canonicalMetadata)

export const captureDirectoryWitness = (path: string, options: CaptureDirectoryOptions): DirectoryWitness => {
  const pathMetadata = lstatSync(path, { bigint: true })
  if (!validPathEntry(pathMetadata, options.allowLink)) {
    return changed()
  }
  const canonicalPath = realpathSync.native(path)
  const canonicalMetadata = lstatSync(canonicalPath, { bigint: true })
  if (!canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink()) {
    return changed()
  }
  options.afterCanonicalisation?.()
  const finalPathMetadata = lstatSync(path, { bigint: true })
  const finalCanonicalPath = realpathSync.native(path)
  const finalCanonicalMetadata = lstatSync(canonicalPath, { bigint: true })
  if (
    !(
      validPathEntry(finalPathMetadata, options.allowLink) && sameStableEntryMetadata(pathMetadata, finalPathMetadata)
    ) ||
    finalCanonicalPath !== canonicalPath ||
    !finalCanonicalMetadata.isDirectory() ||
    finalCanonicalMetadata.isSymbolicLink() ||
    !sameStableEntryMetadata(canonicalMetadata, finalCanonicalMetadata)
  ) {
    return changed()
  }
  return { allowLink: options.allowLink, canonicalMetadata, canonicalPath, path, pathMetadata }
}

export const revalidateDirectoryWitness = (witness: DirectoryWitness, options: RevalidateDirectoryOptions = {}) => {
  const current = captureDirectoryWitness(witness.path, {
    afterCanonicalisation: options.afterCanonicalisation,
    allowLink: witness.allowLink,
  })
  if (witnessMatches(witness, current)) {
    return current
  }
  return changed()
}
