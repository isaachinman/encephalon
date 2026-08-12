import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  captureDirectoryWitness,
  type DirectoryWitness,
  DirectoryWitnessError,
  directoryWitnessIsCurrent,
} from './directory-witness.ts'
import { fail, wrapIo } from './errors.ts'
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
  afterExecutingManifestRead?: ((path: string) => void) | undefined
  afterGitDirectoryLstat?: ((path: string) => void) | undefined
  afterInstalledManifestRead?: ((path: string) => void) | undefined
}

export const repositoryTestHooks: RepositoryTestHooks = {}

const MAX_GIT_MARKER_BYTES = 16_384
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024
const installRequiredMessage = 'Install Encephalon at the Git repository root before running this command.'
let executingPackageIdentity: PackageIdentity | undefined

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

const captureCanonicalDirectory = (path: string, allowLink: boolean, afterCanonicalisation?: () => void) =>
  captureDirectoryWitness(path, { afterCanonicalisation, allowLink })

const validGitMarker = (directory: DirectoryWitness) => {
  const marker = resolve(directory.canonicalPath, '.git')
  try {
    let markerValid = false
    try {
      const markerDirectory = captureCanonicalDirectory(marker, false)
      markerValid = directoryWitnessIsCurrent(markerDirectory)
    } catch (error) {
      if (!(error instanceof DirectoryWitnessError || isMissing(error))) {
        throw error
      }
      const bytes = readVerifiedRegularFile(marker, MAX_GIT_MARKER_BYTES)
      if (bytes !== undefined) {
        const match = /^gitdir:\s*(.+)$/i.exec(decodeVerifiedUtf8(bytes).trim())
        if (match?.[1] !== undefined) {
          const target = match[1].trim()
          const gitDirectory = isAbsolute(target) ? target : resolve(directory.canonicalPath, target)
          const administrationDirectory = captureCanonicalDirectory(gitDirectory, false, () =>
            repositoryTestHooks.afterGitDirectoryLstat?.(gitDirectory),
          )
          markerValid = directoryWitnessIsCurrent(administrationDirectory)
        }
      }
    }
    return directoryWitnessIsCurrent(directory) && markerValid
  } catch (error) {
    if (error instanceof DirectoryWitnessError || error instanceof VerifiedFileError || isMissing(error)) {
      return false
    }
    return wrapIo('Unable to inspect the repository marker.', error)
  }
}

const canonicalDirectory = (path: string) => {
  try {
    return captureCanonicalDirectory(resolve(path), true)
  } catch (error) {
    return wrapIo('Unable to resolve the repository path.', error)
  }
}

export const discoverRepository = (input: DiscoverRepositoryInput = {}) => {
  if (input.root !== undefined) {
    const explicitRoot = canonicalDirectory(input.root)
    if (validGitMarker(explicitRoot)) {
      return explicitRoot.canonicalPath
    }
    return fail('INVALID_REPOSITORY', 'The explicit root is not a Git repository.')
  }

  let current = canonicalDirectory(input.start ?? process.cwd())
  for (;;) {
    if (validGitMarker(current)) {
      return current.canonicalPath
    }
    const parent = dirname(current.canonicalPath)
    if (parent === current.canonicalPath) {
      return fail('REPOSITORY_NOT_FOUND', 'No Git repository was found.')
    }
    current = canonicalDirectory(parent)
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
    let parent: string
    try {
      const directory = captureCanonicalDirectory(current, true)
      const packagePath = resolve(directory.canonicalPath, 'package.json')
      const bytes = readVerifiedRegularFile(packagePath, MAX_PACKAGE_MANIFEST_BYTES)
      let packageJson: PackageManifest | undefined
      if (bytes !== undefined) {
        packageJson = parsePackageManifest(bytes)
        repositoryTestHooks.afterExecutingManifestRead?.(packagePath)
      }
      if (!directoryWitnessIsCurrent(directory)) {
        throw new DirectoryWitnessError()
      }
      if (packageJson?.name === 'encephalon') {
        if (typeof packageJson.version === 'string') {
          const identity = {
            name: packageJson.name,
            root: directory.canonicalPath,
            version: packageJson.version,
          }
          executingPackageIdentity = identity
          return identity
        }
        throw new VerifiedFileError('The executing package version is invalid.')
      }
      parent = dirname(directory.canonicalPath)
      if (parent === directory.canonicalPath) {
        return fail('ROOT_INSTALL_REQUIRED', 'Unable to locate the executing Encephalon package.')
      }
    } catch (error) {
      return wrapIo('Unable to inspect the executing package.', error)
    }
    current = parent
  }
}

const comparablePath = (path: string) => {
  const normalized = path.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const rootInstallationRequired = (): never => fail('ROOT_INSTALL_REQUIRED', installRequiredMessage)

export const assertRootInstallation = (root: string) => {
  const installedPath = resolve(root, 'node_modules', 'encephalon')
  let installedDirectory: DirectoryWitness
  try {
    installedDirectory = captureCanonicalDirectory(installedPath, true)
  } catch {
    return rootInstallationRequired()
  }

  const executingPackage = packageRootFromModule()
  if (comparablePath(installedDirectory.canonicalPath) === comparablePath(executingPackage.root)) {
    let packageJson: PackageManifest
    try {
      const packagePath = resolve(installedDirectory.canonicalPath, 'package.json')
      const bytes = readVerifiedRegularFile(packagePath, MAX_PACKAGE_MANIFEST_BYTES)
      if (bytes === undefined) {
        return rootInstallationRequired()
      }
      packageJson = parsePackageManifest(bytes)
      repositoryTestHooks.afterInstalledManifestRead?.(packagePath)
      if (!directoryWitnessIsCurrent(installedDirectory)) {
        return rootInstallationRequired()
      }
    } catch {
      return rootInstallationRequired()
    }
    if (
      packageJson.name === executingPackage.name &&
      packageJson.version === executingPackage.version &&
      executingPackage.version === PACKAGE_VERSION
    ) {
      return installedDirectory.canonicalPath
    }
    if (packageJson.name === executingPackage.name) {
      const installedVersion = typeof packageJson.version === 'string' ? packageJson.version : 'unknown'
      return fail(
        'ROOT_INSTALL_REQUIRED',
        `Root Encephalon package version ${installedVersion} does not match executing version ${PACKAGE_VERSION}. Rebuild or reinstall Encephalon at the repository root before running this command.`,
      )
    }
  }
  return rootInstallationRequired()
}

export const resolveRepository = (input: { root?: string } = {}) => {
  const root = discoverRepository(input)
  assertRootInstallation(root)
  return root
}
