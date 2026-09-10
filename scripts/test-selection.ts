// Every new file needs a deliberate coverage decision; filesystem/process coverage is the conservative default.
const classification = {
  'scripts/benchmark-command.test.ts': 'platform',
  'scripts/benchmark-comparison.test.ts': 'tooling',
  'scripts/ci-selection.test.ts': 'source',
  'scripts/package-graph.test.ts': 'source',
  'scripts/package-preflight.test.ts': 'package',
  'scripts/package-tarball.test.ts': 'platform',
  'scripts/release-compatibility-process.test.ts': 'history',
  'scripts/release-compatibility.test.ts': 'source',
  'scripts/test-selection.test.ts': 'source',
  'scripts/worktree-clean.test.ts': 'platform',
  'test/api-input.test.ts': 'source',
  'test/artifact-inspection.test.ts': 'platform',
  'test/benchmark.test.ts': 'tooling',
  'test/bounded-directory.test.ts': 'platform',
  'test/cache.test.ts': 'platform',
  'test/canonical-layout.test.ts': 'platform',
  'test/check-package-arguments.test.ts': 'platform',
  'test/ci-workflow.test.ts': 'tooling',
  'test/cli.test.ts': 'package',
  'test/directory-witness.test.ts': 'platform',
  'test/errors.test.ts': 'source',
  'test/filesystem-entry.test.ts': 'platform',
  'test/init.test.ts': 'platform',
  'test/instructions.test.ts': 'platform',
  'test/literal-query.test.ts': 'source',
  'test/lock-candidates.test.ts': 'platform',
  'test/npm-command.test.ts': 'platform',
  'test/npm-publish-conflict.test.ts': 'source',
  'test/order.test.ts': 'source',
  'test/package-version.test.ts': 'package',
  'test/package.test.ts': 'package',
  'test/performance.test.ts': 'platform',
  'test/record-corpus-fingerprint.test.ts': 'platform',
  'test/records.test.ts': 'platform',
  'test/repository.test.ts': 'platform',
  'test/response-budget.test.ts': 'source',
  'test/sqlite-error.test.ts': 'source',
  'test/sqlite-policy.test.ts': 'platform',
  'test/staging.test.ts': 'platform',
  'test/verified-file.test.ts': 'platform',
} as const

export const selectTestFiles = (
  group: string,
  discovered: readonly string[],
  changedTests: readonly string[] = [],
): string[] => {
  const entries = Object.entries(classification)
  if (
    new Set(discovered).size !== discovered.length ||
    entries.length !== discovered.length ||
    discovered.some(path => !Object.hasOwn(classification, path))
  ) {
    throw new Error('A test file is unclassified or its coverage classification is stale.')
  }
  if (
    [
      'source',
      'platform',
      'platform-core',
      'cache',
      'package',
      'package-platform',
      'tooling',
      'history',
      'all',
    ].includes(group)
  ) {
    return entries
      .filter(([path, category]) => {
        if (group === 'source') {
          return category === 'source' || category === 'platform'
        }
        if (group === 'platform' || group === 'platform-core') {
          const platform = category === 'platform' || (category === 'source' && changedTests.includes(path))
          return platform && (group === 'platform' || path !== 'test/cache.test.ts')
        }
        if (group === 'cache') {
          return path === 'test/cache.test.ts'
        }
        if (group === 'package-platform') {
          return path === 'test/cli.test.ts' || path === 'test/package-version.test.ts'
        }
        return group === 'all' || category === group
      })
      .map(([path]) => path)
      .sort()
  }
  throw new Error('Unknown test group.')
}
