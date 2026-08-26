export type DirectoryReader<Entry> = {
  closeSync: () => void
  readSync: () => Entry | null
}

/** @internal */
export const readBoundedDirectoryEntries = <Entry>(
  reader: DirectoryReader<Entry>,
  maximum: number,
  onEntry?: ((entry: Entry) => void) | undefined,
) => {
  const entries: Entry[] = []
  let exhausted = false
  while (entries.length < maximum) {
    const entry = reader.readSync()
    if (entry === null) {
      exhausted = true
      break
    }
    onEntry?.(entry)
    entries.push(entry)
  }
  return { entries, exhausted }
}
