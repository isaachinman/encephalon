import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { sameEntryIdentity } from './filesystem-entry.ts'

const FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const
const MARKER_PREFIX = 'encephalon:managed-instructions:'
const START_PREFIX = '<!-- encephalon:managed-instructions:start '
const END_MARKER = '<!-- encephalon:managed-instructions:end -->'
const SKILL_PATH = './node_modules/encephalon/skills/encephalon/SKILL.md'

type BlockMetadata = {
  formatVersion: 1
  originalFileExisted: boolean
  separatorBase64: string
  lineEnding: 'LF' | 'CRLF'
}

type FilePlan = {
  filename: (typeof FILENAMES)[number]
  action: 'delete' | 'none' | 'write'
  content?: string
  contentBytes?: Buffer
  originalBytes: Buffer
  originalContent: string
  originalFileExisted: boolean
  originalIdentity?: FileIdentity
}

type FileIdentity = {
  birthtimeNs: string
  ctimeNs: string
  dev: string
  ino: string
  mtimeNs: string
  size: string
}

type StableFileIdentity = Omit<FileIdentity, 'ctimeNs'>

const ALLOWED_SEPARATORS = new Set(['', '\n', '\n\n', '\r\n', '\r\n\r\n'])
const MODE_BITS = 0o7777
const MAX_INSTRUCTION_FILE_BYTES = 1024 * 1024
const noFollowFlag = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const identityFor = (metadata: BigIntStats): FileIdentity => ({
  birthtimeNs: metadata.birthtimeNs.toString(),
  ctimeNs: metadata.ctimeNs.toString(),
  dev: metadata.dev.toString(),
  ino: metadata.ino.toString(),
  mtimeNs: metadata.mtimeNs.toString(),
  size: metadata.size.toString(),
})

const stableIdentity = ({ ctimeNs: _ctimeNs, ...identity }: FileIdentity): StableFileIdentity => identity

const sameIdentity = <Identity extends Record<string, string>>(left: Identity | undefined, right: Identity) =>
  left !== undefined && Object.entries(right).every(([key, value]) => left[key] === value)

const lstatIfExists = (path: string) => {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
}

const lstatIdentityIfExists = (path: string) => {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
}

const identityForPath = (path: string) => {
  const metadata = lstatIdentityIfExists(path)
  if (metadata === undefined) {
    return
  }
  return identityFor(metadata)
}

const requiredIdentityForPath = (path: string, filename: (typeof FILENAMES)[number]) => {
  const identity = identityForPath(path)
  if (identity === undefined) {
    return fail('REPOSITORY_CHANGED', `${filename} changed after it was preflighted.`)
  }
  return identity
}

const encodeMetadata = (metadata: BlockMetadata) => Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url')

const decodeMetadata = (encoded: string): BlockMetadata => {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<BlockMetadata>
    if (
      value.formatVersion === 1 &&
      typeof value.originalFileExisted === 'boolean' &&
      typeof value.separatorBase64 === 'string' &&
      (value.lineEnding === 'LF' || value.lineEnding === 'CRLF')
    ) {
      return value as BlockMetadata
    }
  } catch {
    // The stable validation error below deliberately omits parser internals.
  }
  return fail('VALIDATION_FAILED', 'An Encephalon instruction block contains invalid metadata.')
}

const lineEndingFor = (content: string) => (content.includes('\r\n') ? '\r\n' : '\n')

const decodeInstructionBytes = (filename: (typeof FILENAMES)[number], bytes: Buffer) => {
  if (bytes.includes(0)) {
    return fail('VALIDATION_FAILED', `${filename} contains a NUL byte.`)
  }
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    return fail('VALIDATION_FAILED', `${filename} must contain valid UTF-8.`)
  }
}

const readRegularFileBytes = (path: string, filename: (typeof FILENAMES)[number]) => {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      return fail('VALIDATION_FAILED', `${filename} must remain a regular non-symlink file.`)
    }
    throw error
  }
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile()) {
      return fail('VALIDATION_FAILED', 'Managed instruction paths must remain regular files.')
    }
    if (metadata.size > MAX_INSTRUCTION_FILE_BYTES) {
      return fail('VALIDATION_FAILED', `${filename} exceeds the 1 MiB instruction-file limit.`)
    }
    return readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

const boundedInstructionBytes = (filename: (typeof FILENAMES)[number], bytes: Buffer) => {
  if (bytes.length <= MAX_INSTRUCTION_FILE_BYTES) {
    return bytes
  }
  return fail(
    'VALIDATION_FAILED',
    `${filename} cannot fit the Encephalon managed block within the 1 MiB instruction-file limit.`,
  )
}

const blockFor = (metadata: BlockMetadata) => {
  const lineEnding = metadata.lineEnding === 'CRLF' ? '\r\n' : '\n'
  return [
    `${START_PREFIX}${encodeMetadata(metadata)} -->`,
    '## Encephalon',
    'Read and follow the repository-memory skill before making repository assumptions or recording durable knowledge:',
    SKILL_PATH,
    END_MARKER,
    '',
  ].join(lineEnding)
}

const occurrences = (content: string, needle: string) => {
  const positions: number[] = []
  let offset = 0
  while (offset <= content.length) {
    const index = content.indexOf(needle, offset)
    if (index === -1) {
      break
    }
    positions.push(index)
    offset = index + needle.length
  }
  return positions
}

const inspectBlock = (content: string) => {
  const starts = occurrences(content, START_PREFIX)
  const ends = occurrences(content, END_MARKER)
  const markers = occurrences(content, MARKER_PREFIX)
  if (starts.length === 0 && ends.length === 0 && markers.length === 0) {
    return
  }
  const [start] = starts
  const [end] = ends
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    markers.length !== 2 ||
    start === undefined ||
    end === undefined ||
    start >= end
  ) {
    return fail(
      'VALIDATION_FAILED',
      'An instruction file contains malformed, nested, duplicate, or unmatched Encephalon markers.',
    )
  }
  const startEnd = content.indexOf(' -->', start + START_PREFIX.length)
  if (startEnd === -1 || startEnd > end) {
    return fail('VALIDATION_FAILED', 'An Encephalon instruction block has a malformed opening marker.')
  }
  const encoded = content.slice(start + START_PREFIX.length, startEnd)
  const metadata = decodeMetadata(encoded)
  const expected = blockFor(metadata)
  if (content.slice(start, start + expected.length) !== expected) {
    return fail('VALIDATION_FAILED', 'An Encephalon instruction block was modified and cannot be managed safely.')
  }
  const separator = Buffer.from(metadata.separatorBase64, 'base64').toString('utf8')
  if (
    !ALLOWED_SEPARATORS.has(separator) ||
    Buffer.from(separator, 'utf8').toString('base64') !== metadata.separatorBase64
  ) {
    return fail('VALIDATION_FAILED', 'An Encephalon instruction block contains invalid separator metadata.')
  }
  if (start < separator.length || content.slice(start - separator.length, start) !== separator) {
    return fail('VALIDATION_FAILED', 'An Encephalon instruction block separator does not match its metadata.')
  }
  return { end: start + expected.length, metadata, separator, start }
}

