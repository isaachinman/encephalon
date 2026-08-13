import { randomUUID } from 'node:crypto'
import { ARTIFACTS_DIRECTORY_NAME } from './canonical-layout.ts'
import { fail, failBudget } from './errors.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import type { AddRecordInput, BrainRecordFile, JsonValue } from './types.ts'

export const MAX_RECORD_BYTES = 1024 * 1024
export const MAX_PAYLOAD_DEPTH = 64
export const MAX_PAYLOAD_NODES = 10_000
const MAX_SEARCH_TEXT_BYTES = 256 * 1024
const MAX_TEXT_BYTES = 1024
// Portable path components must fit common 255-byte and 255-UTF-16-code-unit filesystem limits.
const MAX_PATH_COMPONENT_BYTES = 255
const MAX_PATH_COMPONENT_UTF16_UNITS = 255
const MAX_ARTIFACTS = 256
const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i
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
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8')

const hasPortableComponentLength = (value: string) =>
  byteLength(value) <= MAX_PATH_COMPONENT_BYTES && value.length <= MAX_PATH_COMPONENT_UTF16_UNITS

const requiredText = (value: unknown, field: string) => {
  if (typeof value === 'string' && value.length > 0 && value === value.trim() && byteLength(value) <= MAX_TEXT_BYTES) {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} must be a non-empty string of at most 1024 UTF-8 bytes.`, {
    field,
  })
}

const assertPortableSegment = (value: string, field: string, pattern: RegExp) => {
  if (
    pattern.test(value) &&
    hasPortableComponentLength(value) &&
    !RESERVED_WINDOWS_NAMES.test(value) &&
    !value.endsWith('.') &&
    !value.endsWith(' ')
  ) {
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

type PayloadTarget = {
  container: JsonValue[] | { [key: string]: JsonValue }
  key: number | string
}

type PayloadWorkItem =
  | {
      action: 'enter'
      depth: number
      path: string
      target?: PayloadTarget
      value: unknown
    }
  | {
      action: 'exit'
      value: object
    }

const assignPayloadValue = (target: PayloadTarget | undefined, value: JsonValue) => {
  if (target === undefined) {
    return value
  }
  if (Array.isArray(target.container) && typeof target.key === 'number') {
    target.container[target.key] = value
    return
  }
  if (!Array.isArray(target.container) && typeof target.key === 'string') {
    Object.defineProperty(target.container, target.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
    return
  }
  return fail('INTERNAL_ERROR', 'Payload traversal target is invalid.')
}

const getPayloadPrototype = (value: object, path: string) => {
  try {
    return Object.getPrototypeOf(value)
  } catch {
    return fail('INVALID_ARGUMENT', 'payload object metadata could not be inspected.', {
      field: path,
    })
  }
}

const getPayloadDescriptors = (value: object, path: string) => {
  try {
    return Object.getOwnPropertyDescriptors(value)
  } catch {
    return fail('INVALID_ARGUMENT', 'payload object descriptors could not be inspected.', {
      field: path,
    })
  }
}

const assertPayloadDescriptors = (descriptors: PropertyDescriptorMap, path: string) => {
  const descriptorKeys = Reflect.ownKeys(descriptors)
  if (descriptorKeys.some(key => typeof key === 'symbol')) {
    return fail('INVALID_ARGUMENT', 'payload contains a symbol-keyed property.', { field: path })
  }
  const accessorKey = descriptorKeys.find(key => {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor | undefined
    return descriptor !== undefined && ('get' in descriptor || 'set' in descriptor)
  })
  if (accessorKey !== undefined) {
    return fail('INVALID_ARGUMENT', 'payload contains an accessor property.', { field: path })
  }
}

const validateJsonValueAt = (
  value: unknown,
  path: string,
  depth: number,
  target: PayloadTarget | undefined,
  stack: PayloadWorkItem[],
  seen: WeakSet<object>,
  nodeCount: { value: number },
) => {
  nodeCount.value += 1
  if (nodeCount.value > MAX_PAYLOAD_NODES) {
    return fail('INVALID_ARGUMENT', `payload may contain at most ${MAX_PAYLOAD_NODES} JSON nodes.`, {
      field: path,
    })
  }
  if (depth > MAX_PAYLOAD_DEPTH) {
    return fail('INVALID_ARGUMENT', `payload may be nested at most ${MAX_PAYLOAD_DEPTH} levels deep.`, {
      field: path,
    })
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return assignPayloadValue(target, value)
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      return assignPayloadValue(target, Object.is(value, -0) ? 0 : value)
    }
    return fail('INVALID_ARGUMENT', 'payload contains a non-finite number.', {
      field: path,
    })
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return fail('INVALID_ARGUMENT', 'payload contains a cycle.', {
        field: path,
      })
    }
    const descriptors = getPayloadDescriptors(value, path)
    assertPayloadDescriptors(descriptors, path)
    const length = descriptors.length?.value
    if (!Number.isSafeInteger(length) || length < 0) {
      return fail('INVALID_ARGUMENT', 'payload contains an invalid array length.', { field: path })
    }
    if (length > MAX_PAYLOAD_NODES - nodeCount.value) {
      return fail('INVALID_ARGUMENT', `payload may contain at most ${MAX_PAYLOAD_NODES} JSON nodes.`, {
        field: path,
      })
    }
    seen.add(value)
    const values: JsonValue[] = new Array(length)
    const assigned = assignPayloadValue(target, values)
    stack.push({ action: 'exit', value })
    for (let index = length - 1; index >= 0; index -= 1) {
      const descriptor = descriptors[String(index)]
      if (descriptor !== undefined && 'value' in descriptor) {
        stack.push({
          action: 'enter',
          depth: depth + 1,
          path: `${path}[${index}]`,
          target: { container: values, key: index },
          value: descriptor.value,
        })
      } else {
        return fail('INVALID_ARGUMENT', 'payload contains a sparse array.', {
          field: path,
        })
      }
    }
    return assigned
  }
  if (typeof value === 'object') {
    const object = value as object
    const prototype = getPayloadPrototype(object, path)
    if (prototype === Object.prototype || prototype === null) {
      if (seen.has(object)) {
        return fail('INVALID_ARGUMENT', 'payload contains a cycle.', {
          field: path,
        })
      }
      const descriptors = getPayloadDescriptors(object, path)
      assertPayloadDescriptors(descriptors, path)
      seen.add(object)
      const result: { [key: string]: JsonValue } = {}
      const assigned = assignPayloadValue(target, result)
      stack.push({ action: 'exit', value: object })
      const keys = Object.keys(descriptors).filter(key => descriptors[key]?.enumerable === true)
      if (keys.length > MAX_PAYLOAD_NODES - nodeCount.value) {
        return fail('INVALID_ARGUMENT', `payload may contain at most ${MAX_PAYLOAD_NODES} JSON nodes.`, {
          field: path,
        })
      }
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index] ?? ''
        const descriptor = descriptors[key]
        if (descriptor !== undefined && 'value' in descriptor) {
          stack.push({
            action: 'enter',
            depth: depth + 1,
            path: `${path}.${key}`,
            target: { container: result, key },
            value: descriptor.value,
          })
        } else {
          return fail('INVALID_ARGUMENT', 'payload contains an invalid property descriptor.', {
            field: path,
          })
        }
      }
      return assigned
    }
    return fail('INVALID_ARGUMENT', 'payload contains a non-plain object.', {
      field: path,
    })
  }
  return fail('INVALID_ARGUMENT', 'payload contains a value that is not JSON serializable.', { field: path })
}

export const validateJsonValue = (value: unknown) => {
  const stack: PayloadWorkItem[] = [{ action: 'enter', depth: 0, path: 'payload', value }]
  const seen = new WeakSet<object>()
  const nodeCount = { value: 0 }
  let result: JsonValue | undefined
  while (stack.length > 0) {
    const item = stack.pop()
    if (item !== undefined) {
      if (item.action === 'exit') {
        seen.delete(item.value)
      } else {
        const assigned = validateJsonValueAt(item.value, item.path, item.depth, item.target, stack, seen, nodeCount)
        if (item.target === undefined && assigned !== undefined) {
          result = assigned
        }
      }
    }
  }
  if (result !== undefined) {
    return result
  }
  return fail('INTERNAL_ERROR', 'Payload validation did not produce a value.')
}

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
        hasPortableComponentLength(segment) &&
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
  if (
    artifact.segments[0] === ARTIFACTS_DIRECTORY_NAME &&
    artifact.segments[1] === kind &&
    artifact.segments[2] === id
  ) {
    return artifact.path
  }
  return fail('INVALID_ARGUMENT', 'artifact must remain beneath the matching record artifact directory.', {
    field: 'artifact',
  })
}

const normalizeOptionalText = (value: unknown, field: string, maximumBytes: number) => {
  if (typeof value === 'string' && value.length > 0 && value === value.trim() && byteLength(value) <= maximumBytes) {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} must be a non-empty string within its size limit.`, { field })
}

