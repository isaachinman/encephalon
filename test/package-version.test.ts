import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { assertPackageVersionSource, renderPackageVersionSource } from '../scripts/package-version.ts'

const root = resolve(import.meta.dirname, '..')
const staleGeneratedVersionMessage =
  'Generated runtime package version is stale. Run `bun run build` and commit src/generated/version.ts.'

test('renders the complete generated package-version source deterministically', () => {
  assert.equal(
    renderPackageVersionSource('1.2.3-beta.1'),
    '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "1.2.3-beta.1"\n',
  )
})

test('accepts platform line endings and rejects generated package-version content drift', () => {
  const renderedSource = renderPackageVersionSource('0.2.0')
  assert.doesNotThrow(() => assertPackageVersionSource('0.2.0', renderedSource))
  assert.doesNotThrow(() => assertPackageVersionSource('0.2.0', renderedSource.replaceAll('\n', '\r\n')))
  const mixedLineEndingSource = renderedSource.replace('\n', '\r\n')
  assert.throws(
    () => assertPackageVersionSource('0.2.0', mixedLineEndingSource),
    new Error(staleGeneratedVersionMessage),
  )
  assert.throws(
    () => assertPackageVersionSource('0.2.0', renderPackageVersionSource('0.2.1')),
    new Error(staleGeneratedVersionMessage),
  )
  const misleadingStaleSource = '// Expected PACKAGE_VERSION = "0.2.0"\nexport const PACKAGE_VERSION = "0.2.1"\n'
  assert.equal(misleadingStaleSource.includes('PACKAGE_VERSION = "0.2.0"'), true)
  assert.throws(
    () => assertPackageVersionSource('0.2.0', misleadingStaleSource),
    new Error(staleGeneratedVersionMessage),
  )
  assert.throws(
    () => assertPackageVersionSource('0.2.0', `// Unreviewed wrapper\n${renderPackageVersionSource('0.2.0')}`),
    new Error(staleGeneratedVersionMessage),
  )
})

test('keeps build and package checks on the shared generated-source authority', () => {
  const buildSource = readFileSync(resolve(root, 'scripts', 'build.ts'), 'utf8')
  const adapterSources = ['check-generated-version.ts', 'check-package.ts'].map(filename =>
    readFileSync(resolve(root, 'scripts', filename), 'utf8'),
  )
  assert.match(buildSource, /import \{ renderPackageVersionSource \} from '\.\/package-version\.ts'/)
  assert.match(buildSource, /renderPackageVersionSource\(packageJson\.version\)/)
  assert.doesNotMatch(buildSource, /export const PACKAGE_VERSION/)
  assert.deepEqual(
    adapterSources.map(source =>
      /import \{[^}]*assertPackageVersionSource[^}]*\} from '\.\/package-version\.ts'/.test(source),
    ),
    [true, true],
  )
  assert.deepEqual(
    adapterSources.map(source =>
      /assertPackageVersionSource\(packageJson\.version, generatedVersionSource\)/.test(source),
    ),
    [true, true],
  )
})

test('generated-version check adapters reject stale or missing source with recovery guidance', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'encephalon-package-version-check-'))
  try {
    mkdirSync(resolve(temporaryRoot, 'scripts'))
    mkdirSync(resolve(temporaryRoot, 'src', 'generated'), { recursive: true })
    for (const filename of ['package-version.ts', 'check-generated-version.ts', 'check-package.ts']) {
      writeFileSync(
        resolve(temporaryRoot, 'scripts', filename),
        readFileSync(resolve(root, 'scripts', filename), 'utf8'),
        'utf8',
      )
    }
    writeFileSync(resolve(temporaryRoot, 'package.json'), '{"type":"module","version":"0.2.0"}\n', 'utf8')
    writeFileSync(resolve(temporaryRoot, 'src', 'generated', 'version.ts'), renderPackageVersionSource('0.2.1'), 'utf8')
    const staleResults = ['check-generated-version.ts', 'check-package.ts'].map(filename =>
      spawnSync(process.execPath, [resolve(temporaryRoot, 'scripts', filename)], { encoding: 'utf8' }),
    )
    assert.deepEqual(
      staleResults.map(result => result.status === 0),
      [false, false],
    )
    assert.deepEqual(
      staleResults.map(result => result.stderr.includes(staleGeneratedVersionMessage)),
      [true, true],
    )

    rmSync(resolve(temporaryRoot, 'src', 'generated', 'version.ts'))
    const missingResult = spawnSync(
      process.execPath,
      [resolve(temporaryRoot, 'scripts', 'check-generated-version.ts')],
      {
        encoding: 'utf8',
      },
    )
    assert.notEqual(missingResult.status, 0)
    assert.match(missingResult.stderr, new RegExp(staleGeneratedVersionMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(missingResult.stderr, /ENOENT/)
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})
