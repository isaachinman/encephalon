import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  captureDirectoryWitness,
  type DirectoryWitness,
  DirectoryWitnessError,
  revalidateDirectoryWitness,
} from './directory-witness.ts'
import { fail, wrapIo } from './errors.ts'
import { sameStableEntryMetadata } from './filesystem-entry.ts'
import { PACKAGE_VERSION } from './generated/version.ts'
import { decodeVerifiedUtf8, readVerifiedRegularFile, VerifiedFileError } from './verified-file.ts'

export type DiscoverRepositoryInput = {
  root?: string
  start?: string
}

type PackageIdentity = {
  directory: DirectoryWitness
  name: string
  version: string
}

type PackageManifest = {
  name?: unknown
  version?: unknown
}

type RepositoryTestHooks = {
  afterExecutingManifestRead?: ((path: string) => void) | undefined
  afterExecutingParentCapture?: ((path: string) => void) | undefined
  afterGitDirectoryLstat?: ((path: string) => void) | undefined
  afterGitMarkerDecision?: (() => void) | undefined
  afterInstalledManifestRead?: ((path: string) => void) | undefined
  afterRepositoryParentCapture?: ((path: string) => void) | undefined
  afterRootInstallation?: (() => void) | undefined
  executingSearchBoundary?: string | undefined
}

export const repositoryTestHooks: RepositoryTestHooks = {}

const MAX_GIT_MARKER_BYTES = 16_384
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024
const installRequiredMessage = 'Install Encephalon at the Git repository root before running this command.'
let executingPackageIdentity: PackageIdentity | undefined

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const isMissingOrNotDirectory = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return code === 'ENOENT' || code === 'ENOTDIR'
}
const isPathReplacement = (error: unknown) =>
  error instanceof DirectoryWitnessError ||
  isMissingOrNotDirectory(error) ||
  (error as NodeJS.ErrnoException).code === 'ELOOP'

const captureLinkedDirectory = (path: string) => captureDirectoryWitness(path, { allowLink: true })
const captureRealDirectory = (path: string, afterCanonicalisation?: () => void) =>
  captureDirectoryWitness(path, { afterCanonicalisation, allowLink: false })

const validGitMarker = (directory: DirectoryWitness) => {
  const marker = resolve(directory.canonicalPath, '.git')
  try {
    let markerValid = false
    try {
      const markerDirectory = captureRealDirectory(marker)
      revalidateDirectoryWitness(markerDirectory)
      markerValid = true
    } catch (error) {
      if (!(error instanceof DirectoryWitnessError || isMissing(error))) {
        throw error
      }
      const bytes = readVerifiedRegularFile(marker, MAX_GIT_MARKER_BYTES)
      if (bytes !== undefined) {
        const match = /^gitdir:\s*(.+)$/i.exec(decodeVerifiedUtf8(bytes).trim())
        if (match?.[1] !== undefined) {
          const target = match[1].trim()
          if (target.length > 0 && !target.includes('\0')) {
            const gitDirectory = isAbsolute(target) ? target : resolve(directory.canonicalPath, target)
            const administrationDirectory = captureRealDirectory(gitDirectory, () =>
              repositoryTestHooks.afterGitDirectoryLstat?.(gitDirectory),
            )
            revalidateDirectoryWitness(administrationDirectory)
            markerValid = true
          }
        }
      }
    }
    repositoryTestHooks.afterGitMarkerDecision?.()
    revalidateDirectoryWitness(directory)
    return markerValid
  } catch (error) {
    if (error instanceof DirectoryWitnessError || error instanceof VerifiedFileError || isMissing(error)) {
      return false
    }
    return wrapIo('Unable to inspect the repository marker.', error)
  }
}

const captureRepositoryDirectory = (path: string, options: { explicit: boolean }) => {
  try {
    return captureLinkedDirectory(resolve(path))
  } catch (error) {
    if (options.explicit && error instanceof DirectoryWitnessError) {
      return fail('INVALID_REPOSITORY', 'The explicit root is not a Git repository.')
    }
    return wrapIo('Unable to resolve the repository path.', error)
  }
}

const discoverRepositoryWitness = (input: DiscoverRepositoryInput = {}) => {
  if (input.root !== undefined) {
    const explicitRoot = captureRepositoryDirectory(input.root, { explicit: true })
    if (validGitMarker(explicitRoot)) {
      return explicitRoot
    }
    return fail('INVALID_REPOSITORY', 'The explicit root is not a Git repository.')
  }

  let current = captureRepositoryDirectory(input.start ?? process.cwd(), { explicit: false })
  for (;;) {
    if (validGitMarker(current)) {
      return current
    }
    const parentPath = dirname(current.canonicalPath)
    if (parentPath === current.canonicalPath) {
      return fail('REPOSITORY_NOT_FOUND', 'No Git repository was found.')
    }
    const parent = captureRepositoryDirectory(parentPath, { explicit: false })
    try {
      repositoryTestHooks.afterRepositoryParentCapture?.(current.path)
      revalidateDirectoryWitness(current)
    } catch (error) {
      if (isPathReplacement(error)) {
        return fail('INVALID_REPOSITORY', 'The repository path changed during discovery.')
      }
      return wrapIo('Unable to verify the repository path during discovery.', error)
    }
    current = parent
  }
}

