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
export const guardedGetOwnPropertyDescriptor = (value: object, key: PropertyKey) => {
  try {
    return Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return PROPERTY_INSPECTION_FAILED
  }
}
