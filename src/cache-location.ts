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
import { EncephalonError, fail } from './errors.ts'

const CACHE_COMPONENTS = ['node_modules', '.cache', 'encephalon'] as const
const DATABASE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const
const OPTIONAL_FILE_OBSERVATION_ATTEMPTS = 3
const MAX_CACHE_DATABASE_OPEN_ATTEMPTS = 3
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

export type CacheEntryIdentity = {
  dev: bigint
  ino: bigint
}

type CacheEntryIncarnation = CacheEntryIdentity & {
  birthtimeNs: bigint
  ctimeNs: bigint
  mode: bigint
  mtimeNs: bigint
  size: bigint
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

type CacheFile = CacheEntryIdentity & {
  path: string
  relativePath: string
}

type CacheDatabaseSidecarSuffix = (typeof DATABASE_SIDECAR_SUFFIXES)[number]

export type CacheDatabase = CacheFile & {
  name: CacheDatabaseName
  sidecars: Partial<Record<CacheDatabaseSidecarSuffix, CacheFile>>
}

export type CacheDatabaseName = 'brain.sqlite' | 'operation-lock.sqlite'

type CacheDatabaseConstructor<Database> = new (
  path: string,
  options?: {
    readOnly?: boolean
    timeout?: number
  },
) => Database

type VerifiedCacheDatabaseOptions<Database> = {
  afterVerifiedOpen?: ((database: Database) => void) | undefined
  create: boolean
  DatabaseConstructor: CacheDatabaseConstructor<Database>
  location: CacheLocation
  missing?: (() => never) | undefined
  name: CacheDatabaseName
  openOptions?: {
    readOnly?: boolean
    timeout?: number
  }
  preserveDatabaseLocksAfterInitialisation?: boolean
}

export type CacheOwnedDirectory = CacheEntryIdentity & {
  name: string
  path: string
}

export class CacheDatabaseFailure extends Error {
  readonly database: CacheDatabase
  readonly failure: unknown

  constructor(failure: unknown, database: CacheDatabase, options: ErrorOptions) {
    super(failure instanceof Error ? failure.message : 'The SQLite cache operation failed.', options)
    this.name = 'CacheDatabaseFailure'
    this.database = database
    this.failure = failure
  }
}

class CacheDatabaseSidecarChanged extends EncephalonError {
  readonly database: CacheDatabase

  constructor(database: CacheDatabase, relativePath: string) {
    super('REPOSITORY_CHANGED', 'The Encephalon cache layout changed during the operation.', {
      entry: relativePath,
      invariant: 'stable-identity',
    })
    this.name = 'CacheDatabaseSidecarChanged'
    this.database = database
  }
}

export const failCacheDatabase = (failure: unknown, database: CacheDatabase): never => {
  throw new CacheDatabaseFailure(failure, database, { cause: failure })
}

type CacheLocationTestHooks = {
  afterDatabaseLockInitialisation?: ((database: CacheDatabase) => void) | undefined
  afterDatabaseOpen?: ((database: CacheDatabase) => void) | undefined
  afterQuarantineRename?: ((path: string) => void) | undefined
  beforeDatabaseOpen?: ((database: CacheDatabase) => void) | undefined
  beforeLocationInspection?: (() => void) | undefined
  beforeOwnedDirectoryFinalIdentity?: ((path: string) => void) | undefined
  beforeQuarantineRename?: ((path: string) => void) | undefined
  duringOwnedDirectoryInspection?: ((path: string) => void) | undefined
}

export const cacheLocationTestHooks: CacheLocationTestHooks = {}

export const sameCacheEntryIdentity = (first: CacheEntryIdentity, second: CacheEntryIdentity) =>
  first.dev === second.dev && first.ino === second.ino

const identityFrom = (metadata: BigIntStats): CacheEntryIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
})

const incarnationFrom = (metadata: BigIntStats): CacheEntryIncarnation => ({
  ...identityFrom(metadata),
  birthtimeNs: metadata.birthtimeNs,
  ctimeNs: metadata.ctimeNs,
  mode: metadata.mode,
  mtimeNs: metadata.mtimeNs,
  size: metadata.size,
})

