import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { parseAddRecordInput, parseRootInput } from './api-input.ts'
import { hydrateResolvedRepository } from './cache.ts'
import { EncephalonError, fail, wrapIo } from './errors.ts'
import { withOperationLock } from './lock.ts'
import { resolveRepository } from './repository.ts'
import { assertArtifactFile, createRecordFile, formatRecordFile, MAX_RECORD_BYTES, parseRecordFile } from './schema.ts'
import type {
  AddRecordInput,
  BrainRecord,
  BrainRecordFile,
  RootInput,
  ValidateResult,
  ValidationIssue,
} from './types.ts'

type RecordScan = {
  records: BrainRecord[]
  errors: ValidationIssue[]
  bytes: number
}

type FileIdentity = {
  dev: number
  ino: number
}

type RecordWriteFault =
  | 'after-publication'
  | 'before-publication'
  | 'during-cleanup'
  | 'during-hydration'
  | 'during-publication-flush'
  | 'during-staging-write'

export type RecordWriteHooks = {
  fault?: (point: RecordWriteFault) => void
}

type RecordReadFault = 'after-record-fstat' | 'after-record-lstat' | 'after-record-open'

export type RecordReadHooks = {
  canonicalScan?: () => void
  fault?: (point: RecordReadFault, path: string) => void
  graphValidation?: () => void
}

type AddRecordOptions = {
  hooks?: RecordWriteHooks
  hydrate?: boolean
}

type PlannedRecord = {
  formatted: string
  path: string
  record: BrainRecord
  recordFile: BrainRecordFile
  relativePath: string
}

type ValidateRecordsOptions = {
  hooks?: RecordReadHooks
}

type AllowedMultiHead = {
  kind: string
  source: string
  subject: string
}

type PostCommitPhase = 'cacheHydration' | 'publicationFlush' | 'stagingCleanup'

const postCommitRecoveryAction = {
  cacheHydration: 'Run prepare to rebuild disposable cache state, then validate before retrying this add.',
  publicationFlush:
    'Confirm the canonical record file is present; prepare does not re-fsync the kind directory, so treat durability as unverified until that sync succeeds.',
  stagingCleanup: 'Retry this add; leftovers under encephalon/_staging are cleared by the next add.',
} as const satisfies Record<PostCommitPhase, string>

const postCommitPriority: Record<PostCommitPhase, number> = {
  cacheHydration: 2,
  publicationFlush: 3,
  stagingCleanup: 1,
}

const postCommitMessage = (recordId: string, phase: PostCommitPhase) =>
  `Record ${recordId} was committed, but the ${phase} post-commit phase failed. ${postCommitRecoveryAction[phase]}`

const postCommitError = (record: BrainRecord, phase: PostCommitPhase, cause: unknown) =>
  new EncephalonError(
    'IO_ERROR',
    postCommitMessage(record.id, phase),
    {
      canonicalCommitted: true,
      path: record.path,
      postCommitPhase: phase,
      recordId: record.id,
      recoveryAction: postCommitRecoveryAction[phase],
    },
    { cause },
  )

const canonicalRecordBytes = (record: BrainRecord) => {
  const { path: _path, ...recordFile } = record
  return Buffer.byteLength(formatRecordFile(recordFile), 'utf8')
}

const STAGING_DIRECTORY = '_staging'
const RESERVED_DIRECTORIES = new Set(['_artifacts', STAGING_DIRECTORY])
const directoryFlag = constants.O_DIRECTORY ?? 0
const noFollowFlag = constants.O_NOFOLLOW ?? 0
export const MAX_CANONICAL_RECORDS = 1000
export const MAX_CANONICAL_RECORD_BYTES = 8 * 1024 * 1024
export const MAX_SUPERSESSION_EDGES = 1000
export const MAX_ARTIFACT_REFERENCES = 1000
export const MAX_VALIDATION_ISSUES = 100
const decoder = new TextDecoder('utf-8', { fatal: true })

