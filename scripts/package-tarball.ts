import { createHash, randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, parse, posix, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

export type PackageCheckArguments = Readonly<{
  retainedDirectory?: string
  suppliedTarball?: string
}>

export type PackageTarEntry = Readonly<{
  content: Buffer
  mode: number
  path: string
  size: number
}>

export type PackageTarballDigests = Readonly<{
  bytes: number
  integrity: string
  sha1: string
  sha256: string
  sha512: string
}>

export type PackageTarballSnapshot = Readonly<{
  digests: PackageTarballDigests
  path: string
}>

export type PackageArtifactMetadata = Readonly<
  PackageTarballDigests & {
    packageVersion: string
    sourceCommit: string
    tarball: string
  }
>

export type PackageArtifactRetention = Readonly<{
  metadata: PackageArtifactMetadata
  metadataPath: string
  path: string
}>

type FileReadHooks = Readonly<{
  afterSourceOpen?: () => void
}>

type RetentionHooks = Readonly<{
  beforeInstall?: () => void
}>

type PathIdentity = Readonly<{
  canonicalPath: string
  device: bigint
  inode: bigint
  mode: bigint
  path: string
  symbolicLink: boolean
}>

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRootIdentity = lstatSync(root, { bigint: true })
const repositoryRootCanonicalPath = realpathSync.native(root)
const maximumTarballBytes = 64 * 1024 * 1024
const maximumArchiveBytes = 256 * 1024 * 1024
const maximumEntryBytes = 64 * 1024 * 1024
const maximumEntryCount = 4096
const maximumMetadataBytes = 8192
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const readBoundedDirectoryNames = (path: string, maximum: number) => {
  const directory = opendirSync(path)
  try {
    const names: string[] = []
    while (names.length <= maximum) {
      const entry = directory.readSync()
      if (entry === null) {
        return names
      }
      names.push(entry.name)
    }
    throw new Error('Retained package directory contains unexpected entries.')
  } finally {
    directory.closeSync()
  }
}
const packageCheckUsage = () =>
  new Error(
    'Usage: check-package.ts [--retain-tarball <repository-relative-directory> | --tarball <repository-relative-tarball>]',
  )

const assertRepositoryRootStable = () => {
  const current = lstatSync(root, { bigint: true, throwIfNoEntry: false })
  if (
    current === undefined ||
    current.dev !== repositoryRootIdentity.dev ||
    current.ino !== repositoryRootIdentity.ino ||
    current.mode !== repositoryRootIdentity.mode ||
    realpathSync.native(root) !== repositoryRootCanonicalPath
  ) {
    throw new Error('The package repository root changed during artifact verification.')
  }
}

const repositoryPath = (value: string) => {
  assertRepositoryRootStable()
  const segments = value.split(/[\\/]/u)
  const resolvedPath = resolve(root, value)
  const repositoryRelativePath = relative(root, resolvedPath)
  const isContained =
    repositoryRelativePath !== '' &&
    repositoryRelativePath !== '..' &&
    !repositoryRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelativePath)
  if (
    value.length > 0 &&
    !value.includes('\0') &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..') &&
    isContained
  ) {
    return { path: resolvedPath, segments: repositoryRelativePath.split(sep) }
  }
  throw packageCheckUsage()
}

const validateRetainedDirectory = (value: string) => {
  const candidate = repositoryPath(value)
  candidate.segments.reduce(
    (state, segment) => {
      const path = resolve(state.parent, segment)
      const entry = state.ancestorMissing ? undefined : lstatSync(path, { throwIfNoEntry: false })
      if (entry !== undefined && (!entry.isDirectory() || entry.isSymbolicLink())) {
        throw packageCheckUsage()
      }
      return { ancestorMissing: state.ancestorMissing || entry === undefined, parent: path }
    },
    { ancestorMissing: false, parent: root },
  )
  return candidate.path
}

const validateSuppliedTarball = (value: string) => {
  const candidate = repositoryPath(value)
  const entries = candidate.segments.map((_segment, index, segments) => {
    const path = resolve(root, ...segments.slice(0, index + 1))
    const entry = lstatSync(path, { throwIfNoEntry: false })
    const isTarball = index === segments.length - 1
    if (
      entry === undefined ||
      entry.isSymbolicLink() ||
      (isTarball ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory())
    ) {
      throw packageCheckUsage()
    }
    return entry
  })
  const finalEntry = entries.at(-1)
  if (value.endsWith('.tgz') && finalEntry !== undefined) {
    return candidate.path
  }
  throw packageCheckUsage()
}

