import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { spawnNpmCommand } from '../scripts/npm-command.ts'
import { PACKAGE_VERSION } from '../src/generated/version.ts'

const root = resolve(import.meta.dirname, '..')
const releaseVersion = '0.3.0'
const metadataPath = (tarball: string) => `${tarball}.metadata.json`

const gitHead = (repositoryRoot: string) => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}

const writeArtifactMetadata = (tarball: string, repositoryRoot: string, packageVersion = releaseVersion) => {
  const bytes = readFileSync(tarball)
  const sha512Hash = createHash('sha512').update(bytes)
  const metadata = {
    bytes: bytes.length,
    integrity: `sha512-${sha512Hash.copy().digest('base64')}`,
    packageVersion,
    sha1: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha512: sha512Hash.digest('hex'),
    sourceCommit: gitHead(repositoryRoot),
    tarball: relative(repositoryRoot, tarball).split(sep).join('/'),
  }
  writeFileSync(metadataPath(tarball), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

const tarField = (header: Buffer, offset: number, length: number) => {
  const field = header.subarray(offset, offset + length)
  const nul = field.indexOf(0)
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8')
}

const mutatePackedFile = (
  source: string,
  destination: string,
  packedPath: string,
  mutate: (bytes: Buffer) => Buffer,
) => {
  const archive = gunzipSync(readFileSync(source))
  let offset = 0
  let found = false
  while (offset + 512 <= archive.length && !found) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      offset = archive.length
    } else {
      const name = tarField(header, 0, 100)
      const prefix = tarField(header, 345, 155)
      const path = prefix.length > 0 ? `${prefix}/${name}` : name
      const size = Number.parseInt(tarField(header, 124, 12).trim(), 8)
      const contentOffset = offset + 512
      if (path === packedPath) {
        const original = Buffer.from(archive.subarray(contentOffset, contentOffset + size))
        const replacement = mutate(original)
        assert.equal(replacement.length, original.length)
        replacement.copy(archive, contentOffset)
        found = true
      }
      offset = contentOffset + Math.ceil(size / 512) * 512
    }
  }
  assert.equal(found, true, packedPath)
  writeFileSync(destination, gzipSync(archive))
}
const published020ChangelogSection = `## [0.2.0] - 2026-08-09

### Added

- Added bounded baseline scanning with deterministic directory ordering and symlink-safe traversal.
- Added package-manager evidence to baseline records instead of inferring npm from incomplete repository metadata.
- Added explicit request, response, corpus, cache, and performance budgets.
- Added package and publish-contract checks to CI, including inspection of the packed package.
- Added a replacement CLI parser and aligned generated TypeScript declarations with the supported Node.js runtime.

### Changed

- Made canonical record staging, publication, instruction-file writes, and post-commit recovery safer across filesystem failures.
- Made cache hydration and gather reads transactional, snapshot-consistent, and resilient to malformed disposable state.
- Made compact search avoid materialising full record JSON and removed persistent-style copying from hot scans.
- Centralised the package version and separated cache schema compatibility from diagnostic package metadata.
- Improved validation of record graphs, kind directories, artifact paths, Windows filename portability, and locale-independent ordering.

### Fixed

- Classified expected filesystem and SQLite environment failures separately from internal defects.
- Made committed add failures report the affected post-commit recovery phase explicitly.
- Made generated baseline refreshes converge on one canonical snapshot.
- Deflaked instruction replacement identity checks across supported platforms.

### Documentation

- Corrected README privacy and packaged-asset claims.
- Resolved implementation-plan drift and removed obsolete documentation surface.
- Added performance baselines and CI budgets for prepare, hydrate, search, and cache-size behaviour.

`
const forbiddenRuntimeDependencyValues = {
  bundleDependencies: ['runtime-package'],
  bundledDependencies: ['runtime-package'],
  dependencies: { 'runtime-package': '1.0.0' },
  optionalDependencies: { 'runtime-package': '1.0.0' },
  peerDependencies: { 'runtime-package': '1.0.0' },
  peerDependenciesMeta: { 'runtime-package': { optional: true } },
} as const

const packageFixturePaths = [
  'package.json',
  'scripts/check-package.ts',
  'scripts/package-declaration-consumer.ts',
  'scripts/npm-command.ts',
  'scripts/package-preflight.ts',
  'scripts/package-tarball.ts',
  'scripts/package-version.ts',
  'scripts/release-contracts.ts',
  'src',
  'dist',
  'skills/encephalon/SKILL.md',
  'assets/encephalon.png',
  'docs/performance.md',
  'docs/performance-baseline.json',
  'docs/performance-budgets.json',
  'README.md',
  'LICENSE',
] as const

const createPackageCheckFixture = (prefix: string) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), prefix))
  const fixtureRoot = resolve(temporaryRoot, 'repository')
  for (const path of packageFixturePaths) {
    const destination = resolve(fixtureRoot, path)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(resolve(root, path), destination, { recursive: true })
  }
  symlinkSync(resolve(root, 'node_modules'), resolve(fixtureRoot, 'node_modules'), 'junction')
  const initialise = spawnSync('git', ['init', '--quiet'], { cwd: fixtureRoot, encoding: 'utf8' })
  assert.equal(initialise.status, 0, `${initialise.stdout}${initialise.stderr}`)
  const stage = spawnSync(
    'git',
    ['add', '--', 'package.json', 'src', 'skills', 'assets', 'docs', 'README.md', 'LICENSE'],
    { cwd: fixtureRoot, encoding: 'utf8' },
  )
  assert.equal(stage.status, 0, `${stage.stdout}${stage.stderr}`)
  const commit = spawnSync(
    'git',
    [
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
      'Package fixture',
    ],
    { cwd: fixtureRoot, encoding: 'utf8' },
  )
  assert.equal(commit.status, 0, `${commit.stdout}${commit.stderr}`)
  return { fixtureRoot, temporaryRoot }
}

