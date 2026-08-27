export const RESULT_LIMIT_CASES = Object.freeze([50, 100, 101, 999, 1000, 1001] as const)

export const RESULT_LIMIT_OPERATIONS = Object.freeze([
  Object.freeze({ budget: 'fullResultLimit', kind: 'full', name: 'list' }),
  Object.freeze({ budget: 'fullResultLimit', kind: 'full', name: 'search' }),
  Object.freeze({ budget: 'compactResultLimit', kind: 'compact', name: 'searchCompact' }),
  Object.freeze({ budget: 'compactResultLimit', kind: 'compact', name: 'gather' }),
] as const)

type NormaliseIntrinsics = Readonly<{
  entries: (value: object) => [string, unknown][]
  fromEntries: (entries: Iterable<readonly [PropertyKey, unknown]>) => Record<string, unknown>
  isArray: (value: unknown) => value is unknown[]
  map: <Value, Result>(values: readonly Value[], callback: (value: Value) => Result) => Result[]
  replaceAll: (value: string, search: string, replacement: string) => string
}>

const normalisePublicValueIntrinsics: NormaliseIntrinsics = Object.freeze({
  entries: Object.entries.bind(Object),
  fromEntries: Object.fromEntries.bind(Object),
  isArray: Array.isArray.bind(Array),
  map: (values, callback) => Array.prototype.map.call(values, callback) as never[],
  replaceAll: (value, search, replacement) =>
    (String.prototype.replaceAll as unknown as (this: string, search: string, replacement: string) => string).call(
      value,
      search,
      replacement,
    ),
})

type NormalisePublicValue = (
  value: unknown,
  fixtureRoot: string,
  key?: string,
  intrinsics?: NormaliseIntrinsics,
) => unknown

export const normalisePublicValue: NormalisePublicValue = (
  value,
  fixtureRoot,
  key,
  intrinsics = normalisePublicValueIntrinsics,
) => {
  if (key === 'createdAt' && typeof value === 'string') {
    return '<timestamp>'
  }
  if (typeof value === 'string') {
    return intrinsics.replaceAll(value, fixtureRoot, '<fixture-root>')
  }
  if (intrinsics.isArray(value)) {
    return intrinsics.map(value, item => normalisePublicValue(item, fixtureRoot, undefined, intrinsics))
  }
  if (value !== null && typeof value === 'object') {
    return intrinsics.fromEntries(
      intrinsics.map(intrinsics.entries(value), ([name, item]) => [
        name,
        normalisePublicValue(item, fixtureRoot, name, intrinsics),
      ]),
    )
  }
  return value
}

export const RELEASE_CONTRACT_PROBE_SOURCE = Object.freeze(
  [
    'const normalisePublicValueIntrinsics = Object.freeze({ entries: Object.entries.bind(Object), fromEntries: Object.fromEntries.bind(Object), isArray: Array.isArray.bind(Array), map: (values, callback) => Array.prototype.map.call(values, callback), replaceAll: (value, search, replacement) => String.prototype.replaceAll.call(value, search, replacement) })',
    `const normalisePublicValue = ${normalisePublicValue.toString()}`,
    `const resultLimitCases = Object.freeze(${JSON.stringify(RESULT_LIMIT_CASES)})`,
    `const resultLimitOperations = Object.freeze(${JSON.stringify(RESULT_LIMIT_OPERATIONS)})`,
  ].join('\n'),
)
