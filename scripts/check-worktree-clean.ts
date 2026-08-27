import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCleanReleaseWorktree } from './worktree-clean.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const allowPackageArtifacts = process.argv.length === 3 && process.argv[2] === '--allow-package-artifacts'
if (!(process.argv.length === 2 || allowPackageArtifacts)) {
  throw new Error('Usage: check-worktree-clean.ts [--allow-package-artifacts]')
}

assertCleanReleaseWorktree(root, allowPackageArtifacts)