const validateSupersedes = (value: unknown) => {
  if (Array.isArray(value) && value.length > OPERATION_BUDGETS.supersessionEdges.maximum) {
    return failBudget(
      OPERATION_BUDGETS.supersessionEdges.field,
      'supersessionEdges',
      OPERATION_BUDGETS.supersessionEdges.maximum,
      `supersedes may contain at most ${OPERATION_BUDGETS.supersessionEdges.maximum} record ids.`,
    )
  }
  return validateStringArray(value, 'supersedes', validateId)
}

const optionalSupersedes = (value: unknown) => {
  if (value === undefined) {
    return
  }
  if (!Array.isArray(value)) {
    return fail('INVALID_ARGUMENT', 'supersedes must be an array of strings.', { field: 'supersedes' })
  }
  if (value.length === 0) {
    return
  }
  return validateSupersedes(value)
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

/** @internal */
export type ValidatedAddRecordInput = Omit<BrainRecordFile, 'createdAt'>

/** @internal */
export const createRecordFile = (input: ValidatedAddRecordInput, createdAt: string): BrainRecordFile => ({
  ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
  ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
  createdAt: validateTimestamp(createdAt),
  id: input.id,
  kind: input.kind,
  payload: input.payload,
  ...(input.searchText === undefined ? {} : { searchText: input.searchText }),
  source: input.source,
  subject: input.subject,
  ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
})

/** @internal */
export const validateAddRecordInput = (input: AddRecordInput): ValidatedAddRecordInput => {
  const id = validateId(input.id ?? randomUUID())
  const kind = validateKind(input.kind)
  const subject = requiredText(input.subject, 'subject')
  const source = requiredText(input.source, 'source')
  const payload = validateJsonValue(input.payload)
  const confidence = input.confidence === undefined ? undefined : validateConfidence(input.confidence)
  const supersedes = optionalSupersedes(input.supersedes)
  const artifacts = optionalArtifacts(input.artifacts, kind, id)
  const searchText =
    input.searchText === undefined
      ? undefined
      : normalizeOptionalText(input.searchText, 'searchText', MAX_SEARCH_TEXT_BYTES)

  const validated = {
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(confidence === undefined ? {} : { confidence }),
    id,
    kind,
    payload,
    ...(searchText === undefined ? {} : { searchText }),
    source,
    subject,
    ...(supersedes === undefined ? {} : { supersedes }),
  }
  formatRecordFile(createRecordFile(validated, '2000-01-01T00:00:00.000Z'))
  return validated
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
    record.supersedes = validateSupersedes(object.supersedes)
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
