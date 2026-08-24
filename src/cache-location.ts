import { randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
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
import {
  type EntryIdentity,
  type EntryMetadata,
  entryIdentityFrom,
  entryMetadataFrom,
  sameEntryIdentity,
  sameStableEntryMetadata,
} from './filesystem-entry.ts'

const CACHE_COMPONENTS = ['node_modules', '.cache', 'encephalon'] as const
const DATABASE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const
const OPTIONAL_FILE_OBSERVATION_ATTEMPTS = 3
const MAX_CACHE_DATABASE_OPEN_ATTEMPTS = 3
const MAX_CACHE_DATABASE_CLOSE_SAFETY_LATCHES = 4
const CACHE_OWNER_MAXIMUM_BYTES = 4096
const MAX_CACHE_OWNER_PUBLICATION_ATTEMPTS = 3
const CACHE_OWNER_SHARING_RETRY_MILLISECONDS = 10
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

export type CacheEntryIdentity = EntryIdentity

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

type CacheDatabasePrimary =
  | { kind: 'create-exclusive' }
  | { kind: 'create-if-missing' }
  | { database: CacheDatabase; kind: 'expected-owned' }
  | { kind: 'existing' }

type VerifiedCacheDatabaseOptions<Database> = {
  afterVerifiedOpen?: ((database: Database, context: { primaryCreated: boolean }) => void) | undefined
  DatabaseConstructor: CacheDatabaseConstructor<Database>
  location: CacheLocation
  missing?: (() => never) | undefined
  name: CacheDatabaseName
  openOptions?: {
    readOnly?: boolean
    timeout?: number
  }
  primary: CacheDatabasePrimary
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

/** @internal */
export class CacheDatabaseCreationConflict extends Error {
  readonly relativePath: string

  constructor(relativePath: string) {
    super('A cache database primary changed while exclusive ownership was required.')
    this.name = 'CacheDatabaseCreationConflict'
    this.relativePath = relativePath
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

class UnsafeCacheDatabaseSidecar extends EncephalonError {}

const cacheDatabaseCloseSafetyLatches = new Map<string, { close: () => void }>()

export const failCacheDatabase = (failure: unknown, database: CacheDatabase): never => {
  throw new CacheDatabaseFailure(failure, database, { cause: failure })
}

type CacheLocationTestHooks = {
  afterCacheOwnerRead?: ((path: string) => void) | undefined
  afterDatabaseLockInitialisation?: ((database: CacheDatabase) => void) | undefined
  afterDatabaseOpen?: ((database: CacheDatabase) => void) | undefined
  afterPrimaryBootstrapClose?: ((path: string) => void) | undefined
  afterPrimaryBootstrapOpen?: ((path: string) => void) | undefined
  afterQuarantineRename?: ((path: string) => void) | undefined
  afterRegularFileOpen?: ((path: string) => void) | undefined
  afterOwnerRecoveryCreation?: ((path: string) => void) | undefined
  beforeDatabaseOpen?: ((database: CacheDatabase) => void) | undefined
  beforeCacheOwnerOpen?: ((path: string) => void) | undefined
  beforeLocationInspection?: (() => void) | undefined
  beforeOwnedDirectoryFinalIdentity?: ((path: string) => void) | undefined
  beforeOwnerRecoveryFsync?: ((path: string) => void) | undefined
  beforeQuarantineRename?: ((path: string) => void) | undefined
  beforeQuarantinedOwnerValidation?: ((path: string) => void) | undefined
  duringOwnedDirectoryInspection?: ((path: string) => void) | undefined
  fsyncOwnedDirectory?: ((path: string) => void) | undefined
  regularFileRealpath?: ((path: string, actual: string) => string) | undefined
  releaseCloseSafetyLatchesForTests?: (() => void) | undefined
}

export const cacheLocationTestHooks: CacheLocationTestHooks = {}

export const sameCacheEntryIdentity = (first: CacheEntryIdentity, second: CacheEntryIdentity) =>
  sameEntryIdentity(first, second)

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

const requiredChangedFileMetadata = (path: string, relativePath: string, invariant: string) => {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if (missingPath(error)) {
      return changedLayout(relativePath, invariant)
    }
    throw error
  }
}

const unsafeReplacement = (relativePath: string): never => {
  throw new UnsafeCacheDatabaseSidecar(
    'REPOSITORY_CHANGED',
    'The Encephalon cache layout changed during the operation.',
    {
      entry: relativePath,
      invariant: 'stable-identity',
    },
  )
}

const unsafeSidecarAlias = (relativePath: string): never => {
  throw new UnsafeCacheDatabaseSidecar('VALIDATION_FAILED', 'The Encephalon cache layout is unsafe.', {
    entry: relativePath,
    invariant: 'single-link-file',
  })
}

type MutableFileLinkObservation = 'multiple' | 'single' | 'unlinked'

const mutableFileLinkObservation = (...observations: readonly BigIntStats[]): MutableFileLinkObservation => {
  if (observations.some(metadata => metadata.nlink === 0n)) {
    return 'unlinked'
  }
  return observations.some(metadata => metadata.nlink > 1n) ? 'multiple' : 'single'
}

const assertSingleLinkMutableFile = (metadata: BigIntStats, relativePath: string, onUnlinked: () => never) => {
  const links = mutableFileLinkObservation(metadata)
  if (links === 'unlinked') {
    return onUnlinked()
  }
  if (links === 'multiple') {
    invalidLayout(relativePath, 'single-link-file')
  }
}

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
  return { ...entryIdentityFrom(metadata), path, relativePath }
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
  if (!sameCacheEntryIdentity(entry, entryIdentityFrom(metadata))) {
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

type RegularFileInspection =
  | { kind: 'changed' }
  | { kind: 'mismatched-realpath' }
  | { kind: 'missing' }
  | { file: CacheFile; kind: 'stable'; links: Exclude<MutableFileLinkObservation, 'unlinked'> }

type RegularFileInspectionOptions = {
  expected?: CacheEntryIdentity | undefined
  onUnsafeCurrent?: (() => never) | undefined
  onUnsafeReplacement?: (() => never) | undefined
  optional?: boolean
  requireSingleLink?: boolean
}

type RegularFileMetadataInspectionOptions = RegularFileInspectionOptions & {
  requireStableObservation?: boolean
}

const regularFileRealpath = (path: string) => {
  const actual = realpathSync.native(path)
  return cacheLocationTestHooks.regularFileRealpath?.(path, actual) ?? actual
}

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
  const captured = entryIdentityFrom(metadata)
  let actualRealpath: string
  try {
    actualRealpath = regularFileRealpath(path)
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'changed' }
    }
    throw error
  }
  if (!samePath(actualRealpath, path)) {
    return { kind: 'mismatched-realpath' }
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
    cacheLocationTestHooks.afterRegularFileOpen?.(path)
    const opened = fstatSync(descriptor, { bigint: true })
    if (!(opened.isFile() && sameCacheEntryIdentity(captured, entryIdentityFrom(opened)))) {
      return { kind: 'changed' }
    }
    const links = mutableFileLinkObservation(metadata, opened)
    if (links === 'unlinked') {
      return { kind: 'changed' }
    }
    return {
      file: { ...captured, path, relativePath },
      kind: 'stable',
      links,
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}

const inspectRegularFile = (
  path: string,
  relativePath: string,
  options: RegularFileInspectionOptions = {},
): CacheFile | undefined => {
  const attempts = options.optional ? OPTIONAL_FILE_OBSERVATION_ATTEMPTS : 1
  for (const attempt of Array.from({ length: attempts }, (_, index) => index)) {
    const inspection = inspectRegularFileOnce(path, relativePath)
    if (inspection.kind === 'stable') {
      const expectedChanged =
        options.expected !== undefined && !sameCacheEntryIdentity(options.expected, inspection.file)
      if (expectedChanged) {
        if (inspection.links === 'multiple') {
          options.onUnsafeReplacement?.()
        }
      } else if (options.requireSingleLink && inspection.links === 'multiple') {
        options.onUnsafeCurrent?.()
        invalidLayout(relativePath, 'single-link-file')
      }
      return inspection.file
    }
    if (inspection.kind === 'missing' && (!options.optional || attempt === attempts - 1)) {
      return
    }
    if (inspection.kind === 'mismatched-realpath' && (!options.optional || attempt === attempts - 1)) {
      return invalidLayout(relativePath, 'expected-realpath')
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
  const captured = entryIdentityFrom(initialMetadata)
  let actualRealpath: string
  try {
    actualRealpath = regularFileRealpath(path)
  } catch (error) {
    if (missingPath(error)) {
      return { kind: 'changed' }
    }
    throw error
  }
  if (!samePath(actualRealpath, path)) {
    return { kind: 'mismatched-realpath' }
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
    !sameCacheEntryIdentity(captured, entryIdentityFrom(finalMetadata))
  ) {
    return { kind: 'changed' }
  }
  const links = mutableFileLinkObservation(initialMetadata, finalMetadata)
  if (links === 'unlinked') {
    return { kind: 'changed' }
  }
  return {
    file: { ...captured, path, relativePath },
    kind: 'stable',
    links,
  }
}

const inspectRegularFileMetadata = (
  path: string,
  relativePath: string,
  options: RegularFileMetadataInspectionOptions,
): CacheFile | undefined => {
  const attempts = options.optional ? OPTIONAL_FILE_OBSERVATION_ATTEMPTS : 1
  for (const attempt of Array.from({ length: attempts }, (_, index) => index)) {
    const inspection = inspectRegularFileMetadataOnce(path, relativePath)
    if (
      options.requireStableObservation &&
      (inspection.kind === 'changed' || inspection.kind === 'mismatched-realpath')
    ) {
      return changedLayout(relativePath, 'stable-metadata-identity')
    }
    if (inspection.kind === 'stable') {
      const expectedChanged =
        options.expected !== undefined && !sameCacheEntryIdentity(options.expected, inspection.file)
      if (expectedChanged) {
        if (inspection.links === 'multiple') {
          options.onUnsafeReplacement?.()
        }
      } else if (options.requireSingleLink && inspection.links === 'multiple') {
        options.onUnsafeCurrent?.()
        invalidLayout(relativePath, 'single-link-file')
      }
      return inspection.file
    }
    if (inspection.kind === 'missing' && (!options.optional || attempt === attempts - 1)) {
      return
    }
    if (inspection.kind === 'mismatched-realpath' && (!options.optional || attempt === attempts - 1)) {
      return invalidLayout(relativePath, 'expected-realpath')
    }
  }
  return changedLayout(relativePath, 'stable-metadata-identity')
}

const inspectSidecars = (
  location: CacheLocation,
  name: CacheDatabaseName,
  expected: Partial<Record<CacheDatabaseSidecarSuffix, CacheFile>> = {},
) =>
  DATABASE_SIDECAR_SUFFIXES.reduce<Partial<Record<CacheDatabaseSidecarSuffix, CacheFile>>>((sidecars, suffix) => {
    const relativePath = `${databaseRelativePath(name)}${suffix}`
    const file = inspectRegularFile(resolve(location.directory, `${name}${suffix}`), relativePath, {
      expected: expected[suffix],
      onUnsafeCurrent: () => unsafeSidecarAlias(relativePath),
      onUnsafeReplacement: () => unsafeReplacement(relativePath),
      optional: true,
      requireSingleLink: true,
    })
    return file === undefined ? sidecars : { ...sidecars, [suffix]: file }
  }, {})

const inspectSidecarMetadata = (
  location: CacheLocation,
  name: CacheDatabaseName,
  expected: Partial<Record<CacheDatabaseSidecarSuffix, CacheFile>>,
) =>
  DATABASE_SIDECAR_SUFFIXES.reduce<Partial<Record<CacheDatabaseSidecarSuffix, CacheFile>>>((sidecars, suffix) => {
    const relativePath = `${databaseRelativePath(name)}${suffix}`
    const file = inspectRegularFileMetadata(resolve(location.directory, `${name}${suffix}`), relativePath, {
      expected: expected[suffix],
      onUnsafeCurrent: () => unsafeSidecarAlias(relativePath),
      onUnsafeReplacement: () => unsafeReplacement(relativePath),
      optional: true,
      requireSingleLink: true,
    })
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
  reconcileSidecarSnapshots(database, inspectSidecars(location, database.name, database.sidecars))

const reconcileSidecarMetadata = (location: CacheLocation, database: CacheDatabase) =>
  reconcileSidecarSnapshots(database, inspectSidecarMetadata(location, database.name, database.sidecars))

const cacheDatabaseCloseIsProvenSafe = (location: CacheLocation, database: CacheDatabase) => {
  try {
    assertCacheLocation(location)
    DATABASE_SIDECAR_SUFFIXES.reduce((safe, suffix) => {
      const relativePath = `${databaseRelativePath(database.name)}${suffix}`
      inspectRegularFileMetadata(resolve(location.directory, `${database.name}${suffix}`), relativePath, {
        optional: true,
        requireSingleLink: true,
        requireStableObservation: true,
      })
      return safe
    }, true)
    assertCacheLocation(location)
    return true
  } catch {
    // The authoritative validation path reports this observation failure. SQLite
    // close is allowed only after containment and every sidecar is proven safe.
    return false
  }
}

const bootstrapPrimary = (
  location: CacheLocation,
  name: CacheDatabaseName,
  mode: 'create-exclusive' | 'create-if-missing',
) => {
  const path = resolve(location.directory, name)
  const relativePath = databaseRelativePath(name)
  let created = false
  let createdIdentity: CacheEntryIdentity | undefined
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW, 0o600)
    try {
      cacheLocationTestHooks.afterPrimaryBootstrapOpen?.(path)
      const metadata = fstatSync(descriptor, { bigint: true })
      assertSingleLinkMutableFile(metadata, relativePath, () => {
        throw new CacheDatabaseCreationConflict(relativePath)
      })
      createdIdentity = entryIdentityFrom(metadata)
    } finally {
      closeSync(descriptor)
    }
    cacheLocationTestHooks.afterPrimaryBootstrapClose?.(path)
    created = true
  } catch (error) {
    if (existingPath(error) && mode === 'create-exclusive') {
      // biome-ignore lint/style/useErrorCause: this internal control sentinel must not retain a path-bearing EEXIST.
      throw new CacheDatabaseCreationConflict(relativePath)
    }
    if (!existingPath(error)) {
      throw error
    }
  }
  const identity = inspectRegularFile(path, relativePath, {
    expected: createdIdentity,
    requireSingleLink: true,
  })
  if (identity === undefined) {
    if (createdIdentity !== undefined) {
      throw new CacheDatabaseCreationConflict(relativePath)
    }
    return changedLayout(relativePath, 'existing-file-present')
  }
  if (createdIdentity !== undefined && !sameCacheEntryIdentity(createdIdentity, identity)) {
    throw new CacheDatabaseCreationConflict(relativePath)
  }
  return { identity, primaryCreated: created }
}

const prepareCacheDatabase = (
  location: CacheLocation,
  name: CacheDatabaseName,
  mode: 'create-exclusive' | 'create-if-missing',
) => {
  assertCacheLocation(location)
  const sidecars = inspectSidecars(location, name)
  const path = resolve(location.directory, name)
  const existing =
    mode === 'create-if-missing'
      ? inspectRegularFile(path, databaseRelativePath(name), { requireSingleLink: true })
      : undefined
  const prepared =
    existing === undefined ? bootstrapPrimary(location, name, mode) : { identity: existing, primaryCreated: false }
  assertCacheLocation(location)
  return {
    database: { ...prepared.identity, name, sidecars: { ...sidecars, ...inspectSidecars(location, name) } },
    primaryCreated: prepared.primaryCreated,
  }
}

export const inspectCacheDatabase = (location: CacheLocation, name: CacheDatabaseName): CacheDatabase | undefined => {
  assertCacheLocation(location)
  const sidecars = inspectSidecars(location, name)
  const path = resolve(location.directory, name)
  const identity = inspectRegularFile(path, databaseRelativePath(name), { requireSingleLink: true })
  return identity === undefined ? undefined : { ...identity, name, sidecars }
}

export const assertCacheDatabase = (location: CacheLocation, database: CacheDatabase, missing?: () => never) => {
  assertCacheLocation(location)
  const identity = inspectRegularFile(database.path, databaseRelativePath(database.name), {
    expected: database,
    requireSingleLink: true,
  })
  if (identity !== undefined && sameCacheEntryIdentity(database, identity)) {
    return { ...database, sidecars: reconcileSidecars(location, database) }
  }
  if (identity === undefined && missing !== undefined) {
    return missing()
  }
  return changedLayout(databaseRelativePath(database.name), 'stable-identity')
}

const assertCacheDatabaseMetadata = (location: CacheLocation, database: CacheDatabase) => {
  // Opening and closing any sibling file descriptor after BEGIN can release
  // process-scoped SQLite locks on POSIX, so this boundary observes metadata only.
  assertCacheLocation(location)
  const identity = inspectRegularFileMetadata(database.path, databaseRelativePath(database.name), {
    expected: database,
    requireSingleLink: true,
  })
  if (identity === undefined || !sameCacheEntryIdentity(database, identity)) {
    return changedLayout(databaseRelativePath(database.name), 'stable-identity')
  }
  assertCacheLocation(location)
  const sidecars = reconcileSidecarMetadata(location, database)
  assertCacheLocation(location)
  return { ...database, sidecars }
}

const assertOwnedCacheDatabase = (location: CacheLocation, database: CacheDatabase) => {
  assertCacheLocation(location)
  const identity = inspectRegularFile(database.path, databaseRelativePath(database.name), {
    expected: database,
    requireSingleLink: true,
  })
  if (identity === undefined || !sameCacheEntryIdentity(database, identity)) {
    throw new CacheDatabaseCreationConflict(database.relativePath)
  }
  return { ...database, sidecars: reconcileSidecars(location, database) }
}

const closeDatabaseAfterFailure = (database: { close: () => void }) => {
  try {
    database.close()
  } catch {
    // Preserve the failure that made the database unusable.
  }
}

cacheLocationTestHooks.releaseCloseSafetyLatchesForTests = () => {
  const retainedDatabases = [...cacheDatabaseCloseSafetyLatches.values()]
  cacheDatabaseCloseSafetyLatches.clear()
  for (const database of retainedDatabases) {
    closeDatabaseAfterFailure(database)
  }
}

const assertCacheDatabaseOpenAllowed = (path: string, relativePath: string) => {
  if (
    cacheDatabaseCloseSafetyLatches.has(path) ||
    cacheDatabaseCloseSafetyLatches.size >= MAX_CACHE_DATABASE_CLOSE_SAFETY_LATCHES
  ) {
    return changedLayout(relativePath, 'stable-identity')
  }
}

const suppressUnsafeDatabaseClose = (
  location: CacheLocation,
  snapshot: CacheDatabase,
  database: { close: () => void },
  errors: readonly unknown[],
) => {
  const closeProvenSafe = cacheDatabaseCloseIsProvenSafe(location, snapshot)
  const markedUnsafeSidecar = errors.some(error => error instanceof UnsafeCacheDatabaseSidecar)
  const suppressClose = markedUnsafeSidecar || !closeProvenSafe
  if (suppressClose) {
    cacheDatabaseCloseSafetyLatches.set(snapshot.path, database)
  }
  return suppressClose
}

const initialCacheDatabase = <Database>(options: VerifiedCacheDatabaseOptions<Database>) => {
  if (options.primary.kind === 'existing') {
    const database = inspectCacheDatabase(options.location, options.name)
    return database === undefined ? undefined : { database, primaryCreated: false }
  }
  if (options.primary.kind === 'expected-owned') {
    return { database: assertOwnedCacheDatabase(options.location, options.primary.database), primaryCreated: false }
  }
  return prepareCacheDatabase(options.location, options.name, options.primary.kind)
}

export const openVerifiedCacheDatabase = <Database extends { close: () => void }>(
  options: VerifiedCacheDatabaseOptions<Database>,
) => {
  const databasePath = resolve(options.location.directory, options.name)
  assertCacheDatabaseOpenAllowed(databasePath, databaseRelativePath(options.name))
  const initial = initialCacheDatabase(options)
  if (initial === undefined) {
    if (options.missing !== undefined) {
      return options.missing()
    }
    return fail('INTERNAL_ERROR', 'The requested Encephalon cache database is missing.')
  }
  let snapshot = initial.database
  let { primaryCreated } = initial
  const ownedPrimary = options.primary.kind === 'create-exclusive' || options.primary.kind === 'expected-owned'
  const assertPrimary = (database: CacheDatabase) =>
    ownedPrimary
      ? assertOwnedCacheDatabase(options.location, database)
      : assertCacheDatabase(options.location, database, options.missing)
  const attempts = Array.from({ length: MAX_CACHE_DATABASE_OPEN_ATTEMPTS }, (_, index) => index)
  for (const attempt of attempts) {
    try {
      cacheLocationTestHooks.beforeDatabaseOpen?.(snapshot)
      snapshot = assertPrimary(snapshot)
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
      snapshot = assertPrimary(snapshot)
      return failCacheDatabase(error, snapshot)
    }
    let lockPreservingInitialisationCompleted = false
    try {
      cacheLocationTestHooks.afterDatabaseOpen?.(snapshot)
      snapshot = assertPrimary(snapshot)
      const context = { primaryCreated }
      primaryCreated = false
      options.afterVerifiedOpen?.(database, context)
      lockPreservingInitialisationCompleted = options.preserveDatabaseLocksAfterInitialisation === true
      if (options.preserveDatabaseLocksAfterInitialisation) {
        cacheLocationTestHooks.afterDatabaseLockInitialisation?.(snapshot)
      }
      snapshot = options.preserveDatabaseLocksAfterInitialisation
        ? assertCacheDatabaseMetadata(options.location, snapshot)
        : assertPrimary(snapshot)
      return { database, identity: snapshot }
    } catch (error) {
      if (error instanceof CacheDatabaseSidecarChanged) {
        const closeSuppressed =
          lockPreservingInitialisationCompleted &&
          suppressUnsafeDatabaseClose(options.location, snapshot, database, [error])
        if (closeSuppressed) {
          throw error
        }
        closeDatabaseAfterFailure(database)
        snapshot = error.database
        if (attempt === MAX_CACHE_DATABASE_OPEN_ATTEMPTS - 1) {
          throw error
        }
      } else {
        let validationError: unknown
        try {
          snapshot = options.preserveDatabaseLocksAfterInitialisation
            ? assertCacheDatabaseMetadata(options.location, snapshot)
            : assertPrimary(snapshot)
        } catch (candidate) {
          validationError = candidate
        }
        const closeSuppressed =
          lockPreservingInitialisationCompleted &&
          suppressUnsafeDatabaseClose(options.location, snapshot, database, [error, validationError])
        if (closeSuppressed) {
          if (validationError !== undefined) {
            throw validationError
          }
          throw error
        }
        closeDatabaseAfterFailure(database)
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
  const current = inspectRegularFile(expected.path, expected.relativePath, {
    expected,
    optional: !required,
    requireSingleLink: true,
  })
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
    const verified = inspectRegularFile(expected.path, expected.relativePath, {
      expected,
      optional: !required,
      requireSingleLink: true,
    })
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
    if (!(movedMetadata.isFile() && sameCacheEntryIdentity(expected, entryIdentityFrom(movedMetadata)))) {
      return changedLayout(expected.relativePath, 'stable-quarantine-identity')
    }
    assertSingleLinkMutableFile(movedMetadata, expected.relativePath, () =>
      changedLayout(expected.relativePath, 'stable-quarantine-identity'),
    )
    const movedIncarnation = entryMetadataFrom(movedMetadata)
    cacheLocationTestHooks.afterQuarantineRename?.(quarantinePath)
    assertCacheLocation(location)
    const quarantinedMetadata = quarantineMetadata(quarantinePath, expected.relativePath)
    if (
      !quarantinedMetadata.isFile() ||
      quarantinedMetadata.isSymbolicLink() ||
      !sameCacheEntryIdentity(expected, entryIdentityFrom(quarantinedMetadata))
    ) {
      return changedLayout(expected.relativePath, 'stable-quarantine-identity')
    }
    if (!sameStableEntryMetadata(movedIncarnation, entryMetadataFrom(quarantinedMetadata))) {
      return changedLayout(expected.relativePath, 'stable-quarantine-identity')
    }
    assertSingleLinkMutableFile(quarantinedMetadata, expected.relativePath, () =>
      changedLayout(expected.relativePath, 'stable-quarantine-identity'),
    )
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
  const captured = entryIdentityFrom(initialMetadata)
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
  if (!sameCacheEntryIdentity(captured, entryIdentityFrom(finalMetadata))) {
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
  if (!sameCacheEntryIdentity(directory, entryIdentityFrom(metadata))) {
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
  const relativePath = `${ownedDirectoryRelativePath(directory.name)}/owner.json`
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600)
  let createdMetadata: EntryMetadata | undefined
  try {
    const bytes = Buffer.from(contents)
    let offset = 0
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset)
    }
    const metadata = fstatSync(descriptor, { bigint: true })
    if (!metadata.isFile()) {
      return changedLayout(relativePath, 'regular-non-symlink-file')
    }
    assertSingleLinkMutableFile(metadata, relativePath, () => changedLayout(relativePath, 'stable-identity'))
    createdMetadata = entryMetadataFrom(metadata)
  } finally {
    closeSync(descriptor)
  }
  if (createdMetadata === undefined) {
    return fail('INTERNAL_ERROR', 'Cache owner identity was not captured before publication.')
  }
  assertOwnedDirectory(location, directory)
  // owner.json is exclusively created and filled once through its owned descriptor,
  // then only read or unlinked; it is not a reopened mutable SQLite file.
  const owner = inspectRegularFile(path, relativePath, {
    expected: createdMetadata,
    requireSingleLink: true,
  })
  const currentMetadata = requiredChangedFileMetadata(path, relativePath, 'stable-identity')
  if (
    owner === undefined ||
    !sameCacheEntryIdentity(createdMetadata, owner) ||
    !currentMetadata.isFile() ||
    currentMetadata.isSymbolicLink() ||
    !sameStableEntryMetadata(createdMetadata, entryMetadataFrom(currentMetadata))
  ) {
    return changedLayout(relativePath, 'stable-identity')
  }
  return { contents, file: owner, kind: 'contents' as const, metadata: createdMetadata }
}

const cacheOwnerSharingViolation = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return process.platform === 'win32' && (code === 'EACCES' || code === 'EBUSY' || code === 'EPERM')
}

const readCacheOwnedFile = (
  location: CacheLocation,
  directory: CacheOwnedDirectory,
  name: 'owner.json' | 'owner.recovered.json',
  maximumBytes: number,
) => {
  assertOwnedDirectory(location, directory)
  const path = resolve(directory.path, name)
  const relativePath = `${ownedDirectoryRelativePath(directory.name)}/${name}`
  const captured = inspectRegularFile(path, relativePath, {
    optional: true,
    requireSingleLink: true,
  })
  if (captured === undefined) {
    return { kind: 'missing' as const }
  }
  cacheLocationTestHooks.beforeCacheOwnerOpen?.(path)
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW)
  } catch (error) {
    if (missingPath(error) && name === 'owner.recovered.json') {
      return changedLayout(relativePath, 'stable-identity')
    }
    throw error
  }
  try {
    const metadata = fstatSync(descriptor, { bigint: true })
    if (!(metadata.isFile() && sameCacheEntryIdentity(captured, entryIdentityFrom(metadata)))) {
      return name === 'owner.json'
        ? invalidLayout(relativePath, 'bounded-stable-owner-file')
        : changedLayout(relativePath, 'bounded-stable-owner-file')
    }
    assertSingleLinkMutableFile(metadata, relativePath, () => changedLayout(relativePath, 'stable-identity'))
    const capturedMetadata = entryMetadataFrom(metadata)
    let contents: string | undefined
    if (metadata.size <= BigInt(maximumBytes)) {
      const bytes = Buffer.alloc(Number(metadata.size))
      const read = readSync(descriptor, bytes, 0, bytes.length, 0)
      if (read !== bytes.length) {
        return changedLayout(relativePath, 'complete-owner-read')
      }
      cacheLocationTestHooks.afterCacheOwnerRead?.(path)
      contents = bytes.toString('utf8')
    }
    const finalOpenedMetadata = fstatSync(descriptor, { bigint: true })
    assertOwnedDirectory(location, directory)
    const current = inspectRegularFile(path, relativePath, {
      expected: captured,
      requireSingleLink: true,
    })
    const finalPathMetadata = requiredChangedFileMetadata(path, relativePath, 'stable-identity')
    if (
      current === undefined ||
      !sameCacheEntryIdentity(captured, current) ||
      !finalPathMetadata.isFile() ||
      finalPathMetadata.isSymbolicLink() ||
      !sameStableEntryMetadata(capturedMetadata, entryMetadataFrom(finalOpenedMetadata)) ||
      !sameStableEntryMetadata(capturedMetadata, entryMetadataFrom(finalPathMetadata))
    ) {
      return changedLayout(relativePath, 'stable-identity')
    }
    if (contents !== undefined) {
      return { contents, file: captured, kind: 'contents' as const, metadata: capturedMetadata }
    }
    return { file: captured, kind: 'oversized' as const, metadata: capturedMetadata }
  } finally {
    closeSync(descriptor)
  }
}

export const observeCacheOwner = (location: CacheLocation, directory: CacheOwnedDirectory) =>
  readCacheOwnedFile(location, directory, 'owner.json', CACHE_OWNER_MAXIMUM_BYTES)

export const observeCacheRecoveryWitness = (location: CacheLocation, directory: CacheOwnedDirectory) =>
  readCacheOwnedFile(location, directory, 'owner.recovered.json', CACHE_OWNER_MAXIMUM_BYTES)

export type CacheOwnedFileObservation = ReturnType<typeof observeCacheOwner>

type CacheOwnerRecoveryPublication =
  | { kind: 'changed'; witness?: Extract<CacheOwnedFileObservation, { kind: 'contents' }> }
  | {
      error: unknown
      kind: 'failed'
      witness?: Extract<CacheOwnedFileObservation, { kind: 'contents' }>
    }
  | {
      durabilityError?: unknown
      file: Extract<CacheOwnedFileObservation, { kind: 'contents' }>['file']
      kind: 'published'
      metadata: EntryMetadata
    }
  | { error?: unknown; kind: 'released' }

const assertMovedCacheOwnedFile = (
  directoryName: string,
  quarantinePath: string,
  name: 'owner.json' | 'owner.recovered.json',
  expected: CacheOwnedFileObservation,
) => {
  const path = resolve(quarantinePath, name)
  const relativePath = `${ownedDirectoryRelativePath(directoryName)}/${name}`
  if (expected.kind === 'missing') {
    const current = inspectRegularFile(path, relativePath, {
      optional: true,
      requireSingleLink: true,
    })
    if (current !== undefined) {
      return changedLayout(relativePath, 'stable-quarantine-owner')
    }
  } else {
    const current = inspectRegularFile(path, relativePath, {
      expected: expected.file,
      requireSingleLink: true,
    })
    const currentPathMetadata = requiredChangedFileMetadata(path, relativePath, 'stable-quarantine-owner')
    if (
      current === undefined ||
      !sameCacheEntryIdentity(expected.file, current) ||
      !currentPathMetadata.isFile() ||
      currentPathMetadata.isSymbolicLink() ||
      !sameStableEntryMetadata(expected.metadata, entryMetadataFrom(currentPathMetadata))
    ) {
      return changedLayout(relativePath, 'stable-quarantine-owner')
    }
    if (expected.kind === 'contents') {
      const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW)
      try {
        const metadata = fstatSync(descriptor, { bigint: true })
        const expectedBytes = Buffer.from(expected.contents)
        if (
          !(metadata.isFile() && sameCacheEntryIdentity(expected.file, entryIdentityFrom(metadata))) ||
          metadata.size !== BigInt(expectedBytes.length) ||
          !sameStableEntryMetadata(expected.metadata, entryMetadataFrom(metadata))
        ) {
          return changedLayout(relativePath, 'stable-quarantine-owner')
        }
        const bytes = Buffer.alloc(expectedBytes.length)
        if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.equals(expectedBytes)) {
          return changedLayout(relativePath, 'stable-quarantine-owner')
        }
        const finalOpenedMetadata = fstatSync(descriptor, { bigint: true })
        if (!sameStableEntryMetadata(expected.metadata, entryMetadataFrom(finalOpenedMetadata))) {
          return changedLayout(relativePath, 'stable-quarantine-owner')
        }
      } finally {
        closeSync(descriptor)
      }
      const final = inspectRegularFile(path, relativePath, {
        expected: expected.file,
        requireSingleLink: true,
      })
      const finalPathMetadata = requiredChangedFileMetadata(path, relativePath, 'stable-quarantine-owner')
      if (
        final === undefined ||
        !sameCacheEntryIdentity(expected.file, final) ||
        !finalPathMetadata.isFile() ||
        finalPathMetadata.isSymbolicLink() ||
        !sameStableEntryMetadata(expected.metadata, entryMetadataFrom(finalPathMetadata))
      ) {
        return changedLayout(relativePath, 'stable-quarantine-owner')
      }
    }
  }
}

const sameObservedCacheOwner = (
  observation: ReturnType<typeof observeCacheOwner>,
  expected: { contents: string; file: CacheEntryIdentity; metadata: EntryMetadata },
) =>
  observation.kind === 'contents' &&
  observation.contents === expected.contents &&
  sameCacheEntryIdentity(observation.file, expected.file) &&
  sameStableEntryMetadata(observation.metadata, expected.metadata)

const observeExactCacheOwnerRecovery = (
  location: CacheLocation,
  directory: CacheOwnedDirectory,
  expectedOwner: { contents: string; file: CacheEntryIdentity; metadata: EntryMetadata },
  expectedWitnessContents: string,
): Extract<CacheOwnedFileObservation, { kind: 'contents' }> | undefined => {
  const owner = observeCacheOwner(location, directory)
  const witness = observeCacheRecoveryWitness(location, directory)
  let exactWitness: Extract<CacheOwnedFileObservation, { kind: 'contents' }> | undefined
  if (
    sameObservedCacheOwner(owner, expectedOwner) &&
    witness.kind === 'contents' &&
    witness.contents === expectedWitnessContents
  ) {
    exactWitness = witness
  }
  return exactWitness
}

const observeCommittedCacheOwnerRecovery = (
  location: CacheLocation,
  directory: CacheOwnedDirectory,
  expectedOwner: { contents: string; file: CacheEntryIdentity; metadata: EntryMetadata },
  expectedWitnessContents: string,
) => {
  let outcome:
    | { kind: 'changed' }
    | { kind: 'exact'; witness: Extract<CacheOwnedFileObservation, { kind: 'contents' }> }
    | { kind: 'released' }
  try {
    const witness = observeExactCacheOwnerRecovery(location, directory, expectedOwner, expectedWitnessContents)
    outcome = witness === undefined ? { kind: 'changed' } : { kind: 'exact', witness }
  } catch (error) {
    if (cacheOwnedDirectoryIsCurrent(location, directory)) {
      throw error
    }
    outcome = { kind: 'released' }
  }
  return outcome
}

const unsupportedWindowsDirectorySync = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return (
    process.platform === 'win32' &&
    (code === 'EACCES' ||
      code === 'EBADF' ||
      code === 'EINVAL' ||
      code === 'EISDIR' ||
      code === 'ENOTSUP' ||
      code === 'EPERM')
  )
}

const fsyncExactOwnedDirectory = (location: CacheLocation, directory: CacheOwnedDirectory) => {
  assertOwnedDirectory(location, directory)
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory.path, constants.O_RDONLY | NO_FOLLOW)
    const metadata = fstatSync(descriptor, { bigint: true })
    if (!(metadata.isDirectory() && sameCacheEntryIdentity(directory, entryIdentityFrom(metadata)))) {
      return changedLayout(ownedDirectoryRelativePath(directory.name), 'stable-identity')
    }
    cacheLocationTestHooks.fsyncOwnedDirectory?.(directory.path)
    fsyncSync(descriptor)
  } catch (error) {
    if (!unsupportedWindowsDirectorySync(error)) {
      throw error
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
  assertOwnedDirectory(location, directory)
}

/** @internal */
export const publishCacheOwnerRecovery = (
  location: CacheLocation,
  directory: CacheOwnedDirectory,
  expectedOwner: { contents: string; file: CacheEntryIdentity; metadata: EntryMetadata },
  contents: string,
): CacheOwnerRecoveryPublication => {
  const bytes = Buffer.from(contents)
  if (bytes.length > CACHE_OWNER_MAXIMUM_BYTES) {
    return fail('INTERNAL_ERROR', 'Cache recovery witness metadata exceeded its internal bound.')
  }
  const witnessPath = resolve(directory.path, 'owner.recovered.json')
  const witnessRelativePath = `${ownedDirectoryRelativePath(directory.name)}/owner.recovered.json`
  let descriptor: number | undefined
  for (const attempt of Array.from({ length: MAX_CACHE_OWNER_PUBLICATION_ATTEMPTS }, (_, index) => index)) {
    const currentOwner = observeCacheOwner(location, directory)
    if (sameObservedCacheOwner(currentOwner, expectedOwner)) {
      try {
        descriptor = openSync(witnessPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW, 0o600)
      } catch (error) {
        if (existingPath(error)) {
          const observedRecovery = observeCommittedCacheOwnerRecovery(location, directory, expectedOwner, contents)
          if (observedRecovery.kind === 'released') {
            return { kind: 'released' as const }
          }
          if (observedRecovery.kind === 'exact') {
            let durabilityError: unknown
            try {
              fsyncExactOwnedDirectory(location, directory)
            } catch (candidate) {
              durabilityError = candidate
            }
            const finalRecovery = observeCommittedCacheOwnerRecovery(location, directory, expectedOwner, contents)
            if (finalRecovery.kind === 'released') {
              return {
                ...(durabilityError === undefined ? {} : { error: durabilityError }),
                kind: 'released' as const,
              }
            }
            if (
              finalRecovery.kind === 'exact' &&
              sameCacheEntryIdentity(observedRecovery.witness.file, finalRecovery.witness.file)
            ) {
              return {
                durabilityError,
                file: observedRecovery.witness.file,
                kind: 'published' as const,
                metadata: observedRecovery.witness.metadata,
              }
            }
          }
          return { kind: 'changed' as const }
        }
        const canRetry = cacheOwnerSharingViolation(error) && attempt < MAX_CACHE_OWNER_PUBLICATION_ATTEMPTS - 1
        if (!canRetry) {
          throw error
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CACHE_OWNER_SHARING_RETRY_MILLISECONDS)
      }
    }
    if (descriptor !== undefined || !sameObservedCacheOwner(currentOwner, expectedOwner)) {
      break
    }
  }
  if (descriptor === undefined) {
    return { kind: 'changed' as const }
  }

  let witness: CacheEntryIdentity | undefined
  let committed = false
  let publicationError: unknown
  try {
    const created = fstatSync(descriptor, { bigint: true })
    if (!created.isFile()) {
      return changedLayout(witnessRelativePath, 'regular-non-symlink-file')
    }
    assertSingleLinkMutableFile(created, witnessRelativePath, () =>
      changedLayout(witnessRelativePath, 'stable-identity'),
    )
    witness = entryIdentityFrom(created)
    cacheLocationTestHooks.afterOwnerRecoveryCreation?.(directory.path)
    const ownerBeforeWrite = observeCacheOwner(location, directory)
    if (sameObservedCacheOwner(ownerBeforeWrite, expectedOwner)) {
      let offset = 0
      while (offset < bytes.length) {
        offset += writeSync(descriptor, bytes, offset)
      }
      cacheLocationTestHooks.beforeOwnerRecoveryFsync?.(directory.path)
      fsyncSync(descriptor)
      committed = true
    }
  } catch (error) {
    publicationError = error
  } finally {
    try {
      closeSync(descriptor)
    } catch (error) {
      if (publicationError === undefined) {
        publicationError = error
      }
    }
  }

  if (publicationError !== undefined) {
    const exactRecovery = observeCommittedCacheOwnerRecovery(location, directory, expectedOwner, contents)
    if (exactRecovery.kind === 'released') {
      return { error: publicationError, kind: 'released' as const }
    }
    if (
      exactRecovery.kind === 'exact' &&
      witness !== undefined &&
      sameCacheEntryIdentity(witness, exactRecovery.witness.file)
    ) {
      return {
        durabilityError: publicationError,
        file: exactRecovery.witness.file,
        kind: 'published' as const,
        metadata: exactRecovery.witness.metadata,
      }
    }
    const currentWitness = observeCacheRecoveryWitness(location, directory)
    if (
      currentWitness.kind === 'contents' &&
      witness !== undefined &&
      sameCacheEntryIdentity(witness, currentWitness.file)
    ) {
      return {
        error: publicationError,
        kind: 'failed' as const,
        witness: currentWitness,
      }
    }
    return { error: publicationError, kind: 'failed' as const }
  }

  if (!committed) {
    if (witness !== undefined) {
      const currentWitness = observeCacheRecoveryWitness(location, directory)
      if (currentWitness.kind === 'contents' && sameCacheEntryIdentity(witness, currentWitness.file)) {
        return { kind: 'changed' as const, witness: currentWitness }
      }
    }
    return { kind: 'changed' as const }
  }

  if (witness === undefined) {
    return fail('INTERNAL_ERROR', 'Cache recovery witness identity was not captured before publication.')
  }
  const recoveryAfterWrite = observeCommittedCacheOwnerRecovery(location, directory, expectedOwner, contents)
  if (recoveryAfterWrite.kind === 'released') {
    return { kind: 'released' as const }
  }
  if (recoveryAfterWrite.kind === 'changed' || !sameCacheEntryIdentity(witness, recoveryAfterWrite.witness.file)) {
    return { kind: 'changed' as const }
  }
  let durabilityError: unknown
  try {
    fsyncExactOwnedDirectory(location, directory)
  } catch (error) {
    durabilityError = error
  }
  const finalRecovery = observeCommittedCacheOwnerRecovery(location, directory, expectedOwner, contents)
  if (finalRecovery.kind === 'released') {
    return { kind: 'released' as const }
  }
  if (finalRecovery.kind === 'exact' && sameCacheEntryIdentity(witness, finalRecovery.witness.file)) {
    return {
      durabilityError,
      file: finalRecovery.witness.file,
      kind: 'published' as const,
      metadata: finalRecovery.witness.metadata,
    }
  }
  return { kind: 'changed' as const }
}

export const quarantineCacheOwnedDirectory = (
  location: CacheLocation,
  directory: CacheOwnedDirectory,
  ownershipIsCurrent?: () => boolean,
  options?:
    | {
        expectedFiles?: { owner: CacheOwnedFileObservation; recoveryWitness: CacheOwnedFileObservation } | undefined
        onMove?: (() => void) | undefined
      }
    | undefined,
) => {
  assertOwnedDirectory(location, directory)
  cacheLocationTestHooks.beforeQuarantineRename?.(directory.path)
  assertOwnedDirectory(location, directory)
  if (ownershipIsCurrent?.() ?? true) {
    const quarantineName = `.${directory.name}.${randomUUID()}.quarantine`
    const quarantinePath = resolve(location.directory, quarantineName)
    renameSync(directory.path, quarantinePath)
    options?.onMove?.()
    assertCacheLocation(location)
    const movedMetadata = quarantineMetadata(quarantinePath, ownedDirectoryRelativePath(directory.name))
    if (!(movedMetadata.isDirectory() && sameCacheEntryIdentity(directory, entryIdentityFrom(movedMetadata)))) {
      return changedLayout(ownedDirectoryRelativePath(directory.name), 'stable-quarantine-identity')
    }
    const movedIncarnation = entryMetadataFrom(movedMetadata)
    cacheLocationTestHooks.afterQuarantineRename?.(quarantinePath)
    assertCacheLocation(location)
    const metadata = quarantineMetadata(quarantinePath, ownedDirectoryRelativePath(directory.name))
    if (!(metadata.isDirectory() && sameStableEntryMetadata(movedIncarnation, entryMetadataFrom(metadata)))) {
      return changedLayout(ownedDirectoryRelativePath(directory.name), 'stable-quarantine-identity')
    }
    cacheLocationTestHooks.beforeQuarantinedOwnerValidation?.(quarantinePath)
    if (options?.expectedFiles !== undefined) {
      assertMovedCacheOwnedFile(directory.name, quarantinePath, 'owner.json', options.expectedFiles.owner)
      assertMovedCacheOwnedFile(
        directory.name,
        quarantinePath,
        'owner.recovered.json',
        options.expectedFiles.recoveryWitness,
      )
    }
    const ownerPath = resolve(quarantinePath, 'owner.json')
    const recoveryWitnessPath = resolve(quarantinePath, 'owner.recovered.json')
    const recoveryWitness = inspectRegularFile(
      recoveryWitnessPath,
      `${ownedDirectoryRelativePath(directory.name)}/owner.recovered.json`,
      { optional: true, requireSingleLink: true },
    )
    if (recoveryWitness !== undefined) {
      unlinkSync(recoveryWitnessPath)
    }
    const owner = inspectRegularFile(ownerPath, `${ownedDirectoryRelativePath(directory.name)}/owner.json`)
    if (owner !== undefined) {
      unlinkSync(ownerPath)
    }
    rmdirSync(quarantinePath)
    assertCacheLocation(location)
    return true
  }
  return false
}
