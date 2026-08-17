import { fail, failBudget } from './errors.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'

const SEMANTIC_NODE_BYTES = 8

/** @internal */
export type ResponseBudgetKey = Extract<keyof typeof OPERATION_BUDGETS, `${string}ResponseBytes`>

/** @internal */
export type ResponseByteBudget = {
  charge: <Value>(value: Value) => Value
  chargeBytes: (bytes: number) => void
}

/** @internal */
export const logicalResponseBytes = (value: unknown): number => {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8')
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return SEMANTIC_NODE_BYTES
  }
  if (Array.isArray(value)) {
    return value.reduce((bytes, item) => bytes + logicalResponseBytes(item), SEMANTIC_NODE_BYTES)
  }
  if (
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    return Object.entries(value).reduce(
      (bytes, [key, item]) => bytes + Buffer.byteLength(key, 'utf8') + logicalResponseBytes(item),
      SEMANTIC_NODE_BYTES,
    )
  }
  return fail('INTERNAL_ERROR', 'Logical response accounting received an unsupported value.')
}

/** @internal */
export const createResponseByteBudget = (budgetKey: ResponseBudgetKey): ResponseByteBudget => {
  const budget = OPERATION_BUDGETS[budgetKey]
  let chargedBytes = 0

  const chargeBytes = (bytes: number) => {
    const nextBytes = chargedBytes + bytes
    if (nextBytes <= budget.maximum) {
      chargedBytes = nextBytes
      return
    }
    return failBudget(budgetKey, `response may contain at most ${budget.maximum} bytes.`)
  }

  const charge = <Value>(value: Value) => {
    chargeBytes(logicalResponseBytes(value))
    return value
  }

  return Object.freeze({ charge, chargeBytes })
}
