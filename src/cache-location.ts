import { randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fail } from './errors.ts'

const CACHE_COMPONENTS = ['node_modules', '.cache', 'encephalon'] as const
const DATABASE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

export type CacheEntryIdentity = {
  dev: bigint
  ino: bigint
}

type CacheDirectoryEntry = CacheEntryIdentity & {
  path: string
  relativePath: string
}

export type CacheLocation = {
  directory: string
  entries: readonly [CacheDirectoryEntry, CacheDirectoryEntry, CacheDirectoryEntry, CacheDirectoryEntry]
  repository: string
}

export type CacheDatabase = CacheEntryIdentity & {
  name: CacheDatabaseName
  path: string
}

export type CacheDatabaseName = 'brain.sqlite' | 'operation-lock.sqlite'

export type CacheOwnedDirectory = CacheEntryIdentity & {
  name: string
  path: string
}

type CacheLocationTestHooks = {
  afterQuarantineRename?: ((path: string) => void) | undefined
  beforeQuarantineRename?: ((path: string) => void) | undefined
}

export const cacheLocationTestHooks: CacheLocationTestHooks = {}

export const sameCacheEntryIdentity = (first: CacheEntryIdentity, second: CacheEntryIdentity) =>
  first.dev === second.dev && first.ino === second.ino

const identityFrom = (metadata: BigIntStats): CacheEntryIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
})

const missingPath = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

const existingPath = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST'

const comparablePath = (path: string) => {
  const normalized = path.replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const samePath = (first: string, second: string) => comparablePath(first) === comparablePath(second)

const invalidLayout = (relativePath: string, invariant: string): never =>
  fail('VALIDATION_FAILED', 'The Encephalon cache layout is unsafe.', {
    entry: relativePath,
    invariant,
  })

const changedLayout = (relativePath: string, invariant: string): never =>
  fail('REPOSITORY_CHANGED', 'The Encephalon cache layout changed during the operation.', {
    entry: relativePath,
    invariant,
  })

const inspectDirectory = (
  path: string,
  relativePath: string,
  expectedRealpath: string,
  create: boolean,
): CacheDirectoryEntry => {
  if (create) {
    try {
      mkdirSync(path)
    } catch (error) {
      if (!existingPath(error)) {
        throw error
      }
    }
  }
  let metadata: BigIntStats
  try {
    metadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return invalidLayout(relativePath, 'directory-present')
    }
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return invalidLayout(relativePath, 'real-directory')
  }
  const actualRealpath = realpathSync.native(path)
  if (!samePath(actualRealpath, expectedRealpath)) {
    return invalidLayout(relativePath, 'expected-realpath')
  }
  return { ...identityFrom(metadata), path, relativePath }
}

const assertDirectoryEntry = (entry: CacheDirectoryEntry) => {
  let metadata: BigIntStats
  try {
    metadata = lstatSync(entry.path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return changedLayout(entry.relativePath, 'directory-present')
    }
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return changedLayout(entry.relativePath, 'real-directory')
  }
  if (!sameCacheEntryIdentity(entry, identityFrom(metadata))) {
    return changedLayout(entry.relativePath, 'stable-identity')
  }
  if (!samePath(realpathSync.native(entry.path), entry.path)) {
    return changedLayout(entry.relativePath, 'expected-realpath')
  }
}

const assertContained = (repository: string, directory: string) => {
  const cacheRelative = relative(repository, directory)
  if (
    cacheRelative.length === 0 ||
    cacheRelative === '..' ||
    cacheRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(cacheRelative)
  ) {
    return invalidLayout('node_modules/.cache/encephalon', 'repository-contained')
  }
}

export const inspectCacheLocation = (root: string): CacheLocation => {
  const repository = realpathSync.native(resolve(root))
  const repositoryEntry = inspectDirectory(repository, '.', repository, false)
  const entries = CACHE_COMPONENTS.reduce<CacheDirectoryEntry[]>(
    (result, component) => {
      const parent = result.at(-1) ?? repositoryEntry
      const path = resolve(parent.path, component)
      const relativePath = parent.relativePath === '.' ? component : `${parent.relativePath}/${component}`
      return [...result, inspectDirectory(path, relativePath, path, true)]
    },
    [repositoryEntry],
  )
  const [capturedRepository, nodeModules, cache, directory] = entries
  if (capturedRepository === undefined || nodeModules === undefined || cache === undefined || directory === undefined) {
    return fail('INTERNAL_ERROR', 'The Encephalon cache location could not be captured.')
  }
  assertContained(repository, directory.path)
  return {
    directory: directory.path,
    entries: [capturedRepository, nodeModules, cache, directory],
    repository,
  }
}

export const assertCacheLocation = (location: CacheLocation) => {
  location.entries.forEach(assertDirectoryEntry)
  assertContained(location.repository, location.directory)
}