const additionPlan = (root: string, filename: (typeof FILENAMES)[number]): FilePlan => {
  const path = resolve(root, filename)
  const existingMetadata = lstatIfExists(path)
  const existed = existingMetadata !== undefined
  if (existingMetadata !== undefined) {
    const metadata = existingMetadata
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return fail('VALIDATION_FAILED', `${filename} must be a regular non-symlink file.`)
    }
  }
  const originalBytes = existed ? readRegularFileBytes(path, filename) : Buffer.alloc(0)
  const content = decodeInstructionBytes(filename, originalBytes)
  const installed = inspectBlock(content)
  if (installed !== undefined) {
    return {
      action: 'none',
      filename,
      originalBytes,
      originalContent: content,
      originalFileExisted: existed,
      ...(existingMetadata === undefined ? {} : { originalIdentity: requiredIdentityForPath(path, filename) }),
    }
  }
  const lineEnding = lineEndingFor(content)
  let separator = ''
  if (content.length > 0) {
    separator = content.endsWith(lineEnding) ? lineEnding : `${lineEnding}${lineEnding}`
  }
  const metadata: BlockMetadata = {
    formatVersion: 1,
    lineEnding: lineEnding === '\r\n' ? 'CRLF' : 'LF',
    originalFileExisted: existed,
    separatorBase64: Buffer.from(separator, 'utf8').toString('base64'),
  }
  const nextContent = `${content}${separator}${blockFor(metadata)}`
  const nextBytes = boundedInstructionBytes(filename, Buffer.from(nextContent, 'utf8'))
  return {
    action: 'write',
    content: nextContent,
    contentBytes: nextBytes,
    filename,
    originalBytes,
    ...(existingMetadata === undefined ? {} : { originalIdentity: requiredIdentityForPath(path, filename) }),
    originalContent: content,
    originalFileExisted: existed,
  }
}

const removalPlan = (root: string, filename: (typeof FILENAMES)[number]): FilePlan => {
  const path = resolve(root, filename)
  const fileMetadata = lstatIfExists(path)
  if (fileMetadata === undefined) {
    return {
      action: 'none',
      filename,
      originalBytes: Buffer.alloc(0),
      originalContent: '',
      originalFileExisted: false,
    }
  }
  if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
    return fail('VALIDATION_FAILED', `${filename} must be a regular non-symlink file.`)
  }
  const originalBytes = readRegularFileBytes(path, filename)
  const content = decodeInstructionBytes(filename, originalBytes)
  const installed = inspectBlock(content)
  if (installed === undefined) {
    return {
      action: 'none',
      filename,
      originalBytes,
      originalContent: content,
      originalFileExisted: true,
      originalIdentity: requiredIdentityForPath(path, filename),
    }
  }
  const contentWithoutBlock = `${content.slice(0, installed.start - installed.separator.length)}${content.slice(installed.end)}`
  if (!installed.metadata.originalFileExisted && contentWithoutBlock.length === 0) {
    return {
      action: 'delete',
      filename,
      originalBytes,
      originalContent: content,
      originalFileExisted: true,
      originalIdentity: requiredIdentityForPath(path, filename),
    }
  }
  const nextBytes = Buffer.from(contentWithoutBlock, 'utf8')
  return {
    action: 'write',
    content: contentWithoutBlock,
    contentBytes: nextBytes,
    filename,
    originalBytes,
    originalContent: content,
    originalFileExisted: true,
    originalIdentity: requiredIdentityForPath(path, filename),
  }
}

const assertPlanIsCurrent = (root: string, plan: FilePlan) => {
  const path = resolve(root, plan.filename)
  const metadata = lstatIfExists(path)
  const exists = metadata !== undefined
  if (exists !== plan.originalFileExisted) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
  if (metadata?.isSymbolicLink() === true || (metadata !== undefined && !metadata.isFile())) {
    return fail('VALIDATION_FAILED', `${plan.filename} must remain a regular non-symlink file.`)
  }
  if (exists && !readRegularFileBytes(path, plan.filename).equals(plan.originalBytes)) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
}

type AtomicWriteFault =
  | 'after-publication'
  | 'after-backup-validation'
  | 'after-delete-quarantine'
  | 'after-delete-verification'
  | 'after-recovery-create'
  | 'after-recovery-private-flush'
  | 'after-recovery-open'
  | 'after-backup-rename'
  | 'after-plan-validation'
  | 'after-temp-create'
  | 'after-temp-unlink'
  | 'before-backup-cleanup-create'
  | 'before-backup-create'
  | 'before-final-backup-validation'
  | 'before-deletion'
  | 'during-delete-flush'
  | 'during-backup-cleanup'
  | 'during-backup-flush'
  | 'during-publication-flush'
  | 'during-quarantine-restore'
  | 'before-temp-create'
  | 'during-backup-restore'
  | 'during-file-flush'
  | 'during-publication'
  | 'during-restore-flush'
  | 'during-temp-cleanup'
  | 'during-temp-write'

type AtomicWriteHooks = {
  close?: (descriptor: number) => void
  fault?: (point: AtomicWriteFault, generatedPath?: string, descriptor?: number) => void
}

const fault = (
  hooks: AtomicWriteHooks | undefined,
  point: AtomicWriteFault,
  generatedPath?: string,
  descriptor?: number,
) => {
  hooks?.fault?.(point, generatedPath, descriptor)
}

const identityBoundaryError = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return code === 'EEXIST' || code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR'
}

const mapInstructionIdentity = <Value>(filename: (typeof FILENAMES)[number], operation: () => Value): Value => {
  try {
    return operation()
  } catch (error) {
    if (identityBoundaryError(error)) {
      return instructionIdentityChanged(filename, { cause: error })
    }
    throw error
  }
}

class InstructionRootAuthority {
  private readonly descriptor: number | undefined
  private filename: (typeof FILENAMES)[number]
  private readonly identity!: BigIntStats
  private readonly root: string