const posixRelative = (root: string, path: string) => relative(root, path).replaceAll('\\', '/')

const issue = (code: string, message: string, path?: string, recordId?: string): ValidationIssue => ({
  code,
  message,
  ...(path === undefined ? {} : { path }),
  ...(recordId === undefined ? {} : { recordId }),
})

const corpusIssue = (code: string, message: string, path = 'encephalon') => issue(code, message, path)

const fault = (hooks: RecordWriteHooks | undefined, point: RecordWriteFault) => hooks?.fault?.(point)

const readFault = (hooks: RecordReadHooks | undefined, point: RecordReadFault, path: string) => {
  hooks?.fault?.(point, path)
}

const identityFor = (metadata: Stats): FileIdentity => ({ dev: metadata.dev, ino: metadata.ino })

const sameIdentity = (first: FileIdentity, second: FileIdentity) => first.dev === second.dev && first.ino === second.ino

const sameStableMetadata = (first: Stats, second: Stats) =>
  sameIdentity(identityFor(first), identityFor(second)) &&
  first.size === second.size &&
  first.mode === second.mode &&
  first.mtimeMs === second.mtimeMs &&
  first.ctimeMs === second.ctimeMs

const assertRealDirectory = (root: string, path: string) => {
  const metadata = lstatSync(path)
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    return
  }
  return fail('VALIDATION_FAILED', `${posixRelative(root, path)} must be a real non-symlink directory.`)
}

const ensureDirectoryChain = (root: string, segments: string[]) => {
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    try {
      mkdirSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
    assertRealDirectory(root, current)
  }
  return current
}

const fsyncDirectory = (path: string) => {
  if (process.platform !== 'win32') {
    let descriptor: number | undefined
    try {
      descriptor = openSync(path, constants.O_RDONLY | directoryFlag)
      fsyncSync(descriptor)
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EPERM') {
        throw error
      }
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor)
      }
    }
  }
}

const cleanupStagingDirectory = (root: string, hooks?: RecordWriteHooks) => {
  const stagingDirectory = resolve(root, 'encephalon', STAGING_DIRECTORY)
  if (existsSync(stagingDirectory)) {
    assertRealDirectory(root, stagingDirectory)
    for (const entry of readdirSync(stagingDirectory, { withFileTypes: true })) {
      fault(hooks, 'during-cleanup')
      rmSync(resolve(stagingDirectory, entry.name), { force: true, recursive: true })
    }
    fsyncDirectory(stagingDirectory)
  }
}

const assertParentIdentity = (root: string, path: string, expected: FileIdentity) => {
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !sameIdentity(identityFor(metadata), expected)) {
    return fail('INVALID_ARGUMENT', 'Record parent directory changed while canonical records were being read.', {
      path: posixRelative(root, path),
    })
  }
}

const readBoundedDescriptor = (descriptor: number, size: number) => {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const bytesRead = readSync(descriptor, buffer, offset, size - offset, offset)
    if (bytesRead === 0) {
      return fail('INVALID_ARGUMENT', 'Record file changed while it was being read.')
    }
    offset += bytesRead
  }
  const extra = Buffer.alloc(1)
  if (readSync(descriptor, extra, 0, 1, size) > 0) {
    return fail('INVALID_ARGUMENT', 'Record file changed while it was being read.')
  }
  return buffer
}

const decodeRecordBytes = (bytes: Buffer) => {
  try {
    return decoder.decode(bytes)
  } catch {
    return fail('INVALID_ARGUMENT', 'Record file is not valid UTF-8.')
  }
}

const parseRecordJson = (content: string) => {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return fail('INVALID_ARGUMENT', 'Record file contains invalid JSON.')
  }
}

