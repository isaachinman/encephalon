import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { relative, resolve, sep } from 'node:path'

export type DurableSnapshotEntry = Readonly<{
  bytes?: Buffer
  mode: number
  path: string
  type: 'directory' | 'file'
}>

export type DurableSnapshot = readonly DurableSnapshotEntry[]

export type DurableSnapshotChange = Readonly<{
  kind: 'added' | 'bytes' | 'mode' | 'removed' | 'type'
  path: string
}>

export type SnapshotHooks = Readonly<{
  afterFileOpen?: (path: string) => void
}>

export class DurableSnapshotMismatch extends Error {
  readonly changes: readonly DurableSnapshotChange[]

  constructor(changes: readonly DurableSnapshotChange[]) {
    super(`Durable compatibility state changed (${changes.map(change => `${change.kind}:${change.path}`).join(', ')}).`)
    this.name = 'DurableSnapshotMismatch'
    this.changes = Object.freeze([...changes])
  }
}

const maximumEntries = 4096
const maximumFileBytes = 16 * 1024 * 1024
const maximumAggregateBytes = 64 * 1024 * 1024
const maximumDepth = 64

const readBoundedDirectoryNames = (path: string, maximum: number) => {
  const directory = opendirSync(path)
  try {
    const names: string[] = []
    while (names.length <= maximum) {
      const entry = directory.readSync()
      if (entry === null) {
        return names.sort(ordinalCompare)
      }
      names.push(entry.name)
    }
    throw new Error('Durable compatibility snapshot exceeded its entry-count or traversal-depth limit.')
  } finally {
    directory.closeSync()
  }
}

const ordinalCompare = (left: string, right: string) => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

const sameStableFile = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.birthtimeNs === right.birthtimeNs

const sameStableDirectory = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs

const readBoundedRegularFile = (path: string, hooks: SnapshotHooks) => {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    const namedBefore = lstatSync(path, { bigint: true })
    if (
      !(before.isFile() && namedBefore.isFile()) ||
      namedBefore.isSymbolicLink() ||
      before.nlink !== 1n ||
      namedBefore.nlink !== 1n ||
      !sameStableFile(before, namedBefore) ||
      before.size > BigInt(maximumFileBytes)
    ) {
      throw new Error(`Durable compatibility file is not one stable bounded regular file without a hard link: ${path}`)
    }
    hooks.afterFileOpen?.(path)
    const bytes = Buffer.alloc(Math.min(Number(before.size) + 1, maximumFileBytes + 1))
    let offset = 0
    let count = 1
    while (offset < bytes.length && count > 0) {
      count = readSync(descriptor, bytes, offset, bytes.length - offset, null)
      offset += count
    }
    const after = fstatSync(descriptor, { bigint: true })
    const namedAfter = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    if (
      namedAfter !== undefined &&
      sameStableFile(before, after) &&
      sameStableFile(before, namedAfter) &&
      offset === Number(before.size)
    ) {
      return Buffer.from(bytes.subarray(0, offset))
    }
    throw new Error(`Durable compatibility file changed while reading stable bounded regular file: ${path}`)
  } finally {
    closeSync(descriptor)
  }
}

type SnapshotState = {
  aggregateBytes: number
  entries: number
}

