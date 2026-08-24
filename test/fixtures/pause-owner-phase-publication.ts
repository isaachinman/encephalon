import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { cacheLocationTestHooks } from '../../src/cache-location.ts'
import { withOperationLock } from '../../src/lock.ts'

const [root, publicationPausedPath] = process.argv.slice(2)

if (root === undefined || publicationPausedPath === undefined) {
  throw new Error('Expected a repository root and publication barrier path.')
}

cacheLocationTestHooks.afterOwnerRecoveryCreation = path => {
  if (basename(path) === 'operation-lock.recovery') {
    writeFileSync(`${path}/owner.recovered.json`, '{"acquiredAt":')
    writeFileSync(publicationPausedPath, 'paused')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
}

withOperationLock(root, () => {
  throw new Error('Operation entered before the owner phase publication barrier.')
})