const readRecord = (
  root: string,
  path: string,
  kindPath: string,
  kindIdentity: FileIdentity,
  hooks?: RecordReadHooks,
): BrainRecord => {
  const relativePath = posixRelative(root, path)
  const pathMetadata = lstatSync(path)
  readFault(hooks, 'after-record-lstat', path)
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag)
    readFault(hooks, 'after-record-open', path)
    const metadata = fstatSync(descriptor)
    assertParentIdentity(root, kindPath, kindIdentity)
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() || !metadata.isFile()) {
      return fail('INVALID_ARGUMENT', 'Record file must be a regular non-symlink JSON file.', {
        path: relativePath,
      })
    }
    if (!sameIdentity(identityFor(pathMetadata), identityFor(metadata))) {
      return fail('INVALID_ARGUMENT', 'Record file changed while canonical records were being read.', {
        path: relativePath,
      })
    }
    if (metadata.size > MAX_RECORD_BYTES) {
      return fail('INVALID_ARGUMENT', 'Record file exceeds the 1 MiB limit.', {
        path: relativePath,
      })
    }
    readFault(hooks, 'after-record-fstat', path)
    const bytes = readBoundedDescriptor(descriptor, metadata.size)
    const finalMetadata = fstatSync(descriptor)
    if (!sameStableMetadata(metadata, finalMetadata)) {
      return fail('INVALID_ARGUMENT', 'Record file changed while it was being read.', {
        path: relativePath,
      })
    }
    const parsed = parseRecordJson(decodeRecordBytes(bytes))
    const record = parseRecordFile(parsed)
    return { ...record, path: relativePath }
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return fail('INVALID_ARGUMENT', 'Record file must be a readable regular non-symlink JSON file.', {
      path: relativePath,
    })
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}

const scanCanonicalRecords = (root: string, options: ValidateRecordsOptions = {}): RecordScan => {
  const brainDirectory = resolve(root, 'encephalon')
  if (existsSync(brainDirectory)) {
    const rootMetadata = lstatSync(brainDirectory)
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return {
        bytes: 0,
        errors: [issue('INVALID_RECORD_LAYOUT', 'encephalon must be a real directory.', 'encephalon')],
        records: [],
      }
    }

    const scanned: RecordScan = { bytes: 0, errors: [], records: [] }
    let recordBytes = 0
    let stopScanning = false
    const addScanError = (validationIssue: ValidationIssue) => {
      scanned.errors.push(validationIssue)
      if (scanned.errors.length >= MAX_VALIDATION_ISSUES) {
        stopScanning = true
      }
    }
    for (const kindEntry of readdirSync(brainDirectory, { withFileTypes: true }).sort((first, second) =>
      first.name.localeCompare(second.name),
    )) {
      if (stopScanning) {
        break
      }
      if (RESERVED_DIRECTORIES.has(kindEntry.name)) {
        if (!(kindEntry.isDirectory() && !kindEntry.isSymbolicLink())) {
          addScanError(
            issue(
              'INVALID_RECORD_LAYOUT',
              `${kindEntry.name} must be a real directory.`,
              `encephalon/${kindEntry.name}`,
            ),
          )
        }
      } else {
        const kindPath = join(brainDirectory, kindEntry.name)
        if (!kindEntry.name.startsWith('_') && kindEntry.isDirectory() && !kindEntry.isSymbolicLink()) {
          const kindMetadata = lstatSync(kindPath)
          if (!kindMetadata.isDirectory() || kindMetadata.isSymbolicLink()) {
            addScanError(
              issue(
                'INVALID_RECORD_LAYOUT',
                'The brain root may contain only kind directories and reserved internal directories.',
                posixRelative(root, kindPath),
              ),
            )
            continue
          }
          const kindIdentity = identityFor(kindMetadata)
          for (const recordEntry of readdirSync(kindPath, { withFileTypes: true }).sort((first, second) =>
            first.name.localeCompare(second.name),
          )) {
            if (stopScanning) {
              break
            }
            const recordPath = join(kindPath, recordEntry.name)
            const relativePath = posixRelative(root, recordPath)
            if (recordEntry.isFile() && !recordEntry.isSymbolicLink() && recordEntry.name.endsWith('.json')) {
              const metadata = lstatSync(recordPath)
              if (scanned.records.length >= MAX_CANONICAL_RECORDS) {
                addScanError(
                  corpusIssue(
                    'CORPUS_RECORD_LIMIT',
                    `Canonical corpus may contain at most ${MAX_CANONICAL_RECORDS} records.`,
                    relativePath,
                  ),
                )
                stopScanning = true
                break
              }
              if (recordBytes + metadata.size > MAX_CANONICAL_RECORD_BYTES) {
                addScanError(
                  corpusIssue(
                    'CORPUS_BYTE_LIMIT',
                    `Canonical corpus may contain at most ${MAX_CANONICAL_RECORD_BYTES} bytes of record JSON.`,
                    relativePath,
                  ),
                )
                stopScanning = true
                break
              }
              recordBytes += metadata.size
              try {
                const record = readRecord(root, recordPath, kindPath, kindIdentity, options.hooks)
                const expectedName = `${record.id}.json`
                if (!(recordEntry.name === expectedName && record.kind === kindEntry.name)) {
                  addScanError(
                    issue(
                      'RECORD_PATH_MISMATCH',
                      'Record filename and parent kind must match its envelope.',
                      relativePath,
                      record.id,
                    ),
                  )
                }
                scanned.records.push(record)
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Record could not be parsed.'
                addScanError(issue('INVALID_RECORD', message, relativePath))
              }
            } else {
              addScanError(
                issue(
                  'INVALID_RECORD_LAYOUT',
                  'Kind directories may contain only direct regular JSON files.',
                  relativePath,
                ),
              )
            }
          }
        } else {
          addScanError(
            issue(
              'INVALID_RECORD_LAYOUT',
              'The brain root may contain only kind directories and reserved internal directories.',
              posixRelative(root, kindPath),
            ),
          )
        }
      }
    }
    return {
      bytes: recordBytes,
      errors: scanned.errors,
      records: scanned.records.sort(
        (first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id),
      ),
    }
  }
  return { bytes: 0, errors: [], records: [] }
}

