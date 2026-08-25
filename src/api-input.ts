import { type DenseDataArrayInspection, inspectDenseDataArray, readDenseDataArray } from './dense-data-array.ts'
import { fail, failBudget } from './errors.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import {
  guardedGetOwnPropertyDescriptor,
  guardedGetPrototypeOf,
  guardedIsArray,
  guardedOwnKeys,
  PROPERTY_INSPECTION_FAILED,
} from './property-inspection.ts'
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

const failObjectStructure = (name: string): never =>
  fail('INVALID_ARGUMENT', `${name} input must be a plain data object.`, { field: name })

const failObjectType = (name: string): never =>
  fail('INVALID_ARGUMENT', `${name} input must be an object.`, { field: name })

const OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object)

const isObjectConstructorForPrototype = (value: unknown, prototype: object) => {
  if (typeof value === 'function') {
    try {
      if (Function.prototype.toString.call(value) === OBJECT_CONSTRUCTOR_SOURCE) {
        const prototypeDescriptor = guardedGetOwnPropertyDescriptor(value, 'prototype')
        return (
          prototypeDescriptor !== PROPERTY_INSPECTION_FAILED &&
          prototypeDescriptor !== undefined &&
          'value' in prototypeDescriptor &&
          prototypeDescriptor.value === prototype
        )
      }
    } catch {
      return false
    }
  }
  return false
}

const hasPlainObjectPrototype = (value: object) => {
  const prototype = guardedGetPrototypeOf(value)
  if (prototype === null) {
    return true
  }
  if (prototype !== PROPERTY_INSPECTION_FAILED && guardedGetPrototypeOf(prototype) === null) {
    const constructorDescriptor = guardedGetOwnPropertyDescriptor(prototype, 'constructor')
    if (
      constructorDescriptor !== PROPERTY_INSPECTION_FAILED &&
      constructorDescriptor !== undefined &&
      'value' in constructorDescriptor
    ) {
      return isObjectConstructorForPrototype(constructorDescriptor.value, prototype)
    }
  }
  return false
}