const sameCacheEntryIncarnation = (first: CacheEntryIncarnation, second: CacheEntryIncarnation) =>
  sameCacheEntryIdentity(first, second) &&
  first.birthtimeNs === second.birthtimeNs &&
  first.ctimeNs === second.ctimeNs &&
  first.mode === second.mode &&
  first.mtimeNs === second.mtimeNs &&
  first.size === second.size

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

const quarantineMetadata = (path: string, relativePath: string) => {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return changedLayout(relativePath, 'stable-quarantine-identity')
    }
    throw error
  }
}

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
  cacheLocationTestHooks.beforeLocationInspection?.()
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

type RegularFileInspection = { kind: 'changed' } | { kind: 'missing' } | { file: CacheFile; kind: 'stable' }

const inspectRegularFileOnce = (path: string, relativePath: string): RegularFileInspection => {
  let metadata: BigIntStats
  try {
    metadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'missing' }
    }
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return invalidLayout(relativePath, 'regular-non-symlink-file')
  }
  const captured = identityFrom(metadata)
  let actualRealpath: string
  try {
    actualRealpath = realpathSync.native(path)
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'changed' }
    }
    throw error
  }
  if (!samePath(actualRealpath, path)) {
    return invalidLayout(relativePath, 'expected-realpath')
  }
  let descriptor: number | undefined
  try {
    try {
      descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW)
    } catch (error) {
      if (missingPath(error)) {
        return { kind: 'changed' }
      }
      throw error
    }
    const opened = fstatSync(descriptor, { bigint: true })
    if (!(opened.isFile() && sameCacheEntryIdentity(captured, identityFrom(opened)))) {
      return { kind: 'changed' }
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
  return { file: { ...captured, path, relativePath }, kind: 'stable' }
}

const inspectRegularFile = (path: string, relativePath: string, optional = false): CacheFile | undefined => {
  const attempts = optional ? OPTIONAL_FILE_OBSERVATION_ATTEMPTS : 1
  for (const attempt of Array.from({ length: attempts }, (_, index) => index)) {
    const inspection = inspectRegularFileOnce(path, relativePath)
    if (inspection.kind === 'stable') {
      return inspection.file
    }
    if (inspection.kind === 'missing' && (!optional || attempt === attempts - 1)) {
      return
    }
  }
  return changedLayout(relativePath, 'stable-open-identity')
}

const inspectRegularFileMetadataOnce = (path: string, relativePath: string): RegularFileInspection => {
  let initialMetadata: BigIntStats
  try {
    initialMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'missing' }
    }
    throw error
  }
  if (!initialMetadata.isFile() || initialMetadata.isSymbolicLink()) {
    return invalidLayout(relativePath, 'regular-non-symlink-file')
  }
  const captured = identityFrom(initialMetadata)
  let actualRealpath: string
  try {
    actualRealpath = realpathSync.native(path)
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'changed' }
    }
    throw error
  }
  if (!samePath(actualRealpath, path)) {
    return invalidLayout(relativePath, 'expected-realpath')
  }
  let finalMetadata: BigIntStats
  try {
    finalMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'changed' }
    }
    throw error
  }
  if (
    !finalMetadata.isFile() ||
    finalMetadata.isSymbolicLink() ||
    !sameCacheEntryIdentity(captured, identityFrom(finalMetadata))
  ) {
    return { kind: 'changed' }
  }
  return { file: { ...captured, path, relativePath }, kind: 'stable' }
}

const inspectRegularFileMetadata = (path: string, relativePath: string, optional = false): CacheFile | undefined => {
  const attempts = optional ? OPTIONAL_FILE_OBSERVATION_ATTEMPTS : 1
  for (const attempt of Array.from({ length: attempts }, (_, index) => index)) {
    const inspection = inspectRegularFileMetadataOnce(path, relativePath)
    if (inspection.kind === 'stable') {
      return inspection.file
    }
    if (inspection.kind === 'missing' && (!optional || attempt === attempts - 1)) {
      return
    }
  }
  return changedLayout(relativePath, 'stable-metadata-identity')
}

