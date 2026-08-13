import { existsSync, writeFileSync } from 'node:fs'
import { addRecord } from '../../src/index.ts'
import { recordWriteTestHooks } from '../../src/records.ts'

const [root, validatedPath, releasePath, resultPath] = process.argv.slice(2)

if (root === undefined || validatedPath === undefined || releasePath === undefined || resultPath === undefined) {
  throw new Error('Expected repository, validation, release, and result paths.')
}

const wait = () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
}

recordWriteTestHooks.beforeOperationLock = () => {
  writeFileSync(validatedPath, 'validated')
  const deadline = Date.now() + 5000
  while (!existsSync(releasePath) && Date.now() < deadline) {
    wait()
  }
  if (!existsSync(releasePath)) {
    throw new Error('Timed out waiting to release validated input.')
  }
}

const record = addRecord({
  id: 'first-process-second-publication',
  kind: 'decision',
  payload: {},
  root,
  source: 'agent',
  subject: 'timestamp.first-process',
})
writeFileSync(resultPath, JSON.stringify(record))
