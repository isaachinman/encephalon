import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { spawnNpmCommand } from './npm-command.ts'
import * as packagePreflightAuthority from './package-preflight.ts'
import { preflightExactPackageArtifact } from './package-preflight.ts'

const sourceRoot = resolve(import.meta.dirname, '..')
const fixturePaths = [
  '.gitignore',
  'package.json',
  'src',
  'dist',
  'skills',
  'assets/encephalon.png',
  'docs/performance.md',
  'docs/performance-baseline.json',
  'docs/performance-budgets.json',
  'README.md',
  'LICENSE',
] as const

test('keeps archive modes strict while accepting the two npm CLI modes on Windows', () => {
  const authority = packagePreflightAuthority as typeof packagePreflightAuthority & {
    reviewedPackageArchiveMode?: (path: string, mode: number, platform: NodeJS.Platform) => boolean
  }
  assert.equal(typeof authority.reviewedPackageArchiveMode, 'function')
  assert.equal(authority.reviewedPackageArchiveMode?.('dist/cli.mjs', 0o755, 'linux'), true)
  assert.equal(authority.reviewedPackageArchiveMode?.('dist/cli.mjs', 0o644, 'linux'), false)
  assert.equal(authority.reviewedPackageArchiveMode?.('dist/cli.mjs', 0o755, 'win32'), true)
  assert.equal(authority.reviewedPackageArchiveMode?.('dist/cli.mjs', 0o644, 'win32'), true)
  assert.equal(authority.reviewedPackageArchiveMode?.('dist/cli.mjs', 0o600, 'win32'), false)
  assert.equal(authority.reviewedPackageArchiveMode?.('README.md', 0o644, 'win32'), true)
  assert.equal(authority.reviewedPackageArchiveMode?.('README.md', 0o755, 'win32'), false)
})

const runGit = (root: string, arguments_: readonly string[]) => {
  const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}

const writeMetadata = (
  root: string,
  tarball: string,
  overrides: Readonly<{ packageVersion?: string; sha256?: string; sourceCommit?: string }> = {},
) => {
  const bytes = readFileSync(tarball)
  const sha512 = createHash('sha512').update(bytes)
  const metadata = {
    bytes: bytes.length,
    integrity: `sha512-${sha512.copy().digest('base64')}`,
    packageVersion: overrides.packageVersion ?? '0.3.0',
    sha1: createHash('sha1').update(bytes).digest('hex'),
    sha256: overrides.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
    sha512: sha512.digest('hex'),
    sourceCommit: overrides.sourceCommit ?? runGit(root, ['rev-parse', 'HEAD']),
    tarball: 'package-artifacts/encephalon-0.3.0.tgz',
  }
  writeFileSync(`${tarball}.metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`)
}

const createFixture = (
  beforePack: (root: string) => void = () => {},
  metadataOverrides: Readonly<{ packageVersion?: string; sha256?: string; sourceCommit?: string }> = {},
) => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-package-preflight-'))
  const root = resolve(temporaryRoot, 'repository')
  for (const path of fixturePaths) {
    const destination = resolve(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(resolve(sourceRoot, path), destination, { recursive: true })
  }
  runGit(root, ['init', '--quiet'])
  runGit(root, ['add', '--', '.gitignore', 'package.json', 'src', 'skills', 'assets', 'docs', 'README.md', 'LICENSE'])
  runGit(root, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Encephalon Test',
    '-c',
    'user.email=encephalon-test@example.invalid',
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    'Preflight fixture',
  ])
  beforePack(root)
  const artifactDirectory = resolve(root, 'package-artifacts')
  mkdirSync(artifactDirectory)
  const packed = spawnNpmCommand(
    ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', artifactDirectory],
    {
      cwd: root,
      environment: { ...process.env, npm_config_cache: resolve(temporaryRoot, 'npm-cache') },
    },
  )
  assert.equal(packed.status, 0, `${packed.stdout}${packed.stderr}`)
  const [pack] = JSON.parse(packed.stdout ?? '') as Array<{ filename?: unknown }>
  assert.equal(pack?.filename, 'encephalon-0.3.0.tgz')
  const tarball = resolve(artifactDirectory, 'encephalon-0.3.0.tgz')
  writeMetadata(root, tarball, metadataOverrides)
  const snapshotDirectory = resolve(temporaryRoot, 'snapshot')
  mkdirSync(snapshotDirectory)
  return { root, snapshotDirectory, tarball, temporaryRoot }
}

test('accepts one exact fixed artifact pair and returns a private reviewed snapshot', () => {
  const fixture = createFixture()
  try {
    const preflight = preflightExactPackageArtifact({
      root: fixture.root,
      snapshotDirectory: fixture.snapshotDirectory,
      tarballPath: fixture.tarball,
    })

    assert.equal(preflight.metadata.packageVersion, '0.3.0')
    assert.equal(preflight.metadata.sourceCommit, runGit(fixture.root, ['rev-parse', 'HEAD']))
    assert.notEqual(preflight.snapshot.path, fixture.tarball)
    assert.deepEqual(preflight.snapshot.digests, {
      bytes: preflight.metadata.bytes,
      integrity: preflight.metadata.integrity,
      sha1: preflight.metadata.sha1,
      sha256: preflight.metadata.sha256,
      sha512: preflight.metadata.sha512,
    })
  } finally {
    rmSync(fixture.temporaryRoot, { force: true, recursive: true })
  }
})

test('rejects forged sidecar, packed content, package version, and source commit independently', () => {
  const cases = [
    {
      create: () => createFixture(() => {}, { sha256: '0'.repeat(64) }),
      label: 'sidecar',
    },
    {
      create: () => {
        let originalReadme = ''
        const fixture = createFixture(root => {
          const readme = resolve(root, 'README.md')
          originalReadme = readFileSync(readme, 'utf8')
          writeFileSync(readme, originalReadme.replace('Encephalon', 'Tamperhere'))
        })
        writeFileSync(resolve(fixture.root, 'README.md'), originalReadme)
        return fixture
      },
      label: 'content',
    },
    {
      create: () => createFixture(() => {}, { packageVersion: '9.9.9' }),
      label: 'version',
    },
    {
      create: () => createFixture(() => {}, { sourceCommit: 'a'.repeat(40) }),
      label: 'commit',
    },
  ] as const

  for (const { create, label } of cases) {
    const fixture = create()
    try {
      assert.throws(
        () =>
          preflightExactPackageArtifact({
            root: fixture.root,
            snapshotDirectory: fixture.snapshotDirectory,
            tarballPath: fixture.tarball,
          }),
        /artifact|metadata|package|reviewed|source/u,
        label,
      )
    } finally {
      rmSync(fixture.temporaryRoot, { force: true, recursive: true })
    }
  }
})
