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
import { createRecordFile, formatRecordFile, parseRecordFile } from '../src/schema.ts'

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
  { envelope: 'root', field: 'root', name: 'root', parse: parseRootInput, value: {} },
  { envelope: 'listRecords', field: 'root', name: 'list', parse: parseListRecordsInput, value: {} },
  { envelope: 'showRecord', field: 'id', name: 'show', parse: parseShowRecordInput, value: { id: 'record-1' } },
  {
    envelope: 'searchRecords',
    field: 'query',
    name: 'full search',
    parse: parseFullSearchRecordsInput,
    value: { query: 'x' },
  },
  {
    envelope: 'searchRecords',
    field: 'query',
    name: 'compact search',
    parse: parseCompactSearchRecordsInput,
    value: { query: 'x' },
  },
  { envelope: 'gatherRecords', field: 'searches', name: 'gather', parse: parseGatherInput, value: {} },
  { envelope: 'initEncephalon', field: 'root', name: 'init', parse: parseInitInput, value: {} },
  { envelope: 'addRecord', field: 'payload', name: 'add', parse: parseAddRecordInput, value: validAddInput() },
] as const satisfies ReadonlyArray<{
  envelope: string
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
        assertInvalidInput(() => parserCase.parse(input), parserCase.envelope)
        assert.equal(getterCalls, 0, `${parserCase.name}.${field}`)
      }

      let setterCalls = 0
      const setterInput = { ...parserCase.value }
      Object.defineProperty(setterInput, parserCase.field, {
        enumerable: true,
        set: () => {
          setterCalls += 1
        },
      })
      assertInvalidInput(() => parserCase.parse(setterInput), parserCase.envelope)
      assert.equal(setterCalls, 0, `${parserCase.name}.${parserCase.field} setter`)
    }
  })

  test('accepts ordinary data objects but rejects unknown, non-enumerable, symbol, and class fields', () => {
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      root: '/repository',
    })
    assert.deepEqual(parseRootInput(nullPrototype), { root: '/repository' })

    const nonEnumerable = {}
    Object.defineProperty(nonEnumerable, 'root', { value: '/repository' })
    assertInvalidInput(() => parseRootInput(nonEnumerable), 'root')
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
      assertInvalidInput(() => parserCase.parse(symbolInput), parserCase.envelope)

      const unknownInput = { ...parserCase.value, unknownData: true }
      assertInvalidInput(() => parserCase.parse(unknownInput), parserCase.envelope)

      const nonEnumerableUnknownInput = { ...parserCase.value }
      Object.defineProperty(nonEnumerableUnknownInput, 'unknownData', { value: true })
      assertInvalidInput(() => parserCase.parse(nonEnumerableUnknownInput), parserCase.envelope)

      class InputEnvelope {}
      const classInput = Object.assign(new InputEnvelope(), parserCase.value)
      assertInvalidInput(() => parserCase.parse(classInput), parserCase.envelope)

      const nullPrototypeInput = Object.assign(Object.create(null) as Record<string, unknown>, parserCase.value)
      assert.doesNotThrow(() => parserCase.parse(nullPrototypeInput), parserCase.name)
    }
  })

  test('normalises reflection failures across every parser and never performs ordinary property gets', () => {
    for (const parserCase of parserCases) {
      for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
        let getCalls = 0
        const input = new Proxy(
          { root: '/repository', ...parserCase.value },
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
        assertInvalidInput(() => parserCase.parse(input), parserCase.envelope)
        assert.equal(getCalls, 0, `${parserCase.name}.${trap}`)
      }
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

  test('rejects envelope metadata changes during descriptor capture', () => {
    const keyTarget = { root: '/repository' }
    const changingKeys = new Proxy(keyTarget, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        Object.defineProperty(target, 'unknownData', { configurable: true, value: true })
        return descriptor
      },
    })
    assertInvalidInput(() => parseRootInput(changingKeys), 'root')

    const prototypeTarget = { root: '/repository' }
    const changingPrototype = new Proxy(prototypeTarget, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        Object.setPrototypeOf(target, { inherited: true })
        return descriptor
      },
    })
    assertInvalidInput(() => parseRootInput(changingPrototype), 'root')

    let getterCalls = 0
    let replaceDataProperty = true
    const descriptorTarget = { root: '/repository' }
    const changingDescriptor = new Proxy(descriptorTarget, {
      getOwnPropertyDescriptor: (target, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        if (key === 'root' && replaceDataProperty) {
          replaceDataProperty = false
          Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            get: () => {
              getterCalls += 1
              return '/replacement'
            },
          })
        }
        return descriptor
      },
    })
    assertInvalidInput(() => parseRootInput(changingDescriptor), 'root')
    assert.equal(getterCalls, 0)
  })

  test('keeps accepted add-record memory and canonical JSON structurally identical', () => {
    const artifact = '_artifacts/context/record-1/file.txt'
    const input = {
      ...validAddInput(),
      artifacts: [artifact],
      confidence: -0,
      searchText: 'canonical search text',
      supersedes: ['record-0'],
    }
    const parsed = parseAddRecordInput(input)
    const { recordDraft, ...normalizedInput } = parsed
    assert.deepEqual(normalizedInput, recordDraft)
    const createdAt = '2026-08-24T00:00:00.000Z'
    const canonical = JSON.parse(formatRecordFile(createRecordFile(recordDraft, createdAt))) as Record<string, unknown>
    assert.deepEqual(canonical, createRecordFile(recordDraft, createdAt))
    assert.deepEqual(canonical.artifacts, parsed.artifacts)
    assert.deepEqual(canonical.supersedes, parsed.supersedes)
  })
})

