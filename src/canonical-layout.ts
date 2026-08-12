import { type Dirent, opendirSync } from 'node:fs'
import { ordinalStringCompare } from './order.ts'

export const MAX_CANONICAL_BRAIN_ROOT_ENTRIES = 1002
export const MAX_CANONICAL_KIND_DIRECTORIES = 1000
export const MAX_CANONICAL_KIND_ENTRIES = 1000

export class CanonicalDirectoryEntryLimitError extends Error {}

type DirectoryReader<Entry> = {
  closeSync: () => void
  readSync: () => Entry | null
}

type OpenDirectory<Entry> = (path: string) => DirectoryReader<Entry>

export const collectBoundedDirectoryEntries = <Entry extends { name: string } = Dirent>(
  directory: string,
  maximum: number,
  openDirectory: OpenDirectory<Entry> = opendirSync as unknown as OpenDirectory<Entry>,
) => {
  const reader = openDirectory(directory)
  try {
    const entries: Entry[] = []
    while (entries.length <= maximum) {
      const entry = reader.readSync()
      if (entry === null) {
        return {
          entries: entries.sort((first, second) => ordinalStringCompare(first.name, second.name)),
          overflow: false as const,
        }
      }
      entries.push(entry)
    }
    return { entries: [], overflow: true as const }
  } finally {
    reader.closeSync()
  }
}
