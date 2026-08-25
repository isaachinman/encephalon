import { fail } from './errors.ts'
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
  if (
    keys !== PROPERTY_INSPECTION_FAILED &&
    keys.length === inspection.length + 1 &&
    keys.every(key => {
      if (key === 'length') {
        return true
      }
      if (typeof key === 'string') {
        const index = canonicalArrayIndex(key)
        return index !== undefined && index < inspection.length
      }
      return false
    })
  ) {
    const values = keys.reduce<unknown[]>((snapshot, key) => {
      if (key === 'length') {
        return snapshot
      }
      if (typeof key === 'string') {
        const descriptor = guardedGetOwnPropertyDescriptor(inspection.value, key)
        const index = canonicalArrayIndex(key)
        if (
          descriptor !== PROPERTY_INSPECTION_FAILED &&
          descriptor !== undefined &&
          'value' in descriptor &&
          descriptor.enumerable === true &&
          index !== undefined
        ) {
          snapshot[index] = descriptor.value
          return snapshot
        }
      }
      return failStructure(inspection.field)
    }, new Array<unknown>(inspection.length))
    const lengthDescriptor = guardedGetOwnPropertyDescriptor(inspection.value, 'length')
    if (
      lengthDescriptor !== PROPERTY_INSPECTION_FAILED &&
      lengthDescriptor !== undefined &&
      'value' in lengthDescriptor &&
      lengthDescriptor.value === inspection.length
    ) {
      return values
    }
  }
  return failStructure(inspection.field)
}
