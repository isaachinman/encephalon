import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  parseCompactSearchRecordsInput,
  parseFullSearchRecordsInput,
  parseGatherInput,
  parseListRecordsInput,
} from '../src/api-input.ts'
import { EncephalonError, failBudget } from '../src/errors.ts'
import { OPERATION_BUDGETS } from '../src/operation-budgets.ts'

type BudgetName = keyof typeof OPERATION_BUDGETS

const assertBudget = (operation: () => unknown, expected: { budget: BudgetName; field: string; maximum: number }) => {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof EncephalonError)
    assert.equal(error.code, 'INVALID_ARGUMENT')
    assert.deepEqual(error.details, expected)
    return true
  })
}

describe('API input budgets', () => {
  test('derives bounded error details from a typed budget key', () => {
    assertBudget(() => failBudget('gatherShows', 'gather is over budget.'), {
      budget: 'gatherShows',
      field: 'shows',
      maximum: 64,
    })
  })

  test('freezes the budget authority and every nested specification at runtime', () => {
    assert.equal(Object.isFrozen(OPERATION_BUDGETS), true)
    assert.equal(
      Object.values(OPERATION_BUDGETS).every(budget => Object.isFrozen(budget)),
      true,
    )
  })

  test('applies operation-specific result limits', () => {
    const limitCases = [
      {
        accept: 50,
        budget: 'fullResultLimit',
        maximum: 50,
        parse: (limit: number) => parseListRecordsInput({ limit }),
      },
      {
        accept: 50,
        budget: 'fullResultLimit',
        maximum: 50,
        parse: (limit: number) => parseFullSearchRecordsInput({ limit, query: 'x' }),
      },
      {
        accept: 100,
        budget: 'compactResultLimit',
        maximum: 100,
        parse: (limit: number) => parseCompactSearchRecordsInput({ limit, query: 'x' }),
      },
      {
        accept: 100,
        budget: 'compactResultLimit',
        maximum: 100,
        parse: (limit: number) => parseGatherInput({ limit }),
      },
    ] as const satisfies ReadonlyArray<{
      accept: number
      budget: BudgetName
      maximum: number
      parse: (limit: number) => { limit?: number }
    }>

    for (const limitCase of limitCases) {
      assert.equal(limitCase.parse(1).limit, 1)
      assert.equal(limitCase.parse(limitCase.accept).limit, limitCase.accept)
      assertBudget(() => limitCase.parse(limitCase.maximum + 1), {
        budget: limitCase.budget,
        field: 'limit',
        maximum: limitCase.maximum,
      })
    }
  })

  test('rejects oversized gather arrays before validating their items', () => {
    assertBudget(() => parseGatherInput({ searches: [42, ...Array.from({ length: 16 }, () => 'x')] }), {
      budget: 'gatherSearches',
      field: 'searches',
      maximum: 16,
    })
    assertBudget(
      () => parseGatherInput({ shows: ['not a valid id!', ...Array.from({ length: 64 }, () => 'valid-id')] }),
      { budget: 'gatherShows', field: 'shows', maximum: 64 },
    )
    assertBudget(
      () =>
        parseGatherInput({
          searches: [42],
          shows: Array.from({ length: 65 }, () => 'valid-id'),
        }),
      { budget: 'gatherShows', field: 'shows', maximum: 64 },
    )
  })
})
