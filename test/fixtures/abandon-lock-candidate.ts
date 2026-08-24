import { renameSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { withOperationLock } from '../../src/lock.ts'

const [root, mode, barrierPath] = process.argv.slice(2)

if (root === undefined || barrierPath === undefined || (mode !== 'before-owner' && mode !== 'after-owner')) {
  throw new Error('Expected repository root, before-owner|after-owner, and barrier path.')
}

const pause = (path: string) => {
  const stagingPath = `${barrierPath}.${process.pid}.tmp`
  writeFileSync(stagingPath, basename(path))
  renameSync(stagingPath, barrierPath)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

withOperationLock(
  root,
  () => {
    throw new Error('Operation entered before the candidate abandonment barrier.')
  },
  mode === 'before-owner' ? { afterCandidateCreation: pause } : { afterCandidateOwnerPublication: pause },
)