export const parsePackageCheckArguments = (args: readonly string[]): PackageCheckArguments => {
  if (args.length === 0) {
    return Object.freeze({})
  }
  if (args.length === 2) {
    const [option, value] = args
    if (option === '--retain-tarball' && value !== undefined) {
      return Object.freeze({ retainedDirectory: validateRetainedDirectory(value) })
    }
    if (option === '--tarball' && value !== undefined) {
      return Object.freeze({ suppliedTarball: validateSuppliedTarball(value) })
    }
  }
  throw packageCheckUsage()
}

const ancestorPaths = (path: string) => {
  const absolutePath = resolve(path)
  const filesystemRoot = parse(absolutePath).root
  const segments = relative(filesystemRoot, dirname(absolutePath)).split(sep).filter(Boolean)
  return segments.reduce<readonly string[]>(
    (paths, segment) => Object.freeze([...paths, resolve(paths.at(-1) ?? filesystemRoot, segment)]),
    Object.freeze([filesystemRoot]),
  )
}

const captureAncestorChain = (path: string): readonly PathIdentity[] =>
  Object.freeze(
    ancestorPaths(path).map(ancestorPath => {
      const named = lstatSync(ancestorPath, { bigint: true })
      if (!statSync(ancestorPath).isDirectory()) {
        throw new Error('Package path ancestor must resolve to a directory.')
      }
      return Object.freeze({
        canonicalPath: realpathSync.native(ancestorPath),
        device: named.dev,
        inode: named.ino,
        mode: named.mode,
        path: ancestorPath,
        symbolicLink: named.isSymbolicLink(),
      })
    }),
  )

const sameAncestorChain = (expected: readonly PathIdentity[]) =>
  expected.every(identity => {
    const current = lstatSync(identity.path, { bigint: true, throwIfNoEntry: false })
    return (
      current !== undefined &&
      current.dev === identity.device &&
      current.ino === identity.inode &&
      current.mode === identity.mode &&
      realpathSync.native(identity.path) === identity.canonicalPath
    )
  })

const assertAncestorChain = (expected: readonly PathIdentity[], label: string) => {
  if (!sameAncestorChain(expected)) {
    throw new Error(`${label} directory changed while the package artifact was being verified.`)
  }
}

const assertRepositoryDestinationChain = (chain: readonly PathIdentity[]) => {
  assertRepositoryRootStable()
  const rootIndex = chain.findIndex(identity => identity.path === root)
  const repositoryChain = rootIndex < 0 ? [] : chain.slice(rootIndex)
  const isCanonicalRepositoryChain = repositoryChain.every(identity => {
    const relativePath = relative(root, identity.path)
    return !identity.symbolicLink && identity.canonicalPath === resolve(repositoryRootCanonicalPath, relativePath)
  })
  if (repositoryChain.length === 0 || !isCanonicalRepositoryChain) {
    throw new Error('Retained package destination ancestors must remain real repository directories.')
  }
}

const sameStableFile = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs &&
  left.birthtimeNs === right.birthtimeNs

const readFixedMaximumPlusOne = (descriptor: number, expectedBytes: number, maximumBytes: number) => {
  const bytes = Buffer.alloc(Math.min(expectedBytes + 1, maximumBytes + 1))
  let offset = 0
  let read = 1
  while (offset < bytes.length && read > 0) {
    read = readSync(descriptor, bytes, offset, bytes.length - offset, null)
    offset += read
  }
  return bytes.subarray(0, offset)
}

const writeDescriptorBytes = (descriptor: number, bytes: Buffer) => {
  let offset = 0
  while (offset < bytes.length) {
    offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
  }
}

const readVerifiedRegularFile = (path: string, maximumBytes: number, hooks: FileReadHooks = {}) => {
  const ancestors = captureAncestorChain(path)
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    const namedBefore = lstatSync(path, { bigint: true })
    if (
      !(before.isFile() && namedBefore.isFile()) ||
      namedBefore.isSymbolicLink() ||
      before.nlink !== 1n ||
      namedBefore.nlink !== 1n ||
      !sameStableFile(before, namedBefore) ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error('Package artifact must be one bounded unchanged regular file with one hard link.')
    }
    hooks.afterSourceOpen?.()
    const bytes = readFixedMaximumPlusOne(descriptor, Number(before.size), maximumBytes)
    const after = fstatSync(descriptor, { bigint: true })
    const namedAfter = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    assertAncestorChain(ancestors, 'Package artifact ancestor')
    if (
      namedAfter !== undefined &&
      sameStableFile(before, after) &&
      sameStableFile(before, namedAfter) &&
      bytes.length === Number(before.size)
    ) {
      return Buffer.from(bytes)
    }
    throw new Error('Package artifact changed while its bytes were being read.')
  } finally {
    closeSync(descriptor)
  }
}

