import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { selectTestFiles } from './test-selection.ts'

const group = process.argv[2] ?? ''
const discovered = ['scripts', 'test'].flatMap(directory =>
  readdirSync(directory, { encoding: 'utf8', recursive: true })
    .filter(name => name.endsWith('.test.ts'))
    .map(name => `${directory}/${name.replaceAll('\\', '/')}`),
)
const changed: unknown = JSON.parse(process.env.CI_CHANGED_TESTS ?? '[]')
if (!(Array.isArray(changed) && changed.every(path => typeof path === 'string'))) {
  throw new Error('CI_CHANGED_TESTS must contain the changed test paths.')
}
const files = selectTestFiles(group, discovered, changed)
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
if (result.error) {
  throw result.error
}
process.exitCode = result.status ?? 1