const duplicateAndCaseIssues = (records: BrainRecord[]) => {
  const ids = new Map<string, BrainRecord>()
  const paths = new Map<string, BrainRecord>()
  const errors: ValidationIssue[] = []
  for (const record of records) {
    const idCollision = ids.get(record.id)
    const pathCollision = paths.get(record.path.normalize('NFC').toLowerCase())
    ids.set(record.id, record)
    paths.set(record.path.normalize('NFC').toLowerCase(), record)
    if (idCollision !== undefined) {
      errors.push(issue('DUPLICATE_RECORD_ID', `Duplicate record id ${record.id}.`, record.path, record.id))
    }
    if (pathCollision !== undefined && pathCollision.path !== record.path) {
      errors.push(
        issue('CASE_COLLISION', 'Record paths collide on case-insensitive filesystems.', record.path, record.id),
      )
    }
  }
  return errors
}

const supersessionIssues = (records: BrainRecord[]) => {
  const byId = new Map(records.map(record => [record.id, record]))
  const edgeCount = records.reduce((count, record) => count + (record.supersedes?.length ?? 0), 0)
  if (edgeCount > MAX_SUPERSESSION_EDGES) {
    return [
      corpusIssue(
        'CORPUS_SUPERSEDES_LIMIT',
        `Canonical corpus may contain at most ${MAX_SUPERSESSION_EDGES} supersession edges.`,
      ),
    ]
  }
  const edgeIssues: ValidationIssue[] = []
  for (const record of records) {
    for (const targetId of record.supersedes ?? []) {
      const target = byId.get(targetId)
      if (target === undefined) {
        edgeIssues.push(
          issue('MISSING_SUPERSEDES', `Record supersedes missing record ${targetId}.`, record.path, record.id),
        )
      } else if (targetId === record.id) {
        edgeIssues.push(issue('SELF_SUPERSEDES', 'A record may not supersede itself.', record.path, record.id))
      } else if (target.kind !== record.kind || target.subject !== record.subject) {
        edgeIssues.push(
          issue(
            'CROSS_SUBJECT_SUPERSEDES',
            'Superseded records must have the same kind and subject.',
            record.path,
            record.id,
          ),
        )
      }
    }
  }

  const cycleIssues: ValidationIssue[] = []
  const state = new Map<string, 'visited' | 'visiting'>()
  for (const record of records) {
    if (state.has(record.id)) {
      continue
    }
    const stack = [{ index: 0, record }]
    state.set(record.id, 'visiting')
    while (stack.length > 0) {
      const frame = stack.at(-1)
      if (frame !== undefined) {
        const targets = frame.record.supersedes ?? []
        if (frame.index >= targets.length) {
          state.set(frame.record.id, 'visited')
          stack.pop()
        } else {
          const targetId = targets[frame.index] ?? ''
          frame.index += 1
          const target = byId.get(targetId)
          if (target !== undefined) {
            const targetState = state.get(target.id)
            if (targetState === 'visiting') {
              cycleIssues.push(
                issue(
                  'SUPERSEDES_CYCLE',
                  'The supersession graph contains a cycle.',
                  frame.record.path,
                  frame.record.id,
                ),
              )
            } else if (targetState !== 'visited') {
              state.set(target.id, 'visiting')
              stack.push({ index: 0, record: target })
            }
          }
        }
      }
    }
  }

  const superseded = new Set<string>()
  for (const record of records) {
    for (const targetId of record.supersedes ?? []) {
      superseded.add(targetId)
    }
  }
  const activeGroups = new Map<string, BrainRecord[]>()
  for (const record of records) {
    if (!superseded.has(record.id)) {
      const key = `${record.kind}\0${record.subject}`
      const group = activeGroups.get(key)
      if (group === undefined) {
        activeGroups.set(key, [record])
      } else {
        group.push(record)
      }
    }
  }
  const activeIssues: ValidationIssue[] = []
  for (const group of activeGroups.values()) {
    if (group.length > 1) {
      for (const record of group) {
        activeIssues.push(
          issue(
            'MULTIPLE_ACTIVE_HEADS',
            `Multiple active records exist for ${record.kind}/${record.subject}.`,
            record.path,
            record.id,
          ),
        )
      }
    }
  }
  return [...edgeIssues, ...cycleIssues, ...activeIssues]
}

