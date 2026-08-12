import type { BigIntStats } from 'node:fs'
import { lstatSync, realpathSync } from 'node:fs'
import { sameStableFileMetadata } from './file-identity.ts'

type CaptureDirectoryOptions = {
  afterCanonicalisation?: (() => void) | undefined
  allowLink: boolean
}

export type DirectoryWitness = {
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
      validPathEntry(finalPathMetadata, options.allowLink) && sameStableFileMetadata(pathMetadata, finalPathMetadata)
    ) ||
    finalCanonicalPath !== canonicalPath ||
    !finalCanonicalMetadata.isDirectory() ||
    finalCanonicalMetadata.isSymbolicLink() ||
    !sameStableFileMetadata(canonicalMetadata, finalCanonicalMetadata)
  ) {
    return changed()
  }
  return { canonicalMetadata, canonicalPath, path, pathMetadata }
}

export const directoryWitnessIsCurrent = (witness: DirectoryWitness) => {
  const pathMetadata = lstatSync(witness.path, { bigint: true })
  const canonicalPath = realpathSync.native(witness.path)
  const canonicalMetadata = lstatSync(witness.canonicalPath, { bigint: true })
  return (
    sameStableFileMetadata(witness.pathMetadata, pathMetadata) &&
    canonicalPath === witness.canonicalPath &&
    canonicalMetadata.isDirectory() &&
    !canonicalMetadata.isSymbolicLink() &&
    sameStableFileMetadata(witness.canonicalMetadata, canonicalMetadata)
  )
}
