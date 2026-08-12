import type { BigIntStats } from 'node:fs'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { PACKAGE_VERSION } from './generated/version.ts'
import { decodeVerifiedUtf8, readVerifiedRegularFile, VerifiedFileError } from './verified-file.ts'

export type DiscoverRepositoryInput = {
  root?: string
  start?: string
}

type PackageIdentity = {
  name: string
  root: string
  version: string
}

type PackageManifest = {
  name?: unknown
  version?: unknown
}

type RepositoryTestHooks = {
  afterGitDirectoryLstat?: ((path: string) => void) | undefined
}

export const repositoryTestHooks: RepositoryTestHooks = {}

const MAX_GIT_MARKER_BYTES = 16_384
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024
let executingPackageIdentity: PackageIdentity | undefined

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

const sameIdentity = (first: BigIntStats, second: BigIntStats) => first.dev === second.dev && first.ino === second.ino

const verifiedRealDirectory = (path: string, observe = false) => {
  let initialMetadata: BigIntStats
  try {
    initialMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) {
      return false
    }
    throw error
  }
  if (initialMetadata.isDirectory() && !initialMetadata.isSymbolicLink()) {
    if (observe) {
      repositoryTestHooks.afterGitDirectoryLstat?.(path)
    }
    try {
      realpathSync.native(path)
      const finalMetadata = lstatSync(path, { bigint: true })
      return (
        finalMetadata.isDirectory() && !finalMetadata.isSymbolicLink() && sameIdentity(initialMetadata, finalMetadata)
      )
    } catch (error) {
      if (isMissing(error)) {
        return false
      }
      throw error
    }
  }
  return false
}

const gitMarkerMetadata = (path: string) => {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) {
      return
    }
    throw error
  }
}

const validGitMarker = (directory: string) => {
  const marker = resolve(directory, '.git')
  try {
    const metadata = gitMarkerMetadata(marker)
    if (metadata?.isDirectory() && !metadata.isSymbolicLink()) {
      return verifiedRealDirectory(marker)
    }
    if (metadata?.isFile() && !metadata.isSymbolicLink()) {
      const bytes = readVerifiedRegularFile(marker, MAX_GIT_MARKER_BYTES)
      if (bytes !== undefined) {
        const match = /^gitdir:\s*(.+)$/i.exec(decodeVerifiedUtf8(bytes).trim())
        if (match?.[1] !== undefined) {
          const target = match[1].trim()
          const gitDirectory = isAbsolute(target) ? target : resolve(directory, target)
          return verifiedRealDirectory(gitDirectory, true)
        }
      }
    }
    return false
  } catch (error) {
    if (error instanceof VerifiedFileError) {
      return false
    }
    return wrapIo('Unable to inspect the repository marker.', error)
  }
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

const parsePackageManifest = (bytes: Buffer): PackageManifest => {
  const parsed = JSON.parse(decodeVerifiedUtf8(bytes)) as unknown
  if (parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object') {
    return parsed as PackageManifest
  }
  throw new VerifiedFileError('The package manifest must contain a JSON object.')
}

const packageRootFromModule = (): PackageIdentity => {
  if (executingPackageIdentity !== undefined) {
    return executingPackageIdentity
  }
  let current = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const packagePath = resolve(current, 'package.json')
    try {
      const bytes = readVerifiedRegularFile(packagePath, MAX_PACKAGE_MANIFEST_BYTES)
      if (bytes !== undefined) {
        const packageJson = parsePackageManifest(bytes)
        if (packageJson.name === 'encephalon') {
          if (typeof packageJson.version === 'string') {
            const identity = {
              name: packageJson.name,
              root: realpathSync.native(current),
              version: packageJson.version,
            }
            executingPackageIdentity = identity
            return identity
          }
          throw new VerifiedFileError('The executing package version is invalid.')
        }
      }
    } catch (error) {
      return wrapIo('Unable to inspect the executing package.', error)
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
  try {
    const installedRoot = realpathSync.native(installedPath)
    const executingPackage = packageRootFromModule()
    if (comparablePath(installedRoot) === comparablePath(executingPackage.root)) {
      const bytes = readVerifiedRegularFile(resolve(installedRoot, 'package.json'), MAX_PACKAGE_MANIFEST_BYTES)
      if (bytes === undefined) {
        throw new VerifiedFileError('The installed package manifest is missing.')
      }
      const packageJson = parsePackageManifest(bytes)
      if (
        packageJson.name === executingPackage.name &&
        packageJson.version === executingPackage.version &&
        executingPackage.version === PACKAGE_VERSION
      ) {
        return installedRoot
      }
      if (packageJson.name === executingPackage.name) {
        const installedVersion = typeof packageJson.version === 'string' ? packageJson.version : 'unknown'
        return fail(
          'ROOT_INSTALL_REQUIRED',
          `Root Encephalon package version ${installedVersion} does not match executing version ${PACKAGE_VERSION}. Rebuild or reinstall Encephalon at the repository root before running this command.`,
        )
      }
    }
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    if (!isMissing(error)) {
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