  constructor(root: string, filename: (typeof FILENAMES)[number]) {
    this.filename = filename
    this.root = root
    const pathMetadata = mapInstructionIdentity(filename, () => lstatSync(root, { bigint: true }))
    if (!pathMetadata.isDirectory() || pathMetadata.isSymbolicLink()) {
      instructionIdentityChanged(filename)
    }
    let descriptor: number | undefined
    try {
      if (process.platform !== 'win32') {
        descriptor = mapInstructionIdentity(filename, () =>
          openSync(root, constants.O_RDONLY | directoryFlag | noFollowFlag),
        )
        const descriptorMetadata = mapInstructionIdentity(filename, () =>
          fstatSync(descriptor as number, { bigint: true }),
        )
        if (!(descriptorMetadata.isDirectory() && sameEntryIdentity(pathMetadata, descriptorMetadata))) {
          instructionIdentityChanged(filename)
        }
      }
      const finalPathMetadata = mapInstructionIdentity(filename, () => lstatSync(root, { bigint: true }))
      if (
        !finalPathMetadata.isDirectory() ||
        finalPathMetadata.isSymbolicLink() ||
        !sameEntryIdentity(pathMetadata, finalPathMetadata)
      ) {
        instructionIdentityChanged(filename)
      }
      this.descriptor = descriptor
      this.identity = pathMetadata
    } catch (error) {
      if (descriptor !== undefined) {
        closeAfterOperation(descriptor, true)
      }
      throw error
    }
  }

  acquireOwned<Value>(
    operation: () => Value,
    acceptOwnership: (value: Value) => void,
    afterAcquire?: (value: Value) => void,
  ) {
    this.assertCurrent()
    const value = mapInstructionIdentity(this.filename, operation)
    acceptOwnership(value)
    afterAcquire?.(value)
    this.assertCurrent()
    return value
  }

  assertCurrent() {
    const pathMetadata = mapInstructionIdentity(this.filename, () => lstatSync(this.root, { bigint: true }))
    if (
      !pathMetadata.isDirectory() ||
      pathMetadata.isSymbolicLink() ||
      !sameEntryIdentity(this.identity, pathMetadata)
    ) {
      return instructionIdentityChanged(this.filename)
    }
    if (this.descriptor !== undefined) {
      const descriptorMetadata = mapInstructionIdentity(this.filename, () =>
        fstatSync(this.descriptor as number, { bigint: true }),
      )
      if (!(descriptorMetadata.isDirectory() && sameEntryIdentity(this.identity, descriptorMetadata))) {
        return instructionIdentityChanged(this.filename)
      }
    }
  }

  useFilename(filename: (typeof FILENAMES)[number]) {
    this.filename = filename
  }

  flush() {
    this.assertCurrent()
    if (this.descriptor !== undefined) {
      try {
        fsyncSync(this.descriptor)
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM') {
          throw error
        }
      }
    }
    this.assertCurrent()
  }

  close(operationFailed: boolean) {
    if (this.descriptor !== undefined) {
      closeAfterOperation(this.descriptor, operationFailed)
    }
  }
}

const closeAfterOperation = (descriptor: number, operationFailed: boolean) => {
  try {
    closeSync(descriptor)
  } catch (error) {
    if (operationFailed) {
      return
    }
    throw error
  }
}

const writeAll = (descriptor: number, bytes: Buffer, plan: FilePlan, hooks: AtomicWriteHooks | undefined) => {
  fault(hooks, 'during-temp-write')
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset)
    if (written <= 0) {
      throw Object.assign(new Error(`Unable to write ${plan.filename}.`), { code: 'EIO' })
    }
    offset += written
  }
}