const inspectSidecars = (location: CacheLocation, name: CacheDatabaseName) =>
  DATABASE_SIDECAR_SUFFIXES.reduce<Partial<Record<CacheDatabaseSidecarSuffix, CacheFile>>>((sidecars, suffix) => {
    const file = inspectRegularFile(
      resolve(location.directory, `${name}${suffix}`),
      `${databaseRelativePath(name)}${suffix}`,
      true,
    )
    return file === undefined ? sidecars : { ...sidecars, [suffix]: file }
  }, {})

const inspectSidecarMetadata = (location: CacheLocation, name: CacheDatabaseName) =>
  DATABASE_SIDECAR_SUFFIXES.reduce<Partial<Record<CacheDatabaseSidecarSuffix, CacheFile>>>((sidecars, suffix) => {
    const file = inspectRegularFileMetadata(
      resolve(location.directory, `${name}${suffix}`),
      `${databaseRelativePath(name)}${suffix}`,
      true,
    )
    return file === undefined ? sidecars : { ...sidecars, [suffix]: file }
  }, {})

const reconcileSidecarSnapshots = (
  database: CacheDatabase,
  observed: Partial<Record<CacheDatabaseSidecarSuffix, CacheFile>>,
) => {
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    const expected = database.sidecars[suffix]
    const current = observed[suffix]
    if (expected !== undefined && current !== undefined && !sameCacheEntryIdentity(expected, current)) {
      throw new CacheDatabaseSidecarChanged(
        { ...database, sidecars: observed },
        `${databaseRelativePath(database.name)}${suffix}`,
      )
    }
  }
  return observed
}

const reconcileSidecars = (location: CacheLocation, database: CacheDatabase) =>
  reconcileSidecarSnapshots(database, inspectSidecars(location, database.name))

const reconcileSidecarMetadata = (location: CacheLocation, database: CacheDatabase) =>
  reconcileSidecarSnapshots(database, inspectSidecarMetadata(location, database.name))

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

const prepareCacheDatabase = (location: CacheLocation, name: CacheDatabaseName): CacheDatabase => {
  assertCacheLocation(location)
  const sidecars = inspectSidecars(location, name)
  const path = resolve(location.directory, name)
  const existing = inspectRegularFile(path, databaseRelativePath(name))
  const identity = existing ?? bootstrapPrimary(location, name)
  assertCacheLocation(location)
  return { ...identity, name, sidecars: { ...sidecars, ...inspectSidecars(location, name) } }
}

export const inspectCacheDatabase = (location: CacheLocation, name: CacheDatabaseName): CacheDatabase | undefined => {
  assertCacheLocation(location)
  const sidecars = inspectSidecars(location, name)
  const path = resolve(location.directory, name)
  const identity = inspectRegularFile(path, databaseRelativePath(name))
  return identity === undefined ? undefined : { ...identity, name, sidecars }
}

export const assertCacheDatabase = (location: CacheLocation, database: CacheDatabase) => {
  assertCacheLocation(location)
  const identity = inspectRegularFile(database.path, databaseRelativePath(database.name))
  if (identity === undefined || !sameCacheEntryIdentity(database, identity)) {
    return changedLayout(databaseRelativePath(database.name), 'stable-identity')
  }
  return { ...database, sidecars: reconcileSidecars(location, database) }
}

const assertCacheDatabaseMetadata = (location: CacheLocation, database: CacheDatabase) => {
  // Opening and closing any sibling file descriptor after BEGIN can release
  // process-scoped SQLite locks on POSIX, so this boundary observes metadata only.
  assertCacheLocation(location)
  const identity = inspectRegularFileMetadata(database.path, databaseRelativePath(database.name))
  if (identity === undefined || !sameCacheEntryIdentity(database, identity)) {
    return changedLayout(databaseRelativePath(database.name), 'stable-identity')
  }
  assertCacheLocation(location)
  const sidecars = reconcileSidecarMetadata(location, database)
  assertCacheLocation(location)
  return { ...database, sidecars }
}

