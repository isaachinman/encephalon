import { spawnSync } from 'node:child_process'
import { lstatSync, opendirSync } from 'node:fs'
import { resolve } from 'node:path'

export const assertCleanReleaseWorktree = (root: string, allowPackageArtifacts: boolean) => {
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'buffer',
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  })
  if (status.error !== undefined) {
    throw status.error
  }
  if (status.status !== 0 || status.stderr.length > 0 || status.stdout.length > 0) {
    throw new Error('The release worktree contains tracked or untracked changes.')
  }

  const artifactDirectory = resolve(root, 'package-artifacts')
  const artifactDirectoryEntry = lstatSync(artifactDirectory, { throwIfNoEntry: false })
  if (allowPackageArtifacts) {
    if (
      artifactDirectoryEntry === undefined ||
      !artifactDirectoryEntry.isDirectory() ||
      artifactDirectoryEntry.isSymbolicLink()
    ) {
      throw new Error('The exact package artifact directory is missing or redirected.')
    }
    const expectedFiles = ['encephalon-0.3.0.tgz', 'encephalon-0.3.0.tgz.metadata.json']
    const directory = opendirSync(artifactDirectory)
    const entries = (() => {
      try {
        const names: string[] = []
        while (names.length <= expectedFiles.length) {
          const entry = directory.readSync()
          if (entry === null) {
            return names.sort((left, right) => left.localeCompare(right, 'en'))
          }
          names.push(entry.name)
        }
        return names
      } finally {
        directory.closeSync()
      }
    })()
    const entriesAreExact =
      JSON.stringify(entries) === JSON.stringify(expectedFiles) &&
      entries.every(name => {
        const entry = lstatSync(resolve(artifactDirectory, name))
        return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1
      })
    if (!entriesAreExact) {
      throw new Error('The exact package artifact directory contains unexpected or unsafe entries.')
    }
  } else if (artifactDirectoryEntry !== undefined) {
    throw new Error('The exact package artifact directory exists before the authorised retention phase.')
  }
}