const artifactIssues = (root: string, records: BrainRecord[]) => {
  const artifactCount = records.reduce((count, record) => count + (record.artifacts?.length ?? 0), 0)
  if (artifactCount > MAX_ARTIFACT_REFERENCES) {
    return [
      corpusIssue(
        'CORPUS_ARTIFACT_LIMIT',
        `Canonical corpus may contain at most ${MAX_ARTIFACT_REFERENCES} artifact references.`,
      ),
    ]
  }
  const brainDirectory = resolve(root, 'encephalon')
  const paths = new Map<string, string>()
  const errors: ValidationIssue[] = []
  for (const record of records) {
    for (const artifact of record.artifacts ?? []) {
      const collisionKey = artifact.normalize('NFC').toLowerCase()
      const collision = paths.get(collisionKey)
      paths.set(collisionKey, artifact)
      if (collision !== undefined && collision !== artifact) {
        errors.push(
          issue('CASE_COLLISION', 'Artifact paths collide on case-insensitive filesystems.', record.path, record.id),
        )
      }
      try {
        assertArtifactFile(brainDirectory, artifact)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Artifact is invalid.'
        errors.push(issue('INVALID_ARTIFACT', message, record.path, record.id))
      }
    }
  }
  return errors
}

const truncateValidationIssues = (errors: ValidationIssue[]) => {
  if (errors.length < MAX_VALIDATION_ISSUES) {
    return { errors, truncated: false }
  }
  return {
    errors: [
      ...errors.slice(0, MAX_VALIDATION_ISSUES - 1),
      issue(
        'VALIDATION_ISSUES_TRUNCATED',
        `Validation stopped reporting after ${MAX_VALIDATION_ISSUES - 1} concrete issues.`,
        'encephalon',
      ),
    ],
    truncated: true,
  }
}