export const openVerifiedCacheDatabase = <Database extends { close: () => void }>(
  options: VerifiedCacheDatabaseOptions<Database>,
) => {
  const initial = options.create
    ? prepareCacheDatabase(options.location, options.name)
    : inspectCacheDatabase(options.location, options.name)
  if (initial === undefined) {
    if (options.missing !== undefined) {
      return options.missing()
    }
    return fail('INTERNAL_ERROR', 'The requested Encephalon cache database is missing.')
  }
  let snapshot = initial
  const attempts = Array.from({ length: MAX_CACHE_DATABASE_OPEN_ATTEMPTS }, (_, index) => index)
  for (const attempt of attempts) {
    try {
      cacheLocationTestHooks.beforeDatabaseOpen?.(snapshot)
      snapshot = assertCacheDatabase(options.location, snapshot)
    } catch (error) {
      if (error instanceof CacheDatabaseSidecarChanged) {
        snapshot = error.database
        if (attempt === MAX_CACHE_DATABASE_OPEN_ATTEMPTS - 1) {
          throw error
        }
        continue
      }
      throw error
    }
    let database: Database
    try {
      database = new options.DatabaseConstructor(snapshot.path, options.openOptions)
    } catch (error) {
      return failCacheDatabase(error, snapshot)
    }
    try {
      cacheLocationTestHooks.afterDatabaseOpen?.(snapshot)
      snapshot = assertCacheDatabase(options.location, snapshot)
      options.afterVerifiedOpen?.(database)
      if (options.preserveDatabaseLocksAfterInitialisation) {
        cacheLocationTestHooks.afterDatabaseLockInitialisation?.(snapshot)
      }
      snapshot = options.preserveDatabaseLocksAfterInitialisation
        ? assertCacheDatabaseMetadata(options.location, snapshot)
        : assertCacheDatabase(options.location, snapshot)
      return database
    } catch (error) {
      if (error instanceof CacheDatabaseSidecarChanged) {
        database.close()
        snapshot = error.database
        if (attempt === MAX_CACHE_DATABASE_OPEN_ATTEMPTS - 1) {
          throw error
        }
      } else {
        let validationError: unknown
        try {
          snapshot = options.preserveDatabaseLocksAfterInitialisation
            ? assertCacheDatabaseMetadata(options.location, snapshot)
            : assertCacheDatabase(options.location, snapshot)
        } catch (candidate) {
          validationError = candidate
        }
        database.close()
        if (validationError !== undefined) {
          throw validationError
        }
        if (error instanceof EncephalonError) {
          throw error
        }
        return failCacheDatabase(error, snapshot)
      }
    }
  }
  return fail('INTERNAL_ERROR', 'The verified Encephalon cache database open ended unexpectedly.')
}

const quarantineFile = (location: CacheLocation, expected: CacheFile, required: boolean) => {
  const current = inspectRegularFile(expected.path, expected.relativePath, !required)
  if (current === undefined) {
    if (required) {
      return changedLayout(expected.relativePath, 'stable-quarantine-source')
    }
  } else {
    if (!sameCacheEntryIdentity(expected, current)) {
      return changedLayout(expected.relativePath, 'stable-quarantine-source')
    }
    assertCacheLocation(location)
    cacheLocationTestHooks.beforeQuarantineRename?.(expected.path)
    assertCacheLocation(location)
    const verified = inspectRegularFile(expected.path, expected.relativePath, !required)
    if (verified === undefined) {
      return changedLayout(expected.relativePath, 'stable-quarantine-source')
    }
    if (!sameCacheEntryIdentity(expected, verified)) {
      return changedLayout(expected.relativePath, 'stable-quarantine-source')
    }
    const quarantineName = `.${expected.relativePath.split('/').at(-1)}.${randomUUID()}.quarantine`
    const quarantinePath = resolve(location.directory, quarantineName)
    renameSync(expected.path, quarantinePath)
    assertCacheLocation(location)
    const movedMetadata = quarantineMetadata(quarantinePath, expected.relativePath)
    if (!(movedMetadata.isFile() && sameCacheEntryIdentity(expected, identityFrom(movedMetadata)))) {
      return changedLayout(expected.relativePath, 'stable-quarantine-identity')
    }
    const movedIncarnation = incarnationFrom(movedMetadata)
    cacheLocationTestHooks.afterQuarantineRename?.(quarantinePath)
    assertCacheLocation(location)
    const quarantinedMetadata = quarantineMetadata(quarantinePath, expected.relativePath)
    if (
      !quarantinedMetadata.isFile() ||
      quarantinedMetadata.isSymbolicLink() ||
      !sameCacheEntryIncarnation(movedIncarnation, incarnationFrom(quarantinedMetadata))
    ) {
      return changedLayout(expected.relativePath, 'stable-quarantine-identity')
    }
    unlinkSync(quarantinePath)
    assertCacheLocation(location)
  }
}