describe('dense data arrays', () => {
  test('rejects holes and indexed accessors across gather and record arrays without invocation', () => {
    const sparse = new Array<string>(2)
    sparse[1] = 'value'
    assertInvalidInput(() => parseGatherInput({ searches: sparse }), 'searches')
    assertInvalidInput(() => parseGatherInput({ shows: sparse }), 'shows')
    assertInvalidInput(() => parseAddRecordInput({ ...validAddInput(), supersedes: sparse }), 'supersedes')
    assertInvalidInput(() => parseAddRecordInput({ ...validAddInput(), artifacts: sparse }), 'artifacts')
    assertInvalidInput(() => parseRecordFile({ ...validRecordFile(), supersedes: sparse }), 'supersedes')
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

  test('rejects symbol, named, accessor, and non-enumerable array properties', () => {
    const dataExtra = ['x']
    Object.defineProperty(dataExtra, 'metadata', { value: 'rejected' })
    assertInvalidInput(() => parseGatherInput({ searches: dataExtra }), 'searches')

    const symbolArray = ['x']
    Object.defineProperty(symbolArray, Symbol('hostile input secret'), { value: true })
    assertInvalidInput(() => parseGatherInput({ searches: symbolArray }), 'searches')

    const crossRealmArray = runInNewContext('["x"]') as string[]
    assert.deepEqual(parseGatherInput({ searches: crossRealmArray }).searches, ['x'])

    const nonEnumerableIndex = ['x']
    Object.defineProperty(nonEnumerableIndex, 0, { enumerable: false, value: 'x' })
    assertInvalidInput(() => parseGatherInput({ searches: nonEnumerableIndex }), 'searches')

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

  test('rejects an array whose length changes during its descriptor snapshot', () => {
    let ownKeyCalls = 0
    const target = ['x']
    const unstable = new Proxy(target, {
      ownKeys: array => {
        ownKeyCalls += 1
        const keys = Reflect.ownKeys(array)
        array.push('y')
        return keys
      },
    })
    assertInvalidInput(() => parseGatherInput({ searches: unstable }), 'searches')
    assert.equal(ownKeyCalls, 2)
  })

  test('rejects array extras added during indexed descriptor capture', () => {
    const target = ['x']
    const unstable = new Proxy(target, {
      getOwnPropertyDescriptor: (array, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(array, key)
        if (key === '0') {
          Object.defineProperty(array, 'metadata', { configurable: true, value: 'added' })
        }
        return descriptor
      },
    })
    assertInvalidInput(() => parseGatherInput({ searches: unstable }), 'searches')

    let getterCalls = 0
    let replaceDataProperty = true
    const descriptorTarget = ['x']
    const changingDescriptor = new Proxy(descriptorTarget, {
      getOwnPropertyDescriptor: (array, key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(array, key)
        if (key === '0' && replaceDataProperty) {
          replaceDataProperty = false
          Object.defineProperty(array, key, {
            configurable: true,
            enumerable: true,
            get: () => {
              getterCalls += 1
              return 'replacement'
            },
          })
        }
        return descriptor
      },
    })
    assertInvalidInput(() => parseGatherInput({ searches: changingDescriptor }), 'searches')
    assert.equal(getterCalls, 0)
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
        budget: 'fullResultLimit',
        parse: (limit: number) => parseListRecordsInput({ limit }),
      },
      {
        budget: 'fullResultLimit',
        parse: (limit: number) => parseFullSearchRecordsInput({ limit, query: 'x' }),
      },
      {
        budget: 'compactResultLimit',
        parse: (limit: number) => parseCompactSearchRecordsInput({ limit, query: 'x' }),
      },
      {
        budget: 'compactResultLimit',
        parse: (limit: number) => parseGatherInput({ limit }),
      },
    ] as const satisfies ReadonlyArray<{
      budget: BudgetName
      parse: (limit: number) => { limit?: number }
    }>

    for (const limitCase of limitCases) {
      assert.equal(limitCase.parse(1).limit, 1)
      const compatibleLimits = [50, 100, 101, 999, 1000] as const
      for (const limit of compatibleLimits) {
        assert.equal(limitCase.parse(limit).limit, limit)
      }
      assertBudget(() => limitCase.parse(1001), {
        budget: limitCase.budget,
        field: 'limit',
        maximum: 1000,
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
