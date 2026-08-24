import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  parseAddRecordInput,
  parseCompactSearchRecordsInput,
  parseFullSearchRecordsInput,
  parseGatherInput,
  parseInitInput,
  parseListRecordsInput,
  parseRootInput,
  parseShowRecordInput,
} from '../src/api-input.ts'
import { EncephalonError, failBudget } from '../src/errors.ts'
import { OPERATION_BUDGETS } from '../src/operation-budgets.ts'
import { parseRecordFile } from '../src/schema.ts'

type BudgetName = keyof typeof OPERATION_BUDGETS

const assertBudget = (operation: () => unknown, expected: { budget: BudgetName; field: string; maximum: number }) => {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof EncephalonError)
    assert.equal(error.code, 'INVALID_ARGUMENT')
    assert.deepEqual(error.details, expected)
    return true
  })
}

const assertInvalidInput = (operation: () => unknown, field?: string) => {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof EncephalonError)
    assert.equal(error.code, 'INVALID_ARGUMENT')
    if (field !== undefined) {
      assert.equal(error.details?.field, field)
    }
    assert.equal(JSON.stringify(error).includes('hostile input secret'), false)
    return true
  })
}

const validAddInput = () => ({
  id: 'record-1',
  kind: 'context',
  payload: null,
  source: 'agent',
  subject: 'api.input',
})

const validRecordFile = () => ({
  ...validAddInput(),
  createdAt: '2026-08-24T00:00:00.000Z',
})

const parserCases = [
  { field: 'root', name: 'root', parse: parseRootInput, value: {} },
  { field: 'root', name: 'list', parse: parseListRecordsInput, value: {} },
  { field: 'id', name: 'show', parse: parseShowRecordInput, value: { id: 'record-1' } },
  { field: 'query', name: 'full search', parse: parseFullSearchRecordsInput, value: { query: 'x' } },
  { field: 'query', name: 'compact search', parse: parseCompactSearchRecordsInput, value: { query: 'x' } },
  { field: 'searches', name: 'gather', parse: parseGatherInput, value: {} },
  { field: 'root', name: 'init', parse: parseInitInput, value: {} },
  { field: 'payload', name: 'add', parse: parseAddRecordInput, value: validAddInput() },
] as const satisfies ReadonlyArray<{
  field: string
  name: string
  parse: (value: unknown) => unknown
  value: Record<string, unknown>
}>

describe('API input envelopes', () => {
  test('snapshots every public envelope without invoking recognised or unknown accessors', () => {
    for (const parserCase of parserCases) {
      for (const field of [parserCase.field, 'unknownAccessor']) {
        let getterCalls = 0
        const input = { ...parserCase.value }
        Object.defineProperty(input, field, {
          enumerable: true,
          get: () => {
            getterCalls += 1
            throw new Error('hostile input secret')
          },
        })
        assertInvalidInput(() => parserCase.parse(input), parserCase.name === 'root' ? 'root' : undefined)
        assert.equal(getterCalls, 0, `${parserCase.name}.${field}`)
      }
    }
  })

  test('accepts compatible data properties but rejects symbols and exotic prototypes', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      root: '/repository',
      unknownData: 'ignored',
    })
    Object.defineProperty(nullPrototype, 'anotherUnknownData', {
      value: true,
    })
    assert.deepEqual(parseRootInput(nullPrototype), { root: '/repository' })

    const nonEnumerable = {}
    Object.defineProperty(nonEnumerable, 'root', { value: '/repository' })
    assert.deepEqual(parseRootInput(nonEnumerable), { root: '/repository' })
    assert.deepEqual(parseRootInput(runInNewContext('({ root: "/repository" })')), { root: '/repository' })
    assertInvalidInput(
      () =>
        parseRootInput(
          Object.assign(Object.create(Object.create(null)) as Record<string, unknown>, { root: '/repository' }),
        ),
      'root',
    )
    const spoofedPrototype = Object.create(null) as Record<string, unknown>
    Object.defineProperty(spoofedPrototype, 'constructor', { value: Object })
    assertInvalidInput(
      () => parseRootInput(Object.assign(Object.create(spoofedPrototype) as Record<string, unknown>, nullPrototype)),
      'root',
    )
    assert.throws(() => parseRootInput([]), /root input must be an object\./)

    for (const parserCase of parserCases) {
      const symbolInput = { ...parserCase.value, [Symbol('hostile input secret')]: true }
      assertInvalidInput(() => parserCase.parse(symbolInput))

      const exoticInput = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, parserCase.value)
      assertInvalidInput(() => parserCase.parse(exoticInput))
    }
  })

  test('normalises reflection failures and never performs ordinary property gets', () => {
    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
      let getCalls = 0
      const input = new Proxy(
        { root: '/repository' },
        {
          get: () => {
            getCalls += 1
            throw new Error('hostile input secret')
          },
          [trap]: () => {
            throw new Error('hostile input secret')
          },
        },
      )
      assertInvalidInput(() => parseRootInput(input), 'root')
      assert.equal(getCalls, 0, trap)
    }

    let getCalls = 0
    const accepted = new Proxy(
      { root: '/repository' },
      {
        get: () => {
          getCalls += 1
          throw new Error('hostile input secret')
        },
      },
    )
    assert.deepEqual(parseRootInput(accepted), { root: '/repository' })
    assert.equal(getCalls, 0)
  })

  test('returns a recognised-field-only add snapshot', () => {
    const input = {
      ...validAddInput(),
      recordDraft: 'hostile',
      start: '/outside',
      unknownData: true,
    }
    Object.defineProperty(input, '__proto__', {
      enumerable: true,
      value: '/outside',
    })
    const parsed = parseAddRecordInput(input) as Record<string, unknown>
    assert.equal(Object.hasOwn(parsed, '__proto__'), false)
    assert.equal('start' in parsed, false)
    assert.equal('unknownData' in parsed, false)
    assert.notEqual(parsed.recordDraft, 'hostile')
  })

  test('bounds ignored envelope data properties before descriptor inspection', () => {
    const boundary = Object.fromEntries([
      ['root', '/repository'],
      ...Array.from({ length: 64 }, (_, index) => [`unknown-${index}`, index]),
    ])
    assert.deepEqual(parseRootInput(boundary), { root: '/repository' })

    let descriptorCalls = 0
    const overBudget = new Proxy(
      Object.fromEntries([
        ['root', '/repository'],
        ...Array.from({ length: 65 }, (_, index) => [`unknown-${index}`, index]),
      ]),
      {
        getOwnPropertyDescriptor: (target, key) => {
          descriptorCalls += 1
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
      },
    )
    assertInvalidInput(() => parseRootInput(overBudget), 'root')
    assert.equal(descriptorCalls, 0)
  })
})

