import type { BigIntStats } from 'node:fs'

export type EntryIdentity = {
  readonly dev: bigint
  readonly ino: bigint
}

export type EntryMetadata = EntryIdentity & {
  readonly birthtimeNs: bigint
  readonly ctimeNs: bigint
  readonly mode: bigint
  readonly mtimeNs: bigint
  readonly size: bigint
}

type EntryType = 'directory' | 'file' | 'other' | 'symlink'

export type ManifestEntryMetadata = {
  readonly ctimeNanoseconds: string
  readonly mtimeNanoseconds: string
  readonly size: string
  readonly type: EntryType
}

export const entryIdentityFrom = (metadata: BigIntStats): EntryIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
})

export const entryMetadataFrom = (metadata: BigIntStats): EntryMetadata => ({
  ...entryIdentityFrom(metadata),
  birthtimeNs: metadata.birthtimeNs,
  ctimeNs: metadata.ctimeNs,
  mode: metadata.mode,
  mtimeNs: metadata.mtimeNs,
  size: metadata.size,
})

const entryTypeFrom = (metadata: BigIntStats): EntryType => {
  if (metadata.isSymbolicLink()) {
    return 'symlink'
  }
  if (metadata.isDirectory()) {
    return 'directory'
  }
  if (metadata.isFile()) {
    return 'file'
  }
  return 'other'
}

export const manifestEntryMetadataFrom = (metadata: BigIntStats): ManifestEntryMetadata => ({
  ctimeNanoseconds: metadata.ctimeNs.toString(),
  mtimeNanoseconds: metadata.mtimeNs.toString(),
  size: metadata.size.toString(),
  type: entryTypeFrom(metadata),
})

export const sameEntryIdentity = (first: EntryIdentity, second: EntryIdentity) =>
  first.dev === second.dev && first.ino === second.ino

export const sameStableEntryMetadataExceptCtime = (first: EntryMetadata, second: EntryMetadata) =>
  sameEntryIdentity(first, second) &&
  first.size === second.size &&
  first.mode === second.mode &&
  first.birthtimeNs === second.birthtimeNs &&
  first.mtimeNs === second.mtimeNs

export const sameStableEntryMetadata = (first: EntryMetadata, second: EntryMetadata) =>
  sameStableEntryMetadataExceptCtime(first, second) && first.ctimeNs === second.ctimeNs
