import { closeSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { withOperationLock } from '../../src/lock.ts'

const [root, observedPath, releasePath, activePath, enteredPath, delayText] = process.argv.slice(2)

if (
  root === undefined ||
  observedPath === undefined ||
  releasePath === undefined ||
  activePath === undefined ||
  enteredPath === undefined ||
  delayText === undefined
) {
  throw new Error('Expected repository, synchronisation, and result paths.')
}

const delay = Number(delayText)
const wait = (milliseconds: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

withOperationLock(
  root,
  () => {
    const descriptor = openSync(activePath, 'wx')
    try {
      writeFileSync(enteredPath, 'entered')
      wait(300)
    } finally {
      closeSync(descriptor)
      rmSync(activePath, { force: true })
    }
  },
  {
    afterStaleObservation: () => {
      writeFileSync(observedPath, 'observed')
      while (!existsSync(releasePath)) {
        wait(10)
      }
      wait(delay)
    },
  },
)