const tempPathFor = (path: string, suffix = 'tmp') =>
  join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.${suffix}`)

const fsyncDirectory = (path: string) => {
  if (process.platform !== 'win32') {
    let descriptor: number | undefined
    let operationFailed = false
    try {
      descriptor = openSync(path, constants.O_RDONLY | directoryFlag)
      fsyncSync(descriptor)
    } catch (error) {
      operationFailed = true
      const { code } = error as NodeJS.ErrnoException
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM') {
        throw error
      }
    } finally {
      if (descriptor !== undefined) {
        closeAfterOperation(descriptor, operationFailed)
      }
    }
  }
}

type PostCommitPhase =
  | 'backupCleanup'
  | 'publicationFlush'
  | 'publicationVerification'
  | 'resourceCleanup'
  | 'temporaryCleanup'

type DescriptorSnapshot = {
  bytes: Buffer
  identity: FileIdentity
  mode: bigint
}

type HeldInstructionFile = DescriptorSnapshot & {
  descriptor: number
}

type PostCommitFailure = {
  cause: unknown
  identityUncertain: boolean
  phase: PostCommitPhase
}

type RecoveryAliases = Map<string, DescriptorSnapshot>

const postCommitPhasePriority = [
  'publicationVerification',
  'publicationFlush',
  'backupCleanup',
  'temporaryCleanup',
  'resourceCleanup',
] as const satisfies readonly PostCommitPhase[]

const postCommitRecoveryAction = {
  backupCleanup:
    'Inspect the repository root and remove only a confirmed backup left by this operation before retrying.',
  publicationFlush:
    'Retry init to revalidate the unchanged canonical instruction file and sync its containing directory.',
  publicationVerification:
    'Inspect the canonical instruction file before retrying; the linked replacement may have been displaced by a concurrent change.',
  resourceCleanup:
    'No instruction alias requires removal. If using the API, end the current process before retrying to release any descriptor that may remain.',
  temporaryCleanup:
    'Inspect the repository root and remove only a confirmed temporary file left by this operation before retrying.',
} as const satisfies Record<PostCommitPhase, string>

class InstructionIdentityError extends Error {}

const instructionIdentityChanged = (filename: (typeof FILENAMES)[number], options?: ErrorOptions): never => {
  throw new InstructionIdentityError(`${filename} changed during publication.`, options)
}

const readDescriptorBytes = (descriptor: number, size: bigint) => {
  if (size > BigInt(MAX_INSTRUCTION_FILE_BYTES)) {
    throw new InstructionIdentityError('An instruction file exceeded its size limit during publication.')
  }
  const bytes = Buffer.alloc(Number(size))
  let offset = 0
  while (offset < bytes.length) {
    const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
    if (read <= 0) {
      throw Object.assign(new Error('Unable to read an instruction file descriptor.'), {
        code: 'EIO',
      })
    }
    offset += read
  }
  return bytes
}

const snapshotDescriptor = (descriptor: number, filename: (typeof FILENAMES)[number]): DescriptorSnapshot => {
  const before = fstatSync(descriptor, { bigint: true })
  if (!before.isFile()) {
    return instructionIdentityChanged(filename)
  }
  const bytes = readDescriptorBytes(descriptor, before.size)
  const after = fstatSync(descriptor, { bigint: true })
  if (
    !sameIdentity(identityFor(before), identityFor(after)) ||
    (before.mode & BigInt(MODE_BITS)) !== (after.mode & BigInt(MODE_BITS))
  ) {
    return instructionIdentityChanged(filename)
  }
  return {
    bytes,
    identity: identityFor(after),
    mode: after.mode & BigInt(MODE_BITS),
  }
}

const expectedDescriptorSnapshot = (
  descriptor: number,
  filename: (typeof FILENAMES)[number],
  bytes: Buffer,
  mode: bigint,
) => {
  const snapshot = snapshotDescriptor(descriptor, filename)
  if (!snapshot.bytes.equals(bytes) || snapshot.mode !== mode) {
    return instructionIdentityChanged(filename)
  }
  return snapshot
}

const holdInstructionFile = (path: string, filename: (typeof FILENAMES)[number]) => {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag)
  try {
    return { descriptor, ...snapshotDescriptor(descriptor, filename) }
  } catch (error) {
    closeAfterOperation(descriptor, true)
    throw error
  }
}

const assertPathIdentifiesDescriptor = (
  path: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  requireHeldState: boolean,
) => {
  const descriptorSnapshot = snapshotDescriptor(held.descriptor, filename)
  let pathnameMetadata: BigIntStats | undefined
  try {
    pathnameMetadata = lstatSync(path, { bigint: true })
  } catch (error) {
    if (identityBoundaryError(error)) {
      return instructionIdentityChanged(filename, { cause: error })
    }
    throw error
  }
  if (pathnameMetadata.isSymbolicLink() || !pathnameMetadata.isFile()) {
    return instructionIdentityChanged(filename)
  }
  if (!sameIdentity(descriptorSnapshot.identity, identityFor(pathnameMetadata))) {
    return instructionIdentityChanged(filename)
  }
  if (
    requireHeldState &&
    (!sameIdentity(stableIdentity(held.identity), stableIdentity(descriptorSnapshot.identity)) ||
      held.mode !== descriptorSnapshot.mode ||
      !held.bytes.equals(descriptorSnapshot.bytes))
  ) {
    return instructionIdentityChanged(filename)
  }
  return descriptorSnapshot
}

const pathIdentifiesDescriptor = (
  path: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  requireHeldState: boolean,
) => {
  try {
    assertPathIdentifiesDescriptor(path, held, filename, requireHeldState)
    return true
  } catch (error) {
    if (error instanceof InstructionIdentityError) {
      return false
    }
    throw error
  }
}

const retainRecoveryAlias = (aliases: RecoveryAliases, path: string, held: DescriptorSnapshot) => {
  aliases.set(path, { bytes: held.bytes, identity: held.identity, mode: held.mode })
}

const releaseRecoveryAlias = (aliases: RecoveryAliases, path: string) => {
  aliases.delete(path)
}

const currentRecoveryPaths = (aliases: RecoveryAliases, filename: (typeof FILENAMES)[number]) =>
  [...aliases]
    .filter(([path, expected]) => {
      let descriptor: number | undefined
      try {
        descriptor = openSync(path, constants.O_RDONLY | noFollowFlag)
        const current = snapshotDescriptor(descriptor, filename)
        const pathname = lstatSync(path, { bigint: true })
        return (
          pathname.isFile() &&
          !pathname.isSymbolicLink() &&
          sameIdentity(current.identity, identityFor(pathname)) &&
          sameIdentity(stableIdentity(expected.identity), stableIdentity(current.identity)) &&
          expected.mode === current.mode &&
          expected.bytes.equals(current.bytes)
        )
      } catch {
        return false
      } finally {
        if (descriptor !== undefined) {
          closeAfterOperation(descriptor, true)
        }
      }
    })
    .map(([path]) => basename(path))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .slice(0, 4)

const linkHeldAlias = (
  sourcePath: string,
  destinationPath: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  authority: InstructionRootAuthority,
  aliases?: RecoveryAliases,
) => {
  authority.assertCurrent()
  assertPathIdentifiesDescriptor(sourcePath, held, filename, true)
  try {
    linkSync(sourcePath, destinationPath)
    aliases?.set(destinationPath, { bytes: held.bytes, identity: held.identity, mode: held.mode })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || identityBoundaryError(error)) {
      return instructionIdentityChanged(filename, { cause: error })
    }
    throw error
  }
  authority.assertCurrent()
  assertPathIdentifiesDescriptor(destinationPath, held, filename, true)
}

const unlinkHeldSource = (
  sourcePath: string,
  destinationPath: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  authority: InstructionRootAuthority,
) => {
  authority.assertCurrent()
  assertPathIdentifiesDescriptor(destinationPath, held, filename, true)
  assertPathIdentifiesDescriptor(sourcePath, held, filename, true)
  try {
    unlinkSync(sourcePath)
  } catch (error) {
    if (identityBoundaryError(error)) {
      return instructionIdentityChanged(filename, { cause: error })
    }
    throw error
  }
  authority.assertCurrent()
  assertPathIdentifiesDescriptor(destinationPath, held, filename, true)
}

const unlinkHeldAlias = (
  path: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  authority: InstructionRootAuthority,
) => {
  authority.assertCurrent()
  assertPathIdentifiesDescriptor(path, held, filename, true)
  try {
    unlinkSync(path)
  } catch (error) {
    if (identityBoundaryError(error)) {
      return instructionIdentityChanged(filename, { cause: error })
    }
    throw error
  }
  authority.assertCurrent()
}

const createDescriptorRecoveryAlias = (
  path: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  authority: InstructionRootAuthority,
  hooks: AtomicWriteHooks | undefined,
  aliases: RecoveryAliases,
  suffix: 'backup' | 'tmp' = 'backup',
) => {
  const snapshot = { bytes: held.bytes, identity: held.identity, mode: held.mode }
  const recoveryPath = tempPathFor(path, suffix)
  let recoveryDescriptor: number | undefined
  let completed = false
  try {
    authority.acquireOwned(
      () => openSync(recoveryPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag, 0o600),
      descriptor => {
        recoveryDescriptor = descriptor
      },
      descriptor => fault(hooks, 'after-recovery-open', recoveryPath, descriptor),
    )
    const ownedDescriptor = recoveryDescriptor
    if (ownedDescriptor === undefined) {
      return fail('INTERNAL_ERROR', `${filename} recovery lost its owned descriptor.`)
    }
    fchmodSync(ownedDescriptor, 0o600)
    fault(hooks, 'after-recovery-create', recoveryPath, ownedDescriptor)
    let offset = 0
    while (offset < snapshot.bytes.length) {
      const written = writeSync(ownedDescriptor, snapshot.bytes, offset, snapshot.bytes.length - offset, offset)
      if (written <= 0) {
        throw Object.assign(new Error(`Unable to recover ${filename}.`), { code: 'EIO' })
      }
      offset += written
    }
    fsyncSync(ownedDescriptor)
    fault(hooks, 'after-recovery-private-flush', recoveryPath, ownedDescriptor)
    const privateRecovery = {
      descriptor: ownedDescriptor,
      ...expectedDescriptorSnapshot(ownedDescriptor, filename, snapshot.bytes, 0o600n),
    }
    assertPathIdentifiesDescriptor(recoveryPath, privateRecovery, filename, true)
    fchmodSync(ownedDescriptor, Number(snapshot.mode))
    fsyncSync(ownedDescriptor)
    const recovery = {
      descriptor: ownedDescriptor,
      ...expectedDescriptorSnapshot(ownedDescriptor, filename, snapshot.bytes, snapshot.mode),
    }
    assertPathIdentifiesDescriptor(recoveryPath, recovery, filename, true)
    retainRecoveryAlias(aliases, recoveryPath, recovery)
    completed = true
    return { path: recoveryPath, recovery }
  } finally {
    if (recoveryDescriptor !== undefined && !completed) {
      closeAfterOperation(recoveryDescriptor, true)
    }
  }
}

const restoreDurableAlias = (
  sourcePath: string,
  path: string,
  held: HeldInstructionFile,
  plan: FilePlan,
  hooks: AtomicWriteHooks | undefined,
  authority: InstructionRootAuthority,
  aliases: RecoveryAliases,
) => {
  if (!pathIdentifiesDescriptor(path, held, plan.filename, true)) {
    linkHeldAlias(sourcePath, path, held, plan.filename, authority)
  }
  assertPathIdentifiesDescriptor(path, held, plan.filename, true)
  assertPathIdentifiesDescriptor(sourcePath, held, plan.filename, true)
  fault(hooks, 'during-restore-flush')
  authority.flush()
  assertPathIdentifiesDescriptor(path, held, plan.filename, true)
  unlinkHeldSource(sourcePath, path, held, plan.filename, authority)
  releaseRecoveryAlias(aliases, sourcePath)
}

const restoreHeldBackup = (
  path: string,
  backupPath: string,
  held: HeldInstructionFile,
  plan: FilePlan,
  hooks: AtomicWriteHooks | undefined,
  authority: InstructionRootAuthority,
  aliases: RecoveryAliases,
) => {
  let recoveryError: unknown
  let recoveryRetained = false
  try {
    authority.assertCurrent()
    fault(hooks, 'during-backup-restore')
    const recoveryHeld = held
    const canonicalExists = mapInstructionIdentity(plan.filename, () => lstatIfExists(path) !== undefined)
    if (canonicalExists) {
      if (pathIdentifiesDescriptor(path, recoveryHeld, plan.filename, true)) {
        if (!pathIdentifiesDescriptor(backupPath, recoveryHeld, plan.filename, true)) {
          return instructionIdentityChanged(plan.filename)
        }
        restoreDurableAlias(backupPath, path, recoveryHeld, plan, hooks, authority, aliases)
      } else if (pathIdentifiesDescriptor(backupPath, recoveryHeld, plan.filename, true)) {
        return instructionIdentityChanged(plan.filename)
      } else {
        const copy = createDescriptorRecoveryAlias(path, recoveryHeld, plan.filename, authority, hooks, aliases)
        recoveryRetained = true
        closeAfterOperation(copy.recovery.descriptor, true)
        return instructionIdentityChanged(plan.filename)
      }
    } else if (pathIdentifiesDescriptor(backupPath, recoveryHeld, plan.filename, true)) {
      restoreDurableAlias(backupPath, path, recoveryHeld, plan, hooks, authority, aliases)
      assertPathIdentifiesDescriptor(path, recoveryHeld, plan.filename, true)
    } else {
      const copy = createDescriptorRecoveryAlias(path, recoveryHeld, plan.filename, authority, hooks, aliases)
      try {
        restoreDurableAlias(copy.path, path, copy.recovery, plan, hooks, authority, aliases)
        const restored = assertPathIdentifiesDescriptor(path, copy.recovery, plan.filename, true)
        if (!restored.bytes.equals(recoveryHeld.bytes) || restored.mode !== recoveryHeld.mode) {
          return instructionIdentityChanged(plan.filename)
        }
      } finally {
        closeAfterOperation(copy.recovery.descriptor, true)
      }
    }
  } catch (error) {
    recoveryError = error
    try {
      const canonicalExact = pathIdentifiesDescriptor(path, held, plan.filename, true)
      const backupExact = pathIdentifiesDescriptor(backupPath, held, plan.filename, true)
      if (!(canonicalExact || backupExact || recoveryRetained)) {
        const copy = createDescriptorRecoveryAlias(path, held, plan.filename, authority, hooks, aliases)
        closeAfterOperation(copy.recovery.descriptor, true)
      }
    } catch {
      // Keep every uncertain alias; the recovery error below remains authoritative.
    }
  }
  return recoveryError
}

const restoreQuarantinedFile = (path: string, quarantinePath: string, hooks: AtomicWriteHooks | undefined) => {
  try {
    if (lstatIfExists(path) === undefined && lstatIfExists(quarantinePath) !== undefined) {
      fault(hooks, 'during-quarantine-restore')
      linkSync(quarantinePath, path)
      rmSync(quarantinePath, { force: true })
    }
  } catch {
    // Keep the quarantined file in place so the inspected bytes remain recoverable.
  }
}

const assertOriginalDeleteTarget = (path: string, plan: FilePlan) => {
  const metadata = lstatIdentityIfExists(path)
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
  if (!sameIdentity(plan.originalIdentity, identityFor(metadata))) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
  if (!readRegularFileBytes(path, plan.filename).equals(plan.originalBytes)) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
}

const assertQuarantinedDeleteTarget = (quarantinePath: string, plan: FilePlan) => {
  const metadata = lstatIdentityIfExists(quarantinePath)
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
  const originalIdentity = plan.originalIdentity === undefined ? undefined : stableIdentity(plan.originalIdentity)
  if (!sameIdentity(originalIdentity, stableIdentity(identityFor(metadata)))) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
  if (!readRegularFileBytes(quarantinePath, plan.filename).equals(plan.originalBytes)) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
}

const deletePlan = (path: string, plan: FilePlan, hooks: AtomicWriteHooks | undefined) => {
  const quarantinePath = tempPathFor(path, 'delete')
  let quarantined = false
  try {
    fault(hooks, 'before-deletion')
    assertOriginalDeleteTarget(path, plan)
    renameSync(path, quarantinePath)
    quarantined = true
    fault(hooks, 'after-delete-quarantine')
    assertQuarantinedDeleteTarget(quarantinePath, plan)
    fault(hooks, 'after-delete-verification')
    assertQuarantinedDeleteTarget(quarantinePath, plan)
    rmSync(quarantinePath, { force: true })
    try {
      fault(hooks, 'during-delete-flush')
      fsyncDirectory(dirname(path))
    } catch {
      // The quarantine unlink is the deletion commit point; do not report a committed deletion as failed.
    }
  } catch (error) {
    if (quarantined) {
      restoreQuarantinedFile(path, quarantinePath, hooks)
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
    }
    throw error
  }
}

const isInstructionIdentityUncertainty = (error: unknown) =>
  error instanceof InstructionIdentityError || (error instanceof EncephalonError && error.code === 'REPOSITORY_CHANGED')

const capturePostCommitFailure = (
  failures: readonly PostCommitFailure[],
  phase: PostCommitPhase,
  operation: () => void,
) => {
  try {
    operation()
    return failures
  } catch (error) {
    return [...failures, postCommitFailure(phase, error)]
  }
}

const postCommitFailure = (phase: PostCommitPhase, cause: unknown): PostCommitFailure => ({
  cause,
  identityUncertain: isInstructionIdentityUncertainty(cause),
  phase,
})

const finaliseHeldBackup = (
  path: string,
  backupPath: string,
  held: HeldInstructionFile,
  plan: FilePlan,
  hooks: AtomicWriteHooks | undefined,
  authority: InstructionRootAuthority,
  aliases: RecoveryAliases,
) => {
  fault(hooks, 'during-backup-cleanup')
  const cleanupPath = tempPathFor(path, 'backup')
  fault(hooks, 'before-backup-cleanup-create', cleanupPath)
  try {
    linkHeldAlias(backupPath, cleanupPath, held, plan.filename, authority, aliases)
    unlinkHeldSource(backupPath, cleanupPath, held, plan.filename, authority)
    releaseRecoveryAlias(aliases, backupPath)
    fault(hooks, 'before-final-backup-validation', cleanupPath)
    if (mapInstructionIdentity(plan.filename, () => lstatIfExists(backupPath) !== undefined)) {
      return instructionIdentityChanged(plan.filename)
    }
    unlinkHeldAlias(cleanupPath, held, plan.filename, authority)
    releaseRecoveryAlias(aliases, cleanupPath)
  } catch (error) {
    if (isInstructionIdentityUncertainty(error)) {
      try {
        const sourceExact = pathIdentifiesDescriptor(backupPath, held, plan.filename, true)
        const cleanupExact = pathIdentifiesDescriptor(cleanupPath, held, plan.filename, true)
        if (!(sourceExact || cleanupExact)) {
          authority.assertCurrent()
          const copy = createDescriptorRecoveryAlias(path, held, plan.filename, authority, hooks, aliases)
          closeAfterOperation(copy.recovery.descriptor, true)
        }
      } catch {
        // Preserve every uncertain pathname; the identity error remains authoritative.
      }
    }
    throw error
  }
}

const orderedFailedPhases = (failures: readonly PostCommitFailure[]) =>
  postCommitPhasePriority.filter(phase => failures.some(failure => failure.phase === phase))

const committedFailureDetails = (
  plan: FilePlan,
  phase: PostCommitPhase,
  failures: readonly PostCommitFailure[],
  aliases: RecoveryAliases,
) => ({
  filename: plan.filename,
  instructionCommitted: true,
  postCommitFailures: orderedFailedPhases(failures).map(failedPhase => ({
    postCommitPhase: failedPhase,
    recoveryAction: postCommitRecoveryAction[failedPhase],
  })),
  postCommitPhase: phase,
  recoveryAction: postCommitRecoveryAction[phase],
  recoveryPaths: currentRecoveryPaths(aliases, plan.filename),
})

const throwHighestPriorityCommittedFailure = (
  plan: FilePlan,
  failures: readonly PostCommitFailure[],
  aliases: RecoveryAliases,
) => {
  const phase = postCommitPhasePriority.find(candidate => failures.some(failure => failure.phase === candidate))
  if (phase !== undefined) {
    const samePhase = failures.filter(candidate => candidate.phase === phase)
    const failure = samePhase.find(candidate => candidate.identityUncertain) ?? samePhase[0]
    if (failure !== undefined) {
      const recoveryAction = postCommitRecoveryAction[phase]
      const message = `${plan.filename} was committed, but the ${phase} post-commit phase failed. ${recoveryAction}`
      const details = committedFailureDetails(plan, phase, failures, aliases)
      const identityFailure = failures.find(candidate => candidate.identityUncertain)
      if (identityFailure !== undefined) {
        throw new EncephalonError('REPOSITORY_CHANGED', message, details, {
          cause: identityFailure.cause,
        })
      }
      return wrapIo(message, failure.cause, details)
    }
  }
}

class PostTemporaryUnlinkError extends Error {}

const cleanupHeldTempFile = (
  path: string,
  tempPath: string,
  held: HeldInstructionFile,
  plan: FilePlan,
  hooks: AtomicWriteHooks | undefined,
  authority: InstructionRootAuthority,
  aliases: RecoveryAliases,
) => {
  fault(hooks, 'during-temp-cleanup', tempPath)
  authority.assertCurrent()
  assertPathIdentifiesDescriptor(path, held, plan.filename, true)
  assertPathIdentifiesDescriptor(tempPath, held, plan.filename, true)
  try {
    unlinkSync(tempPath)
  } catch (error) {
    if (identityBoundaryError(error)) {
      return instructionIdentityChanged(plan.filename, { cause: error })
    }
    throw error
  }
  releaseRecoveryAlias(aliases, tempPath)
  try {
    authority.assertCurrent()
    fault(hooks, 'after-temp-unlink')
    assertPathIdentifiesDescriptor(path, held, plan.filename, true)
  } catch (error) {
    throw new PostTemporaryUnlinkError('The staged instruction path changed after temporary unlink.', { cause: error })
  }
}

const attemptPublicationFlush = (
  failures: readonly PostCommitFailure[],
  hooks: AtomicWriteHooks | undefined,
  authority: InstructionRootAuthority,
) => {
  try {
    fault(hooks, 'during-publication-flush')
    authority.flush()
    return {
      failures: failures.filter(failure => failure.phase !== 'publicationFlush'),
      succeeded: true,
    }
  } catch (error) {
    return {
      failures: [...failures, postCommitFailure('publicationFlush', error)],
      succeeded: false,
    }
  }
}

const finaliseCommittedInstruction = (input: {
  authority: InstructionRootAuthority
  backupPath: string
  hooks: AtomicWriteHooks | undefined
  path: string
  plan: FilePlan
  predecessor?: HeldInstructionFile
  aliases: RecoveryAliases
  staged: HeldInstructionFile
  tempPath: string
}) => {
  const { aliases, authority, backupPath, hooks, path, plan, predecessor, staged, tempPath } = input
  let failures: readonly PostCommitFailure[] = []
  let backupRetained = predecessor !== undefined
  let canonicalVerified = true
  let temporaryRetained = true
  failures = capturePostCommitFailure(failures, 'publicationVerification', () => {
    fault(hooks, 'after-publication')
  })
  try {
    assertPathIdentifiesDescriptor(path, staged, plan.filename, true)
    assertPathIdentifiesDescriptor(tempPath, staged, plan.filename, true)
    authority.assertCurrent()
  } catch (error) {
    canonicalVerified = false
    failures = [...failures, postCommitFailure('publicationVerification', error)]
  }

  let publicationDurable = false
  if (canonicalVerified) {
    const { failures: firstFlushFailures, succeeded: firstFlushSucceeded } = attemptPublicationFlush(
      failures,
      hooks,
      authority,
    )
    failures = firstFlushFailures
    publicationDurable = firstFlushSucceeded
    if (!publicationDurable) {
      const { failures: retryFlushFailures, succeeded: retryFlushSucceeded } = attemptPublicationFlush(
        failures,
        hooks,
        authority,
      )
      failures = retryFlushFailures
      publicationDurable = retryFlushSucceeded
    }
  }

  if (canonicalVerified && publicationDurable) {
    if (predecessor !== undefined) {
      const failureCountBeforeCleanup = failures.length
      failures = capturePostCommitFailure(failures, 'backupCleanup', () => {
        assertPathIdentifiesDescriptor(path, staged, plan.filename, true)
        finaliseHeldBackup(path, backupPath, predecessor, plan, hooks, authority, aliases)
      })
      backupRetained = failures.length !== failureCountBeforeCleanup
    }

    if (failures.some(failure => failure.phase === 'backupCleanup')) {
      try {
        authority.assertCurrent()
      } catch {
        // The recorded backup-cleanup uncertainty remains authoritative.
      }
    }

    try {
      assertPathIdentifiesDescriptor(path, staged, plan.filename, true)
      authority.assertCurrent()
    } catch (error) {
      canonicalVerified = false
      failures = [...failures, postCommitFailure('publicationVerification', error)]
    }

    if (canonicalVerified) {
      const failureCountBeforeCleanup = failures.length
      try {
        cleanupHeldTempFile(path, tempPath, staged, plan, hooks, authority, aliases)
      } catch (error) {
        if (error instanceof PostTemporaryUnlinkError) {
          canonicalVerified = false
          const cause = error.cause ?? error
          failures = [...failures, postCommitFailure('publicationVerification', cause)]
          try {
            const copy = createDescriptorRecoveryAlias(path, staged, plan.filename, authority, hooks, aliases, 'tmp')
            closeAfterOperation(copy.recovery.descriptor, true)
            failures = [...failures, postCommitFailure('temporaryCleanup', cause)]
          } catch (recoveryError) {
            failures = [...failures, postCommitFailure('temporaryCleanup', recoveryError)]
          }
        } else {
          failures = [...failures, postCommitFailure('temporaryCleanup', error)]
        }
      }
      temporaryRetained = failures.length !== failureCountBeforeCleanup
    }

    if (failures.some(failure => failure.phase === 'temporaryCleanup')) {
      try {
        authority.assertCurrent()
      } catch {
        // The recorded temporary-cleanup uncertainty remains authoritative.
      }
    }

    try {
      authority.flush()
      failures = failures.filter(failure => failure.phase !== 'publicationFlush')
    } catch (error) {
      failures = [...failures, postCommitFailure('publicationFlush', error)]
    }
  }

  if (!(canonicalVerified && publicationDurable)) {
    const blockingFailure = failures.find(
      failure => failure.phase === (canonicalVerified ? 'publicationFlush' : 'publicationVerification'),
    )
    if (blockingFailure !== undefined) {
      if (backupRetained) {
        failures = [...failures, postCommitFailure('backupCleanup', blockingFailure.cause)]
      }
      if (temporaryRetained) {
        failures = [...failures, postCommitFailure('temporaryCleanup', blockingFailure.cause)]
      }
    }
  }

  if (predecessor !== undefined) {
    failures = capturePostCommitFailure(failures, 'resourceCleanup', () =>
      (hooks?.close ?? closeSync)(predecessor.descriptor),
    )
  }
  failures = capturePostCommitFailure(failures, 'resourceCleanup', () => (hooks?.close ?? closeSync)(staged.descriptor))
  throwHighestPriorityCommittedFailure(plan, failures, aliases)
}

const writePlan = (path: string, plan: FilePlan, authority: InstructionRootAuthority, hooks?: AtomicWriteHooks) => {
  const bytes = plan.contentBytes ?? Buffer.alloc(0)
  const tempPath = tempPathFor(path)
  const backupPath = tempPathFor(path, 'backup')
  const aliases: RecoveryAliases = new Map()
  let staged: HeldInstructionFile | undefined
  let backup: HeldInstructionFile | undefined
  let descriptor: number | undefined
  let committed = false
  let preCommitError: unknown
  try {
    fault(hooks, 'before-temp-create')
    authority.acquireOwned(
      () => openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag, 0o600),
      acquiredDescriptor => {
        descriptor = acquiredDescriptor
      },
      acquiredDescriptor => fault(hooks, 'after-temp-create', tempPath, acquiredDescriptor),
    )
    const ownedDescriptor = descriptor
    if (ownedDescriptor === undefined) {
      return fail('INTERNAL_ERROR', `${plan.filename} publication lost its owned descriptor.`)
    }
    fchmodSync(ownedDescriptor, 0o600)
    writeAll(ownedDescriptor, bytes, plan, hooks)
    fault(hooks, 'during-file-flush')
    fsyncSync(ownedDescriptor)
    const privateStaged = {
      descriptor: ownedDescriptor,
      ...expectedDescriptorSnapshot(ownedDescriptor, plan.filename, bytes, 0o600n),
    }
    assertPathIdentifiesDescriptor(tempPath, privateStaged, plan.filename, true)
    mapInstructionIdentity(plan.filename, () => assertPlanIsCurrent(dirname(path), plan))
    let intendedMode = BigInt(0o666 & ~process.umask())
    if (plan.originalFileExisted) {
      backup = holdInstructionFile(path, plan.filename)
      if (
        !(
          backup.bytes.equals(plan.originalBytes) &&
          sameIdentity(
            plan.originalIdentity === undefined ? undefined : stableIdentity(plan.originalIdentity),
            stableIdentity(backup.identity),
          )
        )
      ) {
        return instructionIdentityChanged(plan.filename)
      }
      assertPathIdentifiesDescriptor(path, backup, plan.filename, true)
      intendedMode = backup.mode
    }
    fchmodSync(ownedDescriptor, Number(intendedMode))
    fsyncSync(ownedDescriptor)
    staged = {
      descriptor: ownedDescriptor,
      ...expectedDescriptorSnapshot(ownedDescriptor, plan.filename, bytes, intendedMode),
    }
    const verifiedStaged = staged
    assertPathIdentifiesDescriptor(tempPath, verifiedStaged, plan.filename, true)
    retainRecoveryAlias(aliases, tempPath, verifiedStaged)
    if (backup !== undefined) {
      fault(hooks, 'before-backup-create', backupPath)
      linkHeldAlias(path, backupPath, backup, plan.filename, authority, aliases)
      fault(hooks, 'during-backup-flush')
      authority.flush()
      unlinkHeldSource(path, backupPath, backup, plan.filename, authority)
      fault(hooks, 'after-backup-rename')
      fault(hooks, 'after-backup-validation')
      assertPathIdentifiesDescriptor(backupPath, backup, plan.filename, true)
    }
    fault(hooks, 'during-publication')
    authority.assertCurrent()
    assertPathIdentifiesDescriptor(tempPath, verifiedStaged, plan.filename, true)
    try {
      linkSync(tempPath, path)
      committed = true
    } catch (error) {
      if (identityBoundaryError(error)) {
        return instructionIdentityChanged(plan.filename, { cause: error })
      }
      throw error
    }
    authority.assertCurrent()
  } catch (error) {
    preCommitError = error
  }

  if (!committed) {
    let recoveryError: unknown
    if (backup !== undefined) {
      recoveryError = restoreHeldBackup(path, backupPath, backup, plan, hooks, authority, aliases)
    }
    let temporaryCleanupError: unknown
    try {
      try {
        authority.assertCurrent()
      } catch (error) {
        temporaryCleanupError = error
      }
      fault(hooks, 'during-temp-cleanup', tempPath)
      if (descriptor !== undefined && temporaryCleanupError === undefined) {
        const heldTemp = staged ?? { descriptor, ...snapshotDescriptor(descriptor, plan.filename) }
        unlinkHeldAlias(tempPath, heldTemp, plan.filename, authority)
        releaseRecoveryAlias(aliases, tempPath)
      }
    } catch (error) {
      temporaryCleanupError = error
    }
    if (backup !== undefined) {
      closeAfterOperation(backup.descriptor, true)
    }
    if (descriptor !== undefined) {
      closeAfterOperation(descriptor, true)
    }
    const recoveryPaths = currentRecoveryPaths(aliases, plan.filename)
    const recoveryDetails = recoveryPaths.length === 0 ? {} : { filename: plan.filename, recoveryPaths }
    if (
      isInstructionIdentityUncertainty(preCommitError) ||
      isInstructionIdentityUncertainty(recoveryError) ||
      isInstructionIdentityUncertainty(temporaryCleanupError)
    ) {
      return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`, recoveryDetails)
    }
    const failure = preCommitError ?? recoveryError ?? temporaryCleanupError
    if (failure !== undefined) {
      if (failure instanceof EncephalonError || recoveryPaths.length === 0) {
        throw failure
      }
      return wrapIo(`Unable to recover ${plan.filename} before publication.`, failure, recoveryDetails)
    }
    return fail('INTERNAL_ERROR', `${plan.filename} publication ended before its commit point.`)
  }

  if (staged === undefined) {
    return fail('INTERNAL_ERROR', `${plan.filename} publication lost its staged descriptor.`)
  }

  finaliseCommittedInstruction({
    aliases,
    authority,
    backupPath,
    hooks,
    path,
    plan,
    ...(backup === undefined ? {} : { predecessor: backup }),
    staged,
    tempPath,
  })
}

