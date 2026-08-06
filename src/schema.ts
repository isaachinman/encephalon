import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fail } from './errors.ts'
import type { AddRecordInput, BrainRecordFile, JsonValue } from './types.ts'

export const MAX_RECORD_BYTES = 1024 * 1024
const MAX_SEARCH_TEXT_BYTES = 256 * 1024
const MAX_TEXT_BYTES = 1024
const MAX_ARTIFACTS = 256
const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const hasControlCharacters = (value: string) =>
  [...value].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
const ALLOWED_RECORD_KEYS = new Set([
  'id',
  'kind',
  'subject',
  'source',
  'createdAt',
  'confidence',
  'supersedes',
  'artifacts',
  'payload',
  'searchText',
])
let lastCreatedAtMilliseconds = 0

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')

const requiredText = (value: unknown, field: string) => {
  if (typeof value === 'string' && value.length > 0 && value === value.trim() && byteLength(value) <= MAX_TEXT_BYTES) {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} must be a non-empty string of at most 1024 UTF-8 bytes.`, {
    field,
  })
}

const assertPortableSegment = (value: string, field: string, pattern: RegExp) => {
  if (pattern.test(value) && !RESERVED_WINDOWS_NAMES.test(value) && !value.endsWith('.') && !value.endsWith(' ')) {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} is not a portable path segment.`, {
    field,
  })
}

export const validateKind = (value: unknown) => {
  const kind = requiredText(value, 'kind')
  return assertPortableSegment(kind, 'kind', KIND_PATTERN)
}

export const validateId = (value: unknown) => {
  const id = requiredText(value, 'id')
  return assertPortableSegment(id, 'id', ID_PATTERN)
}

const validateTimestamp = (value: unknown) => {
  if (typeof value === 'string' && TIMESTAMP_PATTERN.test(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString() === value) {
      return value
    }
  }
  return fail('INVALID_ARGUMENT', 'createdAt must be canonical UTC RFC3339 with millisecond precision.', {
    field: 'createdAt',
  })
}

const validateConfidence = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
    return value
  }
  return fail('INVALID_ARGUMENT', 'confidence must be a finite number between 0 and 1.', {
    field: 'confidence',
  })
}

const validateStringArray = (value: unknown, field: string, item: (value: unknown) => string) => {
  if (Array.isArray(value) && value.length > 0) {
    const normalized = value.map(item)
    if (new Set(normalized).size === normalized.length) {
      return normalized
    }
  }
  return fail('INVALID_ARGUMENT', `${field} must be a non-empty array of unique strings.`, { field })
}

const validateJsonAt = (value: unknown, seen: WeakSet<object>, path: string): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return value
    }
    return fail('INVALID_ARGUMENT', 'payload contains a non-finite number.', {
      field: path,
    })
  }
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return fail('INVALID_ARGUMENT', 'payload contains a symbol-keyed property.', { field: path })
    }
    if (seen.has(value)) {
      return fail('INVALID_ARGUMENT', 'payload contains a cycle.', {
        field: path,
      })
    }
    seen.add(value)
    const values = Array.from({ length: value.length }, (_, index) => {
      if (Object.hasOwn(value, index)) {
        return validateJsonAt(value[index], seen, `${path}[${index}]`)
      }
      return fail('INVALID_ARGUMENT', 'payload contains a sparse array.', {
        field: path,
      })
    })
    seen.delete(value)
    return values
  }
  if (typeof value === 'object') {
    const object = value as object
    const prototype = Object.getPrototypeOf(object)
    if (prototype === Object.prototype || prototype === null) {
      if (Object.getOwnPropertySymbols(object).length > 0) {
        return fail('INVALID_ARGUMENT', 'payload contains a symbol-keyed property.', { field: path })
      }
      if (seen.has(object)) {
        return fail('INVALID_ARGUMENT', 'payload contains a cycle.', {
          field: path,
        })
      }
      seen.add(object)
      const result = Object.fromEntries(
        Object.entries(object).map(([key, entry]) => [key, validateJsonAt(entry, seen, `${path}.${key}`)]),
      ) as { [key: string]: JsonValue }
      seen.delete(object)
      return result
    }
    return fail('INVALID_ARGUMENT', 'payload contains a non-plain object.', {
      field: path,
    })
  }
  return fail('INVALID_ARGUMENT', 'payload contains a value that is not JSON serializable.', { field: path })
}

export const validateJsonValue = (value: unknown) => validateJsonAt(value, new WeakSet(), 'payload')

