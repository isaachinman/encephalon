import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertPackageVersionSource, renderPackageVersionSource } from '../scripts/package-version.ts'

test('renders the complete generated package-version source deterministically', () => {
  assert.equal(
    renderPackageVersionSource('1.2.3-beta.1'),
    '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "1.2.3-beta.1"\n',
  )
})

test('rejects generated package-version source that is not an exact match', () => {
  assert.doesNotThrow(() => assertPackageVersionSource('0.2.0', renderPackageVersionSource('0.2.0')))
  assert.throws(
    () => assertPackageVersionSource('0.2.0', renderPackageVersionSource('0.2.1')),
    new Error('Generated runtime package version is stale. Run `bun run build` and commit src/generated/version.ts.'),
  )
})
