import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { selectTestFiles } from './test-selection.ts'

const discovered = ['scripts', 'test'].flatMap(directory =>
  readdirSync(directory, { encoding: 'utf8', recursive: true })
    .filter(name => name.endsWith('.test.ts'))
    .map(name => `${directory}/${name.replaceAll('\\', '/')}`),
)

test('classifies every test explicitly and retains complete disjoint source, package and tooling coverage', () => {
  const ordinary = ['source', 'package', 'tooling'].flatMap(group => selectTestFiles(group, discovered))
  assert.equal(ordinary.length, new Set(ordinary).size)
  assert.deepEqual(
    [...ordinary].sort(),
    discovered.filter(path => path !== 'scripts/release-compatibility-process.test.ts').sort(),
  )
  assert.deepEqual(selectTestFiles('all', discovered), [...discovered].sort())
  for (const group of ['source', 'platform', 'platform-core', 'cache', 'package', 'tooling', 'history', 'all']) {
    assert.throws(() => selectTestFiles(group, [...discovered, 'test/nested/new-filesystem.test.ts']), /unclassified/)
  }
  assert.throws(() => selectTestFiles('typo', discovered), /group/)
  assert.throws(() => selectTestFiles('source', discovered.slice(1)), /stale/)
  assert.throws(() => selectTestFiles('source', [...discovered, discovered[0] ?? '']), /unclassified/)
  assert.deepEqual(selectTestFiles('package-platform', discovered), [
    'test/cli.test.ts',
    'test/package-version.test.ts',
  ])
})

test('keeps platform-sensitive files and partitions Windows cache work without source-only or package tooling duplication', () => {
  const platform = selectTestFiles('platform', discovered)
  const split = ['platform-core', 'cache'].flatMap(group => selectTestFiles(group, discovered))
  assert.equal(split.length, new Set(split).size)
  assert.deepEqual([...split].sort(), platform)
  for (const path of [
    'test/cache.test.ts',
    'test/init.test.ts',
    'test/instructions.test.ts',
    'test/verified-file.test.ts',
    'test/npm-command.test.ts',
    'scripts/package-tarball.test.ts',
  ]) {
    assert.ok(platform.includes(path), path)
  }
  assert.ok(!platform.includes('test/order.test.ts'))
  assert.ok(!platform.includes('test/package.test.ts'))
  assert.deepEqual(selectTestFiles('history', discovered), ['scripts/release-compatibility-process.test.ts'])
  assert.ok(selectTestFiles('platform', discovered, ['test/order.test.ts']).includes('test/order.test.ts'))
})
