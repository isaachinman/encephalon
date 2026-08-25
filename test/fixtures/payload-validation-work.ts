import { performance } from 'node:perf_hooks'
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

const target: Record<string, null> = {}
for (let index = 0; index < PROPERTY_COUNT; index += 1) {
  target[`key-${index}`] = null
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
let descriptorMapCalls = 0
Object.getOwnPropertyDescriptors = ((value: object) => {
  descriptorMapCalls += 1
  return originalGetOwnPropertyDescriptors(value)
}) as typeof Object.getOwnPropertyDescriptors

const garbageCollect = (globalThis as typeof globalThis & { gc?: () => void }).gc
garbageCollect?.()
const before = {
  heapUsedBytes: process.memoryUsage().heapUsed,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
}
const startedAt = performance.now()
let retainedDescriptors: PropertyDescriptorMap | undefined

try {
  if (bounded) {
    assertInvalidPayload(() => validateJsonValue(payload))
    assertInvalidPayload(() => validateJsonValue(oversizedArray))
  } else {
    retainedDescriptors = Object.getOwnPropertyDescriptors(payload)
    Object.getOwnPropertyDescriptors(oversizedArray)
  }
} finally {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors
}

garbageCollect?.()
const after = {
  heapUsedBytes: process.memoryUsage().heapUsed,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
}
const retainedDescriptorCount = retainedDescriptors === undefined ? 0 : Reflect.ownKeys(retainedDescriptors).length

process.stdout.write(
  `${JSON.stringify({
    descriptorMapCalls,
    elapsedMilliseconds: performance.now() - startedAt,
    heapGrowthBytes: Math.max(0, after.heapUsedBytes - before.heapUsedBytes),
    mode,
    oversizedArrayWork,
    peakRssBytes: after.peakRssBytes,
    propertyCount: PROPERTY_COUNT,
    retainedDescriptorCount,
    rssGrowthBytes: Math.max(0, after.peakRssBytes - before.peakRssBytes),
    work,
  })}\n`,
)
