import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

export type PackageCheckArguments = Readonly<{
  retainedDirectory?: string
  suppliedTarball?: string
}>

export type PackageTarEntry = Readonly<{
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const maximumTarballBytes = 64 * 1024 * 1024
const maximumArchiveBytes = 256 * 1024 * 1024
const packageCheckUsage = () =>
  new Error(
    'Usage: check-package.ts [--retain-tarball <repository-relative-directory> | --tarball <repository-relative-tarball>]',
  )

const repositoryPath = (value: string) => {
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
    (state, segment, index, segments) => {
      const path = resolve(state.parent, segment)
      const entry = state.ancestorMissing ? undefined : lstatSync(path, { throwIfNoEntry: false })
      const isDestination = index === segments.length - 1
      if (entry !== undefined && (isDestination || !entry.isDirectory() || entry.isSymbolicLink())) {
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

const sameFile = (left: Stats, right: Stats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

const readVerifiedRegularFile = (path: string) => {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const before = fstatSync(descriptor)
    const named = lstatSync(path)
    if (
      before.isFile() &&
      named.isFile() &&
      !named.isSymbolicLink() &&
      before.nlink === 1 &&
      named.nlink === 1 &&
      sameFile(before, named) &&
      before.size <= maximumTarballBytes
    ) {
      const bytes = readFileSync(descriptor)
      const after = fstatSync(descriptor)
      if (sameFile(before, after) && bytes.length === before.size) {
        return bytes
      }
    }
    throw new Error('Package tarball must be one unchanged regular file with one hard link.')
  } finally {
    closeSync(descriptor)
  }
}

const tarField = (header: Buffer, offset: number, length: number) =>
  header
    .subarray(offset, offset + length)
    .toString('utf8')
    .split('\0', 1)[0]
    ?.trimEnd() ?? ''

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
  const archive = gunzipSync(readVerifiedRegularFile(path), { maxOutputLength: maximumArchiveBytes })
  const entries: PackageTarEntry[] = []
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
      if (Number.isSafeInteger(size) && nextOffset <= archive.length) {
        entries.push(Object.freeze({ mode, path: pathValue, size }))
        offset = nextOffset
      } else {
        throw new Error('Package tarball contains an invalid entry size.')
      }
    }
  }
  if (foundEnd) {
    return Object.freeze(entries)
  }
  throw new Error('Package tarball is missing its end marker.')
}

export const packageTarballDigests = (path: string): PackageTarballDigests => {
  const bytes = readVerifiedRegularFile(path)
  return packageDigests(bytes)
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

export const snapshotPackageTarball = (sourcePath: string, directory: string): PackageTarballSnapshot => {
  const bytes = readVerifiedRegularFile(sourcePath)
  const snapshotPath = resolve(directory, 'package.tgz')
  writeFileSync(snapshotPath, bytes, { flag: 'wx', mode: 0o400 })
  return Object.freeze({
    digests: packageDigests(bytes),
    path: snapshotPath,
  })
}
