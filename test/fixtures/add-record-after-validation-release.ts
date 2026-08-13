import { writeFileSync } from 'node:fs'
import { addRecord } from '../../src/index.ts'
import { recordWriteTestHooks } from '../../src/records.ts'

const [root, validatedPath, resultPath] = process.argv.slice(2)

if (root === undefined || validatedPath === undefined || resultPath === undefined) {
  throw new Error('Expected repository, validation, and result paths.')
}

recordWriteTestHooks.beforeOperationLock = () => {
  writeFileSync(validatedPath, 'validated')
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