export const quarantineCacheDatabase = (location: CacheLocation, database: CacheDatabase) => {
  assertCacheLocation(location)
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    const sidecar = database.sidecars[suffix]
    if (sidecar !== undefined) {
      quarantineFile(location, sidecar, false)
    }
  }
  quarantineFile(location, database, true)
}

const safeOwnedDirectoryName = (name: string) =>
  name === 'operation.lock' || name === 'operation-lock.recovery' || /^operation\.lock\.[0-9a-f-]{36}$/u.test(name)

const ownedDirectoryRelativePath = (name: string) => `node_modules/.cache/encephalon/${name}`

type CacheOwnedDirectoryObservation =
  | { kind: 'changed' }
  | { kind: 'missing' }
  | { directory: CacheOwnedDirectory; kind: 'stable' }

const observeOwnedDirectoryPath = (location: CacheLocation, name: string): CacheOwnedDirectoryObservation => {
  if (!safeOwnedDirectoryName(name)) {
    return fail('INTERNAL_ERROR', 'An unsupported cache directory name was requested.')
  }
  const path = resolve(location.directory, name)
  let initialMetadata: BigIntStats
  try {
    initialMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      cacheLocationTestHooks.duringOwnedDirectoryInspection?.(path)
      try {
        const replacement = lstatSync(path, { bigint: true })
        if (!replacement.isDirectory() || replacement.isSymbolicLink()) {
          return invalidLayout(ownedDirectoryRelativePath(name), 'real-directory')
        }
        return { kind: 'changed' }
      } catch (candidate) {
        if (missingPath(candidate)) {
          return { kind: 'missing' }
        }
        throw candidate
      }
    }
    throw error
  }
  if (!initialMetadata.isDirectory() || initialMetadata.isSymbolicLink()) {
    return invalidLayout(ownedDirectoryRelativePath(name), 'real-directory')
  }
  const captured = identityFrom(initialMetadata)
  cacheLocationTestHooks.duringOwnedDirectoryInspection?.(path)
  let actualRealpath: string
  try {
    actualRealpath = realpathSync.native(path)
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'changed' }
    }
    throw error
  }
  if (!samePath(actualRealpath, path)) {
    return invalidLayout(ownedDirectoryRelativePath(name), 'real-directory')
  }
  cacheLocationTestHooks.beforeOwnedDirectoryFinalIdentity?.(path)
  let finalMetadata: BigIntStats
  try {
    finalMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'changed' }
    }
    throw error
  }
  if (!finalMetadata.isDirectory() || finalMetadata.isSymbolicLink()) {
    return invalidLayout(ownedDirectoryRelativePath(name), 'real-directory')
  }
  if (!sameCacheEntryIdentity(captured, identityFrom(finalMetadata))) {
    return { kind: 'changed' }
  }
  return { directory: { ...captured, name, path }, kind: 'stable' }
}

export const observeCacheOwnedDirectory = (location: CacheLocation, name: string) => {
  assertCacheLocation(location)
  const observation = observeOwnedDirectoryPath(location, name)
  assertCacheLocation(location)
  return observation
}

