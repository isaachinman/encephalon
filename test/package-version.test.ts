import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { assertPackageVersionSource, renderPackageVersionSource } from '../scripts/package-version.ts'

const root = resolve(import.meta.dirname, '..')
const staleGeneratedVersionMessage =
  'Generated runtime package version is stale. Run `bun run build` and commit src/generated/version.ts.'

const assertGeneratedVersionWorkflowCommands = () => {
  const workflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const verifyStart = workflow.indexOf('\n  verify:\n')
  const releaseStart = workflow.indexOf('\n  release:\n', verifyStart)
  assert.notEqual(verifyStart, -1)
  assert.notEqual(releaseStart, -1)
  const commands = [workflow.slice(verifyStart, releaseStart), workflow.slice(releaseStart)].map(job => {
    const matchingCommands = [...job.matchAll(/^\s+- run: (.+check-generated-version\.ts)$/gmu)].map(match => match[1])
    assert.equal(matchingCommands.length, 1)
    return matchingCommands[0]
  })
  assert.deepEqual(commands, ['node ./scripts/check-generated-version.ts', 'node ./scripts/check-generated-version.ts'])
}

const runWorkflowGeneratedVersionCheck = (temporaryRoot: string) => {
  assertGeneratedVersionWorkflowCommands()
  return spawnSync(process.execPath, ['./scripts/check-generated-version.ts'], {
    cwd: temporaryRoot,
    encoding: 'utf8',
  })
}

const createCheckFixture = () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'encephalon-package-version-check-'))
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
  return temporaryRoot
}

const runFixtureScript = (temporaryRoot: string, filename: string) =>
  spawnSync(process.execPath, [resolve(temporaryRoot, 'scripts', filename)], { encoding: 'utf8' })

test('renders generated package-version source deterministically', () => {
  assert.equal(
    renderPackageVersionSource('1.2.3-beta.1'),
    '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "1.2.3-beta.1"\n',
  )
})

test('accepts complete checkout line endings and rejects every other source shape', () => {
  const renderedSource = '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "0.2.0"\n'
  assert.doesNotThrow(() => assertPackageVersionSource('0.2.0', renderedSource))
  assert.doesNotThrow(() => assertPackageVersionSource('0.2.0', renderedSource.replaceAll('\n', '\r\n')))

  const misleadingSource = '// Expected PACKAGE_VERSION = "0.2.0"\nexport const PACKAGE_VERSION = "0.2.1"\n'
  assert.equal(misleadingSource.includes('PACKAGE_VERSION = "0.2.0"'), true)
  for (const source of [
    renderedSource.replace('\n', '\r\n'),
    '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "0.2.1"\n',
    misleadingSource,
    `// Unreviewed wrapper\n${renderedSource}`,
  ]) {
    assert.throws(() => assertPackageVersionSource('0.2.0', source), new Error(staleGeneratedVersionMessage))
  }
})

