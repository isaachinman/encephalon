import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, wrapIo } from './errors.ts'
import { PACKAGE_VERSION } from './generated/version.ts'

export type DiscoverRepositoryInput = {
  root?: string
  start?: string
}

const validGitMarker = (directory: string) => {
  const marker = resolve(directory, '.git')
  if (existsSync(marker)) {
    try {
      const metadata = lstatSync(marker)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        return true
      }
      if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 16_384) {
        const content = readFileSync(marker, 'utf8').trim()
        const match = /^gitdir:\s*(.+)$/i.exec(content)
        if (match?.[1] !== undefined) {
          const target = match[1].trim()
          const gitDirectory = isAbsolute(target) ? target : resolve(directory, target)
          if (existsSync(gitDirectory)) {
            const targetMetadata = lstatSync(gitDirectory)
            return targetMetadata.isDirectory() && !targetMetadata.isSymbolicLink()
          }
        }
      }
      return false
    } catch (error) {
      return wrapIo('Unable to inspect the repository marker.', error)
    }
  }
  return false
}

const canonicalDirectory = (path: string) => {
  try {
    return realpathSync.native(resolve(path))
  } catch (error) {
    return wrapIo('Unable to resolve the repository path.', error)
  }
}

export const discoverRepository = (input: DiscoverRepositoryInput = {}) => {
  if (input.root !== undefined) {
    const explicitRoot = canonicalDirectory(input.root)
    if (validGitMarker(explicitRoot)) {
      return explicitRoot
    }
    return fail('INVALID_REPOSITORY', 'The explicit root is not a Git repository.')
  }

  let current = canonicalDirectory(input.start ?? process.cwd())
  for (;;) {
    if (validGitMarker(current)) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      return fail('REPOSITORY_NOT_FOUND', 'No Git repository was found.')
    }
    current = parent
  }
}

const packageRootFromModule = () => {
  let current = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const packagePath = resolve(current, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
          name?: unknown
        }
        if (packageJson.name === 'encephalon') {
          return realpathSync.native(current)
        }
      } catch (error) {
        return wrapIo('Unable to inspect the executing package.', error)
      }
    }
    const parent = dirname(current)
    if (parent === current) {
      return fail('ROOT_INSTALL_REQUIRED', 'Unable to locate the executing Encephalon package.')
    }
    current = parent
  }
}

const comparablePath = (path: string) => {
  const normalized = path.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export const assertRootInstallation = (root: string) => {
  const installedPath = resolve(root, 'node_modules', 'encephalon')
  if (existsSync(installedPath)) {
    try {
      const installedRoot = realpathSync.native(installedPath)
      const executingRoot = packageRootFromModule()
      if (comparablePath(installedRoot) === comparablePath(executingRoot)) {
        const packageJson = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (packageJson.name === 'encephalon' && packageJson.version === PACKAGE_VERSION) {
          return installedRoot
        }
      }
    } catch (error) {
      return wrapIo('Unable to verify the root Encephalon installation.', error)
    }
  }
  return fail('ROOT_INSTALL_REQUIRED', 'Install Encephalon at the Git repository root before running this command.')
}

export const resolveRepository = (input: { root?: string } = {}) => {
  const root = discoverRepository(input)
  assertRootInstallation(root)
  return root
}