const objectInput = (value: unknown, name: string, recognizedKeys: ReadonlySet<string>): Record<string, unknown> => {
  if (value === undefined) {
    return {}
  }
  if (value !== null && typeof value === 'object') {
    const object = value as object
    const array = guardedIsArray(object)
    if (array === true) {
      return failObjectType(name)
    }
    if (array === false && hasPlainObjectPrototype(object)) {
      const keys = guardedOwnKeys(object)
      if (
        keys !== PROPERTY_INSPECTION_FAILED &&
        keys.length <= recognizedKeys.size &&
        keys.every((key): key is string => typeof key === 'string' && recognizedKeys.has(key))
      ) {
        return keys.reduce<Record<string, unknown>>((snapshot, key) => {
          const descriptor = guardedGetOwnPropertyDescriptor(object, key)
          if (
            descriptor !== PROPERTY_INSPECTION_FAILED &&
            descriptor !== undefined &&
            'value' in descriptor &&
            descriptor.enumerable === true
          ) {
            Object.defineProperty(snapshot, key, {
              enumerable: true,
              value: descriptor.value,
              writable: true,
            })
            return snapshot
          }
          return failObjectStructure(name)
        }, {})
      }
    }
    return failObjectStructure(name)
  }
  return failObjectType(name)
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

const boundedArray = (value: unknown, budgetKey: GatherArrayBudgetKey) => {
  const budget = OPERATION_BUDGETS[budgetKey]
  const inspection = inspectDenseDataArray(value, budget.field, `${budget.field} must be an array of strings.`)
  if (inspection.length > budget.maximum) {
    return failBudget(budgetKey, `gather may contain at most ${budget.maximum} ${budget.field}.`)
  }
  return inspection
}

const mapBoundedStringArray = (
  inspection: DenseDataArrayInspection,
  budgetKey: GatherArrayBudgetKey,
  item: (value: unknown, index: number) => string,
) => {
  const budget = OPERATION_BUDGETS[budgetKey]
  const value = readDenseDataArray(inspection)
  if (value.every(entry => typeof entry === 'string')) {
    return value.map(item)
  }
  return fail('INVALID_ARGUMENT', `${budget.field} must be an array of strings.`, { field: budget.field })
}

const ROOT_KEYS = new Set(Object.keys({ root: true } satisfies Record<keyof RootInput, true>))
const LIST_KEYS = new Set(
  Object.keys({
    includeSuperseded: true,
    kind: true,
    limit: true,
    root: true,
    subject: true,
  } satisfies Record<keyof ListRecordsInput, true>),
)
const SHOW_KEYS = new Set(
  Object.keys({ activeOnly: true, id: true, root: true } satisfies Record<keyof ShowRecordInput, true>),
)
const SEARCH_KEYS = new Set(
  Object.keys({
    includeSuperseded: true,
    kind: true,
    limit: true,
    query: true,
    root: true,
  } satisfies Record<keyof SearchRecordsInput, true>),
)
const GATHER_KEYS = new Set(
  Object.keys({
    hydrate: true,
    includeSuperseded: true,
    kind: true,
    limit: true,
    root: true,
    searches: true,
    shows: true,
  } satisfies Record<keyof GatherInput, true>),
)
const INIT_KEYS = new Set(
  Object.keys({ refreshBaseline: true, remove: true, root: true } satisfies Record<keyof InitEncephalonInput, true>),
)
const ADD_KEYS = new Set(
  Object.keys({
    artifacts: true,
    confidence: true,
    id: true,
    kind: true,
    payload: true,
    root: true,
    searchText: true,
    source: true,
    subject: true,
    supersedes: true,
  } satisfies Record<keyof AddRecordInput, true>),
)

const rootProperties = (input: Record<string, unknown>): RootInput => {
  const root = optionalRoot(input.root)
  return root === undefined ? {} : { root }
}

export const parseRootInput = (value: unknown = {}, name = 'root'): RootInput =>
  rootProperties(objectInput(value, name, ROOT_KEYS))

export const parseListRecordsInput = (value: unknown = {}): ListRecordsInput => {
  const input = objectInput(value, 'listRecords', LIST_KEYS)
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
  const input = objectInput(value, 'showRecord', SHOW_KEYS)
  const root = rootProperties(input)
  const activeOnly = optionalBoolean(input.activeOnly, 'activeOnly')
  return {
    ...root,
    ...(activeOnly === undefined ? {} : { activeOnly }),
    id: validateId(input.id),
  }
}

const parseSearchRecordsInputWithBudget = (value: unknown, budgetKey: ResultLimitBudgetKey): SearchRecordsInput => {
  const input = objectInput(value, 'searchRecords', SEARCH_KEYS)
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
  const input = objectInput(value, 'gatherRecords', GATHER_KEYS)
  const root = rootProperties(input)
  const kind = input.kind === undefined ? undefined : validateKind(input.kind)
  const includeSuperseded = optionalBoolean(input.includeSuperseded, 'includeSuperseded')
  const hydrate = optionalBoolean(input.hydrate, 'hydrate')
  const limit = optionalLimit(input.limit, 'compactResultLimit')
  const unvalidatedSearches = input.searches === undefined ? undefined : boundedArray(input.searches, 'gatherSearches')
  const unvalidatedShows = input.shows === undefined ? undefined : boundedArray(input.shows, 'gatherShows')
  const searches =
    unvalidatedSearches === undefined
      ? undefined
      : mapBoundedStringArray(
          unvalidatedSearches,
          'gatherSearches',
          (entry, index) => optionalQuery(entry, `searches[${index}]`) ?? '',
        )
  const shows =
    unvalidatedShows === undefined
      ? undefined
      : mapBoundedStringArray(unvalidatedShows, 'gatherShows', (entry, index) => validateId(entry, `shows[${index}]`))
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
  const input = objectInput(value, 'initEncephalon', INIT_KEYS)
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
  const input = objectInput(value, 'addRecord', ADD_KEYS) as AddRecordInput
  const root = rootProperties(input)
  const recordDraft = validateAddRecordInput(input)
  return {
    ...root,
    ...recordDraft,
    recordDraft,
  }
}