const tarField = (header: Buffer, offset: number, length: number) => {
  const field = header.subarray(offset, offset + length)
  const nul = field.indexOf(0)
  return utf8Decoder.decode(field.subarray(0, nul < 0 ? field.length : nul))
}

const tarOctal = (header: Buffer, offset: number, length: number) => {
  const value = tarField(header, offset, length).trim()
  if (/^[0-7]+$/u.test(value)) {
    return Number.parseInt(value, 8)
  }
  throw new Error('Package tarball contains an invalid numeric header field.')
}

const normaliseTarPath = (path: string) => {
  const withoutDotPrefix = path.replace(/^(?:\.\/)+/u, '')
  const normalised = posix.normalize(withoutDotPrefix)
  const segments = withoutDotPrefix.split('/')
  if (
    withoutDotPrefix.length > 0 &&
    !withoutDotPrefix.includes('\0') &&
    !posix.isAbsolute(withoutDotPrefix) &&
    segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..') &&
    normalised === withoutDotPrefix
  ) {
    return normalised
  }
  throw new Error('Package tarball contains an invalid entry path.')
}

export const readPackageTarEntries = (path: string): readonly PackageTarEntry[] => {
  const archive = gunzipSync(readVerifiedRegularFile(path, maximumTarballBytes), {
    maxOutputLength: maximumArchiveBytes,
  })
  const entries: PackageTarEntry[] = []
  const seenPaths = new Set<string>()
  let offset = 0
  let foundEnd = false
  while (offset + 512 <= archive.length && !foundEnd) {
    const header = archive.subarray(offset, offset + 512)
    const isEnd = header.every(byte => byte === 0)
    if (isEnd) {
      const endOffset = offset + 1024
      const hasSecondEndBlock =
        endOffset <= archive.length && archive.subarray(offset + 512, endOffset).every(byte => byte === 0)
      const hasOnlyZeroTrailingBytes = hasSecondEndBlock && archive.subarray(endOffset).every(byte => byte === 0)
      if (hasOnlyZeroTrailingBytes) {
        foundEnd = true
      } else {
        throw new Error('Package tarball has an incomplete end marker or non-zero trailing bytes.')
      }
    } else {
      const expectedChecksum = tarOctal(header, 148, 8)
      const actualChecksum = header.reduce(
        (checksum, byte, index) => checksum + (index >= 148 && index < 156 ? 0x20 : byte),
        0,
      )
      if (expectedChecksum !== actualChecksum) {
        throw new Error('Package tarball contains an invalid header checksum.')
      }
      const name = tarField(header, 0, 100)
      const prefix = tarField(header, 345, 155)
      const size = tarOctal(header, 124, 12)
      const mode = tarOctal(header, 100, 8)
      const type = tarField(header, 156, 1)
      if (type !== '' && type !== '0') {
        throw new Error('Package tarball contains a non-regular entry.')
      }
      const pathValue = normaliseTarPath(prefix.length > 0 ? `${prefix}/${name}` : name)
      const nextOffset = offset + 512 + Math.ceil(size / 512) * 512
      if (
        Number.isSafeInteger(size) &&
        size <= maximumEntryBytes &&
        nextOffset <= archive.length &&
        entries.length < maximumEntryCount &&
        !seenPaths.has(pathValue)
      ) {
        const content = Buffer.from(archive.subarray(offset + 512, offset + 512 + size))
        seenPaths.add(pathValue)
        entries.push(Object.freeze({ content, mode, path: pathValue, size }))
        offset = nextOffset
      } else {
        throw new Error('Package tarball contains an invalid, duplicate, or oversized entry.')
      }
    }
  }
  if (foundEnd) {
    return Object.freeze(entries)
  }
  throw new Error('Package tarball is missing its end marker.')
}

