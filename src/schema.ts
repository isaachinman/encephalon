import { randomUUID } from 'node:crypto'
import { CANONICAL_BUDGETS } from './canonical-budgets.ts'
import { ARTIFACTS_DIRECTORY_NAME } from './canonical-layout.ts'
import { inspectDenseDataArray, readDenseDataArray } from './dense-data-array.ts'
import { fail, failBudget } from './errors.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import {
  guardedGetOwnPropertyDescriptor,
  guardedGetPrototypeOf,
  guardedOwnKeys,
  PROPERTY_INSPECTION_FAILED,
} from './property-inspection.ts'
import type { AddRecordInput, BrainRecordFile, JsonValue } from './types.ts'

export const MAX_RECORD_BYTES = CANONICAL_BUDGETS.recordBytes
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

export const validateId = (value: unknown, field = 'id') => {
  const id = requiredText(value, field)
  return assertPortableSegment(id, field, ID_PATTERN)
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
    return Object.is(value, -0) ? 0 : value
  }
  return fail('INVALID_ARGUMENT', 'confidence must be a finite number between 0 and 1.', {
    field: 'confidence',
  })
}

const validateStringArray = (value: unknown[], field: string, item: (value: unknown, index: number) => string) => {
  if (value.length > 0) {
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
  const prototype = guardedGetPrototypeOf(value)
  if (prototype !== PROPERTY_INSPECTION_FAILED) {
    return prototype
  }
  return fail('INVALID_ARGUMENT', 'payload object metadata could not be inspected.', {
    field: path,
  })
}

const getPayloadOwnKeys = (value: object, path: string) => {
  const keys = guardedOwnKeys(value)
  if (keys !== PROPERTY_INSPECTION_FAILED) {
    return keys
  }
  return fail('INVALID_ARGUMENT', 'payload object descriptors could not be inspected.', {
    field: path,
  })
}

const getPayloadOwnPropertyDescriptor = (value: object, key: PropertyKey, path: string) => {
  const descriptor = guardedGetOwnPropertyDescriptor(value, key)
  if (descriptor !== PROPERTY_INSPECTION_FAILED) {
    return descriptor
  }
  return fail('INVALID_ARGUMENT', 'payload object descriptors could not be inspected.', {
    field: path,
  })
}

const assertPayloadDataDescriptor = (descriptor: PropertyDescriptor | undefined, path: string) => {
  if (descriptor !== undefined && ('get' in descriptor || 'set' in descriptor)) {
    return fail('INVALID_ARGUMENT', 'payload contains an accessor property.', { field: path })
  }
  return descriptor
}

const canonicalArrayIndex = (key: string) => {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key ? index : undefined
}

const orderPayloadObjectKeys = (keys: PropertyKey[], length: number) => {
  keys.length = length
  keys.sort((left, right) => {
    if (typeof left === 'string' && typeof right === 'string') {
      const leftIndex = canonicalArrayIndex(left)
      const rightIndex = canonicalArrayIndex(right)
      if (leftIndex !== undefined && rightIndex !== undefined) {
        return leftIndex - rightIndex
      }
      if (leftIndex !== undefined) {
        return -1
      }
      if (rightIndex !== undefined) {
        return 1
      }
    }
    return 0
  })
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
    const lengthDescriptor = assertPayloadDataDescriptor(getPayloadOwnPropertyDescriptor(value, 'length', path), path)
    const length = lengthDescriptor?.value
    if (!Number.isSafeInteger(length) || length < 0) {
      return fail('INVALID_ARGUMENT', 'payload contains an invalid array length.', { field: path })
    }
    if (length > MAX_PAYLOAD_NODES - nodeCount.value) {
      return fail('INVALID_ARGUMENT', `payload may contain at most ${MAX_PAYLOAD_NODES} JSON nodes.`, {
        field: path,
      })
    }
    const keys = getPayloadOwnKeys(value, path)
    seen.add(value)
    const values: unknown[] = new Array(length)
    const normalizedValues = values as JsonValue[]
    const assigned = assignPayloadValue(target, normalizedValues)
    stack.push({ action: 'exit', value })
    let hasAccessor = false
    let hasSymbol = false
    let presentIndices = 0
    for (const key of keys) {
      if (key !== 'length') {
        const descriptor = getPayloadOwnPropertyDescriptor(value, key, path)
        if (typeof key === 'symbol' && descriptor !== undefined) {
          hasSymbol = true
        }
        if (descriptor !== undefined && ('get' in descriptor || 'set' in descriptor)) {
          hasAccessor = true
        }
        const index = typeof key === 'string' ? canonicalArrayIndex(key) : undefined
        if (
          typeof key === 'string' &&
          descriptor !== undefined &&
          'value' in descriptor &&
          index !== undefined &&
          index < length
        ) {
          presentIndices += 1
          values[index] = descriptor.value
        }
      }
    }
    if (hasSymbol) {
      return fail('INVALID_ARGUMENT', 'payload contains a symbol-keyed property.', { field: path })
    }
    if (hasAccessor) {
      return fail('INVALID_ARGUMENT', 'payload contains an accessor property.', { field: path })
    }
    if (presentIndices !== length) {
      return fail('INVALID_ARGUMENT', 'payload contains a sparse array.', {
        field: path,
      })
    }
    for (let index = length - 1; index >= 0; index -= 1) {
      stack.push({
        action: 'enter',
        depth: depth + 1,
        path: `${path}[${index}]`,
        target: { container: normalizedValues, key: index },
        value: values[index],
      })
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
      const keys = getPayloadOwnKeys(object, path)
      const values: unknown[] = []
      const remainingNodes = MAX_PAYLOAD_NODES - nodeCount.value
      let enumerableKeyCount = 0
      let hasAccessor = false
      let hasSymbol = false
      let overBudget = false
      for (const key of keys) {
        const descriptor = getPayloadOwnPropertyDescriptor(object, key, path)
        if (typeof key === 'symbol' && descriptor !== undefined) {
          hasSymbol = true
        }
        if (descriptor !== undefined && ('get' in descriptor || 'set' in descriptor)) {
          hasAccessor = true
        }
        if (typeof key === 'string' && descriptor?.enumerable === true && 'value' in descriptor) {
          if (enumerableKeyCount >= remainingNodes) {
            overBudget = true
          } else {
            keys[enumerableKeyCount] = key
            values[enumerableKeyCount] = descriptor.value
            enumerableKeyCount += 1
          }
        }
      }
      if (hasSymbol) {
        return fail('INVALID_ARGUMENT', 'payload contains a symbol-keyed property.', { field: path })
      }
      if (hasAccessor) {
        return fail('INVALID_ARGUMENT', 'payload contains an accessor property.', { field: path })
      }
      if (overBudget) {
        return fail('INVALID_ARGUMENT', `payload may contain at most ${MAX_PAYLOAD_NODES} JSON nodes.`, {
          field: path,
        })
      }
      const result: { [key: string]: unknown } = {}
      for (let index = 0; index < enumerableKeyCount; index += 1) {
        const key = keys[index]
        if (typeof key === 'string') {
          Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            value: values[index],
            writable: true,
          })
        }
      }
      orderPayloadObjectKeys(keys, enumerableKeyCount)
      seen.add(object)
      const normalizedResult = result as { [key: string]: JsonValue }
      const assigned = assignPayloadValue(target, normalizedResult)
      stack.push({ action: 'exit', value: object })
      for (let index = enumerableKeyCount - 1; index >= 0; index -= 1) {
        const key = keys[index]
        if (typeof key === 'string') {
          stack.push({
            action: 'enter',
            depth: depth + 1,
            path: `${path}.${key}`,
            target: { container: normalizedResult, key },
            value: result[key],
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

const portableArtifactSegments = (value: unknown, field: string) => {
  const path = requiredText(value, field)
  if (byteLength(path) > MAX_TEXT_BYTES || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    return fail('INVALID_ARGUMENT', `${field} is not a portable relative path.`, { field })
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
  return fail('INVALID_ARGUMENT', `${field} contains an unsafe path segment.`, { field })
}

export const validateArtifactPath = (value: unknown, kind: string, id: string, field = 'artifact') => {
  const artifact = portableArtifactSegments(value, field)
  if (
    artifact.segments[0] === ARTIFACTS_DIRECTORY_NAME &&
    artifact.segments[1] === kind &&
    artifact.segments[2] === id
  ) {
    return artifact.path
  }
  return fail('INVALID_ARGUMENT', `${field} must remain beneath the matching record artifact directory.`, { field })
}

const normalizeOptionalText = (value: unknown, field: string, maximumBytes: number) => {
  if (typeof value === 'string' && value.length > 0 && value === value.trim() && byteLength(value) <= maximumBytes) {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} must be a non-empty string within its size limit.`, { field })
}

const validateSupersedes = (value: unknown) => {
  const inspection = inspectDenseDataArray(value, 'supersedes', 'supersedes must be an array of strings.')
  if (inspection.length > OPERATION_BUDGETS.supersessionEdges.maximum) {
    return failBudget(
      'supersessionEdges',
      `supersedes may contain at most ${OPERATION_BUDGETS.supersessionEdges.maximum} record ids.`,
    )
  }
  return validateStringArray(readDenseDataArray(inspection), 'supersedes', (entry, index) =>
    validateId(entry, `supersedes[${index}]`),
  )
}

const optionalSupersedes = (value: unknown) => {
  if (value === undefined) {
    return
  }
  const inspection = inspectDenseDataArray(value, 'supersedes', 'supersedes must be an array of strings.')
  if (inspection.length > OPERATION_BUDGETS.supersessionEdges.maximum) {
    return failBudget(
      'supersessionEdges',
      `supersedes may contain at most ${OPERATION_BUDGETS.supersessionEdges.maximum} record ids.`,
    )
  }
  const items = readDenseDataArray(inspection)
  if (items.length === 0) {
    return
  }
  return validateStringArray(items, 'supersedes', (entry, index) => validateId(entry, `supersedes[${index}]`))
}

const optionalArtifacts = (value: unknown, kind: string, id: string) => {
  if (value === undefined) {
    return
  }
  const inspection = inspectDenseDataArray(value, 'artifacts', 'artifacts must be an array of strings.')
  if (inspection.length > MAX_ARTIFACTS) {
    return fail('INVALID_ARGUMENT', 'artifacts may contain at most 256 paths.', { field: 'artifacts' })
  }
  const items = readDenseDataArray(inspection)
  if (items.length === 0) {
    return
  }
  return validateStringArray(items, 'artifacts', (entry, index) =>
    validateArtifactPath(entry, kind, id, `artifacts[${index}]`),
  )
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

/** @internal */
export const projectParsedRecordFile = (record: BrainRecordFile): BrainRecordFile => ({
  createdAt: record.createdAt,
  id: record.id,
  kind: record.kind,
  payload: record.payload,
  source: record.source,
  subject: record.subject,
  ...(record.artifacts === undefined ? {} : { artifacts: record.artifacts }),
  ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
  ...(record.searchText === undefined ? {} : { searchText: record.searchText }),
  ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
})

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
    const inspection = inspectDenseDataArray(object.artifacts, 'artifacts', 'artifacts must be an array of strings.')
    if (inspection.length > MAX_ARTIFACTS) {
      return fail('INVALID_ARGUMENT', 'artifacts may contain at most 256 paths.', {
        field: 'artifacts',
      })
    }
    record.artifacts = validateStringArray(readDenseDataArray(inspection), 'artifacts', (entry, index) =>
      validateArtifactPath(entry, kind, id, `artifacts[${index}]`),
    )
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
  return projectParsedRecordFile(record)
}

export const formatRecordFile = (record: BrainRecordFile) => {
  const formatted = `${JSON.stringify(record, null, 2)}\n`
  if (byteLength(formatted) <= MAX_RECORD_BYTES) {
    return formatted
  }
  return fail('INVALID_ARGUMENT', 'The formatted record exceeds the 1 MiB limit.')
}
