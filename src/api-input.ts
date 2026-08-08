import { fail } from './errors.ts'
import { createRecordFile, validateId, validateKind } from './schema.ts'
import type {
  AddRecordInput,
  BrainRecordFile,
  GatherInput,
  InitEncephalonInput,
  ListRecordsInput,
  RootInput,
  SearchRecordsInput,
  ShowRecordInput,
} from './types.ts'

export type ParsedAddRecordInput = AddRecordInput & {
  recordFile: BrainRecordFile
}

const MAX_TEXT_BYTES = 1024

const objectInput = (value: unknown, name: string): Record<string, unknown> => {
  if (value === undefined) {
    return {}
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return fail('INVALID_ARGUMENT', `${name} input must be an object.`, { field: name })
}

const optionalRoot = (value: unknown) => {
  if (value === undefined) {
    return
  }
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  return fail('INVALID_ARGUMENT', 'root must be a non-empty string.', { field: 'root' })
}

const optionalBoolean = (value: unknown, field: string) => {
  if (value === undefined) {
    return
  }
  if (typeof value === 'boolean') {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} must be a boolean.`, { field })
}

export const optionalLimit = (value: unknown) => {
  if (value === undefined) {
    return
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000) {
    return value
  }
  return fail('INVALID_ARGUMENT', 'limit must be an integer between 1 and 1000.', { field: 'limit' })
}

const optionalText = (value: unknown, field: string) => {
  if (value === undefined) {
    return
  }
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES
  ) {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} must be a non-empty string of at most 1024 UTF-8 bytes.`, { field })
}

const optionalQuery = (value: unknown, field: string) => {
  if (value === undefined) {
    return
  }
  if (typeof value === 'string') {
    return value
  }
  return fail('INVALID_ARGUMENT', `${field} must be a string.`, { field })
}

const optionalStringArray = (value: unknown, field: string, item: (value: unknown) => string) => {
  if (value === undefined) {
    return
  }
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
    return value.map(item)
  }
  return fail('INVALID_ARGUMENT', `${field} must be an array of strings.`, { field })
}

const rootProperties = (input: Record<string, unknown>): RootInput => {
  const root = optionalRoot(input.root)
  return root === undefined ? {} : { root }
}

export const parseRootInput = (value: unknown = {}, name = 'root'): RootInput =>
  rootProperties(objectInput(value, name))

export const parseListRecordsInput = (value: unknown = {}): ListRecordsInput => {
  const input = objectInput(value, 'listRecords')
  const root = rootProperties(input)
  const kind = input.kind === undefined ? undefined : validateKind(input.kind)
  const subject = optionalText(input.subject, 'subject')
  const includeSuperseded = optionalBoolean(input.includeSuperseded, 'includeSuperseded')
  const limit = optionalLimit(input.limit)
  return {
    ...root,
    ...(kind === undefined ? {} : { kind }),
    ...(subject === undefined ? {} : { subject }),
    ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
    ...(limit === undefined ? {} : { limit }),
  }
}

export const parseShowRecordInput = (value: unknown): ShowRecordInput => {
  const input = objectInput(value, 'showRecord')
  const root = rootProperties(input)
  const activeOnly = optionalBoolean(input.activeOnly, 'activeOnly')
  return {
    ...root,
    ...(activeOnly === undefined ? {} : { activeOnly }),
    id: validateId(input.id),
  }
}

export const parseSearchRecordsInput = (value: unknown): SearchRecordsInput => {
  const input = objectInput(value, 'searchRecords')
  const root = rootProperties(input)
  const kind = input.kind === undefined ? undefined : validateKind(input.kind)
  const includeSuperseded = optionalBoolean(input.includeSuperseded, 'includeSuperseded')
  const limit = optionalLimit(input.limit)
  const query = optionalQuery(input.query, 'query')
  if (query === undefined) {
    return fail('INVALID_ARGUMENT', 'query must be a string.', { field: 'query' })
  }
  return {
    ...root,
    query,
    ...(kind === undefined ? {} : { kind }),
    ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
    ...(limit === undefined ? {} : { limit }),
  }
}

export const parseGatherInput = (value: unknown): GatherInput => {
  const input = objectInput(value, 'gatherRecords')
  const root = rootProperties(input)
  const kind = input.kind === undefined ? undefined : validateKind(input.kind)
  const includeSuperseded = optionalBoolean(input.includeSuperseded, 'includeSuperseded')
  const hydrate = optionalBoolean(input.hydrate, 'hydrate')
  const limit = optionalLimit(input.limit)
  const searches = optionalStringArray(input.searches, 'searches', entry => optionalQuery(entry, 'searches') ?? '')
  const shows = optionalStringArray(input.shows, 'shows', validateId)
  return {
    ...root,
    ...(searches === undefined ? {} : { searches }),
    ...(shows === undefined ? {} : { shows }),
    ...(kind === undefined ? {} : { kind }),
    ...(includeSuperseded === undefined ? {} : { includeSuperseded }),
    ...(hydrate === undefined ? {} : { hydrate }),
    ...(limit === undefined ? {} : { limit }),
  }
}

export const parseInitInput = (value: unknown = {}): InitEncephalonInput => {
  const input = objectInput(value, 'initEncephalon')
  const root = rootProperties(input)
  const refreshBaseline = optionalBoolean(input.refreshBaseline, 'refreshBaseline')
  const remove = optionalBoolean(input.remove, 'remove')
  return {
    ...root,
    ...(refreshBaseline === undefined ? {} : { refreshBaseline }),
    ...(remove === undefined ? {} : { remove }),
  }
}

export const parseAddRecordInput = (value: unknown): ParsedAddRecordInput => {
  const input = objectInput(value, 'addRecord') as AddRecordInput
  const root = rootProperties(input)
  return {
    ...input,
    ...root,
    recordFile: createRecordFile(input),
  }
}
