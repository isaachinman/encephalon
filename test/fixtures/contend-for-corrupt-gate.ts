import { closeSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { withOperationLock } from '../../src/lock.ts'

const [root, readyPath, releasePath, activePath, enteredPath, holdText, role, markerOwnedPath, markerObservedPath] =
  process.argv.slice(2)

if (
  root === undefined ||
  readyPath === undefined ||
  releasePath === undefined ||
  activePath === undefined ||
  enteredPath === undefined ||
  holdText === undefined ||
  (role !== 'observer' && role !== 'owner') ||
  markerOwnedPath === undefined ||
  markerObservedPath === undefined
) {
  throw new Error('Expected repository, synchronisation, and result paths.')
}

const holdMilliseconds = Number(holdText)
const wait = (milliseconds: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

const waitForPath = (path: string) => {
  const deadline = Date.now() + 5000
  while (!existsSync(path) && Date.now() < deadline) {
    wait(10)
  }
  if (!existsSync(path)) {
    throw new Error('Timed out waiting at the corrupt-gate test barrier.')
  }
}

writeFileSync(readyPath, 'ready')
while (!existsSync(releasePath)) {
  wait(10)
}

withOperationLock(
  root,
  () => {
    const descriptor = openSync(activePath, 'wx')
    try {
      writeFileSync(enteredPath, 'entered')
      wait(holdMilliseconds)
    } finally {
      closeSync(descriptor)
      rmSync(activePath, { force: true })
    }
  },
  role === 'owner'
    ? {
        afterRecoveryCreation: () => {
          writeFileSync(markerOwnedPath, 'owned')
          waitForPath(markerObservedPath)
        },
      }
    : {
        duringRecoveryObservation: () => {
          writeFileSync(markerObservedPath, 'observed')
        },
      },
)