export const discoverRepository = (input: DiscoverRepositoryInput = {}) =>
  discoverRepositoryWitness(input).canonicalPath

const parsePackageManifest = (bytes: Buffer): PackageManifest => {
  const parsed = JSON.parse(decodeVerifiedUtf8(bytes)) as unknown
  if (parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object') {
    return parsed as PackageManifest
  }
  throw new VerifiedFileError('The package manifest must contain a JSON object.')
}

const findExecutingPackage = (): PackageIdentity => {
  if (executingPackageIdentity !== undefined) {
    return executingPackageIdentity
  }
  let current: DirectoryWitness
  try {
    current = captureLinkedDirectory(dirname(fileURLToPath(import.meta.url)))
  } catch (error) {
    return wrapIo('Unable to inspect the executing package.', error)
  }
  for (;;) {
    let packageJson: PackageManifest | undefined
    try {
      const packagePath = resolve(current.canonicalPath, 'package.json')
      const bytes = readVerifiedRegularFile(packagePath, MAX_PACKAGE_MANIFEST_BYTES)
      if (bytes !== undefined) {
        packageJson = parsePackageManifest(bytes)
        repositoryTestHooks.afterExecutingManifestRead?.(packagePath)
      }
      revalidateDirectoryWitness(current)
    } catch (error) {
      return wrapIo('Unable to inspect the executing package.', error)
    }
    if (packageJson?.name === 'encephalon') {
      if (typeof packageJson.version === 'string') {
        const identity = {
          directory: current,
          name: packageJson.name,
          version: packageJson.version,
        }
        executingPackageIdentity = identity
        return identity
      }
      return wrapIo('Unable to inspect the executing package.', new VerifiedFileError())
    }
    if (
      repositoryTestHooks.executingSearchBoundary !== undefined &&
      comparablePath(current.canonicalPath) === comparablePath(repositoryTestHooks.executingSearchBoundary)
    ) {
      return fail('ROOT_INSTALL_REQUIRED', 'Unable to locate the executing Encephalon package.')
    }
    const parentPath = dirname(current.canonicalPath)
    if (parentPath === current.canonicalPath) {
      return fail('ROOT_INSTALL_REQUIRED', 'Unable to locate the executing Encephalon package.')
    }
    try {
      const parent = captureLinkedDirectory(parentPath)
      repositoryTestHooks.afterExecutingParentCapture?.(current.path)
      revalidateDirectoryWitness(current)
      current = parent
    } catch (error) {
      return wrapIo('Unable to inspect the executing package.', error)
    }
  }
}

const comparablePath = (path: string) => {
  const normalized = path.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const rootInstallationRequired = (): never => fail('ROOT_INSTALL_REQUIRED', installRequiredMessage)

const installedVerificationError = (error: unknown): never => {
  if (
    error instanceof DirectoryWitnessError ||
    error instanceof VerifiedFileError ||
    error instanceof SyntaxError ||
    isMissingOrNotDirectory(error) ||
    (error as NodeJS.ErrnoException).code === 'ELOOP'
  ) {
    return rootInstallationRequired()
  }
  return wrapIo('Unable to verify the root Encephalon installation.', error)
}

const assertRootInstallationWitness = (root: DirectoryWitness) => {
  const installedPath = resolve(root.canonicalPath, 'node_modules', 'encephalon')
  let installedDirectory: DirectoryWitness
  try {
    installedDirectory = captureLinkedDirectory(installedPath)
  } catch (error) {
    return installedVerificationError(error)
  }

  const executingPackage = findExecutingPackage()
  if (
    comparablePath(installedDirectory.canonicalPath) === comparablePath(executingPackage.directory.canonicalPath) &&
    sameStableEntryMetadata(installedDirectory.canonicalMetadata, executingPackage.directory.canonicalMetadata)
  ) {
    let packageJson: PackageManifest
    try {
      const packagePath = resolve(installedDirectory.canonicalPath, 'package.json')
      const bytes = readVerifiedRegularFile(packagePath, MAX_PACKAGE_MANIFEST_BYTES)
      if (bytes === undefined) {
        return rootInstallationRequired()
      }
      packageJson = parsePackageManifest(bytes)
      repositoryTestHooks.afterInstalledManifestRead?.(packagePath)
      revalidateDirectoryWitness(installedDirectory)
    } catch (error) {
      return installedVerificationError(error)
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

export const assertRootInstallation = (root: string) => assertRootInstallationWitness(captureLinkedDirectory(root))

export const resolveRepository = (input: { root?: string } = {}) => {
  const root = discoverRepositoryWitness(input)
  assertRootInstallationWitness(root)
  try {
    repositoryTestHooks.afterRootInstallation?.()
    revalidateDirectoryWitness(root)
  } catch (error) {
    if (isPathReplacement(error)) {
      return fail('INVALID_REPOSITORY', 'The repository path changed while its installation was verified.')
    }
    return wrapIo('Unable to verify the repository path after installation.', error)
  }
  return root.canonicalPath
}
