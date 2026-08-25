import { existsSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { cacheLocationTestHooks } from '../../src/cache-location.ts'
import { withOperationLock } from '../../src/lock.ts'

const [role, root, resultPath, releasePath] = process.argv.slice(2)

if (root === undefined || resultPath === undefined || (role !== 'owner' && role !== 'successor')) {
  throw new Error('Expected a role, repository root, and result path.')
}

const wait = () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
}

if (role === 'owner') {
  if (releasePath === undefined) {
    throw new Error('Expected an owner release path.')
  }
  cacheLocationTestHooks.beforeQuarantineRename = path => {
    if (basename(path) === 'operation-lock.recovery') {
      cacheLocationTestHooks.beforeQuarantineRename = undefined
      throw Object.assign(new Error('injected recovery marker cleanup failure'), { code: 'EIO' })
    }
  }
  let operationEntered = false
  try {
    withOperationLock(root, () => {
      operationEntered = true
    })
    throw new Error('Expected recovery marker cleanup to fail.')
  } catch (error) {
    if (operationEntered || (error as { code?: unknown }).code !== 'IO_ERROR') {
      throw error
    }
  }
  writeFileSync(resultPath, 'abandoned')
  while (!existsSync(releasePath)) {
    wait()
  }
} else {
  withOperationLock(root, () => {
    writeFileSync(resultPath, 'entered')
  })
}