test('generated-version adapters reject stale or missing source without modifying it', () => {
  const temporaryRoot = createCheckFixture()
  const generatedVersionPath = resolve(temporaryRoot, 'src', 'generated', 'version.ts')
  try {
    const currentSource =
      '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "0.2.0"\n'
    writeFileSync(generatedVersionPath, currentSource, 'utf8')
    const currentResult = runFixtureScript(temporaryRoot, 'check-generated-version.ts')
    assert.equal(currentResult.status, 0, `${currentResult.stdout}${currentResult.stderr}`)
    assert.equal(readFileSync(generatedVersionPath, 'utf8'), currentSource)

    const staleSource = '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "0.2.1"\n'
    writeFileSync(generatedVersionPath, staleSource, 'utf8')
    const staleResults = ['check-generated-version.ts', 'check-package.ts'].map(filename =>
      runFixtureScript(temporaryRoot, filename),
    )
    assert.deepEqual(
      staleResults.map(result => result.status === 0),
      [false, false],
    )
    assert.deepEqual(
      staleResults.map(result => result.stderr.includes(staleGeneratedVersionMessage)),
      [true, true],
    )
    assert.equal(readFileSync(generatedVersionPath, 'utf8'), staleSource)

    rmSync(generatedVersionPath)
    const missingResult = runFixtureScript(temporaryRoot, 'check-generated-version.ts')
    assert.notEqual(missingResult.status, 0)
    assert.equal(missingResult.stderr.includes(staleGeneratedVersionMessage), true)
    assert.doesNotMatch(missingResult.stderr, /ENOENT/)
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

test('direct generated-version check bypasses package lifecycle hooks', () => {
  const temporaryRoot = createCheckFixture()
  const generatedVersionPath = resolve(temporaryRoot, 'src', 'generated', 'version.ts')
  const repairMarkerPath = resolve(temporaryRoot, 'repair-ran')
  const staleSource = '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "0.2.1"\n'
  const currentSource = '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "0.2.0"\n'
  try {
    writeFileSync(generatedVersionPath, staleSource, 'utf8')
    writeFileSync(
      resolve(temporaryRoot, 'package.json'),
      `${JSON.stringify({
        scripts: {
          'check:generated': 'bun run scripts/check-generated-version.ts',
          'precheck:generated': 'node ./repair-generated.mjs',
        },
        type: 'module',
        version: '0.2.0',
      })}\n`,
      'utf8',
    )
    writeFileSync(
      resolve(temporaryRoot, 'repair-generated.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./src/generated/version.ts', import.meta.url), ${JSON.stringify(currentSource)})\nwriteFileSync(new URL('./repair-ran', import.meta.url), ${JSON.stringify('true\n')})\n`,
      'utf8',
    )

    const directResult = runWorkflowGeneratedVersionCheck(temporaryRoot)
    assert.notEqual(directResult.status, 0)
    assert.equal(directResult.stderr.includes(staleGeneratedVersionMessage), true)
    assert.equal(readFileSync(generatedVersionPath, 'utf8'), staleSource)
    assert.equal(existsSync(repairMarkerPath), false)

    const aliasResult = spawnSync('bun', ['run', 'check:generated'], { cwd: temporaryRoot, encoding: 'utf8' })
    assert.equal(aliasResult.status, 0, `${aliasResult.stdout}${aliasResult.stderr}`)
    assert.equal(readFileSync(generatedVersionPath, 'utf8'), currentSource)
    assert.equal(readFileSync(repairMarkerPath, 'utf8'), 'true\n')
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

test('authoritative workflow check bypasses Bun preloads', () => {
  const temporaryRoot = createCheckFixture()
  const generatedVersionPath = resolve(temporaryRoot, 'src', 'generated', 'version.ts')
  const repairMarkerPath = resolve(temporaryRoot, 'preload-ran')
  const staleSource = '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "0.2.1"\n'
  const currentSource = '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "0.2.0"\n'
  try {
    writeFileSync(generatedVersionPath, staleSource, 'utf8')
    writeFileSync(resolve(temporaryRoot, 'bunfig.toml'), 'preload = ["./repair-generated.ts"]\n', 'utf8')
    writeFileSync(
      resolve(temporaryRoot, 'repair-generated.ts'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('./src/generated/version.ts', import.meta.url), ${JSON.stringify(currentSource)})\nwriteFileSync(new URL('./preload-ran', import.meta.url), ${JSON.stringify('true\n')})\n`,
      'utf8',
    )

    const result = runWorkflowGeneratedVersionCheck(temporaryRoot)
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr.includes(staleGeneratedVersionMessage), true)
    assert.equal(readFileSync(generatedVersionPath, 'utf8'), staleSource)
    assert.equal(existsSync(repairMarkerPath), false)

    const bunResult = spawnSync('bun', ['run', './scripts/check-generated-version.ts'], {
      cwd: temporaryRoot,
      encoding: 'utf8',
    })
    assert.equal(bunResult.status, 0, `${bunResult.stdout}${bunResult.stderr}`)
    assert.equal(readFileSync(generatedVersionPath, 'utf8'), currentSource)
    assert.equal(readFileSync(repairMarkerPath, 'utf8'), 'true\n')
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

test('generated-version check preserves unrelated generated-source I/O failures', () => {
  const temporaryRoot = createCheckFixture()
  const generatedVersionPath = resolve(temporaryRoot, 'src', 'generated', 'version.ts')
  try {
    mkdirSync(generatedVersionPath)
    const result = runFixtureScript(temporaryRoot, 'check-generated-version.ts')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /EISDIR/)
    assert.equal(result.stderr.includes(staleGeneratedVersionMessage), false)
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})

test('build regenerates the exact package-version source in an isolated repository', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'encephalon-package-version-build-'))
  try {
    mkdirSync(resolve(temporaryRoot, 'scripts'))
    mkdirSync(resolve(temporaryRoot, 'src'))
    for (const filename of ['build.ts', 'package-version.ts']) {
      writeFileSync(
        resolve(temporaryRoot, 'scripts', filename),
        readFileSync(resolve(root, 'scripts', filename), 'utf8'),
        'utf8',
      )
    }
    symlinkSync(resolve(root, 'node_modules'), resolve(temporaryRoot, 'node_modules'), 'junction')
    writeFileSync(resolve(temporaryRoot, 'package.json'), '{"type":"module","version":"1.2.3-fixture"}\n', 'utf8')
    writeFileSync(resolve(temporaryRoot, 'src', 'index.ts'), 'export const fixture = true\n', 'utf8')
    writeFileSync(resolve(temporaryRoot, 'src', 'cli.ts'), '#!/usr/bin/env node\nexport {}\n', 'utf8')
    writeFileSync(
      resolve(temporaryRoot, 'tsconfig.build.json'),
      `${JSON.stringify({
        compilerOptions: {
          declaration: true,
          declarationDir: './dist',
          emitDeclarationOnly: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: false,
          rootDir: './src',
          target: 'ES2024',
        },
        include: ['src/**/*.ts'],
      })}\n`,
      'utf8',
    )

    const result = spawnSync('bun', ['run', resolve(temporaryRoot, 'scripts', 'build.ts')], {
      cwd: temporaryRoot,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.equal(
      readFileSync(resolve(temporaryRoot, 'src', 'generated', 'version.ts'), 'utf8'),
      '// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "1.2.3-fixture"\n',
    )
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})
