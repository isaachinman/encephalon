export type DirectoryReader<Entry> = {
  closeSync: () => void
  readSync: () => Entry | null
}

/** @internal */
export const readBoundedDirectoryEntries = <Entry>(reader: DirectoryReader<Entry>, maximum: number) => {
  const entries: Entry[] = []
  let exhausted = false
  while (entries.length < maximum) {
    const entry = reader.readSync()
    if (entry === null) {
      exhausted = true
      break
    }
    entries.push(entry)
  }
  return { entries, exhausted }
}