const portableArtifactSegments = (value: unknown) => {
  const path = requiredText(value, 'artifact')
  if (byteLength(path) > MAX_TEXT_BYTES || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return fail('INVALID_ARGUMENT', 'artifact is not a portable relative path.', { field: 'artifact' })
  }
  const segments = path.split('/')
  if (
    segments.length >= 4 &&
    segments.every(
      segment =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !hasControlCharacters(segment) &&
        !/[<>:"|?*]/.test(segment) &&
        !segment.endsWith('.') &&
        !segment.endsWith(' ') &&
        segment === segment.normalize('NFC') &&
        !RESERVED_WINDOWS_NAMES.test(segment),
    )
  ) {
    return { path, segments }
  }
  return fail('INVALID_ARGUMENT', 'artifact contains an unsafe path segment.', {
    field: 'artifact',
  })
}

export const validateArtifactPath = (value: unknown, kind: string, id: string) => {
  const artifact = portableArtifactSegments(value)
  if (artifact.segments[0] === '_artifacts' && artifact.segments[1] === kind && artifact.segments[2] === id) {
    return artifact.path
  }
  return fail('INVALID_ARGUMENT', 'artifact must remain beneath the matching record artifact directory.', {
    field: 'artifact',
  })
}

export const assertArtifactFile = (brainDirectory: string, artifact: string) => {
  const root = realpathSync.native(brainDirectory)
  const segments = artifact.split('/')
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    const metadata = lstatSync(current)
    if (metadata.isSymbolicLink()) {
      fail('VALIDATION_FAILED', 'Artifact paths may not contain symbolic links.')
    }
  }
  const relativePath = relative(root, current)
  const finalMetadata = lstatSync(current)
  if (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath) &&
    finalMetadata.isFile() &&
    !finalMetadata.isSymbolicLink()
  ) {
    return current
  }
  return fail('VALIDATION_FAILED', 'Artifact must resolve to a regular file beneath the brain directory.')
}

const normalizeOptionalText = (value: unknown, field: string, maximumBytes: number) => {
  if (typeof value === 'string' && value.length > 0 && value === value.trim() && byteLength(value) <= maximumBytes) {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} must be a non-empty string within its size limit.`, { field })
}

const optionalStringArray = (value: unknown, field: string, item: (value: unknown) => string) => {
  if (value === undefined) {
    return
  }
  if (!Array.isArray(value)) {
    return fail('INVALID_ARGUMENT', `${field} must be an array of strings.`, { field })
  }
  if (value.length === 0) {
    return
  }
  return validateStringArray(value, field, item)
}

const optionalArtifacts = (value: unknown, kind: string, id: string) => {
  if (value === undefined) {
    return
  }
  if (!Array.isArray(value)) {
    return fail('INVALID_ARGUMENT', 'artifacts must be an array of strings.', { field: 'artifacts' })
  }
  if (value.length === 0) {
    return
  }
  if (value.length > MAX_ARTIFACTS) {
    return fail('INVALID_ARGUMENT', 'artifacts may contain at most 256 paths.', { field: 'artifacts' })
  }
  return validateStringArray(value, 'artifacts', entry => validateArtifactPath(entry, kind, id))
}

export const createRecordFile = (input: AddRecordInput): BrainRecordFile => {
  const id = validateId(input.id ?? randomUUID())
  const kind = validateKind(input.kind)
  const subject = requiredText(input.subject, 'subject')
  const source = requiredText(input.source, 'source')
  const now = Date.now()
  lastCreatedAtMilliseconds = Math.max(now, lastCreatedAtMilliseconds + 1)
  const createdAt = new Date(lastCreatedAtMilliseconds).toISOString()
  const payload = validateJsonValue(input.payload)
  const confidence = input.confidence === undefined ? undefined : validateConfidence(input.confidence)
  const supersedes = optionalStringArray(input.supersedes, 'supersedes', validateId)
  const artifacts = optionalArtifacts(input.artifacts, kind, id)
  const searchText =
    input.searchText === undefined
      ? undefined
      : normalizeOptionalText(input.searchText, 'searchText', MAX_SEARCH_TEXT_BYTES)

  return {
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(confidence === undefined ? {} : { confidence }),
    createdAt,
    id,
    kind,
    payload,
    ...(searchText === undefined ? {} : { searchText }),
    source,
    subject,
    ...(supersedes === undefined ? {} : { supersedes }),
  }
}

export const parseRecordFile = (value: unknown): BrainRecordFile => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('INVALID_ARGUMENT', 'Record JSON must contain an object.')
  }
  const object = value as Record<string, unknown>
  const unknownKey = Object.keys(object).find(key => !ALLOWED_RECORD_KEYS.has(key))
  if (unknownKey !== undefined) {
    return fail('INVALID_ARGUMENT', `Record contains unknown field ${unknownKey}.`, { field: unknownKey })
  }

  const id = validateId(object.id)
  const kind = validateKind(object.kind)
  const record: BrainRecordFile = {
    createdAt: validateTimestamp(object.createdAt),
    id,
    kind,
    payload: validateJsonValue(object.payload),
    source: requiredText(object.source, 'source'),
    subject: requiredText(object.subject, 'subject'),
  }
  if (object.artifacts !== undefined) {
    if (Array.isArray(object.artifacts) && object.artifacts.length <= MAX_ARTIFACTS) {
      record.artifacts = validateStringArray(object.artifacts, 'artifacts', entry =>
        validateArtifactPath(entry, kind, id),
      )
    } else {
      fail('INVALID_ARGUMENT', 'artifacts may contain at most 256 paths.', {
        field: 'artifacts',
      })
    }
  }
  if (object.confidence !== undefined) {
    record.confidence = validateConfidence(object.confidence)
  }
  if (object.searchText !== undefined) {
    record.searchText = normalizeOptionalText(object.searchText, 'searchText', MAX_SEARCH_TEXT_BYTES)
  }
  if (object.supersedes !== undefined) {
    record.supersedes = validateStringArray(object.supersedes, 'supersedes', validateId)
  }
  return record
}

export const formatRecordFile = (record: BrainRecordFile) => {
  const formatted = `${JSON.stringify(record, null, 2)}\n`
  if (byteLength(formatted) <= MAX_RECORD_BYTES) {
    return formatted
  }
  return fail('INVALID_ARGUMENT', 'The formatted record exceeds the 1 MiB limit.')
}
