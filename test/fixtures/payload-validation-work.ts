import { performance } from 'node:perf_hooks'
import { MAX_PAYLOAD_NODES, validateJsonValue } from '../../src/schema.ts'

const PROPERTY_COUNT = 100_000
const [, , mode] = process.argv
const accepted = mode === 'bounded-accepted' || mode === 'descriptor-map-accepted'
const bounded = mode === 'bounded' || mode === 'bounded-accepted'

if (!(bounded || mode === 'descriptor-map' || mode === 'descriptor-map-accepted')) {
  throw new Error('Expected bounded, bounded-accepted, descriptor-map, or descriptor-map-accepted mode.')
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

const propertyCount = accepted ? MAX_PAYLOAD_NODES - 1 : PROPERTY_COUNT
const target: Record<string, null> = {}
for (let index = 0; index < propertyCount; index += 1) {
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
const garbageCollect = (globalThis as typeof globalThis & { gc?: () => void }).gc
garbageCollect?.()
const before = {
  heapUsedBytes: process.memoryUsage().heapUsed,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
}
const startedAt = performance.now()
let retainedDescriptors: PropertyDescriptorMap | undefined
let retainedResult: unknown

if (bounded) {
  if (accepted) {
    retainedResult = validateJsonValue(payload)
  } else {
    assertInvalidPayload(() => validateJsonValue(payload))
  }
} else {
  retainedDescriptors = Object.getOwnPropertyDescriptors(payload)
  if (accepted) {
    retainedResult = Object.fromEntries(Object.entries(target))
  }
}

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

if (bounded) {
  assertInvalidPayload(() => validateJsonValue(oversizedArray))
} else {
  Object.getOwnPropertyDescriptors(oversizedArray)
}

garbageCollect?.()
const after = {
  heapUsedBytes: process.memoryUsage().heapUsed,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
}
const retainedDescriptorCount = retainedDescriptors === undefined ? 0 : Reflect.ownKeys(retainedDescriptors).length
const retainedResultKeyCount =
  retainedResult !== undefined && typeof retainedResult === 'object' && retainedResult !== null
    ? Reflect.ownKeys(retainedResult).length
    : 0

process.stdout.write(
  `${JSON.stringify({
    elapsedMilliseconds: performance.now() - startedAt,
    heapGrowthBytes: Math.max(0, after.heapUsedBytes - before.heapUsedBytes),
    mode,
    oversizedArrayWork,
    peakRssBytes: after.peakRssBytes,
    propertyCount,
    retainedDescriptorCount,
    retainedResultKeyCount,
    rssGrowthBytes: Math.max(0, after.peakRssBytes - before.peakRssBytes),
    work,
  })}\n`,
)