export const planInstructionChanges = (root: string, remove: boolean) => {
  try {
    return FILENAMES.map(filename => (remove ? removalPlan(root, filename) : additionPlan(root, filename)))
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to preflight repository instruction files.', error)
  }
}

export const applyInstructionChanges = (root: string, plans: FilePlan[], hooks?: AtomicWriteHooks) => {
  let authority: InstructionRootAuthority | undefined
  let operationFailed = false
  try {
    const writePlanEntry = plans.find(plan => plan.action === 'write')
    const allPlansAreUnchanged = plans.length > 0 && plans.every(plan => plan.action === 'none')
    const authorityPlan = writePlanEntry ?? (allPlansAreUnchanged ? plans[0] : undefined)
    authority = authorityPlan === undefined ? undefined : new InstructionRootAuthority(root, authorityPlan.filename)
    for (const plan of plans) {
      if (plan.action !== 'none' || allPlansAreUnchanged) {
        mapInstructionIdentity(plan.filename, () => assertPlanIsCurrent(root, plan))
      }
    }
    fault(hooks, 'after-plan-validation')
    if (allPlansAreUnchanged && authority !== undefined) {
      fault(hooks, 'during-publication-flush')
      authority.flush()
      for (const plan of plans) {
        mapInstructionIdentity(plan.filename, () => assertPlanIsCurrent(root, plan))
      }
    }
    for (const plan of plans) {
      const path = resolve(root, plan.filename)
      authority?.useFilename(plan.filename)
      if (plan.action === 'delete') {
        deletePlan(path, plan, hooks)
      }
      if (plan.action === 'write') {
        writePlan(path, plan, authority as InstructionRootAuthority, hooks)
      }
    }
    return plans
      .filter(plan => plan.action !== 'none')
      .map(plan => ({
        action: plan.action === 'delete' ? ('removed' as const) : ('updated' as const),
        file: plan.filename,
      }))
  } catch (error) {
    operationFailed = true
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to update repository instruction files.', error)
  } finally {
    authority?.close(operationFailed)
  }
}