const databaseRelativePath = (name: CacheDatabaseName) => `node_modules/.cache/encephalon/${name}`

const inspectRegularFile = (path: string, relativePath: string): CacheEntryIdentity | undefined => {
  let metadata: BigIntStats
  try {
    metadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return
    }
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return invalidLayout(relativePath, 'regular-non-symlink-file')
  }
  const captured = identityFrom(metadata)
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW)
    const opened = fstatSync(descriptor, { bigint: true })
    if (!(opened.isFile() && sameCacheEntryIdentity(captured, identityFrom(opened)))) {
      return changedLayout(relativePath, 'stable-open-identity')
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
  return captured
}

const inspectSidecars = (location: CacheLocation, name: CacheDatabaseName) => {
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    inspectRegularFile(resolve(location.directory, `${name}${suffix}`), `${databaseRelativePath(name)}${suffix}`)
  }
}

const bootstrapPrimary = (location: CacheLocation, name: CacheDatabaseName) => {
  const path = resolve(location.directory, name)
  const relativePath = databaseRelativePath(name)
  let created = false
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW, 0o600)
    closeSync(descriptor)
    created = true
  } catch (error) {
    if (!existingPath(error)) {
      throw error
    }
  }
  const identity = inspectRegularFile(path, relativePath)
  if (identity === undefined) {
    return changedLayout(relativePath, created ? 'created-file-present' : 'existing-file-present')
  }
  return identity
}

export const prepareCacheDatabase = (location: CacheLocation, name: CacheDatabaseName): CacheDatabase => {
  assertCacheLocation(location)
  inspectSidecars(location, name)
  const path = resolve(location.directory, name)
  const existing = inspectRegularFile(path, databaseRelativePath(name))
  const identity = existing ?? bootstrapPrimary(location, name)
  assertCacheLocation(location)
  inspectSidecars(location, name)
  return { ...identity, name, path }
}

export const inspectCacheDatabase = (location: CacheLocation, name: CacheDatabaseName): CacheDatabase | undefined => {
  assertCacheLocation(location)
  inspectSidecars(location, name)
  const path = resolve(location.directory, name)
  const identity = inspectRegularFile(path, databaseRelativePath(name))
  return identity === undefined ? undefined : { ...identity, name, path }
}

export const assertCacheDatabase = (location: CacheLocation, database: CacheDatabase) => {
  assertCacheLocation(location)
  const identity = inspectRegularFile(database.path, databaseRelativePath(database.name))
  if (identity === undefined || !sameCacheEntryIdentity(database, identity)) {
    return changedLayout(databaseRelativePath(database.name), 'stable-identity')
  }
  inspectSidecars(location, database.name)
}

const quarantineFile = (location: CacheLocation, path: string, relativePath: string) => {
  const captured = inspectRegularFile(path, relativePath)
  if (captured !== undefined) {
    assertCacheLocation(location)
    cacheLocationTestHooks.beforeQuarantineRename?.(path)
    assertCacheLocation(location)
    const current = inspectRegularFile(path, relativePath)
    if (current === undefined || !sameCacheEntryIdentity(captured, current)) {
      return changedLayout(relativePath, 'stable-quarantine-source')
    }
    const quarantineName = `.${relativePath.split('/').at(-1)}.${randomUUID()}.quarantine`
    const quarantinePath = resolve(location.directory, quarantineName)
    renameSync(path, quarantinePath)
    assertCacheLocation(location)
    cacheLocationTestHooks.afterQuarantineRename?.(quarantinePath)
    assertCacheLocation(location)
    const quarantined = inspectRegularFile(quarantinePath, `node_modules/.cache/encephalon/${quarantineName}`)
    if (quarantined === undefined || !sameCacheEntryIdentity(captured, quarantined)) {
      return changedLayout(relativePath, 'stable-quarantine-identity')
    }
    unlinkSync(quarantinePath)
    assertCacheLocation(location)
  }
}

export const quarantineCacheDatabase = (location: CacheLocation, name: CacheDatabaseName) => {
  assertCacheLocation(location)
  for (const suffix of [...DATABASE_SIDECAR_SUFFIXES, ''] as const) {
    const candidateName = `${name}${suffix}`
    quarantineFile(
      location,
      resolve(location.directory, candidateName),
      `node_modules/.cache/encephalon/${candidateName}`,
    )
  }
}

const safeOwnedDirectoryName = (name: string) =>
  name === 'operation.lock' || name === 'operation-lock.recovery' || /^operation\.lock\.[0-9a-f-]{36}$/u.test(name)

const ownedDirectoryRelativePath = (name: string) => `node_modules/.cache/encephalon/${name}`

