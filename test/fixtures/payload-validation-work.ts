import { validateJsonValue } from '../../src/schema.ts'

const PROPERTY_COUNT = 100_000
const [, , mode] = process.argv
const bounded = mode === 'bounded'

if (!(bounded || mode === 'descriptor-map')) {
  throw new Error('Expected bounded or descriptor-map mode.')
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
const payload = new Proxy(target, {
  getOwnPropertyDescriptor: (object, key) => {
    work.descriptors += 1
    return Reflect.getOwnPropertyDescriptor(object, key)
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
const originalDefineProperty = Object.defineProperty
let descriptorMapCalls = 0
let outputWrites = 0
Object.getOwnPropertyDescriptors = ((value: object) => {
  descriptorMapCalls += 1
  return originalGetOwnPropertyDescriptors(value)
}) as typeof Object.getOwnPropertyDescriptors
Object.defineProperty = ((value: object, key: PropertyKey, attributes: PropertyDescriptor) => {
  outputWrites += 1
  return originalDefineProperty(value, key, attributes)
}) as typeof Object.defineProperty

const garbageCollect = (globalThis as typeof globalThis & { gc?: () => void }).gc
garbageCollect?.()
const beforeHeapUsedBytes = process.memoryUsage().heapUsed
let retainedDescriptors: PropertyDescriptorMap | undefined
let acceptedOutputWrites = 0
let rejectedOutputWrites = 0

try {
  if (bounded) {
    validateJsonValue({ nested: [{ value: null }] })
    acceptedOutputWrites = outputWrites
    outputWrites = 0
    assertInvalidPayload(() => validateJsonValue(payload))
    assertInvalidPayload(() => validateJsonValue(oversizedArray))
    rejectedOutputWrites = outputWrites
  } else {
    retainedDescriptors = Object.getOwnPropertyDescriptors(payload)
    Object.getOwnPropertyDescriptors(oversizedArray)
  }
} finally {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors
  Object.defineProperty = originalDefineProperty
}

garbageCollect?.()
const afterHeapUsedBytes = process.memoryUsage().heapUsed
const retainedDescriptorCount = retainedDescriptors === undefined ? 0 : Reflect.ownKeys(retainedDescriptors).length

process.stdout.write(
  `${JSON.stringify({
    acceptedOutputWrites,
    descriptorMapCalls,
    heapGrowthBytes: Math.max(0, afterHeapUsedBytes - beforeHeapUsedBytes),
    mode,
    oversizedArrayWork,
    propertyCount: PROPERTY_COUNT,
    rejectedOutputWrites,
    retainedDescriptorCount,
    work,
  })}\n`,
)