const corpusBudgetIssues = (scan: RecordScan) => {
  const path = scan.records.at(-1)?.path ?? 'encephalon'
  return [
    ...(scan.records.length > MAX_CANONICAL_RECORDS
      ? [
          corpusIssue(
            'CORPUS_RECORD_LIMIT',
            `Canonical corpus may contain at most ${MAX_CANONICAL_RECORDS} records.`,
            path,
          ),
        ]
      : []),
    ...(scan.bytes > MAX_CANONICAL_RECORD_BYTES
      ? [
          corpusIssue(
            'CORPUS_BYTE_LIMIT',
            `Canonical corpus may contain at most ${MAX_CANONICAL_RECORD_BYTES} bytes of record JSON.`,
            path,
          ),
        ]
      : []),
  ]
}

const validateScanned = (root: string, scan: RecordScan, hooks: RecordReadHooks = {}): ValidateResult => {
  hooks.graphValidation?.()
  const collectedErrors = [
    ...scan.errors,
    ...corpusBudgetIssues(scan),
    ...duplicateAndCaseIssues(scan.records),
    ...supersessionIssues(scan.records),
    ...artifactIssues(root, scan.records),
  ]
  const { errors, truncated } = truncateValidationIssues(collectedErrors)
  return {
    errors,
    recordsChecked: scan.records.length,
    truncated,
    valid: errors.length === 0,
  }
}

const allowedMultiHeadRecordIds = (records: BrainRecord[], allowed: AllowedMultiHead[]) => {
  const allowedKeys = new Set(allowed.map(candidate => `${candidate.kind} ${candidate.subject} ${candidate.source}`))
  const superseded = new Set<string>()
  for (const record of records) {
    for (const targetId of record.supersedes ?? []) {
      superseded.add(targetId)
    }
  }
  const activeGroups = new Map<string, BrainRecord[]>()
  for (const record of records) {
    if (!superseded.has(record.id)) {
      const key = `${record.kind} ${record.subject}`
      const group = activeGroups.get(key)
      if (group === undefined) {
        activeGroups.set(key, [record])
      } else {
        group.push(record)
      }
    }
  }
  const ids = new Set<string>()
  for (const group of activeGroups.values()) {
    const [first] = group
    if (
      first !== undefined &&
      group.length > 1 &&
      group.every(record => allowedKeys.has(`${record.kind} ${record.subject} ${record.source}`))
    ) {
      for (const record of group) {
        ids.add(record.id)
      }
    }
  }
  return ids
}

export const validateRecordsResolved = (root: string, options: ValidateRecordsOptions = {}): ValidateResult => {
  try {
    return validateScanned(root, scanCanonicalRecords(root, options))
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to validate Encephalon records.', error)
  }
}

export const validateRecords = (input: RootInput = {}): ValidateResult => {
  const root = resolveRepository(parseRootInput(input, 'validateRecords'))
  return validateRecordsResolved(root)
}

