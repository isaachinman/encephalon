import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
