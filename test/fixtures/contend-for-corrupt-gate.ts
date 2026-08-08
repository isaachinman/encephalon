import { closeSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { withOperationLock } from '../../src/lock.ts'

const [root, readyPath, releasePath, activePath, enteredPath, holdText] = process.argv.slice(2)

if (
  root === undefined ||
  readyPath === undefined ||
  releasePath === undefined ||
  activePath === undefined ||
  enteredPath === undefined ||
  holdText === undefined
) {
  throw new Error('Expected repository, synchronisation, and result paths.')
}

const holdMilliseconds = Number(holdText)
const wait = (milliseconds: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

writeFileSync(readyPath, 'ready')
while (!existsSync(releasePath)) {
  wait(10)
}

withOperationLock(root, () => {
  const descriptor = openSync(activePath, 'wx')
  try {
    writeFileSync(enteredPath, 'entered')
    wait(holdMilliseconds)
  } finally {
    closeSync(descriptor)
    rmSync(activePath, { force: true })
  }
})
