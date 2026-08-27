import { type BigIntStats, lstatSync, opendirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

export type IsolatedRootWitness = Readonly<{
  canonicalPath: string
  identity: BigIntStats
  parentCanonicalPath: string
  parentIdentity: BigIntStats
  path: string
}>

const maximumCleanupDepth = 64
const maximumCleanupEntries = 8192
const maximumCleanupBytes = 128 * 1024 * 1024

const sameDirectoryIdentity = (expected: BigIntStats, actual: BigIntStats) =>
  expected.dev === actual.dev &&
  expected.ino === actual.ino &&
  expected.mode === actual.mode &&
  expected.isDirectory() === actual.isDirectory() &&
  expected.isSymbolicLink() === actual.isSymbolicLink()

const ordinaryDirectory = (path: string) => {
  const metadata = lstatSync(path, { bigint: true })
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    return metadata
  }
  throw new Error(`Isolated cleanup root is not one ordinary directory: ${path}`)
}

export const captureIsolatedRoot = (path: string): IsolatedRootWitness => {
  const absolutePath = resolve(path)
  const parent = dirname(absolutePath)
  const identity = ordinaryDirectory(absolutePath)
  const parentIdentity = ordinaryDirectory(parent)
  return Object.freeze({
    canonicalPath: realpathSync.native(absolutePath),
    identity,
    parentCanonicalPath: realpathSync.native(parent),
    parentIdentity,
    path: absolutePath,
  })
}

type CleanupState = { bytes: number; entries: number }

const boundedNames = (path: string, state: CleanupState) => {
  const directory = opendirSync(path)
  try {
    const names: string[] = []
    while (state.entries + names.length <= maximumCleanupEntries) {
      const entry = directory.readSync()
      if (entry === null) {
        return names
      }
      names.push(entry.name)
    }
    throw new Error('Isolated cleanup exceeded its entry-count bound.')
  } finally {
    directory.closeSync()
  }
}

const removeContainedEntry = (root: string, path: string, depth: number, state: CleanupState) => {
  const contained = relative(root, path)
  if (
    depth > maximumCleanupDepth ||
    contained === '..' ||
    contained.startsWith(`..${sep}`) ||
    state.entries >= maximumCleanupEntries
  ) {
    throw new Error('Isolated cleanup escaped containment or exceeded its traversal bound.')
  }
  const before = lstatSync(path, { bigint: true })
  state.entries += 1
  state.bytes += Number(before.size)
  if (state.bytes > maximumCleanupBytes) {
    throw new Error('Isolated cleanup exceeded its aggregate byte bound.')
  }
  if (before.isDirectory() && !before.isSymbolicLink()) {
    for (const name of boundedNames(path, state)) {
      removeContainedEntry(root, resolve(path, name), depth + 1, state)
    }
    const after = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    if (after !== undefined && sameDirectoryIdentity(before, after)) {
      rmdirSync(path)
    } else {
      throw new Error('Isolated cleanup directory identity changed during bounded disposal.')
    }
  } else if (before.isFile() || before.isSymbolicLink()) {
    unlinkSync(path)
  } else {
    throw new Error('Isolated cleanup refuses special filesystem entries.')
  }
}

export const disposeIsolatedRoot = (witness: IsolatedRootWitness) => {
  const parent = dirname(witness.path)
  const parentIdentity = ordinaryDirectory(parent)
  const rootIdentity = ordinaryDirectory(witness.path)
  if (
    sameDirectoryIdentity(witness.parentIdentity, parentIdentity) &&
    witness.parentCanonicalPath === realpathSync.native(parent) &&
    sameDirectoryIdentity(witness.identity, rootIdentity) &&
    witness.canonicalPath === realpathSync.native(witness.path)
  ) {
    const state: CleanupState = { bytes: 0, entries: 0 }
    for (const name of boundedNames(witness.path, state)) {
      removeContainedEntry(witness.path, resolve(witness.path, name), 1, state)
    }
    const finalIdentity = ordinaryDirectory(witness.path)
    if (sameDirectoryIdentity(witness.identity, finalIdentity)) {
      rmdirSync(witness.path)
      return
    }
  }
  throw new Error('Isolated cleanup root or parent identity changed; refusing recursive disposal.')
}