describe('dense data arrays', () => {
  test('rejects holes and indexed accessors across gather and record arrays without invocation', () => {
    const sparse = new Array<string>(2)
    sparse[1] = 'value'
    assertInvalidInput(() => parseGatherInput({ searches: sparse }), 'searches')
    assertInvalidInput(() => parseGatherInput({ shows: sparse }), 'shows')
    assertInvalidInput(() => parseAddRecordInput({ ...validAddInput(), supersedes: sparse }), 'supersedes')
    assertInvalidInput(
      () =>
        parseRecordFile({
          ...validRecordFile(),
          artifacts: sparse,
        }),
      'artifacts',
    )

    for (const field of ['searches', 'shows', 'supersedes', 'artifacts'] as const) {
      let getterCalls = 0
      const array = ['value']
      Object.defineProperty(array, 0, {
        enumerable: true,
        get: () => {
          getterCalls += 1
          throw new Error('hostile input secret')
        },
      })
      const operations = {
        artifacts: () => parseRecordFile({ ...validRecordFile(), artifacts: array }),
        searches: () => parseGatherInput({ searches: array }),
        shows: () => parseGatherInput({ shows: array }),
        supersedes: () => parseAddRecordInput({ ...validAddInput(), supersedes: array }),
      }
      const operation = operations[field]
      assertInvalidInput(operation, field)
      assert.equal(getterCalls, 0, field)
    }
  })

  test('rejects symbols and accessor extras while ignoring ordinary string data extras', () => {
    const dataExtra = ['x']
    Object.defineProperty(dataExtra, 'metadata', { value: 'ignored' })
    assert.deepEqual(parseGatherInput({ searches: dataExtra }).searches, ['x'])

    const symbolArray = ['x']
    Object.defineProperty(symbolArray, Symbol('hostile input secret'), { value: true })
    assertInvalidInput(() => parseGatherInput({ searches: symbolArray }), 'searches')

    const crossRealmArray = runInNewContext('["x"]') as string[]
    assert.deepEqual(parseGatherInput({ searches: crossRealmArray }).searches, ['x'])

    const nonEnumerableIndex = ['x']
    Object.defineProperty(nonEnumerableIndex, 0, { value: 'x' })
    assert.deepEqual(parseGatherInput({ searches: nonEnumerableIndex }).searches, ['x'])

    let getterCalls = 0
    const accessorExtra = ['x']
    Object.defineProperty(accessorExtra, 'metadata', {
      get: () => {
        getterCalls += 1
        throw new Error('hostile input secret')
      },
    })
    assertInvalidInput(() => parseGatherInput({ searches: accessorExtra }), 'searches')
    assert.equal(getterCalls, 0)
  })

  test('bounds ignored array data properties before descriptor inspection', () => {
    const boundary = ['x']
    for (const index of Array.from({ length: 64 }, (_, value) => value)) {
      Object.defineProperty(boundary, `unknown-${index}`, { value: index })
    }
    assert.deepEqual(parseGatherInput({ searches: boundary }).searches, ['x'])

    const target = ['x']
    for (const index of Array.from({ length: 65 }, (_, value) => value)) {
      Object.defineProperty(target, `unknown-${index}`, { value: index })
    }
    let descriptorCalls = 0
    const overBudget = new Proxy(target, {
      getOwnPropertyDescriptor: (array, key) => {
        descriptorCalls += 1
        return Reflect.getOwnPropertyDescriptor(array, key)
      },
    })
    assertInvalidInput(() => parseGatherInput({ searches: overBudget }), 'searches')
    assert.equal(descriptorCalls, 1)
  })

  test('normalises array inspection failures and checks count budgets before own keys', () => {
    const hostile = new Proxy(['x'], {
      ownKeys: () => {
        throw new Error('hostile input secret')
      },
    })
    assertInvalidInput(() => parseGatherInput({ searches: hostile }), 'searches')

    let ownKeyCalls = 0
    const oversized = new Proxy(
      Array.from({ length: 17 }, () => 'x'),
      {
        ownKeys: target => {
          ownKeyCalls += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    assertBudget(() => parseGatherInput({ searches: oversized }), {
      budget: 'gatherSearches',
      field: 'searches',
      maximum: 16,
    })
    assert.equal(ownKeyCalls, 0)
  })

  test('preserves cross-array budget precedence and reports indexed item paths', () => {
    const sparseSearches = new Array<string>(2)
    sparseSearches[1] = 'y'
    assertBudget(
      () =>
        parseGatherInput({
          searches: sparseSearches,
          shows: Array.from({ length: 65 }, () => 'valid-id'),
        }),
      { budget: 'gatherShows', field: 'shows', maximum: 64 },
    )

    assertInvalidInput(() => parseGatherInput({ shows: ['valid-id', '../bad'] }), 'shows[1]')
    assertInvalidInput(
      () => parseAddRecordInput({ ...validAddInput(), supersedes: ['valid-id', '../bad'] }),
      'supersedes[1]',
    )
    const validArtifact = '_artifacts/context/record-1/file.txt'
    assertInvalidInput(
      () => parseAddRecordInput({ ...validAddInput(), artifacts: [validArtifact, '../bad'] }),
      'artifacts[1]',
    )
    assertInvalidInput(
      () => parseRecordFile({ ...validRecordFile(), artifacts: [validArtifact, '../bad'] }),
      'artifacts[1]',
    )
    assertInvalidInput(
      () => parseRecordFile({ ...validRecordFile(), supersedes: ['valid-id', '../bad'] }),
      'supersedes[1]',
    )
  })

  test('checks schema array budgets before own-key enumeration', () => {
    let supersedesOwnKeyCalls = 0
    const supersedes = new Proxy(
      Array.from({ length: 1001 }, () => 'valid-id'),
      {
        ownKeys: target => {
          supersedesOwnKeyCalls += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    assertBudget(() => parseAddRecordInput({ ...validAddInput(), supersedes }), {
      budget: 'supersessionEdges',
      field: 'supersedes',
      maximum: 1000,
    })
    assert.equal(supersedesOwnKeyCalls, 0)

    let recordSupersedesOwnKeyCalls = 0
    const recordSupersedes = new Proxy(
      Array.from({ length: 1001 }, () => 'valid-id'),
      {
        ownKeys: target => {
          recordSupersedesOwnKeyCalls += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    assertBudget(() => parseRecordFile({ ...validRecordFile(), supersedes: recordSupersedes }), {
      budget: 'supersessionEdges',
      field: 'supersedes',
      maximum: 1000,
    })
    assert.equal(recordSupersedesOwnKeyCalls, 0)

    let artifactOwnKeyCalls = 0
    const artifacts = new Proxy(
      Array.from({ length: 257 }, () => 'invalid'),
      {
        ownKeys: target => {
          artifactOwnKeyCalls += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    assertInvalidInput(() => parseRecordFile({ ...validRecordFile(), artifacts }), 'artifacts')
    assert.equal(artifactOwnKeyCalls, 0)

    let addArtifactOwnKeyCalls = 0
    const addArtifacts = new Proxy(
      Array.from({ length: 257 }, () => 'invalid'),
      {
        ownKeys: target => {
          addArtifactOwnKeyCalls += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    assertInvalidInput(() => parseAddRecordInput({ ...validAddInput(), artifacts: addArtifacts }), 'artifacts')
    assert.equal(addArtifactOwnKeyCalls, 0)
  })
})

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