export const readRecordsResolved = (root: string, hooks: RecordReadHooks = {}, allowed?: AllowedMultiHead[]) => {
  hooks.canonicalScan?.()
  const scan = scanCanonicalRecords(root)
  const result = validateScanned(root, scan, hooks)
  if (allowed === undefined) {
    if (result.valid) {
      return scan.records
    }
    return fail('VALIDATION_FAILED', 'Canonical records are invalid.', {
      errors: result.errors.map(error => ({
        code: error.code,
        message: error.message,
      })),
    })
  }
  const allowedIds = allowedMultiHeadRecordIds(scan.records, allowed)
  const blockingErrors = result.errors.filter(
    error =>
      !(error.code === 'MULTIPLE_ACTIVE_HEADS' && error.recordId !== undefined && allowedIds.has(error.recordId)),
  )
  if (blockingErrors.length === 0) {
    return scan.records
  }
  return fail('VALIDATION_FAILED', 'Canonical records are invalid.', {
    errors: blockingErrors.map(error => ({
      code: error.code,
      message: error.message,
    })),
  })
}

export const readRecords = (input: RootInput = {}) => readRecordsResolved(resolveRepository(input))

export const readRecordsAllowingGeneratedMultiHeads = (input: RootInput, allowed: AllowedMultiHead[]) =>
  readRecordsResolved(resolveRepository(input), {}, allowed)

export const planRecordAddition = (root: string, input: AddRecordInput): PlannedRecord => {
  const recordFile = createRecordFile(input)
  const relativePath = `encephalon/${recordFile.kind}/${recordFile.id}.json`
  const path = resolve(root, ...relativePath.split('/'))
  if (existsSync(path)) {
    return fail('RECORD_EXISTS', `Record ${recordFile.id} already exists.`, {
      path: relativePath,
    })
  }
  const record: BrainRecord = { ...recordFile, path: relativePath }
  return {
    formatted: formatRecordFile(recordFile),
    path,
    record,
    recordFile,
    relativePath,
  }
}

export const assertRecordGraph = (
  root: string,
  records: BrainRecord[],
  message = 'Canonical records are invalid.',
  hooks: RecordReadHooks = {},
  bytes?: number,
) => {
  const result = validateScanned(
    root,
    {
      bytes: bytes ?? records.reduce((total, record) => total + canonicalRecordBytes(record), 0),
      errors: [],
      records,
    },
    hooks,
  )
  if (result.valid) {
    return
  }
  return fail('VALIDATION_FAILED', message, {
    errors: result.errors.map(error => ({
      code: error.code,
      message: error.message,
    })),
  })
}

type PublishResult = {
  committedError?: EncephalonError
  committedErrorPhase?: PostCommitPhase
  record: BrainRecord
}

