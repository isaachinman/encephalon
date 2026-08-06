import { randomUUID } from 'node:crypto'
import {
  closeSync,
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

const posixRelative = (root: string, path: string) => relative(root, path).replaceAll('\\', '/')

const issue = (code: string, message: string, path?: string, recordId?: string): ValidationIssue => ({
  code,
  message,
  ...(path === undefined ? {} : { path }),
  ...(recordId === undefined ? {} : { recordId }),
})

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

    const scanned = readdirSync(brainDirectory, { withFileTypes: true })
      .sort((first, second) => first.name.localeCompare(second.name))
      .reduce<RecordScan>(
        (result, kindEntry) => {
          if (kindEntry.name === '_artifacts') {
            return kindEntry.isDirectory() && !kindEntry.isSymbolicLink()
              ? result
              : {
                  errors: [
                    ...result.errors,
                    issue('INVALID_RECORD_LAYOUT', '_artifacts must be a real directory.', 'encephalon/_artifacts'),
                  ],
                  records: result.records,
                }
          }
          const kindPath = join(brainDirectory, kindEntry.name)
          if (!kindEntry.name.startsWith('_') && kindEntry.isDirectory() && !kindEntry.isSymbolicLink()) {
            return readdirSync(kindPath, { withFileTypes: true })
              .sort((first, second) => first.name.localeCompare(second.name))
              .reduce<RecordScan>((kindResult, recordEntry) => {
                const recordPath = join(kindPath, recordEntry.name)
                const relativePath = posixRelative(root, recordPath)
                if (recordEntry.isFile() && !recordEntry.isSymbolicLink() && recordEntry.name.endsWith('.json')) {
                  try {
                    const record = readRecord(root, recordPath)
                    const expectedName = `${record.id}.json`
                    const pathErrors = [
                      ...(recordEntry.name === expectedName && record.kind === kindEntry.name
                        ? []
                        : [
                            issue(
                              'RECORD_PATH_MISMATCH',
                              'Record filename and parent kind must match its envelope.',
                              relativePath,
                              record.id,
                            ),
                          ]),
                    ]
                    return {
                      errors: [...kindResult.errors, ...pathErrors],
                      records: [...kindResult.records, record],
                    }
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Record could not be parsed.'
                    return {
                      errors: [...kindResult.errors, issue('INVALID_RECORD', message, relativePath)],
                      records: kindResult.records,
                    }
                  }
                }
                return {
                  errors: [
                    ...kindResult.errors,
                    issue(
                      'INVALID_RECORD_LAYOUT',
                      'Kind directories may contain only direct regular JSON files.',
                      relativePath,
                    ),
                  ],
                  records: kindResult.records,
                }
              }, result)
          }
          return {
            errors: [
              ...result.errors,
              issue(
                'INVALID_RECORD_LAYOUT',
                'The brain root may contain only kind directories and the reserved _artifacts directory.',
                posixRelative(root, kindPath),
              ),
            ],
            records: result.records,
          }
        },
        { errors: [], records: [] },
      )
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
  return records.reduce<ValidationIssue[]>((errors, record) => {
    const idCollision = ids.get(record.id)
    const pathCollision = paths.get(record.path.normalize('NFC').toLowerCase())
    ids.set(record.id, record)
    paths.set(record.path.normalize('NFC').toLowerCase(), record)
    return [
      ...errors,
      ...(idCollision === undefined
        ? []
        : [issue('DUPLICATE_RECORD_ID', `Duplicate record id ${record.id}.`, record.path, record.id)]),
      ...(pathCollision === undefined || pathCollision.path === record.path
        ? []
        : [issue('CASE_COLLISION', 'Record paths collide on case-insensitive filesystems.', record.path, record.id)]),
    ]
  }, [])
}

const supersessionIssues = (records: BrainRecord[]) => {
  const byId = new Map(records.map(record => [record.id, record]))
  const edgeIssues = records.flatMap(record =>
    (record.supersedes ?? []).flatMap(targetId => {
      const target = byId.get(targetId)
      if (target === undefined) {
        return [issue('MISSING_SUPERSEDES', `Record supersedes missing record ${targetId}.`, record.path, record.id)]
      }
      if (targetId === record.id) {
        return [issue('SELF_SUPERSEDES', 'A record may not supersede itself.', record.path, record.id)]
      }
      if (target.kind !== record.kind || target.subject !== record.subject) {
        return [
          issue(
            'CROSS_SUBJECT_SUPERSEDES',
            'Superseded records must have the same kind and subject.',
            record.path,
            record.id,
          ),
        ]
      }
      return []
    }),
  )

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
  const activeGroups = records
    .filter(record => !superseded.has(record.id))
    .reduce<Map<string, BrainRecord[]>>((groups, record) => {
      const key = `${record.kind}\0${record.subject}`
      groups.set(key, [...(groups.get(key) ?? []), record])
      return groups
    }, new Map())
  const activeIssues = [...activeGroups.values()].flatMap(group =>
    group.length <= 1
      ? []
      : group.map(record =>
          issue(
            'MULTIPLE_ACTIVE_HEADS',
            `Multiple active records exist for ${record.kind}/${record.subject}.`,
            record.path,
            record.id,
          ),
        ),
  )
  return [...edgeIssues, ...cycleIssues, ...activeIssues]
}

const artifactIssues = (root: string, records: BrainRecord[]) => {
  const brainDirectory = resolve(root, 'encephalon')
  const paths = new Map<string, string>()
  return records.flatMap(record =>
    (record.artifacts ?? []).flatMap(artifact => {
      const collisionKey = artifact.normalize('NFC').toLowerCase()
      const collision = paths.get(collisionKey)
      paths.set(collisionKey, artifact)
      const collisionIssues =
        collision === undefined || collision === artifact
          ? []
          : [issue('CASE_COLLISION', 'Artifact paths collide on case-insensitive filesystems.', record.path, record.id)]
      try {
        assertArtifactFile(brainDirectory, artifact)
        return collisionIssues
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Artifact is invalid.'
        return [...collisionIssues, issue('INVALID_ARTIFACT', message, record.path, record.id)]
      }
    }),
  )
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

export const addRecordResolved = (
  root: string,
  input: AddRecordInput,
  options: { hydrate?: boolean } = {},
): BrainRecord => {
  const recordFile = createRecordFile(input)
  const relativePath = `encephalon/${recordFile.kind}/${recordFile.id}.json`
  const path = resolve(root, ...relativePath.split('/'))
  if (existsSync(path)) {
    return fail('RECORD_EXISTS', `Record ${recordFile.id} already exists.`, {
      path: relativePath,
    })
  }

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
  const kindDirectory = resolve(root, 'encephalon', recordFile.kind)
  const stagingDirectory = resolve(root, 'encephalon', '_artifacts', recordFile.kind, recordFile.id)
  const stagingPath = resolve(stagingDirectory, `.encephalon-record-${randomUUID()}.tmp`)
  mkdirSync(kindDirectory, { recursive: true })
  mkdirSync(stagingDirectory, { recursive: true })
  try {
    const descriptor = openSync(stagingPath, 'wx', 0o644)
    try {
      writeFileSync(descriptor, formatted, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    try {
      linkSync(stagingPath, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail('RECORD_EXISTS', `Record ${recordFile.id} already exists.`, { path: relativePath })
      }
      throw error
    }
  } finally {
    rmSync(stagingPath, { force: true })
  }
  if (options.hydrate !== false) {
    hydrateResolvedRepository(root, false)
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
