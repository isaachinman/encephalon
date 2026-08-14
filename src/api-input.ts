import { fail, failBudget } from './errors.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import type { ValidatedAddRecordInput } from './schema.ts'
import { validateAddRecordInput, validateId, validateKind } from './schema.ts'
import type {
  AddRecordInput,
  GatherInput,
  InitEncephalonInput,
  ListRecordsInput,
  RootInput,
  SearchRecordsInput,
  ShowRecordInput,
} from './types.ts'

/** @internal */
export type ParsedAddRecordInput = AddRecordInput & {
  recordDraft: ValidatedAddRecordInput
}

const MAX_TEXT_BYTES = 1024

type OperationBudgetKey = keyof typeof OPERATION_BUDGETS

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

type ResultLimitBudgetKey = Extract<OperationBudgetKey, 'compactResultLimit' | 'fullResultLimit'>

const optionalLimit = (value: unknown, budgetKey: ResultLimitBudgetKey) => {
  if (value !== undefined) {
    const budget = OPERATION_BUDGETS[budgetKey]
    if (typeof value === 'number' && Number.isInteger(value) && value >= budget.minimum && value <= budget.maximum) {
      return value
    }
    return failBudget(budgetKey, `limit must be an integer between ${budget.minimum} and ${budget.maximum}.`)
  }
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

type GatherArrayBudgetKey = Extract<OperationBudgetKey, 'gatherSearches' | 'gatherShows'>

const optionalBoundedArray = (value: unknown, budgetKey: GatherArrayBudgetKey) => {
  if (value !== undefined) {
    const budget = OPERATION_BUDGETS[budgetKey]
    if (!Array.isArray(value)) {
      return fail('INVALID_ARGUMENT', `${budget.field} must be an array of strings.`, { field: budget.field })
    }
    if (value.length > budget.maximum) {
      return failBudget(budgetKey, `gather may contain at most ${budget.maximum} ${budget.field}.`)
    }
    return value
  }
}

const mapBoundedStringArray = (value: unknown[], budgetKey: GatherArrayBudgetKey, item: (value: unknown) => string) => {
  const budget = OPERATION_BUDGETS[budgetKey]
  if (value.every(entry => typeof entry === 'string')) {
    return value.map(item)
  }
  return fail('INVALID_ARGUMENT', `${budget.field} must be an array of strings.`, { field: budget.field })
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
  const limit = optionalLimit(input.limit, 'fullResultLimit')
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

const parseSearchRecordsInputWithBudget = (value: unknown, budgetKey: ResultLimitBudgetKey): SearchRecordsInput => {
  const input = objectInput(value, 'searchRecords')
  const root = rootProperties(input)
  const kind = input.kind === undefined ? undefined : validateKind(input.kind)
  const includeSuperseded = optionalBoolean(input.includeSuperseded, 'includeSuperseded')
  const limit = optionalLimit(input.limit, budgetKey)
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

export const parseFullSearchRecordsInput = (value: unknown): SearchRecordsInput =>
  parseSearchRecordsInputWithBudget(value, 'fullResultLimit')

export const parseCompactSearchRecordsInput = (value: unknown): SearchRecordsInput =>
  parseSearchRecordsInputWithBudget(value, 'compactResultLimit')

export const parseGatherInput = (value: unknown): GatherInput => {
  const input = objectInput(value, 'gatherRecords')
  const root = rootProperties(input)
  const kind = input.kind === undefined ? undefined : validateKind(input.kind)
  const includeSuperseded = optionalBoolean(input.includeSuperseded, 'includeSuperseded')
  const hydrate = optionalBoolean(input.hydrate, 'hydrate')
  const limit = optionalLimit(input.limit, 'compactResultLimit')
  const unvalidatedSearches = optionalBoundedArray(input.searches, 'gatherSearches')
  const unvalidatedShows = optionalBoundedArray(input.shows, 'gatherShows')
  const searches =
    unvalidatedSearches === undefined
      ? undefined
      : mapBoundedStringArray(unvalidatedSearches, 'gatherSearches', entry => optionalQuery(entry, 'searches') ?? '')
  const shows =
    unvalidatedShows === undefined ? undefined : mapBoundedStringArray(unvalidatedShows, 'gatherShows', validateId)
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

/** @internal */
export const parseAddRecordInput = (value: unknown): ParsedAddRecordInput => {
  const input = objectInput(value, 'addRecord') as AddRecordInput
  const root = rootProperties(input)
  return {
    ...input,
    ...root,
    recordDraft: validateAddRecordInput(input),
  }
}
