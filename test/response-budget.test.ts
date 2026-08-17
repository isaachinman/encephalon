import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { EncephalonError } from '../src/errors.ts'
import { OPERATION_BUDGETS } from '../src/operation-budgets.ts'
import { createResponseByteBudget, logicalResponseBytes, type ResponseBudgetKey } from '../src/response-budget.ts'

const assertBudgetFailure = (budgetKey: ResponseBudgetKey) => {
  const budget = createResponseByteBudget(budgetKey)
  const { maximum } = OPERATION_BUDGETS[budgetKey]

  budget.chargeBytes(maximum)

  assert.throws(
    () => budget.chargeBytes(1),
    (error: unknown) => {
      assert.ok(error instanceof EncephalonError)
      assert.equal(error.code, 'INVALID_ARGUMENT')
      assert.deepEqual(error.details, {
        budget: budgetKey,
        field: 'response',
        maximum: 4 * 1024 * 1024,
      })
      return true
    },
  )
}

describe('logical response bytes', () => {
  test('counts UTF-8 text, semantic nodes, object keys, and nested values', () => {
    const cases = [
      { expected: 5, name: 'ASCII string', value: 'hello' },
      { expected: 6, name: 'multibyte string', value: 'é🙂' },
      { expected: 8, name: 'number', value: 42 },
      { expected: 8, name: 'boolean', value: true },
      { expected: 8, name: 'null', value: null },
      { expected: 8, name: 'empty array', value: [] },
      { expected: 8, name: 'empty object', value: {} },
      { expected: 11, name: 'multibyte object key', value: { é: 'x' } },
      {
        expected: 52,
        name: 'nested value',
        value: { items: ['é', 42, null], ready: false },
      },
    ] as const

    for (const example of cases) {
      assert.equal(logicalResponseBytes(example.value), example.expected, example.name)
    }
  })

  test('counts reordered objects equally', () => {
    const reordered = Object.fromEntries([
      ['beta', 42],
      ['alpha', ['é', null]],
    ])

    assert.equal(logicalResponseBytes({ alpha: ['é', null], beta: 42 }), logicalResponseBytes(reordered))
  })

  test('rejects unsupported internal values', () => {
    const unsupportedValues = [undefined, 1n, Symbol('response'), new Date(0)]

    for (const value of unsupportedValues) {
      assert.throws(
        () => logicalResponseBytes(value),
        (error: unknown) => {
          assert.ok(error instanceof EncephalonError)
          assert.equal(error.code, 'INTERNAL_ERROR')
          return true
        },
      )
    }
  })
})

describe('response byte budgets', () => {
  test('accepts the exact compact-response boundary and rejects one byte over', () => {
    assertBudgetFailure('compactResponseBytes')
  })

  test('accepts the exact gather-response boundary and rejects one byte over', () => {
    assertBudgetFailure('gatherResponseBytes')
  })

  test('charges logical values cumulatively and returns the charged value', () => {
    const budget = createResponseByteBudget('compactResponseBytes')
    const value = { result: 'é' }

    assert.equal(budget.charge(value), value)
    budget.chargeBytes(OPERATION_BUDGETS.compactResponseBytes.maximum - 16)
    assert.throws(() => budget.chargeBytes(1), EncephalonError)
  })
})
