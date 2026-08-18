import { Buffer } from 'node:buffer'

type Request = {
  nonce?: unknown
  operation?: unknown
  root?: unknown
}

const sample = () => ({
  overheadMs: 1,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
  preparationIntegrityMs: 4,
  queryProjectionMs: 5,
  rssDeltaBytes: -1024,
  totalMs: 10,
})

let retained: Buffer | undefined

const send = (value: unknown, done?: () => void) => {
  if (process.send !== undefined) {
    process.send(value, () => done?.())
  }
}

process.once('message', value => {
  const request = value as Request
  const nonce = typeof request.nonce === 'string' ? request.nonce : ''
  const result = () => ({ nonce, processId: process.pid, sample: sample() })

  if (request.root === '/crash') {
    process.exitCode = 23
    process.disconnect()
    return
  }
  if (request.root === '/stdout') {
    process.stdout.write('unexpected benchmark stdout')
  }

  switch (request.operation) {
    case 'coldHydrate': {
      retained = Buffer.alloc(96 * 1024 * 1024)
      for (let offset = 0; offset < retained.length; offset += 4096) {
        retained[offset] = 1
      }
      send(result(), () => process.disconnect())
      break
    }
    case 'compactSearch': {
      send({ nonce, processId: 'not-a-process', sample: sample() }, () => process.disconnect())
      break
    }
    case 'fullSearch': {
      send(result(), () => process.disconnect())
      break
    }
    case 'gather': {
      setInterval(() => undefined, 1000)
      break
    }
    case 'list': {
      send(result(), () => {
        process.exitCode = 17
        process.disconnect()
      })
      break
    }
    case 'show': {
      send(result())
      setInterval(() => undefined, 1000)
      break
    }
    case 'stalePrepare': {
      send(result())
      send(result(), () => process.disconnect())
      break
    }
    case 'unchangedPrepare': {
      send({ ...result(), nonce: `${nonce}-wrong` }, () => process.disconnect())
      break
    }
    default: {
      process.exitCode = 19
      process.disconnect()
    }
  }
})
