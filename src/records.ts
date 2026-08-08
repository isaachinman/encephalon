import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
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
}

type RecordWriteFault =
  | 'after-publication'
  | 'before-publication'
  | 'during-cleanup'
  | 'during-hydration'
  | 'during-publication-flush'
  | 'during-staging-write'

type RecordWriteHooks = {
  fault?: (point: RecordWriteFault) => void
}

type AddRecordOptions = {
  hooks?: RecordWriteHooks
  hydrate?: boolean
}

const STAGING_DIRECTORY = '_staging'
const RESERVED_DIRECTORIES = new Set(['_artifacts', STAGING_DIRECTORY])
const directoryFlag = constants.O_DIRECTORY ?? 0
const noFollowFlag = constants.O_NOFOLLOW ?? 0

const posixRelative = (root: string, path: string) => relative(root, path).replaceAll('\\', '/')

const issue = (code: string, message: string, path?: string, recordId?: string): ValidationIssue => ({
  code,
  message,
  ...(path === undefined ? {} : { path }),
  ...(recordId === undefined ? {} : { recordId }),
})

const fault = (hooks: RecordWriteHooks | undefined, point: RecordWriteFault) => hooks?.fault?.(point)

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

const readRecord = (root: string, path: string): BrainRecord => {
  const relativePath = posixRelative(root, path)
  const metadata = lstatSync(path)
  if (metadata.size > MAX_RECORD_BYTES) {
    return fail('INVALID_ARGUMENT', 'Record file exceeds the 1 MiB limit.', {
      path: relativePath,
    })
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const record = parseRecordFile(parsed)
  return { ...record, path: relativePath }
}

const scanCanonicalRecords = (root: string): RecordScan => {
  const brainDirectory = resolve(root, 'encephalon')
  if (existsSync(brainDirectory)) {
    const rootMetadata = lstatSync(brainDirectory)
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      return {
        errors: [issue('INVALID_RECORD_LAYOUT', 'encephalon must be a real directory.', 'encephalon')],
        records: [],
      }
    }

    const scanned: RecordScan = { errors: [], records: [] }
    for (const kindEntry of readdirSync(brainDirectory, { withFileTypes: true }).sort((first, second) =>
      first.name.localeCompare(second.name),
    )) {
      if (RESERVED_DIRECTORIES.has(kindEntry.name)) {
        if (!(kindEntry.isDirectory() && !kindEntry.isSymbolicLink())) {
          scanned.errors.push(
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
          for (const recordEntry of readdirSync(kindPath, { withFileTypes: true }).sort((first, second) =>
            first.name.localeCompare(second.name),
          )) {
            const recordPath = join(kindPath, recordEntry.name)
            const relativePath = posixRelative(root, recordPath)
            if (recordEntry.isFile() && !recordEntry.isSymbolicLink() && recordEntry.name.endsWith('.json')) {
              try {
                const record = readRecord(root, recordPath)
                const expectedName = `${record.id}.json`
                if (recordEntry.name !== expectedName || record.kind !== kindEntry.name) {
                  scanned.errors.push(
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
                scanned.errors.push(issue('INVALID_RECORD', message, relativePath))
              }
            } else {
              scanned.errors.push(
                issue(
                  'INVALID_RECORD_LAYOUT',
                  'Kind directories may contain only direct regular JSON files.',
                  relativePath,
                ),
              )
            }
          }
        } else {
          scanned.errors.push(
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
      errors: scanned.errors,
      records: scanned.records.sort(
        (first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id),
      ),
    }
  }
  return { errors: [], records: [] }
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
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (record: BrainRecord) => {
    if (!visited.has(record.id)) {
      if (visiting.has(record.id)) {
        cycleIssues.push(issue('SUPERSEDES_CYCLE', 'The supersession graph contains a cycle.', record.path, record.id))
      } else {
        visiting.add(record.id)
        for (const targetId of record.supersedes ?? []) {
          const target = byId.get(targetId)
          if (target !== undefined) {
            visit(target)
          }
        }
        visiting.delete(record.id)
        visited.add(record.id)
      }
    }
  }
  for (const record of records) {
    visit(record)
  }

  const superseded = new Set(records.flatMap(record => record.supersedes ?? []))
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

const validateScanned = (root: string, scan: RecordScan): ValidateResult => {
  const errors = [
    ...scan.errors,
    ...duplicateAndCaseIssues(scan.records),
    ...supersessionIssues(scan.records),
    ...artifactIssues(root, scan.records),
  ]
  return {
    errors,
    recordsChecked: scan.records.length,
    valid: errors.length === 0,
  }
}

export const validateRecords = (input: RootInput = {}): ValidateResult => {
  const root = resolveRepository(input)
  try {
    return validateScanned(root, scanCanonicalRecords(root))
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to validate Encephalon records.', error)
  }
}

export const readRecords = (input: RootInput = {}) => {
  const root = resolveRepository(input)
  const scan = scanCanonicalRecords(root)
  const result = validateScanned(root, scan)
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

export const addRecordResolved = (root: string, input: AddRecordInput, options: AddRecordOptions = {}): BrainRecord => {
  const recordFile = createRecordFile(input)
  const relativePath = `encephalon/${recordFile.kind}/${recordFile.id}.json`
  const path = resolve(root, ...relativePath.split('/'))
  if (existsSync(path)) {
    return fail('RECORD_EXISTS', `Record ${recordFile.id} already exists.`, {
      path: relativePath,
    })
  }

  cleanupStagingDirectory(root, options.hooks)
  const scan = scanCanonicalRecords(root)
  if (scan.errors.length > 0) {
    return fail('VALIDATION_FAILED', 'Existing canonical records are invalid.', {
      errors: scan.errors.map(error => ({
        code: error.code,
        message: error.message,
      })),
    })
  }
  const candidate: BrainRecord = { ...recordFile, path: relativePath }
  const candidateResult = validateScanned(root, {
    errors: [],
    records: [...scan.records, candidate],
  })
  if (!candidateResult.valid) {
    return fail('VALIDATION_FAILED', 'The new record would make canonical records invalid.', {
      errors: candidateResult.errors.map(error => ({
        code: error.code,
        message: error.message,
      })),
    })
  }

  const formatted = formatRecordFile(recordFile)
  const kindDirectory = ensureDirectoryChain(root, ['encephalon', recordFile.kind])
  const stagingDirectory = ensureDirectoryChain(root, ['encephalon', STAGING_DIRECTORY])
  const stagingPath = resolve(stagingDirectory, `record-${process.pid}-${randomUUID()}.tmp`)
  let published = false
  let operationFailed = false
  let cleanupError: unknown
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
    } catch {
      // The canonical hard link is already visible; do not report a committed mutation as failed.
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
      if (!(operationFailed || published)) {
        cleanupError = error
      }
    }
  }
  if (cleanupError !== undefined) {
    throw cleanupError
  }
  if (options.hydrate !== false) {
    try {
      fault(options.hooks, 'during-hydration')
      hydrateResolvedRepository(root, false)
    } catch {
      // Cache rebuild is derived state after the record commit point; the next read can rebuild it.
    }
  }
  return candidate
}

export const addRecord = (input: AddRecordInput): BrainRecord => {
  const root = resolveRepository(input)
  try {
    return withOperationLock(root, () => addRecordResolved(root, input))
  } catch (error) {
    if (error instanceof EncephalonError) {
      throw error
    }
    return wrapIo('Unable to add the Encephalon record.', error)
  }
}

export const canonicalRecordPath = (record: BrainRecordFile) =>
  join('encephalon', record.kind, `${basename(record.id)}.json`).replaceAll('\\', '/')