const createPublishCheckFixture = () => {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'encephalon-publish-tarball-')))
  const scriptsDirectory = resolve(temporaryRoot, 'scripts')
  const tarball = resolve(temporaryRoot, 'candidate.tgz')
  const capturedArguments = resolve(temporaryRoot, 'npm-arguments.json')
  mkdirSync(scriptsDirectory)
  cpSync(resolve(root, 'scripts', 'check-publish.ts'), resolve(scriptsDirectory, 'check-publish.ts'))
  cpSync(resolve(root, 'scripts', 'npm-publish-conflict.ts'), resolve(scriptsDirectory, 'npm-publish-conflict.ts'))
  cpSync(resolve(root, 'scripts', 'package-tarball.ts'), resolve(scriptsDirectory, 'package-tarball.ts'))
  writeFileSync(
    resolve(scriptsDirectory, 'package-preflight.ts'),
    `import { snapshotPackageTarball, verifyPackageArtifactMetadata } from './package-tarball.ts'
export const preflightExactPackageArtifact = ({ snapshotDirectory, tarballPath }) => {
  const metadata = verifyPackageArtifactMetadata(tarballPath)
  const snapshot = snapshotPackageTarball(tarballPath, snapshotDirectory)
  return { metadata, snapshot }
}
`,
  )
  writeFileSync(resolve(temporaryRoot, 'package.json'), '{"type":"module"}\n')
  writeFileSync(tarball, 'candidate tarball')
  writeFileSync(
    metadataPath(tarball),
    `${JSON.stringify(
      {
        bytes: 17,
        integrity: 'sha512-pTxmTw4D11aGOhLuuuLi7XMdkIwxMD/CLeWekvX9m00fIf2X+zxgZ/yhlV2/ZgbNj9U6a6zJFfMCchSrkKTj8A==',
        packageVersion: releaseVersion,
        sha1: '4d85c35b6eaaf3bb12766dd30b7f6d763bd34be8',
        sha256: '840e0eaa94a08f97f361ebdc32d46cb60b9e94a5f10773d0647b363847605b67',
        sha512:
          'a53c664f0e03d756863a12eebae2e2ed731d908c31303fc22de59e92f5fd9b4d1f21fd97fb3c6067fca1955dbf6606cd8fd53a6bacc915f3027214ab90a4e3f0',
        sourceCommit: 'a'.repeat(40),
        tarball: 'candidate.tgz',
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    resolve(scriptsDirectory, 'npm-command.ts'),
    `import { readFileSync, renameSync, writeFileSync } from 'node:fs'
export const spawnNpmCommand = (arguments_, options) => {
  const source = process.env.ENCEPHALON_TEST_NPM_SOURCE
  renameSync(source, source + '.original')
  writeFileSync(source, 'replacement tarball bytes')
  writeFileSync(process.env.ENCEPHALON_TEST_NPM_CAPTURE, JSON.stringify({
    arguments: arguments_,
    cwd: options.cwd,
    targetBytes: readFileSync(arguments_[1], 'utf8'),
  }))
  return JSON.parse(process.env.ENCEPHALON_TEST_NPM_RESULT)
}
`,
  )
  return { capturedArguments, tarball, temporaryRoot }
}

const runPublishCheckFixture = (temporaryRoot: string, arguments_: readonly string[], result: object) =>
  spawnSync(process.execPath, ['./scripts/check-publish.ts', ...arguments_], {
    cwd: temporaryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ENCEPHALON_TEST_NPM_CAPTURE: resolve(temporaryRoot, 'npm-arguments.json'),
      ENCEPHALON_TEST_NPM_RESULT: JSON.stringify(result),
      ENCEPHALON_TEST_NPM_SOURCE: resolve(temporaryRoot, 'candidate.tgz'),
    },
  })

const changelogSection = (changelog: string, version: string, followingVersion: string): string => {
  const start = changelog.indexOf(`## [${version}]`)
  const end = changelog.indexOf(`## [${followingVersion}]`, start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return changelog.slice(start, end)
}

const assertInstalledVersionSurfaces = (consumer: string) => {
  const apiProbe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { DatabaseSync } from 'node:sqlite'
const api = await import('encephalon')
api.prepare({ root: process.cwd() })
const database = new DatabaseSync('node_modules/.cache/encephalon/brain.sqlite', { readOnly: true })
try {
  const row = database.prepare("SELECT value FROM metadata WHERE key = 'packageVersion'").get()
  process.stdout.write(String(row?.value ?? ''))
} finally {
  database.close()
}`,
    ],
    { cwd: consumer, encoding: 'utf8', timeout: 30_000 },
  )
  assert.equal(apiProbe.status, 0, `${apiProbe.stdout}${apiProbe.stderr}`)
  assert.equal(apiProbe.stdout, releaseVersion)

  const cli = spawnSync(
    process.execPath,
    [resolve(consumer, 'node_modules', 'encephalon', 'dist', 'cli.mjs'), '--version'],
    {
      cwd: consumer,
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  assert.equal(cli.status, 0, `${cli.stdout}${cli.stderr}`)
  assert.equal(cli.stdout, `${releaseVersion}\n`)
}

describe('package contract', () => {
  test('declares a zero-runtime-dependency Node ESM package', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>

    assert.equal(packageJson.name, 'encephalon')
    assert.equal(packageJson.version, PACKAGE_VERSION)
    assert.equal(packageJson.type, 'module')
    assert.deepEqual(packageJson.engines, { node: '>=24.15.0' })
    assert.deepEqual(packageJson.bin, { encephalon: 'dist/cli.mjs' })
    for (const field of Object.keys(forbiddenRuntimeDependencyValues)) {
      assert.equal(packageJson[field], undefined, field)
    }

    const scripts = packageJson.scripts as Record<string, unknown> | undefined
    assert.equal(scripts?.install, undefined)
    assert.equal(scripts?.preinstall, undefined)
    assert.equal(scripts?.postinstall, undefined)
    assert.equal(scripts?.prepare, undefined)
  })

  test('rejects every runtime dependency manifest field', () => {
    const failures = Object.entries(forbiddenRuntimeDependencyValues).map(([field, value]) => {
      const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-dependency-')
      try {
        const packageJson = JSON.parse(readFileSync(resolve(fixtureRoot, 'package.json'), 'utf8')) as Record<
          string,
          unknown
        >
        writeFileSync(resolve(fixtureRoot, 'package.json'), `${JSON.stringify({ ...packageJson, [field]: value })}\n`)
        return {
          field,
          result: spawnSync(process.execPath, ['./scripts/check-package.ts'], {
            cwd: fixtureRoot,
            encoding: 'utf8',
            timeout: 30_000,
          }),
        }
      } finally {
        rmSync(temporaryRoot, { force: true, recursive: true })
      }
    })

    for (const { field, result } of failures) {
      assert.notEqual(result.status, 0, field)
      assert.equal(result.stdout, '', field)
      assert.match(result.stderr, /zero-runtime-dependency contract is invalid/u, field)
    }
  })

  test('has a side-effect-free TypeScript API entrypoint', () => {
    assert.equal(existsSync(resolve(root, 'src/index.ts')), true)
    const declarations = ['index.d.ts', 'baseline.d.ts', 'cache.d.ts', 'canonical-layout.d.ts', 'records.d.ts']
      .map(file => readFileSync(resolve(root, 'dist', file), 'utf8'))
      .join('\n')
    assert.doesNotMatch(
      declarations,
      /BaselineWork|RecordWork|WorkObserver|afterGatherSearchEvaluation|cacheReadTestHooks|onEntry|onWork|scanBaselineWithHooks|validateRecordsResolved/,
    )
  })

  test('keeps generated runtime version metadata in sync with the manifest', () => {
    const generated = readFileSync(resolve(root, 'src', 'generated', 'version.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }

    assert.equal(PACKAGE_VERSION, packageJson.version)
    assert.equal(generated.includes(`PACKAGE_VERSION = ${JSON.stringify(PACKAGE_VERSION)}`), true)
  })

  test('reports the 0.3.0 release version from source, built, and packed API and CLI surfaces', {
    timeout: 75_000,
  }, () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    const generated = readFileSync(resolve(root, 'src', 'generated', 'version.ts'), 'utf8')
    assert.equal(packageJson.version, releaseVersion)
    assert.equal(PACKAGE_VERSION, releaseVersion)
    assert.equal(
      generated,
      `// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = "${releaseVersion}"\n`,
    )

    const builtConsumer = mkdtempSync(join(tmpdir(), 'encephalon-built-version-'))
    const packedConsumer = mkdtempSync(join(tmpdir(), 'encephalon-packed-version-'))
    const packageDirectory = mkdtempSync(join(tmpdir(), 'encephalon-release-package-'))
    try {
      for (const consumer of [builtConsumer, packedConsumer]) {
        mkdirSync(resolve(consumer, '.git'))
        writeFileSync(resolve(consumer, 'package.json'), '{"name":"version-probe","private":true,"type":"module"}\n')
      }
      mkdirSync(resolve(builtConsumer, 'node_modules'))
      symlinkSync(root, resolve(builtConsumer, 'node_modules', 'encephalon'), 'junction')
      assertInstalledVersionSurfaces(builtConsumer)

      const packed = spawnNpmCommand(
        ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', packageDirectory],
        { cwd: root },
      )
      assert.equal(packed.status, 0, `${packed.stdout}${packed.stderr}`)
      const [result] = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>
      assert.equal(typeof result?.filename, 'string')
      const tarball = resolve(packageDirectory, String(result?.filename))
      const installed = spawnNpmCommand(
        ['install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', tarball],
        { cwd: packedConsumer },
      )
      assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`)
      assertInstalledVersionSurfaces(packedConsumer)
    } finally {
      rmSync(builtConsumer, { force: true, recursive: true })
      rmSync(packedConsumer, { force: true, recursive: true })
      rmSync(packageDirectory, { force: true, recursive: true })
    }
  })

  test('preserves the complete published 0.2.0 changelog section', () => {
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
    const section = changelogSection(changelog, '0.2.0', '0.1.0')

    assert.equal(section, published020ChangelogSection)
    const leakedClaims = [
      'Isolated every benchmark operation sample',
      'Assigned record creation timestamps under the repository operation lock',
      'Validated disposable SQLite table, constraint, index, and FTS5 semantics',
      'Normalised negative-zero confidence',
      'Applied payload node budgets before avoidable descriptor and output allocation',
      'Rejected multiply linked mutable SQLite primaries',
    ].filter(postPublicationClaim => section.includes(postPublicationClaim))
    assert.deepEqual(leakedClaims, [])
  })

  test('documents the dated 0.3.0 compatibility and exact-artifact release above 0.2.0', () => {
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
    const releaseStart = changelog.indexOf('## [0.3.0] - 2026-08-27')
    const publishedStart = changelog.indexOf('## [0.2.0] - 2026-08-09')
    assert.notEqual(releaseStart, -1)
    assert.equal(releaseStart < publishedStart, true)
    const section = changelog.slice(releaseStart, publishedStart)

    const missingClaims = [
      /published 0\.2\.0.*compatibility/isu,
      /1,000.*result limit/isu,
      /exact.*candidate.*tarball/isu,
      /schema 1.*schema 2.*schema 1/isu,
      /stable canonical.*snapshot/isu,
      /negative-zero/isu,
      /bounded.*recovery/isu,
    ].filter(requiredClaim => !requiredClaim.test(section))
    assert.deepEqual(missingClaims, [])
  })

  test('ships the generic repository-memory skill', () => {
    const skill = readFileSync(resolve(root, 'skills', 'encephalon', 'SKILL.md'), 'utf8')
    assert.equal(skill.includes('npx --no-install encephalon search'), true)
    assert.equal(skill.includes('--supersedes'), true)
    assert.equal(skill.includes('npx --no-install encephalon validate'), true)
    assert.equal(skill.includes('Do not stage, commit, push'), true)
  })

  test('marks the old implementation plan historical and maintains a concise contract', () => {
    const implementationPlan = readFileSync(resolve(root, 'docs', 'implementation-plan.md'), 'utf8')
    const contract = readFileSync(resolve(root, 'docs', 'contract.md'), 'utf8')
    const performance = readFileSync(resolve(root, 'docs', 'performance.md'), 'utf8')
    const superpowersArchive = resolve(
      root,
      'encephalon',
      '_artifacts',
      'context',
      '8afddab6-4b74-4f16-8144-0b409ef880c7',
      'specs',
    )
    const operationBudgetsDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-13-operation-budgets-design.md'),
      'utf8',
    )
    const boundedCacheValidationDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-16-bounded-cache-validation-design.md'),
      'utf8',
    )
    const semanticCacheSchemaDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-17-sqlite-schema-semantics-design.md'),
      'utf8',
    )
    const ftsTextIntegrityDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-17-fts-text-integrity-design.md'),
      'utf8',
    )
    const responseByteBudgetsDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-17-response-byte-budgets-design.md'),
      'utf8',
    )
    const unicodeLiteralSearchDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-18-unicode-literal-search-design.md'),
      'utf8',
    )
    const singlePassCacheReadDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-18-single-pass-cache-read-design.md'),
      'utf8',
    )
    const gatherDeduplicationDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-18-gather-deduplication-design.md'),
      'utf8',
    )
    const validatedMutationCacheDesign = readFileSync(
      resolve(superpowersArchive, '2026-08-22-validated-mutation-cache-design.md'),
      'utf8',
    )

    assert.match(implementationPlan, /Status: historical design input; not the maintained normative contract/)
    assert.match(implementationPlan, /\[`docs\/contract\.md`]\(\.\/contract\.md\)/)
    assert.doesNotMatch(implementationPlan, /createdAt is assigned only after the repository operation lock is held/)
    assert.match(contract, /## Public API and CLI/)
    assert.match(contract, /## Operation Budgets/)
    assert.match(contract, /## Unicode Literal Search/)
    assert.match(contract, /## Canonical Storage/)
    assert.match(contract, /## Stable Canonical Read Snapshots/)
    assert.match(contract, /## Partial Initialisation Progress/)
    assert.match(contract, /## Cache Compatibility/)
    assert.match(contract, /## Bounded Disposable Cache Validation/)
    assert.match(contract, /## Gather Deduplication/)
    assert.match(contract, /Cache schema compatibility requires the exact owned ordinary-table semantics/)
    assert.match(contract, /## Package and Release Gates/)
    assert.match(contract, /## Historical Plan Divergence Checklist/)
    assert.doesNotMatch(contract, /MAR-2640 required current-Node.*`[0-9a-f]{40}`/u)
    assert.match(
      contract,
      /Stable response-budget names are `fullResponseBytes`, `compactResponseBytes`, and `gatherResponseBytes`\./,
    )
    assert.match(
      contract,
      /MAR-2554 bounded full, compact, and gather read responses: `b43daf795de35d34602d1018ad509f68e494fe3d`\./,
    )
    assert.match(
      contract,
      /Last reviewed: 2026-08-26 for code and behavioural-test snapshot `c17834e5d4f4129c8f8374713be224c54ab4a39f`\./,
    )
    assert.match(
      contract,
      /MAR-2575 stable canonical read and validation snapshots with one bounded operation-scoped retry ledger: `c17834e5d4f4129c8f8374713be224c54ab4a39f`\./,
    )
    assert.match(
      contract,
      /MAR-2641 negative-zero confidence normalisation across validation, canonical storage, mutation-cache hydration, public reads, and CLI output: `b6de02d1c5c6eab7d98e7d4525b8dee41035f1ab`\./,
    )
    assert.match(
      contract,
      /MAR-2576 bounded payload property inspection, allocation-order enforcement, canonical-output compatibility, and packed API coverage: `58ba821f4b655fad1b1e79be9df57600e7409381`\./,
    )
    assert.match(contract, /Each successful public cache read validates its cache generation exactly once/)
    assert.match(
      contract,
      /MAR-2552 single-pass cache reads and identity-bound recovery: `9b5821d59999215f975d613edf4a9c252fb6258d`\./,
    )
    assert.match(
      singlePassCacheReadDesign,
      /The exact code and behavioural-test snapshot implementing this design is `9b5821d59999215f975d613edf4a9c252fb6258d`\./,
    )
    assert.match(
      gatherDeduplicationDesign,
      /The exact implementation and behavioural-test snapshot is `36091c7e886b67b5c5bc355e6bcdb078f9a74f85`\./,
    )
    assert.match(
      validatedMutationCacheDesign,
      /The exact implementation and behavioural-test snapshot is `30104a049f72ba2e87f51af95d5da11b55045cc3`\./,
    )
    assert.match(
      contract,
      /MAR-2560 snapshot-local exact-key gather deduplication: `36091c7e886b67b5c5bc355e6bcdb078f9a74f85`\./,
    )
    assert.match(
      contract,
      /MAR-2565 validated mutation cache construction, deterministic disk fallback, and unchanged public error semantics: `30104a049f72ba2e87f51af95d5da11b55045cc3`\./,
    )
    assert.match(contract, /## Performance Evidence/)
    assert.match(contract, /implementing the MAR-2566 benchmark guarantees above/)
    assert.match(contract, /MAR-2568 behavioural hot-scan work bounds: `de66f6ab7e10696fc878e380dd5417d194d60fe8`\./)
    assert.match(performance, /## Validated mutation snapshot comparison/)
    assert.match(performance, /Correctness tests enforce deterministic output and bounded work counts/)
    assert.match(
      contract,
      /MAR-2566 isolated operation performance samples, additive phase boundaries, schema-version 2 distributions and strict budgets: `eae98315e53ce568c62f6854a8542b285b7f9e4f`\./,
    )
    assert.match(
      contract,
      /MAR-2548 restart-safe partial initialisation progress and convergence: `f388a67819e2bebcabcaa5051bab6fe8985dd4ab`\./,
    )
    assert.match(
      contract,
      /MAR-2563 operation-locked record timestamp assignment, locked canonical authority, and cross-process ordering: `2874874096bb7d327e084d7e17d5243564244c43`\./,
    )
    assert.match(
      contract,
      /MAR-2549 bounded disposable cache validation and exact-generation recovery: `fa5c1688c274b4f0f8fdc94ea102ed6cb1f0a4dd`\./,
    )
    assert.match(contract, /Historical plan's wall-clock-only `createdAt` policy/)
    assert.match(
      operationBudgetsDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `1e913807c20a332dc49a004be672205fbeabfe15`\./,
    )
    assert.match(
      boundedCacheValidationDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `fa5c1688c274b4f0f8fdc94ea102ed6cb1f0a4dd`\./,
    )
    assert.match(
      semanticCacheSchemaDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `f539720542a3302dd849002652e958da4a6063bf`\./,
    )
    assert.match(
      ftsTextIntegrityDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `2a68ce4dc839481a91b9afd6fb44a13ace13cb26`\./,
    )
    assert.match(
      responseByteBudgetsDesign,
      /The exact reviewed code and behavioural-test snapshot implementing this design is `b43daf795de35d34602d1018ad509f68e494fe3d`\./,
    )
    assert.match(
      unicodeLiteralSearchDesign,
      /The exact implementation and behavioural-test snapshot is `aa1a2596f4ca5be42b8896beedc802040eb57161`\./,
    )
    assert.match(
      readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'),
      /creation timestamps under the repository operation lock/,
    )
    assert.doesNotMatch(readFileSync(resolve(root, 'dist', 'api-input.d.ts'), 'utf8'), /ValidatedAddRecordInput/)
    assert.doesNotMatch(readFileSync(resolve(root, 'dist', 'errors.d.ts'), 'utf8'), /failBudget|operation-budgets/)
    assert.doesNotMatch(
      readFileSync(resolve(root, 'dist', 'cache-location.d.ts'), 'utf8'),
      /CacheDatabaseCreationConflict/,
    )
    assert.doesNotMatch(
      readFileSync(resolve(root, 'dist', 'operation-budgets.d.ts'), 'utf8'),
      /OPERATION_BUDGETS|OperationBudgetKey/,
    )
  })

  test('keeps installed command guidance aligned with root-install verification', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const skill = readFileSync(resolve(root, 'skills', 'encephalon', 'SKILL.md'), 'utf8')
    const contract = readFileSync(resolve(root, 'docs', 'contract.md'), 'utf8')

    assert.match(readme, /npx --no-install encephalon init/)
    assert.match(skill, /npx --no-install encephalon search/)
    assert.match(skill, /npx --no-install encephalon validate/)
    assert.match(contract, /npx --no-install encephalon/)
    assert.doesNotMatch(skill, /node \.\/node_modules\/encephalon\/dist\/cli\.mjs/)
  })

  test('retains the exact package tarball exercised by the package checker', { timeout: 75_000 }, () => {
    const artifactParentName = join('test', `.package-artifacts-test-${randomUUID()}`)
    const artifactDirectoryName = join(artifactParentName, 'nested')
    const artifactParent = resolve(root, artifactParentName)
    const artifactDirectory = resolve(root, artifactDirectoryName)
    const referenceDirectory = mkdtempSync(join(tmpdir(), 'encephalon-package-reference-'))
    try {
      mkdirSync(artifactParent)
      const result = spawnSync(
        process.execPath,
        ['./scripts/check-package.ts', '--retain-tarball', artifactDirectoryName],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
        },
      )
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
      const retainedFilename = `encephalon-${PACKAGE_VERSION}.tgz`
      assert.equal(result.stdout, `${artifactDirectoryName.split(sep).join('/')}/${retainedFilename}\n`)
      assert.deepEqual(readdirSync(artifactDirectory).sort(), [retainedFilename, `${retainedFilename}.metadata.json`])

      const retainedMetadata = JSON.parse(
        readFileSync(resolve(artifactDirectory, `${retainedFilename}.metadata.json`), 'utf8'),
      ) as Record<string, unknown>
      assert.deepEqual(retainedMetadata, {
        ...JSON.parse(result.stderr),
        packageVersion: releaseVersion,
        sourceCommit: gitHead(root),
        tarball: `${artifactDirectoryName.split(sep).join('/')}/${retainedFilename}`,
      })

      const referenceResult = spawnNpmCommand(
        ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', referenceDirectory],
        { cwd: root },
      )
      assert.equal(referenceResult.status, 0, `${referenceResult.stdout}${referenceResult.stderr}`)
      const [referencePack] = JSON.parse(referenceResult.stdout) as Array<{ filename?: unknown }>
      assert.equal(referencePack?.filename, retainedFilename)
      assert.deepEqual(
        readFileSync(resolve(artifactDirectory, retainedFilename)),
        readFileSync(resolve(referenceDirectory, retainedFilename)),
      )

      const suppliedResult = spawnSync(
        process.execPath,
        ['./scripts/check-package.ts', '--tarball', `${artifactDirectoryName}/${retainedFilename}`],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
        },
      )
      assert.equal(suppliedResult.status, 0, `${suppliedResult.stdout}${suppliedResult.stderr}`)
      assert.equal(suppliedResult.stdout, '')
    } finally {
      rmSync(artifactParent, { force: true, recursive: true })
      rmSync(referenceDirectory, { force: true, recursive: true })
    }
  })

  test('binds supplied package checks to one private snapshot without invoking npm pack', { timeout: 75_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-supplied-')
    const packageDirectory = resolve(fixtureRoot, 'package-artifacts')
    const capturedInstall = resolve(fixtureRoot, 'captured-install.json')
    try {
      mkdirSync(packageDirectory)
      const packResult = spawnNpmCommand(
        ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', packageDirectory],
        { cwd: fixtureRoot },
      )
      assert.equal(packResult.status, 0, `${packResult.stdout}${packResult.stderr}`)
      const [pack] = JSON.parse(packResult.stdout) as Array<{ filename?: unknown }>
      assert.equal(typeof pack?.filename, 'string')
      const suppliedTarball = resolve(packageDirectory, String(pack?.filename))
      const suppliedBytes = readFileSync(suppliedTarball)
      const expectedSha256 = createHash('sha256').update(suppliedBytes).digest('hex')
      writeArtifactMetadata(suppliedTarball, fixtureRoot)
      cpSync(resolve(fixtureRoot, 'scripts', 'npm-command.ts'), resolve(fixtureRoot, 'scripts', 'npm-command-real.ts'))
      writeFileSync(
        resolve(fixtureRoot, 'scripts', 'npm-command.ts'),
        `import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnNpmCommand as spawnRealNpmCommand } from './npm-command-real.ts'
export const spawnNpmCommand = (arguments_, options) => {
  if (arguments_[0] === 'pack') throw new Error('supplied mode invoked npm pack')
  renameSync(process.env.ENCEPHALON_TEST_SUPPLIED_TARBALL, process.env.ENCEPHALON_TEST_SUPPLIED_TARBALL + '.original')
  writeFileSync(process.env.ENCEPHALON_TEST_SUPPLIED_TARBALL, 'replacement tarball bytes')
  const target = arguments_.at(-1)
  writeFileSync(process.env.ENCEPHALON_TEST_CAPTURED_INSTALL, JSON.stringify({
    sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
    target,
  }))
  return spawnRealNpmCommand(arguments_, options)
}
`,
      )

      const result = spawnSync(
        process.execPath,
        ['./scripts/check-package.ts', '--tarball', `package-artifacts/${String(pack?.filename)}`],
        {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            ENCEPHALON_TEST_CAPTURED_INSTALL: capturedInstall,
            ENCEPHALON_TEST_SUPPLIED_TARBALL: suppliedTarball,
          },
          timeout: 60_000,
        },
      )
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
      const captured = JSON.parse(readFileSync(capturedInstall, 'utf8')) as { sha256?: unknown; target?: unknown }
      assert.equal(captured.sha256, expectedSha256)
      assert.notEqual(captured.target, suppliedTarball)
      assert.equal(existsSync(String(captured.target)), false)
      assert.equal(JSON.parse(result.stderr).sha256, expectedSha256)
      assert.equal(readFileSync(suppliedTarball, 'utf8'), 'replacement tarball bytes')
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects a mismatched supplied archive before executing the repository CLI', { timeout: 75_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-source-cli-')
    const packageDirectory = resolve(fixtureRoot, 'package-artifacts')
    const sentinel = resolve(temporaryRoot, 'source-cli-executed')
    try {
      mkdirSync(packageDirectory)
      const packed = spawnNpmCommand(
        ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', packageDirectory],
        { cwd: fixtureRoot },
      )
      assert.equal(packed.status, 0, `${packed.stdout}${packed.stderr}`)
      const [pack] = JSON.parse(packed.stdout ?? '') as Array<{ filename?: unknown }>
      const suppliedTarball = resolve(packageDirectory, String(pack?.filename))
      writeArtifactMetadata(suppliedTarball, fixtureRoot)

      const cliPath = resolve(fixtureRoot, 'dist', 'cli.mjs')
      const cliSource = readFileSync(cliPath, 'utf8')
      assert.equal(cliSource.startsWith('#!/usr/bin/env node\n'), true)
      writeFileSync(
        cliPath,
        cliSource.replace(
          '#!/usr/bin/env node\n',
          `#!/usr/bin/env node\nif (process.argv.includes('--version')) (await import('node:fs')).writeFileSync(${JSON.stringify(sentinel)}, 'executed')\n`,
        ),
      )

      const result = spawnSync(
        process.execPath,
        ['./scripts/check-package.ts', '--tarball', `package-artifacts/${String(pack?.filename)}`],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 60_000 },
      )
      assert.notEqual(result.status, 0)
      assert.equal(existsSync(sentinel), false, `${result.stdout}${result.stderr}`)
      assert.match(result.stderr, /reviewed package bytes|differ/iu)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects byte-modified and wrong-version supplied package tarballs', { timeout: 120_000 }, () => {
    const artifactParentName = join('test', `.package-invalid-test-${randomUUID()}`)
    const artifactParent = resolve(root, artifactParentName)
    try {
      mkdirSync(artifactParent)
      const packResult = spawnNpmCommand(
        ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', artifactParent],
        { cwd: root },
      )
      assert.equal(packResult.status, 0, `${packResult.stdout}${packResult.stderr}`)
      const [pack] = JSON.parse(packResult.stdout) as Array<{ filename?: unknown }>
      assert.equal(typeof pack?.filename, 'string')
      const originalTarball = resolve(artifactParent, String(pack?.filename))
      const modifiedTarball = resolve(artifactParent, 'byte-modified.tgz')
      const modifiedBytes = Buffer.from(readFileSync(originalTarball))
      modifiedBytes[0] = (modifiedBytes[0] ?? 0) ^ 0xff
      writeFileSync(modifiedTarball, modifiedBytes)
      writeArtifactMetadata(modifiedTarball, root)

      const wrongVersionTarball = resolve(artifactParent, 'wrong-version.tgz')
      const archive = gunzipSync(readFileSync(originalTarball))
      const expectedVersion = Buffer.from(`"version": "${PACKAGE_VERSION}"`, 'utf8')
      const wrongVersion = Buffer.from('"version": "9.9.9"', 'utf8')
      const versionOffset = archive.indexOf(expectedVersion)
      assert.notEqual(versionOffset, -1)
      wrongVersion.copy(archive, versionOffset)
      writeFileSync(wrongVersionTarball, gzipSync(archive))
      writeArtifactMetadata(wrongVersionTarball, root)

      const failures = [modifiedTarball, wrongVersionTarball].map(tarball =>
        spawnSync(process.execPath, ['./scripts/check-package.ts', '--tarball', relative(root, tarball)], {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
        }),
      )
      assert.deepEqual(
        failures.map(result => result.status === 0),
        [false, false],
      )
      assert.equal(
        failures.every(result => result.stdout === ''),
        true,
      )
      assert.equal(
        failures.every(result => !/Usage: check-package\.ts/u.test(result.stderr)),
        true,
      )
    } finally {
      rmSync(artifactParent, { force: true, recursive: true })
    }
  })

  test('rejects checksum-valid packed manifest and non-manifest byte mutations', { timeout: 120_000 }, () => {
    const artifactParentName = join('test', `.package-content-mutation-${randomUUID()}`)
    const artifactParent = resolve(root, artifactParentName)
    try {
      mkdirSync(artifactParent)
      const packed = spawnNpmCommand(
        ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', artifactParent],
        { cwd: root },
      )
      assert.equal(packed.status, 0, `${packed.stdout}${packed.stderr}`)
      const [pack] = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>
      const original = resolve(artifactParent, String(pack?.filename))
      const manifestMutation = resolve(artifactParent, 'manifest-mutation.tgz')
      const readmeMutation = resolve(artifactParent, 'readme-mutation.tgz')

      mutatePackedFile(original, manifestMutation, 'package/package.json', bytes => {
        const source = bytes.toString('utf8')
        assert.equal(source.includes('"prepack"'), true)
        return Buffer.from(source.replace('"prepack"', '"install"'))
      })
      mutatePackedFile(original, readmeMutation, 'package/README.md', bytes => {
        const source = bytes.toString('utf8')
        assert.equal(source.includes('Encephalon'), true)
        return Buffer.from(source.replace('Encephalon', 'tamperhere'))
      })
      writeArtifactMetadata(manifestMutation, root)
      writeArtifactMetadata(readmeMutation, root)

      const failures = [manifestMutation, readmeMutation].map(tarball =>
        spawnSync(process.execPath, ['./scripts/check-package.ts', '--tarball', relative(root, tarball)], {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
        }),
      )
      assert.deepEqual(
        failures.map(result => result.status === 0),
        [false, false],
      )
      assert.equal(
        failures.every(result => /reviewed package (?:manifest|bytes|contents)/u.test(result.stderr)),
        true,
      )
    } finally {
      rmSync(artifactParent, { force: true, recursive: true })
    }
  })

  test('the packed API independently exercises every result-limit boundary', { timeout: 120_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-api-limit-matrix-')
    try {
      const path = resolve(fixtureRoot, 'dist', 'index.mjs')
      const source = readFileSync(path, 'utf8')
      const marker = 'const limit = value === undefined ? budget.default : value;'
      assert.equal(source.includes(marker), true)
      writeFileSync(
        path,
        source.replace(
          marker,
          `${marker}\n  if (limit === 101) return failBudget(budgetKey, 'candidate-only API boundary drift');`,
        ),
      )

      const result = spawnSync(process.execPath, ['./scripts/check-package.ts'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 90_000,
      })
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /packed API.*result-limit|failed with exit code/u)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('the packed CLI independently exercises every result-limit boundary', { timeout: 120_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-cli-limit-matrix-')
    try {
      const path = resolve(fixtureRoot, 'dist', 'cli.mjs')
      const source = readFileSync(path, 'utf8')
      const marker = 'const limit = value === undefined ? budget.default : value;'
      assert.equal(source.includes(marker), true)
      writeFileSync(
        path,
        source.replace(
          marker,
          `${marker}\n  if (limit === 101) return failBudget(budgetKey, 'candidate-only CLI boundary drift');`,
        ),
      )

      const result = spawnSync(process.execPath, ['./scripts/check-package.ts'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 90_000,
      })
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /packed.*CLI.*result-limit|failed with exit code/u)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('uses every public declaration member and the complete error-code union', { timeout: 120_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-declaration-surface-')
    try {
      const declarations = resolve(fixtureRoot, 'dist', 'types.d.ts')
      const source = readFileSync(declarations, 'utf8')
      assert.equal(source.includes('recordsChecked: number;'), true)
      writeFileSync(declarations, source.replace('recordsChecked: number;', 'recordCount: number;'))

      const result = spawnSync(process.execPath, ['./scripts/check-package.ts'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 90_000,
      })
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /typescript|tsc|declaration|failed with exit code/iu)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('declaration consumers independently omit public optional root and record fields', { timeout: 180_000 }, () => {
    const mutations = [
      ['root?: string;', 'root: string;'],
      ['confidence?: number;', 'confidence: number;'],
    ] as const
    const results = mutations.map(([from, to], index) => {
      const fixture = createPackageCheckFixture(`encephalon-package-optional-declaration-${index}-`)
      try {
        const declarations = resolve(fixture.fixtureRoot, 'dist', 'types.d.ts')
        const source = readFileSync(declarations, 'utf8')
        assert.equal(source.includes(from), true)
        writeFileSync(declarations, source.replace(from, to))
        return spawnSync(process.execPath, ['./scripts/check-package.ts'], {
          cwd: fixture.fixtureRoot,
          encoding: 'utf8',
          timeout: 90_000,
        })
      } finally {
        rmSync(fixture.temporaryRoot, { force: true, recursive: true })
      }
    })

    assert.deepEqual(
      results.map(result => result.status === 0),
      [false, false],
    )
    assert.equal(
      results.every(result => /typescript|tsc|failed with exit code/iu.test(result.stderr)),
      true,
    )
  })

  test('publishes only an immutable private snapshot of the supplied repository-relative tarball', () => {
    const { capturedArguments, tarball, temporaryRoot } = createPublishCheckFixture()
    try {
      const result = runPublishCheckFixture(temporaryRoot, ['candidate.tgz'], {
        signal: null,
        status: 0,
        stderr: '',
        stdout: 'publish succeeded\n',
      })
      assert.equal(result.status, 0, result.stderr)
      const captured = JSON.parse(readFileSync(capturedArguments, 'utf8')) as {
        arguments?: unknown[]
        cwd?: unknown
        targetBytes?: unknown
      }
      assert.deepEqual(captured.arguments?.slice(0, 1), ['publish'])
      assert.deepEqual(captured.arguments?.slice(2), ['--dry-run', '--ignore-scripts', '--access', 'public', '--json'])
      assert.notEqual(captured.arguments?.[1], tarball)
      assert.equal(captured.targetBytes, 'candidate tarball')
      assert.equal(captured.cwd, temporaryRoot)
      assert.equal(readFileSync(tarball, 'utf8'), 'replacement tarball bytes')
      assert.equal(existsSync(String(captured.arguments?.[1])), false)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects invalid publish targets before invoking npm', () => {
    const { capturedArguments, temporaryRoot } = createPublishCheckFixture()
    const realDirectory = resolve(temporaryRoot, 'real')
    const symlinkDirectory = resolve(temporaryRoot, 'symlink')
    try {
      mkdirSync(realDirectory)
      writeFileSync(resolve(realDirectory, 'candidate.tgz'), 'candidate tarball')
      symlinkSync(realDirectory, symlinkDirectory, 'junction')
      const invalidArguments = [
        [],
        ['.'],
        ['candidate.tgz', 'extra.tgz'],
        ['../candidate.tgz'],
        ['symlink/candidate.tgz'],
        ['missing.tgz'],
      ] as const
      const failures = invalidArguments.map(arguments_ =>
        runPublishCheckFixture(temporaryRoot, arguments_, {
          signal: null,
          status: 0,
          stderr: '',
          stdout: '',
        }),
      )
      assert.equal(
        failures.every(result => result.status !== 0),
        true,
      )
      assert.equal(
        failures.every(result => /Usage: check-publish\.ts <repository-relative-tarball>/u.test(result.stderr)),
        true,
      )
      assert.equal(
        failures.every(result => !/Usage: check-package\.ts/u.test(result.stderr)),
        true,
      )
      assert.equal(existsSync(capturedArguments), false)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('accepts supplied-tarball publish conflicts only through the existing conflict authority', () => {
    const { temporaryRoot } = createPublishCheckFixture()
    try {
      const conflict = runPublishCheckFixture(temporaryRoot, ['candidate.tgz'], {
        signal: null,
        status: 1,
        stderr: '',
        stdout:
          '{"error":{"code":"EPUBLISHCONFLICT","summary":"You cannot publish over the previously published versions: 0.3.0."}}\n',
      })
      assert.equal(conflict.status, 0, conflict.stderr)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('does not retain a tarball when a late packed CLI check fails', { timeout: 30_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-late-failure-')
    const retainedDirectory = resolve(fixtureRoot, 'late-package-artifact', 'nested')
    try {
      appendFileSync(
        resolve(fixtureRoot, 'dist', 'cli.mjs'),
        '\nif (process.argv.includes("gather") && process.argv.includes("--limit=1000")) process.exitCode = 91\n',
      )

      const result = spawnSync(
        process.execPath,
        ['./scripts/check-package.ts', '--retain-tarball', 'late-package-artifact/nested'],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 30_000 },
      )
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /failed with exit code 91/)
      assert.equal(existsSync(retainedDirectory), false)
      assert.equal(existsSync(dirname(retainedDirectory)), false)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects unreviewed files from packaged source and generated output trees', { timeout: 30_000 }, () => {
    const results = ['skills/encephalon/unreviewed.txt', 'dist/unreviewed.txt'].map(path => {
      const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-manifest-')
      try {
        writeFileSync(resolve(fixtureRoot, path), 'unreviewed package content\n')
        return spawnSync(process.execPath, ['./scripts/check-package.ts'], {
          cwd: fixtureRoot,
          encoding: 'utf8',
          timeout: 30_000,
        })
      } finally {
        rmSync(temporaryRoot, { force: true, recursive: true })
      }
    })
    assert.deepEqual(
      results.map(result => result.status === 0),
      [false, false],
    )
    for (const result of results) {
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /reviewed package file manifest/)
    }
  })

  test('rejects a missing declaration derived from reviewed TypeScript source', { timeout: 30_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-missing-declaration-')
    try {
      rmSync(resolve(fixtureRoot, 'dist', 'api-input.d.ts'))

      const result = spawnSync(process.execPath, ['./scripts/check-package.ts'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 30_000,
      })

      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /reviewed package file manifest/)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('accepts newly reviewed skill files in the package manifest', { timeout: 30_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-reviewed-skill-')
    try {
      const reviewedSkill = 'skills/encephalon/reviewed.txt'
      writeFileSync(resolve(fixtureRoot, reviewedSkill), 'reviewed package content\n')
      const stage = spawnSync('git', ['add', '--', reviewedSkill], { cwd: fixtureRoot, encoding: 'utf8' })
      assert.equal(stage.status, 0, `${stage.stdout}${stage.stderr}`)

      const result = spawnSync(process.execPath, ['./scripts/check-package.ts'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 30_000,
      })

      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })
})