const inspectOwnedDirectoryPath = (location: CacheLocation, name: string): CacheOwnedDirectory | undefined => {
  if (!safeOwnedDirectoryName(name)) {
    return fail('INTERNAL_ERROR', 'An unsupported cache directory name was requested.')
  }
  const path = resolve(location.directory, name)
  let metadata: BigIntStats
  try {
    metadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return
    }
    throw error
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(realpathSync.native(path), path)) {
    return invalidLayout(ownedDirectoryRelativePath(name), 'real-directory')
  }
  return { ...identityFrom(metadata), name, path }
}

export const inspectCacheOwnedDirectory = (location: CacheLocation, name: string) => {
  assertCacheLocation(location)
  return inspectOwnedDirectoryPath(location, name)
}

export const assertCacheOwnedEntries = (location: CacheLocation) => {
  assertCacheLocation(location)
  readdirSync(location.directory)
    .filter(name => /^operation\.lock\.[0-9a-f-]{36}$/u.test(name))
    .map(name => inspectOwnedDirectoryPath(location, name))
}

export const createCacheOwnedDirectory = (location: CacheLocation, name: string) => {
  assertCacheLocation(location)
  if (!safeOwnedDirectoryName(name)) {
    return fail('INTERNAL_ERROR', 'An unsupported cache directory name was requested.')
  }
  mkdirSync(resolve(location.directory, name))
  const directory = inspectOwnedDirectoryPath(location, name)
  if (directory === undefined) {
    return changedLayout(ownedDirectoryRelativePath(name), 'created-directory-present')
  }
  return directory
}

const assertOwnedDirectory = (location: CacheLocation, directory: CacheOwnedDirectory) => {
  assertCacheLocation(location)
  const current = inspectOwnedDirectoryPath(location, directory.name)
  if (current === undefined || !sameCacheEntryIdentity(directory, current)) {
    return changedLayout(ownedDirectoryRelativePath(directory.name), 'stable-identity')
  }
}

export const writeCacheOwner = (location: CacheLocation, directory: CacheOwnedDirectory, contents: string) => {
  assertOwnedDirectory(location, directory)
  const path = resolve(directory.path, 'owner.json')
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600)
  try {
    const bytes = Buffer.from(contents)
    let offset = 0
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset)
    }
  } finally {
    closeSync(descriptor)
  }
  assertOwnedDirectory(location, directory)
  inspectRegularFile(path, `${ownedDirectoryRelativePath(directory.name)}/owner.json`)
}

export const readCacheOwner = (location: CacheLocation, directory: CacheOwnedDirectory, maximumBytes: number) => {
  assertOwnedDirectory(location, directory)
  const path = resolve(directory.path, 'owner.json')
  const captured = inspectRegularFile(path, `${ownedDirectoryRelativePath(directory.name)}/owner.json`)
  if (captured === undefined) {
    return
  }
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW)
  try {
    const metadata = fstatSync(descriptor, { bigint: true })
    if (!sameCacheEntryIdentity(captured, identityFrom(metadata)) || metadata.size > BigInt(maximumBytes)) {
      return invalidLayout(`${ownedDirectoryRelativePath(directory.name)}/owner.json`, 'bounded-stable-owner-file')
    }
    const bytes = Buffer.alloc(Number(metadata.size))
    const read = readSync(descriptor, bytes, 0, bytes.length, 0)
    if (read !== bytes.length) {
      return changedLayout(`${ownedDirectoryRelativePath(directory.name)}/owner.json`, 'complete-owner-read')
    }
    return bytes.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export const quarantineCacheOwnedDirectory = (location: CacheLocation, directory: CacheOwnedDirectory) => {
  assertOwnedDirectory(location, directory)
  cacheLocationTestHooks.beforeQuarantineRename?.(directory.path)
  assertOwnedDirectory(location, directory)
  const quarantineName = `.${directory.name}.${randomUUID()}.quarantine`
  const quarantinePath = resolve(location.directory, quarantineName)
  renameSync(directory.path, quarantinePath)
  assertCacheLocation(location)
  cacheLocationTestHooks.afterQuarantineRename?.(quarantinePath)
  assertCacheLocation(location)
  const metadata = lstatSync(quarantinePath, { bigint: true })
  if (!(metadata.isDirectory() && sameCacheEntryIdentity(directory, identityFrom(metadata)))) {
    return changedLayout(ownedDirectoryRelativePath(directory.name), 'stable-quarantine-identity')
  }
  const ownerPath = resolve(quarantinePath, 'owner.json')
  const owner = inspectRegularFile(ownerPath, `${ownedDirectoryRelativePath(directory.name)}/owner.json`)
  if (owner !== undefined) {
    unlinkSync(ownerPath)
  }
  rmdirSync(quarantinePath)
  assertCacheLocation(location)
}
