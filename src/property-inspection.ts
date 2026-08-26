/** @internal */
export const PROPERTY_INSPECTION_FAILED: unique symbol = Symbol('property inspection failed')

/** @internal */
export const guardedIsArray = (value: unknown) => {
  try {
    return Array.isArray(value)
  } catch {
    return PROPERTY_INSPECTION_FAILED
  }
}

/** @internal */
export const guardedGetPrototypeOf = (value: object) => {
  try {
    return Object.getPrototypeOf(value) as object | null
  } catch {
    return PROPERTY_INSPECTION_FAILED
  }
}

/** @internal */
export const guardedOwnKeys = (value: object) => {
  try {
    return Reflect.ownKeys(value)
  } catch {
    return PROPERTY_INSPECTION_FAILED
  }
}

/** @internal */
export const guardedOwnKeysMatch = (value: object, expected: readonly PropertyKey[]) => {
  const actual = guardedOwnKeys(value)
  if (actual !== PROPERTY_INSPECTION_FAILED && actual.length === expected.length) {
    const expectedKeys = new Set(expected)
    return actual.every(key => expectedKeys.has(key))
  }
  return false
}

/** @internal */
export const guardedGetOwnPropertyDescriptor = (value: object, key: PropertyKey) => {
  try {
    return Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return PROPERTY_INSPECTION_FAILED
  }
}

/** @internal */
export const guardedEnumerableDataPropertyMatches = (value: object, key: PropertyKey, expected: unknown) => {
  const descriptor = guardedGetOwnPropertyDescriptor(value, key)
  return (
    descriptor !== PROPERTY_INSPECTION_FAILED &&
    descriptor !== undefined &&
    'value' in descriptor &&
    descriptor.enumerable === true &&
    Object.is(descriptor.value, expected)
  )
}
