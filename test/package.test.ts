import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'
import { spawnNpmCommand } from '../scripts/npm-command.ts'
import { PACKAGE_VERSION } from '../src/generated/version.ts'

const root = resolve(import.meta.dirname, '..')
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
  'scripts/npm-command.ts',
  'scripts/package-version.ts',
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
  return { fixtureRoot, temporaryRoot }
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
    const operationBudgetsDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-13-operation-budgets-design.md'),
      'utf8',
    )
    const boundedCacheValidationDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-16-bounded-cache-validation-design.md'),
      'utf8',
    )
    const semanticCacheSchemaDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-17-sqlite-schema-semantics-design.md'),
      'utf8',
    )
    const ftsTextIntegrityDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-17-fts-text-integrity-design.md'),
      'utf8',
    )
    const responseByteBudgetsDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-17-response-byte-budgets-design.md'),
      'utf8',
    )
    const unicodeLiteralSearchDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-18-unicode-literal-search-design.md'),
      'utf8',
    )
    const singlePassCacheReadDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-18-single-pass-cache-read-design.md'),
      'utf8',
    )
    const gatherDeduplicationDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-18-gather-deduplication-design.md'),
      'utf8',
    )
    const validatedMutationCacheDesign = readFileSync(
      resolve(root, 'docs', 'superpowers', 'specs', '2026-08-22-validated-mutation-cache-design.md'),
      'utf8',
    )

    assert.match(implementationPlan, /Status: historical design input; not the maintained normative contract/)
    assert.match(implementationPlan, /\[`docs\/contract\.md`]\(\.\/contract\.md\)/)
    assert.doesNotMatch(implementationPlan, /createdAt is assigned only after the repository operation lock is held/)
    assert.match(contract, /## Public API and CLI/)
    assert.match(contract, /## Operation Budgets/)
    assert.match(contract, /## Unicode Literal Search/)
    assert.match(contract, /## Canonical Storage/)
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
      /Last reviewed: 2026-08-25 for code and behavioural-test snapshot `0f36d438d132d6a453f56619b5c8dd1f392bfaa4`\./,
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
      assert.deepEqual(readdirSync(artifactDirectory), [retainedFilename])

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
    } finally {
      rmSync(artifactParent, { force: true, recursive: true })
      rmSync(referenceDirectory, { force: true, recursive: true })
    }
  })

  test('does not retain a tarball when a late packed CLI check fails', { timeout: 30_000 }, () => {
    const { fixtureRoot, temporaryRoot } = createPackageCheckFixture('encephalon-package-late-failure-')
    const retainedDirectory = resolve(fixtureRoot, 'late-package-artifact', 'nested')
    try {
      appendFileSync(
        resolve(fixtureRoot, 'dist', 'cli.mjs'),
        '\nif (process.argv.includes("gather")) process.exitCode = 91\n',
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
