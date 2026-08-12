import { existsSync, writeFileSync } from 'node:fs'
import { withOperationLock } from '../../src/lock.ts'

const [root, attemptedPath, enteredPath, releasePath] = process.argv.slice(2)

if (root === undefined || attemptedPath === undefined || enteredPath === undefined || releasePath === undefined) {
  throw new Error('Expected repository, attempted, entered, and release paths.')
}

const wait = () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
}

writeFileSync(attemptedPath, 'attempted')
withOperationLock(root, () => {
  writeFileSync(enteredPath, 'entered')
  while (!existsSync(releasePath)) {
    wait()
  }
})
