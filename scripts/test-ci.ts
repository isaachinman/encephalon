import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const [group] = process.argv.slice(2)
const compatibility = 'scripts/release-compatibility.test.ts'
const tooling = [
  'scripts/benchmark-comparison.test.ts',
  'test/benchmark.test.ts',
  'test/package.test.ts',
  'test/ci-workflow.test.ts',
]
if (group === 'runtime' || group === 'tooling' || group === 'all') {
  const files = ['scripts', 'test']
    .flatMap(directory =>
      readdirSync(directory)
        .filter(name => name.endsWith('.test.ts'))
        .map(name => `${directory}/${name}`),
    )
    .filter(path => {
      const isRuntime = !tooling.includes(path)
      return group === 'all' || (group === 'runtime' ? isRuntime : !isRuntime || path === compatibility)
    })
  const result = spawnSync(
    process.execPath,
    ['--test', ...(group === 'runtime' ? ['--test-skip-pattern=release compatibility process fixture'] : []), ...files],
    { stdio: 'inherit' },
  )
  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
} else {
  throw new Error('Expected runtime, tooling, or all.')
}
