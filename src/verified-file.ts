import type { BigIntStats } from 'node:fs'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { sameEntryIdentity, sameStableEntryMetadata } from './filesystem-entry.ts'

type VerifiedFileFault = 'after-fstat' | 'after-lstat' | 'before-allocation' | 'before-final-path-lstat'

type VerifiedFileOptions = {
  fault?: (point: VerifiedFileFault) => void
}

const noFollowFlag = constants.O_NOFOLLOW ?? 0
const decoder = new TextDecoder('utf-8', { fatal: true })

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

const isReplacementOpenError = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR'
}

export class VerifiedFileError extends Error {
  constructor(message = 'The file is not a stable bounded regular file.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'VerifiedFileError'
  }
}

const changed = (): never => {
  throw new VerifiedFileError()
}

const readExactBytes = (descriptor: number, size: number) => {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const bytesRead = readSync(descriptor, bytes, offset, size - offset, offset)
    if (bytesRead === 0) {
      changed()
    }
    offset += bytesRead
  }
  if (readSync(descriptor, Buffer.alloc(1), 0, 1, size) > 0) {
    changed()
  }
  return bytes
}

const readVerifiedDescriptor = (
  descriptor: number,
  path: string,
  pathMetadata: BigIntStats,
  maximumBytes: number,
  options: VerifiedFileOptions,
) => {
  const metadata = fstatSync(descriptor, { bigint: true })
  if (!(metadata.isFile() && sameEntryIdentity(pathMetadata, metadata)) || metadata.size > BigInt(maximumBytes)) {
    return changed()
  }
  options.fault?.('after-fstat')
  options.fault?.('before-allocation')
  const bytes = readExactBytes(descriptor, Number(metadata.size))
  const finalMetadata = fstatSync(descriptor, { bigint: true })
  options.fault?.('before-final-path-lstat')
  let finalPathMetadata: BigIntStats
  try {
    finalPathMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) {
      return changed()
    }
    throw error
  }
  if (
    !finalPathMetadata.isFile() ||
    finalPathMetadata.isSymbolicLink() ||
    !sameStableEntryMetadata(finalPathMetadata, finalMetadata) ||
    !sameStableEntryMetadata(metadata, finalMetadata)
  ) {
    return changed()
  }
  return bytes
}

export const readVerifiedRegularFile = (
  path: string,
  maximumBytes: number,
  options: VerifiedFileOptions = {},
): Buffer | undefined => {
  let pathMetadata: BigIntStats
  try {
    pathMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) {
      return
    }
    throw error
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    return changed()
  }
  options.fault?.('after-lstat')

  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag)
  } catch (error) {
    if (isReplacementOpenError(error)) {
      return changed()
    }
    throw error
  }

  let bytes: Buffer | undefined
  let primaryError: unknown
  try {
    bytes = readVerifiedDescriptor(descriptor, path, pathMetadata, maximumBytes, options)
  } catch (error) {
    primaryError = error
  }
  let closeError: unknown
  try {
    closeSync(descriptor)
  } catch (error) {
    closeError = error
  }
  if (primaryError !== undefined) {
    throw primaryError
  }
  if (closeError !== undefined) {
    throw closeError
  }
  return bytes
}

export const decodeVerifiedUtf8 = (bytes: Buffer) => {
  try {
    return decoder.decode(bytes)
  } catch (error) {
    throw new VerifiedFileError('The file is not valid UTF-8.', { cause: error })
  }
}