const publishPlannedRecordInternal = (
  root: string,
  plan: PlannedRecord,
  options: { hooks?: RecordWriteHooks } = {},
): PublishResult => {
  cleanupStagingDirectory(root, options.hooks)
  const { formatted, path, record, recordFile, relativePath } = plan
  const kindDirectory = ensureDirectoryChain(root, ['encephalon', recordFile.kind])
  const stagingDirectory = ensureDirectoryChain(root, ['encephalon', STAGING_DIRECTORY])
  const stagingPath = resolve(stagingDirectory, `record-${process.pid}-${randomUUID()}.tmp`)
  let published = false
  let operationFailed = false
  let cleanupError: unknown
  let committedError: EncephalonError | undefined
  let committedErrorPhase: PostCommitPhase | undefined
  const capturePostCommitError = (phase: PostCommitPhase, error: unknown) => {
    if (committedErrorPhase === undefined || postCommitPriority[phase] > postCommitPriority[committedErrorPhase]) {
      committedError = postCommitError(record, phase, error)
      committedErrorPhase = phase
    }
  }
  try {
    assertRealDirectory(root, stagingDirectory)
    const descriptor = openSync(
      stagingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag,
      0o644,
    )
    try {
      fault(options.hooks, 'during-staging-write')
      writeFileSync(descriptor, formatted, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    fault(options.hooks, 'before-publication')
    assertRealDirectory(root, kindDirectory)
    assertRealDirectory(root, stagingDirectory)
    try {
      linkSync(stagingPath, path)
      published = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail('RECORD_EXISTS', `Record ${recordFile.id} already exists.`, { path: relativePath })
      }
      throw error
    }
    try {
      fault(options.hooks, 'after-publication')
      fault(options.hooks, 'during-publication-flush')
      fsyncDirectory(kindDirectory)
    } catch (error) {
      capturePostCommitError('publicationFlush', error)
    }
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    try {
      fault(options.hooks, 'during-cleanup')
      rmSync(stagingPath, { force: true })
      fsyncDirectory(stagingDirectory)
    } catch (error) {
      if (published) {
        capturePostCommitError('stagingCleanup', error)
      } else if (!operationFailed) {
        cleanupError = error
      }
    }
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  return {
    record,
    ...(committedError === undefined ? {} : { committedError }),
    ...(committedErrorPhase === undefined ? {} : { committedErrorPhase }),
  }
}

export const publishPlannedRecord = (
  root: string,
  plan: PlannedRecord,
  options: { hooks?: RecordWriteHooks } = {},
): BrainRecord => {
  const published = publishPlannedRecordInternal(root, plan, options)
  if (published.committedError !== undefined) {
    throw published.committedError
  }
  return published.record
}

const addRecordFileResolved = (
  root: string,
  recordFile: BrainRecordFile,
  options: AddRecordOptions = {},
): BrainRecord => {
  const relativePath = `encephalon/${recordFile.kind}/${recordFile.id}.json`
  const path = resolve(root, ...relativePath.split('/'))
  if (existsSync(path)) {
    return fail('RECORD_EXISTS', `Record ${recordFile.id} already exists.`, {
      path: relativePath,
    })
  }
  const record: BrainRecord = { ...recordFile, path: relativePath }
  const formatted = formatRecordFile(recordFile)
  const plan: PlannedRecord = { formatted, path, record, recordFile, relativePath }

  const scan = scanCanonicalRecords(root)
  if (scan.errors.length > 0) {
    return fail('VALIDATION_FAILED', 'Existing canonical records are invalid.', {
      errors: scan.errors.map(error => ({
        code: error.code,
        message: error.message,
      })),
    })
  }
  assertRecordGraph(
    root,
    [...scan.records, plan.record],
    'The new record would make canonical records invalid.',
    {},
    scan.bytes + Buffer.byteLength(plan.formatted, 'utf8'),
  )

  const publishOptions = options.hooks === undefined ? {} : { hooks: options.hooks }
  const published = publishPlannedRecordInternal(root, plan, publishOptions)
  let { committedError, committedErrorPhase } = published
  const capturePostCommitError = (phase: PostCommitPhase, error: unknown) => {
    if (committedErrorPhase === undefined || postCommitPriority[phase] > postCommitPriority[committedErrorPhase]) {
      committedError = postCommitError(published.record, phase, error)
      committedErrorPhase = phase
    }
  }
  if (committedErrorPhase !== 'publicationFlush' && options.hydrate !== false) {
    try {
      fault(options.hooks, 'during-hydration')
      hydrateResolvedRepository(root, false)
    } catch (error) {
      capturePostCommitError('cacheHydration', error)
    }
  }
  if (committedError !== undefined) {
    throw committedError
  }
  return published.record
}

export const addRecordResolved = (root: string, input: AddRecordInput, options: AddRecordOptions = {}): BrainRecord =>
  addRecordFileResolved(root, createRecordFile(input), options)

export const addRecord = (input: AddRecordInput): BrainRecord => {
  const parsed = parseAddRecordInput(input)
  const root = resolveRepository(parsed)
  try {
    return withOperationLock(root, () => addRecordFileResolved(root, parsed.recordFile))
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to add the Encephalon record.', error)
  }
}

export const canonicalRecordPath = (record: BrainRecordFile) =>
  join('encephalon', record.kind, `${basename(record.id)}.json`).replaceAll('\\', '/')
