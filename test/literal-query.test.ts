import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { EncephalonError } from '../src/errors.ts'
import { literalMatchQuery } from '../src/literal-query.ts'

describe('literal Unicode queries', () => {
  test('normalises and quotes Unicode terms without exposing FTS syntax', () => {
    const cases = [
      { expected: '"Café"', query: 'Cafe\u0301' },
      { expected: '"한글"', query: '한글'.normalize('NFD') },
      {
        expected: '"Ελληνικά" AND "Русский" AND "مرحبا" AND "שלום" AND "中文" AND "किताब"',
        query: 'Ελληνικά Русский مرحبا שלום 中文 किताब',
      },
      { expected: '"snake__case" AND "version2"', query: '__snake__case__ version2' },
      { expected: '"repeat" AND "repeat"', query: 'repeat repeat' },
      {
        expected: '"alpha" AND "OR" AND "beta" AND "gamma" AND "NOT" AND "delta" AND "NEAR"',
        query: 'alpha OR beta* "gamma" -NOT delta NEAR()',
      },
      { expected: '', query: '\u0301 _ __ * " - + ^ : () {} []\u0000' },
    ] as const

    for (const example of cases) {
      assert.equal(literalMatchQuery(example.query), example.expected, example.query)
    }
  })

  test('enforces the byte budget before normalization', () => {
    assert.throws(
      () => literalMatchQuery('e\u0301'.repeat(342)),
      (error: unknown) => {
        assert.ok(error instanceof EncephalonError)
        assert.equal(error.code, 'INVALID_ARGUMENT')
        assert.deepEqual(error.details, {
          budget: 'queryBytes',
          field: 'query',
          maximum: 1024,
        })
        return true
      },
    )
  })
})
