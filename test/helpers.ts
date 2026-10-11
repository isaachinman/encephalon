import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const createTestRepository = () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-test-'))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(packageRoot, join(root, 'node_modules', 'encephalon'), process.platform === 'win32' ? 'junction' : 'dir')
  return root
}

// Windows can give writes within one clock tick identical file times, and its directory sizes are always 0, so a
// simulated concurrent change may otherwise be invisible to metadata checks. Tests that simulate one use these helpers.

/** Runs a mutation of `path` (or of an entry inside directory `path`) and moves its mtime past every earlier value. */
export const mutateObservably = (path: string, mutate: () => void) => {
  const previousMtimeMs = statSync(path).mtimeMs
  mutate()
  const { atime, mtimeMs } = statSync(path)
  utimesSync(path, atime, new Date(Math.max(previousMtimeMs, mtimeMs) + 2000))
}

/** Restores `atime` and `mtime` after an in-place rewrite and waits until the ctime differs from `previousCtimeNs`. */
export const restoreTimesWithNewCtime = (path: string, atime: Date, mtime: Date, previousCtimeNs: bigint) => {
  utimesSync(path, atime, mtime)
  const deadline = Date.now() + 3000
  while (statSync(path, { bigint: true }).ctimeNs === previousCtimeNs && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    utimesSync(path, atime, mtime)
  }
  if (statSync(path, { bigint: true }).ctimeNs === previousCtimeNs) {
    throw new Error(`The ctime of ${path} did not change.`)
  }
}

export const removeTestRepository = (root: string) => {
  rmSync(root, { force: true, recursive: true })
}

export const canRenameParentWithOpenChild = () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-open-child-rename-test-'))
  const parent = join(root, 'parent')
  const renamed = join(root, 'renamed')
  const child = join(parent, 'child')
  mkdirSync(parent)
  writeFileSync(child, 'probe')
  const descriptor = openSync(child, 'r')
  try {
    renameSync(parent, renamed)
    return true
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      return false
    }
    throw error
  } finally {
    closeSync(descriptor)
    rmSync(root, { force: true, recursive: true })
  }
}

export const ensureParent = (path: string) => {
  mkdirSync(dirname(path), { recursive: true })
}