const captureEntry = (
  root: string,
  relativePath: string,
  depth: number,
  state: SnapshotState,
  hooks: SnapshotHooks,
  excluded: (relativePath: string) => boolean,
): DurableSnapshotEntry[] => {
  if (depth > maximumDepth || state.entries >= maximumEntries) {
    throw new Error('Durable compatibility snapshot exceeded its entry-count or traversal-depth limit.')
  }
  const path = relativePath === '.' ? root : resolve(root, relativePath)
  const containedPath = relative(root, path)
  const expectedCanonicalPath =
    relativePath === '.' ? realpathSync.native(root) : resolve(realpathSync.native(root), relativePath)
  if (
    containedPath === '..' ||
    containedPath.startsWith(`..${sep}`) ||
    realpathSync.native(path) !== expectedCanonicalPath
  ) {
    throw new Error(`Durable compatibility entry escaped or redirected its snapshot root: ${relativePath}`)
  }
  const metadata = lstatSync(path, { bigint: true })
  const mode = Number(metadata.mode & 0o7777n)
  state.entries += 1
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    const children = readBoundedDirectoryNames(path, maximumEntries - state.entries)
    const descendants = children.flatMap(child => {
      const childPath = relativePath === '.' ? child : `${relativePath}/${child}`
      return excluded(childPath) ? [] : captureEntry(root, childPath, depth + 1, state, hooks, excluded)
    })
    const after = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    if (after !== undefined && sameStableDirectory(metadata, after)) {
      return [Object.freeze({ mode, path: relativePath, type: 'directory' as const }), ...descendants]
    }
    throw new Error(`Durable compatibility directory changed while its generation was being captured: ${relativePath}`)
  }
  if (metadata.isFile() && !metadata.isSymbolicLink()) {
    const bytes = readBoundedRegularFile(path, hooks)
    state.aggregateBytes += bytes.length
    if (state.aggregateBytes <= maximumAggregateBytes) {
      return [Object.freeze({ bytes, mode, path: relativePath, type: 'file' as const })]
    }
    throw new Error('Durable compatibility snapshot exceeded its aggregate byte limit.')
  }
  throw new Error(`Durable compatibility entry is neither a regular file nor a directory: ${relativePath}`)
}

const captureRoots = (
  root: string,
  roots: readonly string[],
  hooks: SnapshotHooks,
  excluded: (relativePath: string) => boolean,
) => {
  const state: SnapshotState = { aggregateBytes: 0, entries: 0 }
  return Object.freeze(
    roots.flatMap(relativePath =>
      lstatSync(resolve(root, relativePath), { throwIfNoEntry: false }) === undefined
        ? []
        : captureEntry(root, relativePath, 0, state, hooks, excluded),
    ),
  )
}

export const captureDurableSnapshot = (root: string, hooks: SnapshotHooks = {}): DurableSnapshot =>
  captureRoots(root, ['AGENTS.md', 'CLAUDE.md', 'encephalon'], hooks, () => false)

export const captureImportSnapshot = (root: string, hooks: SnapshotHooks = {}): DurableSnapshot =>
  captureRoots(
    root,
    ['.'],
    hooks,
    relativePath =>
      relativePath === 'node_modules/.bin' ||
      relativePath.startsWith('node_modules/.bin/') ||
      relativePath === 'node_modules/.cache/encephalon' ||
      relativePath.startsWith('node_modules/.cache/encephalon/'),
  )

const snapshotEntryChanges = (
  expected: DurableSnapshotEntry,
  actual: DurableSnapshotEntry,
): DurableSnapshotChange[] => {
  const typeChanges: DurableSnapshotChange[] =
    expected.type === actual.type ? [] : [{ kind: 'type', path: expected.path }]
  const modeChanges: DurableSnapshotChange[] =
    expected.mode === actual.mode ? [] : [{ kind: 'mode', path: expected.path }]
  const byteChanges: DurableSnapshotChange[] =
    expected.type === 'file' &&
    actual.type === 'file' &&
    expected.bytes !== undefined &&
    actual.bytes !== undefined &&
    Buffer.compare(expected.bytes, actual.bytes) !== 0
      ? [{ kind: 'bytes', path: expected.path }]
      : []
  return [...typeChanges, ...modeChanges, ...byteChanges]
}

export const assertDurableSnapshotsEqual = (expected: DurableSnapshot, actual: DurableSnapshot) => {
  const expectedByPath = new Map(expected.map(entry => [entry.path, entry]))
  const actualByPath = new Map(actual.map(entry => [entry.path, entry]))
  const removed = expected
    .filter(entry => !actualByPath.has(entry.path))
    .map(entry => ({ kind: 'removed' as const, path: entry.path }))
  const added = actual
    .filter(entry => !expectedByPath.has(entry.path))
    .map(entry => ({ kind: 'added' as const, path: entry.path }))
  const changed = expected.flatMap(entry => {
    const current = actualByPath.get(entry.path)
    return current === undefined ? [] : snapshotEntryChanges(entry, current)
  })
  const changes = [...removed, ...added, ...changed].sort((left, right) =>
    ordinalCompare(`${left.path}:${left.kind}`, `${right.path}:${right.kind}`),
  )
  if (changes.length > 0) {
    throw new DurableSnapshotMismatch(changes)
  }
}
