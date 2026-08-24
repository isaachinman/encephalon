import { fail } from './errors.ts'
import { OPERATION_BUDGETS } from './operation-budgets.ts'
import { guardedGetOwnPropertyDescriptor, guardedOwnKeys, PROPERTY_INSPECTION_FAILED } from './property-inspection.ts'

declare const denseDataArrayInspectionBrand: unique symbol

/** @internal */
export type DenseDataArrayInspection = {
  readonly [denseDataArrayInspectionBrand]: never
  readonly field: string
  readonly length: number
  readonly value: unknown[]
}

const failStructure = (field: string): never =>
  fail('INVALID_ARGUMENT', `${field} must be a dense array of data properties.`, { field })

const isArray = (value: unknown) => {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

/** @internal */
export const inspectDenseDataArray = (
  value: unknown,
  field: string,
  invalidTypeMessage: string,
): DenseDataArrayInspection => {
  if (isArray(value)) {
    const array = value as unknown[]
    const descriptor = guardedGetOwnPropertyDescriptor(array, 'length')
    if (
      descriptor !== PROPERTY_INSPECTION_FAILED &&
      descriptor !== undefined &&
      'value' in descriptor &&
      typeof descriptor.value === 'number' &&
      Number.isSafeInteger(descriptor.value) &&
      descriptor.value >= 0
    ) {
      return { field, length: descriptor.value, value: array } as DenseDataArrayInspection
    }
    return failStructure(field)
  }
  return fail('INVALID_ARGUMENT', invalidTypeMessage, { field })
}

const canonicalArrayIndex = (key: string) => {
  const numeric = Number(key)
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < 4_294_967_295 && String(numeric) === key) {
    return numeric
  }
}

/** @internal */
export const readDenseDataArray = (inspection: DenseDataArrayInspection): unknown[] => {
  const keys = guardedOwnKeys(inspection.value)
  if (keys !== PROPERTY_INSPECTION_FAILED) {
    const maximumKeys = inspection.length + OPERATION_BUDGETS.denseArrayExtraProperties.maximum + 1
    if (keys.length <= maximumKeys) {
      const values = new Array<unknown>(inspection.length)
      let indexedProperties = 0
      for (const key of keys) {
        if (typeof key === 'string') {
          if (key !== 'length') {
            const descriptor = guardedGetOwnPropertyDescriptor(inspection.value, key)
            if (descriptor !== PROPERTY_INSPECTION_FAILED && descriptor !== undefined && 'value' in descriptor) {
              const index = canonicalArrayIndex(key)
              if (index !== undefined && index < inspection.length) {
                values[index] = descriptor.value
                indexedProperties += 1
              }
            } else {
              return failStructure(inspection.field)
            }
          }
        } else {
          return failStructure(inspection.field)
        }
      }
      if (indexedProperties === inspection.length) {
        return values
      }
    }
  }
  return failStructure(inspection.field)
}
