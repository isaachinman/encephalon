import { type Dirent, opendirSync } from 'node:fs'
import {
  captureDirectoryWitness,
  type DirectoryWitness,
  DirectoryWitnessError,
  revalidateDirectoryWitness,
} from './directory-witness.ts'
import { ordinalStringCompare } from './order.ts'

export const MAX_CANONICAL_BRAIN_ROOT_ENTRIES = 1002
export const MAX_CANONICAL_KIND_DIRECTORIES = 1000
export const MAX_CANONICAL_KIND_ENTRIES = 1000
export const ARTIFACTS_DIRECTORY_NAME = '_artifacts'
export const STAGING_DIRECTORY_NAME = '_staging'

export class CanonicalDirectoryEntryLimitError extends Error {}

export class CanonicalDirectoryChangedError extends Error {
  readonly path: string

  constructor(path: string, options?: ErrorOptions) {
    super('A canonical directory changed while it was being enumerated.', options)
    this.name = 'CanonicalDirectoryChangedError'
    this.path = path
  }
}

const CANONICAL_RESERVED_DIRECTORIES = new Set([ARTIFACTS_DIRECTORY_NAME, STAGING_DIRECTORY_NAME])

export const isCanonicalReservedDirectory = (name: string) => CANONICAL_RESERVED_DIRECTORIES.has(name)

export const isCanonicalKindDirectoryEntry = (entry: Dirent) =>
  !entry.name.startsWith('_') && entry.isDirectory() && !entry.isSymbolicLink()

type DirectoryReader<Entry> = {
  closeSync: () => void
  readSync: () => Entry | null
}

type OpenDirectory<Entry> = (path: string) => DirectoryReader<Entry>

/** @internal */
export const collectBoundedDirectoryEntries = <Entry extends { name: string } = Dirent>(
  directory: string,
  maximum: number,
  openDirectory: OpenDirectory<Entry> = opendirSync as unknown as OpenDirectory<Entry>,
  onEntry?: () => void,
) => {
  const reader = openDirectory(directory)
  let primaryError: unknown
  let result: { entries: Entry[]; overflow: false } | { entries: never[]; overflow: true } | undefined
  try {
    const entries: Entry[] = []
    while (entries.length <= maximum) {
      const entry = reader.readSync()
      if (entry === null) {
        result = {
          entries: entries.sort((first, second) => ordinalStringCompare(first.name, second.name)),
          overflow: false as const,
        }
        break
      }
      onEntry?.()
      entries.push(entry)
    }
    result ??= { entries: [], overflow: true as const }
  } catch (error) {
    primaryError = error
  }
  try {
    reader.closeSync()
  } catch (error) {
    if (primaryError === undefined) {
      throw error
    }
  }
  if (primaryError !== undefined) {
    throw primaryError
  }
  return result as NonNullable<typeof result>
}

export const isCanonicalDirectoryReplacementError = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return (
    error instanceof CanonicalDirectoryChangedError ||
    error instanceof DirectoryWitnessError ||
    code === 'ELOOP' ||
    code === 'ENOENT' ||
    code === 'ENOTDIR'
  )
}

export type CanonicalDirectorySnapshot = {
  entries: Dirent[]
  overflow: boolean
  witness: DirectoryWitness
}

/** @internal */
export const captureCanonicalDirectory = (
  path: string,
  maximum: number,
  afterEnumeration?: (path: string) => void,
  onEntry?: () => void,
): CanonicalDirectorySnapshot => {
  try {
    const witness = captureDirectoryWitness(path, { allowLink: false })
    const collected = collectBoundedDirectoryEntries(witness.canonicalPath, maximum, undefined, onEntry)
    afterEnumeration?.(path)
    revalidateDirectoryWitness(witness)
    return { ...collected, witness }
  } catch (error) {
    if (isCanonicalDirectoryReplacementError(error)) {
      throw new CanonicalDirectoryChangedError(path, { cause: error })
    }
    throw error
  }
}

export const revalidateCanonicalDirectory = (snapshot: CanonicalDirectorySnapshot) => {
  try {
    revalidateDirectoryWitness(snapshot.witness)
  } catch (error) {
    if (isCanonicalDirectoryReplacementError(error)) {
      throw new CanonicalDirectoryChangedError(snapshot.witness.path, { cause: error })
    }
    throw error
  }
}
