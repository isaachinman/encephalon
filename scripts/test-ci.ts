import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const [group] = process.argv.slice(2)
const compatibility = 'scripts/release-compatibility.test.ts'
const patterns: Record<string, string> = {
  'compatibility-a': 'release compatibility process fixture group [BC]',
  'compatibility-b': 'release compatibility process fixture group B',
  'compatibility-c': 'release compatibility process fixture group C',
}
const pattern = group ? patterns[group] : undefined
if (group === 'main' || group === 'all' || pattern) {
  const files =
    group === 'main' || group === 'all'
      ? ['scripts', 'test']
          .flatMap(directory =>
            readdirSync(directory)
              .filter(name => name.endsWith('.test.ts'))
              .map(name => `${directory}/${name}`),
          )
          .filter(path => group === 'all' || path !== compatibility)
      : [compatibility]
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      ...(pattern ? [`--test-${group === 'compatibility-a' ? 'skip' : 'name'}-pattern=${pattern}`] : []),
      ...files,
    ],
    { stdio: 'inherit' },
  )
  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
} else {
  throw new Error('Expected all, main, compatibility-a, compatibility-b, or compatibility-c test group.')
}
