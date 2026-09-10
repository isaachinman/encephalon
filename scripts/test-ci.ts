import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const [group] = process.argv.slice(2)
const compatibility = 'scripts/release-compatibility.test.ts'
const cache = 'test/cache.test.ts'
const runtime = group === 'runtime' || group === 'runtime-core' || group === 'cache'
const tooling = [
  'scripts/benchmark-comparison.test.ts',
  'test/benchmark.test.ts',
  'test/package.test.ts',
  'test/ci-workflow.test.ts',
]
if (runtime || group === 'tooling' || group === 'all') {
  const files = ['scripts', 'test']
    .flatMap(directory =>
      readdirSync(directory)
        .filter(name => name.endsWith('.test.ts'))
        .map(name => `${directory}/${name}`),
    )
    .filter(path => {
      const isRuntime = !tooling.includes(path)
      const selectedRuntime = group === 'runtime' || (group === 'cache' ? path === cache : path !== cache)
      return group === 'all' || (runtime ? isRuntime && selectedRuntime : !isRuntime || path === compatibility)
    })
  const result = spawnSync(
    process.execPath,
    ['--test', ...(runtime ? ['--test-skip-pattern=release compatibility process fixture'] : []), ...files],
    { stdio: 'inherit' },
  )
  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
} else {
  throw new Error('Expected runtime, runtime-core, cache, tooling, or all.')
}
