import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { EncephalonError, fail, wrapIo } from './errors.ts'

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
}

const ALLOWED_SEPARATORS = new Set(['', '\n', '\n\n', '\r\n', '\r\n\r\n'])
const MODE_BITS = 0o7777
const MAX_INSTRUCTION_FILE_BYTES = 1024 * 1024
const noFollowFlag = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

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
  return fail('VALIDATION_FAILED', `${filename} exceeds the 1 MiB instruction-file limit.`)
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
  | 'after-final-backup-validation'
  | 'before-temp-create'
  | 'during-backup-restore'
  | 'during-file-flush'
  | 'during-publication'
  | 'during-temp-cleanup'
  | 'during-temp-write'

type AtomicWriteHooks = {
  fault?: (point: AtomicWriteFault) => void
}

const fault = (hooks: AtomicWriteHooks | undefined, point: AtomicWriteFault) => {
  hooks?.fault?.(point)
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
      throw new Error(`Unable to write ${plan.filename}.`)
    }
    offset += written
  }
}

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

const tempPathFor = (path: string, suffix = 'tmp') =>
  join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.${suffix}`)

const fsyncFile = (path: string) => {
  const access = process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY
  const descriptor = openSync(path, access | noFollowFlag)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

const restoreBackupFile = (path: string, backupPath: string, hooks: AtomicWriteHooks | undefined) => {
  try {
    fault(hooks, 'during-backup-restore')
    linkSync(backupPath, path)
    rmSync(backupPath, { force: true })
  } catch {
    // Keep the backup file in place so the pre-publication bytes remain recoverable.
  }
}

const assertBackupUnchanged = (backupPath: string, plan: FilePlan) => {
  const metadata = lstatIfExists(backupPath)
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile()) {
    return fail('VALIDATION_FAILED', `${plan.filename} must remain a regular non-symlink file.`)
  }
  if (!readRegularFileBytes(backupPath, plan.filename).equals(plan.originalBytes)) {
    return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
  }
  return metadata
}

const publishTempFile = (path: string, tempPath: string, plan: FilePlan, hooks: AtomicWriteHooks | undefined) => {
  if (!plan.originalFileExisted) {
    try {
      linkSync(tempPath, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
      }
      throw error
    }
    return
  }

  const backupPath = tempPathFor(path, 'backup')
  let backupCreated = false
  let published = false
  try {
    renameSync(path, backupPath)
    backupCreated = true
    const backupMetadata = assertBackupUnchanged(backupPath, plan)
    chmodSync(tempPath, backupMetadata.mode & MODE_BITS)
    fsyncFile(tempPath)
    fault(hooks, 'after-backup-validation')
    linkSync(tempPath, path)
    published = true
    const finalBackupMetadata = assertBackupUnchanged(backupPath, plan)
    fault(hooks, 'after-final-backup-validation')
    if ((finalBackupMetadata.mode & MODE_BITS) !== (backupMetadata.mode & MODE_BITS)) {
      return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return fail('REPOSITORY_CHANGED', `${plan.filename} changed after it was preflighted.`)
    }
    throw error
  } finally {
    if (backupCreated && !published) {
      restoreBackupFile(path, backupPath, hooks)
    }
  }
}

const cleanupTempFile = (tempPath: string, hooks: AtomicWriteHooks | undefined, operationFailed: boolean) => {
  try {
    fault(hooks, 'during-temp-cleanup')
    rmSync(tempPath, { force: true })
  } catch (error) {
    if (!operationFailed) {
      throw error
    }
  }
}

const writePlan = (root: string, path: string, plan: FilePlan, hooks?: AtomicWriteHooks) => {
  const bytes = plan.contentBytes ?? Buffer.alloc(0)
  const tempPath = tempPathFor(path)
  let descriptor: number | undefined
  let operationFailed = false
  try {
    fault(hooks, 'before-temp-create')
    descriptor = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o666)
    writeAll(descriptor, bytes, plan, hooks)
    fault(hooks, 'during-file-flush')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    assertPlanIsCurrent(root, plan)
    fault(hooks, 'during-publication')
    publishTempFile(path, tempPath, plan, hooks)
    fault(hooks, 'after-publication')
    fsyncDirectory(dirname(path))
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    if (descriptor !== undefined) {
      closeAfterOperation(descriptor, operationFailed)
    }
    cleanupTempFile(tempPath, hooks, operationFailed)
  }
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
    for (const plan of plans) {
      if (plan.action !== 'none') {
        assertPlanIsCurrent(root, plan)
      }
    }
    for (const plan of plans) {
      const path = resolve(root, plan.filename)
      if (plan.action === 'delete') {
        rmSync(path)
      }
      if (plan.action === 'write') {
        writePlan(root, path, plan, hooks)
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
