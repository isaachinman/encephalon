import { writeFileSync } from 'node:fs'
import { prepare } from '../../src/cache.ts'

const [root, resultPath] = process.argv.slice(2)

if (root === undefined || resultPath === undefined) {
  throw new Error('Expected a repository root and result path.')
}

writeFileSync(resultPath, JSON.stringify(prepare({ root })))
