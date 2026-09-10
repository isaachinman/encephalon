import { validateJsonValue } from '../../src/schema.ts'

const PROPERTY_COUNT = 100_000
const [, , mode] = process.argv
const bounded = mode === 'bounded'

if (!(bounded || mode === 'retained-values')) {
  throw new Error('Expected bounded or retained-values mode.')
}

const assertInvalidPayload = (operation: () => unknown) => {
  let rejected = false
  try {
    operation()
  } catch (error) {
    if ((error as { code?: unknown }).code === 'INVALID_ARGUMENT') {
      rejected = true
    } else {
      throw error
    }
  }
  if (!rejected) {
    throw new Error('Expected payload validation to reject.')
  }
}

const target: Record<string, number> = {}
for (let index = 0; index < PROPERTY_COUNT; index += 1) {
  target[`key-${index}`] = index
}

const work = { descriptors: 0, ownKeys: 0 }
const garbageCollect = (globalThis as typeof globalThis & { gc?: () => void }).gc
if (garbageCollect === undefined) {
  throw new Error('The allocation fixture requires --expose-gc.')
}
let initialHeapBytes = 0
let retainedHeapBytes = 0
const payload = new Proxy(target, {
  getOwnPropertyDescriptor: (object, key) => {
    work.descriptors += 1
    // Both snapshots occur after key enumeration and before rejection can release the values buffer.
    if (work.descriptors === 1 || work.descriptors === PROPERTY_COUNT) {
      garbageCollect()
      const heapBytes = process.memoryUsage().heapUsed
      if (work.descriptors === 1) {
        initialHeapBytes = heapBytes
      } else {
        retainedHeapBytes = Math.max(0, heapBytes - initialHeapBytes)
      }
    }
    // Fresh descriptor values have no owner outside validation, making excess retention observable.
    return { ...Reflect.getOwnPropertyDescriptor(object, key), value: new Array(32).fill(null) }
  },
  ownKeys: object => {
    work.ownKeys += 1
    return Reflect.ownKeys(object)
  },
})
const oversizedArrayWork = { descriptors: [] as string[], ownKeys: 0 }
const oversizedArray = new Proxy(new Array(2 ** 32 - 1), {
  getOwnPropertyDescriptor: (array, key) => {
    oversizedArrayWork.descriptors.push(String(key))
    return Reflect.getOwnPropertyDescriptor(array, key)
  },
  ownKeys: array => {
    oversizedArrayWork.ownKeys += 1
    return Reflect.ownKeys(array)
  },
})

const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
let descriptorMapCalls = 0
Object.getOwnPropertyDescriptors = ((value: object) => {
  descriptorMapCalls += 1
  return originalGetOwnPropertyDescriptors(value)
}) as typeof Object.getOwnPropertyDescriptors

const retainedValues: unknown[] = []

try {
  if (bounded) {
    validateJsonValue({ nested: [{ value: null }] })
    assertInvalidPayload(() => validateJsonValue(payload))
    assertInvalidPayload(() => validateJsonValue(oversizedArray))
  } else {
    for (const key of Reflect.ownKeys(payload)) {
      retainedValues.push(Reflect.getOwnPropertyDescriptor(payload, key)?.value)
    }
  }
} finally {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors
}

process.stdout.write(
  `${JSON.stringify({
    descriptorMapCalls,
    mode,
    oversizedArrayWork,
    propertyCount: PROPERTY_COUNT,
    retainedHeapBytes,
    retainedValueCount: retainedValues.length,
    work,
  })}\n`,
)
