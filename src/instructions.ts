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
import {
  captureDirectoryWitness,
  type DirectoryWitness,
  DirectoryWitnessError,
  revalidateDirectoryWitness,
} from './directory-witness.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { sameEntryIdentity, sameStableEntryMetadata } from './filesystem-entry.ts'

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
  | 'after-backup-rename'
  | 'after-plan-validation'
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
  | 'during-temp-cleanup'
  | 'during-temp-write'

type AtomicWriteHooks = {
  fault?: (point: AtomicWriteFault, generatedPath?: string) => void
}

const fault = (hooks: AtomicWriteHooks | undefined, point: AtomicWriteFault, generatedPath?: string) => {
  hooks?.fault?.(point, generatedPath)
}

const identityBoundaryError = (error: unknown) => {
  const { code } = error as NodeJS.ErrnoException
  return error instanceof DirectoryWitnessError || code === 'ELOOP' || code === 'ENOENT' || code === 'ENOTDIR'
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

const sameDirectoryIdentity = (first: DirectoryWitness, second: DirectoryWitness) =>
  first.path === second.path &&
  first.canonicalPath === second.canonicalPath &&
  sameEntryIdentity(first.pathMetadata, second.pathMetadata) &&
  sameEntryIdentity(first.canonicalMetadata, second.canonicalMetadata)

class InstructionRootAuthority {
  private filename: (typeof FILENAMES)[number]
  private witness: DirectoryWitness | undefined

  constructor(root: string, filename: (typeof FILENAMES)[number]) {
    this.filename = filename
    this.witness = mapInstructionIdentity(filename, () => captureDirectoryWitness(root, { allowLink: false }))
  }

  prepareMutation() {
    const witness = this.requiredWitness()
    mapInstructionIdentity(this.filename, () => revalidateDirectoryWitness(witness))
    return witness
  }

  completeMutation(previous: DirectoryWitness) {
    this.witness = undefined
    const next = mapInstructionIdentity(this.filename, () =>
      captureDirectoryWitness(previous.path, { allowLink: false }),
    )
    if (!sameDirectoryIdentity(previous, next)) {
      return instructionIdentityChanged(this.filename)
    }
    this.witness = next
  }

  mutate<Value>(operation: () => Value) {
    const witness = this.prepareMutation()
    const value = mapInstructionIdentity(this.filename, operation)
    this.completeMutation(witness)
    return value
  }

  assertCurrent() {
    mapInstructionIdentity(this.filename, () => revalidateDirectoryWitness(this.requiredWitness()))
  }

  recoverCurrentGeneration() {
    const witness = this.requiredWitness()
    const next = mapInstructionIdentity(this.filename, () =>
      captureDirectoryWitness(witness.path, { allowLink: false }),
    )
    if (!sameDirectoryIdentity(witness, next)) {
      return instructionIdentityChanged(this.filename)
    }
    this.witness = next
  }

  useFilename(filename: (typeof FILENAMES)[number]) {
    this.filename = filename
  }

  flush() {
    const witness = this.requiredWitness()
    mapInstructionIdentity(this.filename, () => revalidateDirectoryWitness(witness))
    if (process.platform !== 'win32') {
      let descriptor: number | undefined
      let operationFailed = false
      try {
        descriptor = mapInstructionIdentity(this.filename, () =>
          openSync(witness.canonicalPath, constants.O_RDONLY | directoryFlag | noFollowFlag),
        )
        const metadata = mapInstructionIdentity(this.filename, () => fstatSync(descriptor as number, { bigint: true }))
        if (!sameStableEntryMetadata(metadata, witness.canonicalMetadata)) {
          return instructionIdentityChanged(this.filename)
        }
        try {
          fsyncSync(descriptor)
        } catch (error) {
          const { code } = error as NodeJS.ErrnoException
          if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM') {
            throw error
          }
        }
      } catch (error) {
        operationFailed = true
        throw error
      } finally {
        if (descriptor !== undefined) {
          closeAfterOperation(descriptor, operationFailed)
        }
      }
    }
    mapInstructionIdentity(this.filename, () => revalidateDirectoryWitness(witness))
  }

  private requiredWitness() {
    if (this.witness === undefined) {
      return instructionIdentityChanged(this.filename)
    }
    return this.witness
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

type PostCommitPhase = 'backupCleanup' | 'publicationFlush' | 'publicationVerification' | 'temporaryCleanup'

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

const postCommitPhasePriority = [
  'publicationVerification',
  'publicationFlush',
  'backupCleanup',
  'temporaryCleanup',
] as const satisfies readonly PostCommitPhase[]

const postCommitRecoveryAction = {
  backupCleanup:
    'Inspect the repository root and remove only a confirmed backup left by this operation before retrying.',
  publicationFlush:
    'Confirm the canonical instruction file is present; init does not re-fsync an unchanged instruction file, so treat durability as unverified until the repository directory sync succeeds.',
  publicationVerification:
    'Inspect the canonical instruction file before retrying; the linked replacement may have been displaced by a concurrent change.',
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
      throw Object.assign(new Error('Unable to read an instruction file descriptor.'), { code: 'EIO' })
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

const holdInstructionFile = (path: string, filename: (typeof FILENAMES)[number]) => {
  const access = process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY
  const descriptor = openSync(path, access | noFollowFlag)
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

const linkHeldAlias = (
  sourcePath: string,
  destinationPath: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  authority: InstructionRootAuthority,
) => {
  const generation = authority.prepareMutation()
  assertPathIdentifiesDescriptor(sourcePath, held, filename, true)
  try {
    linkSync(sourcePath, destinationPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || identityBoundaryError(error)) {
      return instructionIdentityChanged(filename, { cause: error })
    }
    throw error
  }
  authority.completeMutation(generation)
  assertPathIdentifiesDescriptor(destinationPath, held, filename, true)
}

const unlinkHeldSource = (
  sourcePath: string,
  destinationPath: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  authority: InstructionRootAuthority,
) => {
  const generation = authority.prepareMutation()
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
  authority.completeMutation(generation)
  assertPathIdentifiesDescriptor(destinationPath, held, filename, true)
}

const unlinkHeldAlias = (
  path: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  authority: InstructionRootAuthority,
) => {
  const generation = authority.prepareMutation()
  assertPathIdentifiesDescriptor(path, held, filename, true)
  try {
    unlinkSync(path)
  } catch (error) {
    if (identityBoundaryError(error)) {
      return instructionIdentityChanged(filename, { cause: error })
    }
    throw error
  }
  authority.completeMutation(generation)
}

const createDescriptorRecoveryAlias = (
  path: string,
  held: HeldInstructionFile,
  filename: (typeof FILENAMES)[number],
  authority: InstructionRootAuthority,
  hooks: AtomicWriteHooks | undefined,
) => {
  const snapshot = snapshotDescriptor(held.descriptor, filename)
  const recoveryPath = tempPathFor(path, 'backup')
  let recoveryDescriptor: number | undefined
  let completed = false
  try {
    recoveryDescriptor = authority.mutate(() =>
      openSync(recoveryPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag, 0o600),
    )
    fault(hooks, 'after-recovery-create', recoveryPath)
    let offset = 0
    while (offset < snapshot.bytes.length) {
      const written = writeSync(recoveryDescriptor, snapshot.bytes, offset, snapshot.bytes.length - offset, offset)
      if (written <= 0) {
        throw Object.assign(new Error(`Unable to recover ${filename}.`), { code: 'EIO' })
      }
      offset += written
    }
    fchmodSync(recoveryDescriptor, Number(snapshot.mode))
    fsyncSync(recoveryDescriptor)
    const recovery = { descriptor: recoveryDescriptor, ...snapshotDescriptor(recoveryDescriptor, filename) }
    assertPathIdentifiesDescriptor(recoveryPath, recovery, filename, true)
    completed = true
    return { path: recoveryPath, recovery }
  } finally {
    if (recoveryDescriptor !== undefined && !completed) {
      closeAfterOperation(recoveryDescriptor, true)
    }
  }
}

const restoreHeldBackup = (
  path: string,
  backupPath: string,
  held: HeldInstructionFile,
  plan: FilePlan,
  hooks: AtomicWriteHooks | undefined,
  authority: InstructionRootAuthority,
) => {
  let recoveryError: unknown
  let recoveryRetained = false
  try {
    authority.recoverCurrentGeneration()
    fault(hooks, 'during-backup-restore')
    const recoveryHeld = { descriptor: held.descriptor, ...snapshotDescriptor(held.descriptor, plan.filename) }
    const canonicalExists = mapInstructionIdentity(plan.filename, () => lstatIfExists(path) !== undefined)
    if (canonicalExists) {
      if (pathIdentifiesDescriptor(path, recoveryHeld, plan.filename, false)) {
        if (!pathIdentifiesDescriptor(backupPath, recoveryHeld, plan.filename, false)) {
          return instructionIdentityChanged(plan.filename)
        }
        unlinkHeldSource(backupPath, path, recoveryHeld, plan.filename, authority)
      } else if (pathIdentifiesDescriptor(backupPath, recoveryHeld, plan.filename, false)) {
        return instructionIdentityChanged(plan.filename)
      } else {
        const copy = createDescriptorRecoveryAlias(path, recoveryHeld, plan.filename, authority, hooks)
        recoveryRetained = true
        closeAfterOperation(copy.recovery.descriptor, true)
        return instructionIdentityChanged(plan.filename)
      }
    } else {
      if (pathIdentifiesDescriptor(backupPath, recoveryHeld, plan.filename, false)) {
        linkHeldAlias(backupPath, path, recoveryHeld, plan.filename, authority)
        unlinkHeldSource(backupPath, path, recoveryHeld, plan.filename, authority)
      } else {
        const copy = createDescriptorRecoveryAlias(path, recoveryHeld, plan.filename, authority, hooks)
        try {
          linkHeldAlias(copy.path, path, copy.recovery, plan.filename, authority)
          unlinkHeldSource(copy.path, path, copy.recovery, plan.filename, authority)
        } finally {
          closeAfterOperation(copy.recovery.descriptor, true)
        }
      }
      assertPathIdentifiesDescriptor(path, recoveryHeld, plan.filename, true)
    }
  } catch (error) {
    recoveryError = error
    try {
      const canonicalExact = pathIdentifiesDescriptor(path, held, plan.filename, false)
      const backupExact = pathIdentifiesDescriptor(backupPath, held, plan.filename, false)
      if (!(canonicalExact || backupExact || recoveryRetained)) {
        const copy = createDescriptorRecoveryAlias(path, held, plan.filename, authority, hooks)
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
) => {
  fault(hooks, 'during-backup-cleanup')
  const cleanupPath = tempPathFor(path, 'backup')
  fault(hooks, 'before-backup-cleanup-create', cleanupPath)
  try {
    linkHeldAlias(backupPath, cleanupPath, held, plan.filename, authority)
    unlinkHeldSource(backupPath, cleanupPath, held, plan.filename, authority)
    fault(hooks, 'before-final-backup-validation', cleanupPath)
    if (mapInstructionIdentity(plan.filename, () => lstatIfExists(backupPath) !== undefined)) {
      return instructionIdentityChanged(plan.filename)
    }
    unlinkHeldAlias(cleanupPath, held, plan.filename, authority)
  } catch (error) {
    if (isInstructionIdentityUncertainty(error)) {
      try {
        const sourceExact = pathIdentifiesDescriptor(backupPath, held, plan.filename, false)
        const cleanupExact = pathIdentifiesDescriptor(cleanupPath, held, plan.filename, false)
        if (!(sourceExact || cleanupExact)) {
          authority.recoverCurrentGeneration()
          const copy = createDescriptorRecoveryAlias(path, held, plan.filename, authority, hooks)
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

const committedFailureDetails = (plan: FilePlan, phase: PostCommitPhase, failures: readonly PostCommitFailure[]) => ({
  filename: plan.filename,
  instructionCommitted: true,
  postCommitFailures: orderedFailedPhases(failures).map(failedPhase => ({
    postCommitPhase: failedPhase,
    recoveryAction: postCommitRecoveryAction[failedPhase],
  })),
  postCommitPhase: phase,
  recoveryAction: postCommitRecoveryAction[phase],
})

const throwHighestPriorityCommittedFailure = (plan: FilePlan, failures: readonly PostCommitFailure[]) => {
  const phase = postCommitPhasePriority.find(candidate => failures.some(failure => failure.phase === candidate))
  if (phase !== undefined) {
    const samePhase = failures.filter(candidate => candidate.phase === phase)
    const failure = samePhase.find(candidate => candidate.identityUncertain) ?? samePhase[0]
    if (failure !== undefined) {
      const recoveryAction = postCommitRecoveryAction[phase]
      const message = `${plan.filename} was committed, but the ${phase} post-commit phase failed. ${recoveryAction}`
      const details = committedFailureDetails(plan, phase, failures)
      if (failure.identityUncertain) {
        throw new EncephalonError('REPOSITORY_CHANGED', message, details, { cause: failure.cause })
      }
      return wrapIo(message, failure.cause, details)
    }
  }
}

const cleanupHeldTempFile = (
  path: string,
  tempPath: string,
  held: HeldInstructionFile,
  plan: FilePlan,
  hooks: AtomicWriteHooks | undefined,
  authority: InstructionRootAuthority,
) => {
  fault(hooks, 'during-temp-cleanup', tempPath)
  const generation = authority.prepareMutation()
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
  authority.completeMutation(generation)
  assertPathIdentifiesDescriptor(path, held, plan.filename, true)
}

const attemptPublicationFlush = (
  failures: readonly PostCommitFailure[],
  hooks: AtomicWriteHooks | undefined,
  authority: InstructionRootAuthority,
) => {
  try {
    fault(hooks, 'during-publication-flush')
    authority.flush()
    return { failures: failures.filter(failure => failure.phase !== 'publicationFlush'), succeeded: true }
  } catch (error) {
    return { failures: [...failures, postCommitFailure('publicationFlush', error)], succeeded: false }
  }
}

const finaliseCommittedInstruction = (input: {
  authority: InstructionRootAuthority
  backupPath: string
  hooks: AtomicWriteHooks | undefined
  path: string
  plan: FilePlan
  predecessor?: HeldInstructionFile
  staged: HeldInstructionFile
  tempPath: string
}) => {
  const { authority, backupPath, hooks, path, plan, predecessor, staged, tempPath } = input
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
        finaliseHeldBackup(path, backupPath, predecessor, plan, hooks, authority)
      })
      backupRetained = failures.length !== failureCountBeforeCleanup
    }

    if (failures.some(failure => failure.phase === 'backupCleanup')) {
      try {
        authority.recoverCurrentGeneration()
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
      failures = capturePostCommitFailure(failures, 'temporaryCleanup', () => {
        cleanupHeldTempFile(path, tempPath, staged, plan, hooks, authority)
      })
      temporaryRetained = failures.length !== failureCountBeforeCleanup
    }

    if (failures.some(failure => failure.phase === 'temporaryCleanup')) {
      try {
        authority.recoverCurrentGeneration()
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
    failures = capturePostCommitFailure(failures, 'backupCleanup', () => closeSync(predecessor.descriptor))
  }
  failures = capturePostCommitFailure(failures, 'temporaryCleanup', () => closeSync(staged.descriptor))
  throwHighestPriorityCommittedFailure(plan, failures)
}

const writePlan = (path: string, plan: FilePlan, authority: InstructionRootAuthority, hooks?: AtomicWriteHooks) => {
  const bytes = plan.contentBytes ?? Buffer.alloc(0)
  const tempPath = tempPathFor(path)
  const backupPath = tempPathFor(path, 'backup')
  let staged: HeldInstructionFile | undefined
  let backup: HeldInstructionFile | undefined
  let descriptor: number | undefined
  let committed = false
  let preCommitError: unknown
  try {
    fault(hooks, 'before-temp-create')
    descriptor = authority.mutate(() =>
      openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag, 0o666),
    )
    writeAll(descriptor, bytes, plan, hooks)
    fault(hooks, 'during-file-flush')
    fsyncSync(descriptor)
    assertPlanIsCurrent(dirname(path), plan)
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
      fchmodSync(descriptor, Number(backup.mode))
      fsyncSync(descriptor)
      fault(hooks, 'before-backup-create', backupPath)
      linkHeldAlias(path, backupPath, backup, plan.filename, authority)
      fault(hooks, 'during-backup-flush')
      authority.flush()
      unlinkHeldSource(path, backupPath, backup, plan.filename, authority)
      fault(hooks, 'after-backup-rename')
      fault(hooks, 'after-backup-validation')
      assertPathIdentifiesDescriptor(backupPath, backup, plan.filename, true)
    }
    staged = { descriptor, ...snapshotDescriptor(descriptor, plan.filename) }
    fault(hooks, 'during-publication')
    const publicationGeneration = authority.prepareMutation()
    assertPathIdentifiesDescriptor(tempPath, staged, plan.filename, true)
    try {
      linkSync(tempPath, path)
      committed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
      }
      throw error
    }
    authority.completeMutation(publicationGeneration)
  } catch (error) {
    preCommitError = error
  }

  if (!committed) {
    let recoveryError: unknown
    if (backup !== undefined) {
      recoveryError = restoreHeldBackup(path, backupPath, backup, plan, hooks, authority)
    }
    let temporaryCleanupError: unknown
    try {
      try {
        authority.recoverCurrentGeneration()
      } catch (error) {
        temporaryCleanupError = error
      }
      fault(hooks, 'during-temp-cleanup', tempPath)
      if (descriptor !== undefined && temporaryCleanupError === undefined) {
        const heldTemp = staged ?? { descriptor, ...snapshotDescriptor(descriptor, plan.filename) }
        unlinkHeldAlias(tempPath, heldTemp, plan.filename, authority)
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
    if (
      isInstructionIdentityUncertainty(preCommitError) ||
      isInstructionIdentityUncertainty(recoveryError) ||
      isInstructionIdentityUncertainty(temporaryCleanupError)
    ) {
      return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
    }
    if (preCommitError !== undefined) {
      throw preCommitError
    }
    if (recoveryError !== undefined) {
      throw recoveryError
    }
    if (temporaryCleanupError !== undefined) {
      throw temporaryCleanupError
    }
    return fail('INTERNAL_ERROR', `${plan.filename} publication ended before its commit point.`)
  }

  if (staged === undefined) {
    return fail('INTERNAL_ERROR', `${plan.filename} publication lost its staged descriptor.`)
  }

  finaliseCommittedInstruction({
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
  try {
    const activePlan = plans.find(plan => plan.action === 'write')
    const authority = activePlan === undefined ? undefined : new InstructionRootAuthority(root, activePlan.filename)
    for (const plan of plans) {
      if (plan.action !== 'none') {
        assertPlanIsCurrent(root, plan)
      }
    }
    fault(hooks, 'after-plan-validation')
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
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to update repository instruction files.', error)
  }
}