export const inspectCacheOwnedDirectory = (location: CacheLocation, name: string) => {
  const observation = observeCacheOwnedDirectory(location, name)
  if (observation.kind === 'changed') {
    return changedLayout(ownedDirectoryRelativePath(name), 'stable-identity')
  }
  return observation.kind === 'stable' ? observation.directory : undefined
}

export const assertCacheLockCandidates = (location: CacheLocation) => {
  assertCacheLocation(location)
  const candidates = readdirSync(location.directory).filter(name => /^operation\.lock\.[0-9a-f-]{36}$/u.test(name))
  // biome-ignore lint/complexity/noForEach: validation intentionally visits every candidate entry.
  candidates.forEach(name => {
    observeCacheOwnedDirectory(location, name)
  })
}

export const createCacheOwnedDirectory = (location: CacheLocation, name: string) => {
  assertCacheLocation(location)
  if (!safeOwnedDirectoryName(name)) {
    return fail('INTERNAL_ERROR', 'An unsupported cache directory name was requested.')
  }
  mkdirSync(resolve(location.directory, name))
  const observation = observeCacheOwnedDirectory(location, name)
  if (observation.kind !== 'stable') {
    return changedLayout(ownedDirectoryRelativePath(name), 'created-directory-present')
  }
  return observation.directory
}

const assertOwnedDirectory = (location: CacheLocation, directory: CacheOwnedDirectory) => {
  const observation = observeCacheOwnedDirectory(location, directory.name)
  if (observation.kind !== 'stable' || !sameCacheEntryIdentity(directory, observation.directory)) {
    return changedLayout(ownedDirectoryRelativePath(directory.name), 'stable-identity')
  }
}

export const cacheOwnedDirectoryIsCurrent = (location: CacheLocation, directory: CacheOwnedDirectory) => {
  const observation = observeCacheOwnedDirectory(location, directory.name)
  return observation.kind === 'stable' && sameCacheEntryIdentity(directory, observation.directory)
}

export const cacheOwnedDirectoryMtimeMilliseconds = (location: CacheLocation, directory: CacheOwnedDirectory) => {
  assertOwnedDirectory(location, directory)
  const metadata = lstatSync(directory.path, { bigint: true })
  if (!sameCacheEntryIdentity(directory, identityFrom(metadata))) {
    return changedLayout(ownedDirectoryRelativePath(directory.name), 'stable-metadata-identity')
  }
  return Number(metadata.mtimeMs)
}

export const promoteCacheOwnedDirectory = (
  location: CacheLocation,
  directory: CacheOwnedDirectory,
  targetName: 'operation.lock',
) => {
  assertOwnedDirectory(location, directory)
  const targetObservation = observeCacheOwnedDirectory(location, targetName)
  if (targetObservation.kind !== 'missing') {
    return changedLayout(ownedDirectoryRelativePath(targetName), 'promotion-target-missing')
  }
  const targetPath = resolve(location.directory, targetName)
  renameSync(directory.path, targetPath)
  assertCacheLocation(location)
  const promoted = observeCacheOwnedDirectory(location, targetName)
  if (promoted.kind !== 'stable' || !sameCacheEntryIdentity(directory, promoted.directory)) {
    return changedLayout(ownedDirectoryRelativePath(targetName), 'stable-promoted-identity')
  }
  return promoted.directory
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
  const movedMetadata = quarantineMetadata(quarantinePath, ownedDirectoryRelativePath(directory.name))
  if (!(movedMetadata.isDirectory() && sameCacheEntryIdentity(directory, identityFrom(movedMetadata)))) {
    return changedLayout(ownedDirectoryRelativePath(directory.name), 'stable-quarantine-identity')
  }
  const movedIncarnation = incarnationFrom(movedMetadata)
  cacheLocationTestHooks.afterQuarantineRename?.(quarantinePath)
  assertCacheLocation(location)
  const metadata = quarantineMetadata(quarantinePath, ownedDirectoryRelativePath(directory.name))
  if (!(metadata.isDirectory() && sameCacheEntryIncarnation(movedIncarnation, incarnationFrom(metadata)))) {
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