const packageDigests = (bytes: Buffer): PackageTarballDigests => {
  const sha1 = createHash('sha1').update(bytes).digest('hex')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const sha512Hash = createHash('sha512').update(bytes)
  const sha512 = sha512Hash.copy().digest('hex')
  return Object.freeze({
    bytes: bytes.length,
    integrity: `sha512-${sha512Hash.digest('base64')}`,
    sha1,
    sha256,
    sha512,
  })
}

export const packageTarballDigests = (path: string): PackageTarballDigests =>
  packageDigests(readVerifiedRegularFile(path, maximumTarballBytes))

const sameDigests = (left: PackageTarballDigests, right: PackageTarballDigests) =>
  left.bytes === right.bytes &&
  left.integrity === right.integrity &&
  left.sha1 === right.sha1 &&
  left.sha256 === right.sha256 &&
  left.sha512 === right.sha512

export const snapshotPackageTarball = (
  sourcePath: string,
  directory: string,
  hooks: FileReadHooks = {},
): PackageTarballSnapshot => {
  const bytes = readVerifiedRegularFile(sourcePath, maximumTarballBytes, hooks)
  const snapshotPath = resolve(directory, 'package.tgz')
  const ancestors = captureAncestorChain(snapshotPath)
  const descriptor = openSync(snapshotPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400)
  try {
    writeDescriptorBytes(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  assertAncestorChain(ancestors, 'Package snapshot destination')
  const snapshotDigests = packageTarballDigests(snapshotPath)
  const sourceDigests = packageDigests(bytes)
  if (!sameDigests(snapshotDigests, sourceDigests)) {
    throw new Error('Package snapshot changed while it was being written.')
  }
  return Object.freeze({ digests: snapshotDigests, path: snapshotPath })
}

const metadataKeys = [
  'bytes',
  'integrity',
  'packageVersion',
  'sha1',
  'sha256',
  'sha512',
  'sourceCommit',
  'tarball',
] as const

const serialiseMetadata = (metadata: PackageArtifactMetadata) => `${JSON.stringify(metadata, null, 2)}\n`

const repositoryRelativePath = (path: string) => {
  assertRepositoryRootStable()
  const repositoryRelative = relative(root, resolve(path))
  if (
    repositoryRelative.length > 0 &&
    repositoryRelative !== '..' &&
    !repositoryRelative.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryRelative)
  ) {
    return repositoryRelative.split(sep).join('/')
  }
  throw new Error('Package artifact must remain within the repository.')
}

export const createPackageArtifactMetadata = (
  digests: PackageTarballDigests,
  packageVersion: string,
  sourceCommit: string,
  tarball: string,
): PackageArtifactMetadata =>
  Object.freeze({
    bytes: digests.bytes,
    integrity: digests.integrity,
    packageVersion,
    sha1: digests.sha1,
    sha256: digests.sha256,
    sha512: digests.sha512,
    sourceCommit,
    tarball,
  })

export const packageArtifactMetadataPath = (tarballPath: string) => `${tarballPath}.metadata.json`

const parsePackageArtifactMetadata = (bytes: Buffer): PackageArtifactMetadata => {
  const text = utf8Decoder.decode(bytes)
  const parsed = JSON.parse(text) as Record<string, unknown>
  if (
    Object.keys(parsed).length === metadataKeys.length &&
    metadataKeys.every(key => Object.hasOwn(parsed, key)) &&
    typeof parsed.bytes === 'number' &&
    Number.isSafeInteger(parsed.bytes) &&
    parsed.bytes >= 0 &&
    typeof parsed.integrity === 'string' &&
    /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(parsed.integrity) &&
    typeof parsed.packageVersion === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(parsed.packageVersion) &&
    typeof parsed.sha1 === 'string' &&
    /^[0-9a-f]{40}$/u.test(parsed.sha1) &&
    typeof parsed.sha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(parsed.sha256) &&
    typeof parsed.sha512 === 'string' &&
    /^[0-9a-f]{128}$/u.test(parsed.sha512) &&
    typeof parsed.sourceCommit === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(parsed.sourceCommit) &&
    typeof parsed.tarball === 'string' &&
    parsed.tarball.length > 0
  ) {
    const metadata = createPackageArtifactMetadata(
      {
        bytes: parsed.bytes,
        integrity: parsed.integrity,
        sha1: parsed.sha1,
        sha256: parsed.sha256,
        sha512: parsed.sha512,
      },
      parsed.packageVersion,
      parsed.sourceCommit,
      parsed.tarball,
    )
    if (serialiseMetadata(metadata) === text) {
      return metadata
    }
  }
  throw new Error('Package artifact metadata is not the bounded canonical sidecar format.')
}

export const verifyPackageArtifactMetadata = (
  tarballPath: string,
  expected: Readonly<{ packageVersion?: string; sourceCommit?: string; tarball?: string }> = {},
) => {
  const metadata = parsePackageArtifactMetadata(
    readVerifiedRegularFile(packageArtifactMetadataPath(tarballPath), maximumMetadataBytes),
  )
  const digests = packageTarballDigests(tarballPath)
  const expectedTarball = expected.tarball ?? repositoryRelativePath(tarballPath)
  if (
    sameDigests(metadata, digests) &&
    metadata.tarball === expectedTarball &&
    (expected.packageVersion === undefined || metadata.packageVersion === expected.packageVersion) &&
    (expected.sourceCommit === undefined || metadata.sourceCommit === expected.sourceCommit)
  ) {
    return metadata
  }
  throw new Error('Package artifact metadata does not identify the exact supplied tarball and reviewed source.')
}

const writePrivateFile = (path: string, bytes: Buffer) => {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400)
  try {
    writeDescriptorBytes(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

const fileIdentity = (path: string) => {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (entry?.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n) {
    return entry
  }
  throw new Error('Retained package entries must be regular files with one hard link.')
}

const sameEntryIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink

const sameDirectoryIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode

const removeFileIfIdentityMatches = (path: string, identity: BigIntStats | undefined) => {
  const current = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  if (identity !== undefined && current !== undefined && sameEntryIdentity(identity, current) && current.isFile()) {
    unlinkSync(path)
    return true
  }
  return current === undefined
}

export const retainPackageArtifact = (
  snapshot: PackageTarballSnapshot,
  options: Readonly<{
    filename: string
    packageVersion: string
    retainedDirectory: string
    sourceCommit: string
  }>,
  hooks: RetentionHooks = {},
): PackageArtifactRetention => {
  const { filename, packageVersion, retainedDirectory, sourceCommit } = options
  if (
    posix.basename(filename) !== filename ||
    !filename.endsWith('.tgz') ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)
  ) {
    throw new Error('Retained package artifact identity is invalid.')
  }
  if (lstatSync(retainedDirectory, { throwIfNoEntry: false }) !== undefined) {
    throw new Error('The retained package artifact directory must be absent before retention.')
  }
  const destination = resolve(retainedDirectory, filename)
  const metadataDestination = packageArtifactMetadataPath(destination)
  const expectedEntries = new Set([filename, `${filename}.metadata.json`])
  const directoryAncestors = captureAncestorChain(retainedDirectory)
  assertRepositoryDestinationChain(directoryAncestors)
  const snapshotBytes = readVerifiedRegularFile(snapshot.path, maximumTarballBytes)
  const snapshotDigests = packageDigests(snapshotBytes)
  if (!sameDigests(snapshot.digests, snapshotDigests)) {
    throw new Error('Reviewed package snapshot changed before retention.')
  }
  const metadata = createPackageArtifactMetadata(
    snapshotDigests,
    packageVersion,
    sourceCommit,
    repositoryRelativePath(destination),
  )
  const nonce = randomUUID()
  const privateDirectory = resolve(dirname(retainedDirectory), `.${basename(retainedDirectory)}.${nonce}.private`)
  const privateTarball = resolve(privateDirectory, filename)
  const privateMetadata = resolve(privateDirectory, `${filename}.metadata.json`)
  let privateDirectoryIdentity: BigIntStats | undefined
  let privateTarballIdentity: BigIntStats | undefined
  let privateMetadataIdentity: BigIntStats | undefined
  let installed = false

  const rollback = () => {
    if (!installed && sameAncestorChain(directoryAncestors) && privateDirectoryIdentity !== undefined) {
      const currentDirectory = lstatSync(privateDirectory, { bigint: true, throwIfNoEntry: false })
      if (
        currentDirectory?.isDirectory() &&
        !currentDirectory.isSymbolicLink() &&
        sameDirectoryIdentity(privateDirectoryIdentity, currentDirectory) &&
        removeFileIfIdentityMatches(privateTarball, privateTarballIdentity) &&
        removeFileIfIdentityMatches(privateMetadata, privateMetadataIdentity) &&
        readBoundedDirectoryNames(privateDirectory, 0).length === 0
      ) {
        rmdirSync(privateDirectory)
      }
    }
  }

  const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
  const signalHandlers = new Map(
    signals.map(signal => [
      signal,
      () => {
        rollback()
        signalHandlers.forEach((handler, value) => {
          process.removeListener(value, handler)
        })
        process.kill(process.pid, signal)
      },
    ]),
  )
  signalHandlers.forEach((handler, signal) => {
    process.on(signal, handler)
  })
  try {
    mkdirSync(privateDirectory, { mode: 0o700 })
    const createdPrivateDirectory = lstatSync(privateDirectory, { bigint: true })
    if (
      !createdPrivateDirectory.isDirectory() ||
      createdPrivateDirectory.isSymbolicLink() ||
      realpathSync.native(privateDirectory) !== privateDirectory
    ) {
      throw new Error('The private package artifact directory is not one canonical directory.')
    }
    privateDirectoryIdentity = createdPrivateDirectory
    writePrivateFile(privateTarball, snapshotBytes)
    privateTarballIdentity = fileIdentity(privateTarball)
    writePrivateFile(privateMetadata, Buffer.from(serialiseMetadata(metadata), 'utf8'))
    privateMetadataIdentity = fileIdentity(privateMetadata)
    privateDirectoryIdentity = lstatSync(privateDirectory, { bigint: true })
    const privateEntries = readBoundedDirectoryNames(privateDirectory, expectedEntries.size)
    if (privateEntries.length !== expectedEntries.size || privateEntries.some(entry => !expectedEntries.has(entry))) {
      throw new Error('The private package artifact directory contains unexpected entries.')
    }
    const privateVerifiedMetadata = verifyPackageArtifactMetadata(privateTarball, {
      packageVersion,
      sourceCommit,
      tarball: metadata.tarball,
    })
    if (!sameDigests(privateVerifiedMetadata, snapshotDigests)) {
      throw new Error('The private package artifact differs from the reviewed snapshot.')
    }
    hooks.beforeInstall?.()
    assertAncestorChain(directoryAncestors, 'Retained package destination')
    assertRepositoryDestinationChain(directoryAncestors)
    if (lstatSync(retainedDirectory, { throwIfNoEntry: false }) !== undefined) {
      throw new Error('The retained package destination came into existence before its atomic directory rename.')
    }
    renameSync(privateDirectory, retainedDirectory)
    installed = true
    assertAncestorChain(directoryAncestors, 'Retained package destination')
    assertRepositoryDestinationChain(directoryAncestors)
    const retainedDirectoryIdentity = lstatSync(retainedDirectory, { bigint: true, throwIfNoEntry: false })
    const retainedTarballIdentity = lstatSync(destination, { bigint: true, throwIfNoEntry: false })
    const retainedMetadataIdentity = lstatSync(metadataDestination, { bigint: true, throwIfNoEntry: false })
    const retainedEntries = readBoundedDirectoryNames(retainedDirectory, expectedEntries.size)
    if (
      retainedDirectoryIdentity === undefined ||
      !retainedDirectoryIdentity.isDirectory() ||
      retainedDirectoryIdentity.isSymbolicLink() ||
      privateDirectoryIdentity === undefined ||
      !sameEntryIdentity(privateDirectoryIdentity, retainedDirectoryIdentity) ||
      retainedTarballIdentity === undefined ||
      privateTarballIdentity === undefined ||
      !sameStableFile(privateTarballIdentity, retainedTarballIdentity) ||
      retainedMetadataIdentity === undefined ||
      privateMetadataIdentity === undefined ||
      !sameStableFile(privateMetadataIdentity, retainedMetadataIdentity) ||
      retainedEntries.length !== expectedEntries.size ||
      retainedEntries.some(entry => !expectedEntries.has(entry)) ||
      realpathSync.native(retainedDirectory) !== retainedDirectory
    ) {
      throw new Error('The retained package directory or file identities changed during installation.')
    }
    const retainedMetadata = verifyPackageArtifactMetadata(destination, {
      packageVersion,
      sourceCommit,
      tarball: metadata.tarball,
    })
    if (!sameDigests(retainedMetadata, snapshotDigests)) {
      throw new Error('Retained package artifact differs from the reviewed snapshot.')
    }
    return Object.freeze({ metadata: retainedMetadata, metadataPath: metadataDestination, path: destination })
  } catch (error) {
    rollback()
    throw error
  } finally {
    signalHandlers.forEach((handler, signal) => {
      process.removeListener(signal, handler)
    })
  }
}
