import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import { PACKAGE_VERSION } from '../src/generated/version.ts'

const root = resolve(import.meta.dirname, '..')

describe('package contract', () => {
  test('declares a zero-runtime-dependency Node ESM package', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>

    assert.equal(packageJson.name, 'encephalon')
    assert.equal(packageJson.version, PACKAGE_VERSION)
    assert.equal(packageJson.type, 'module')
    assert.deepEqual(packageJson.engines, { node: '>=24.15.0' })
    assert.deepEqual(packageJson.bin, { encephalon: 'dist/cli.mjs' })
    assert.equal(packageJson.dependencies, undefined)
    assert.equal((packageJson.files as readonly unknown[]).includes('scripts'), false)

    const scripts = packageJson.scripts as Record<string, unknown> | undefined
    assert.equal(scripts?.install, undefined)
    assert.equal(scripts?.preinstall, undefined)
    assert.equal(scripts?.postinstall, undefined)
    assert.equal(scripts?.prepare, undefined)
  })

  test('keeps workflow tooling development-only and scripts-scoped', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      devDependencies?: Readonly<Record<string, unknown>>
    }
    const configFiles = readdirSync(root)
      .filter(file => file.startsWith('tsconfig.') && file.endsWith('.json'))
      .toSorted()
    const configs = configFiles.map(file => ({
      file,
      value: JSON.parse(readFileSync(resolve(root, file), 'utf8')) as {
        compilerOptions?: Readonly<{ skipLibCheck?: unknown; types?: unknown }>
      },
    }))
    const bunTypedProjects = configs
      .filter(({ value }) => Array.isArray(value.compilerOptions?.types) && value.compilerOptions.types.includes('bun'))
      .map(({ file }) => file)
    const skippedLibraryCheckProjects = configs
      .filter(({ value }) => value.compilerOptions?.skipLibCheck === true)
      .map(({ file }) => file)

    assert.equal(packageJson.devDependencies?.['@types/bun'], '1.3.1')
    assert.equal(packageJson.devDependencies?.yaml, '2.9.0')
    assert.deepEqual(bunTypedProjects, ['tsconfig.scripts.json'])
    assert.deepEqual(skippedLibraryCheckProjects, ['tsconfig.scripts.json'])
    assert.equal(existsSync(resolve(root, 'scripts', 'bun-runtime.d.ts')), false)
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
      /Last reviewed: 2026-08-24 for code and behavioural-test snapshot `7666139ad3d1f4853cfee8710ddc841dc3978aec`\./,
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

  // This bootstrap assertion executes independently so disabling the workflow security suite cannot disable its CI gate.
  test('runs pull-request and current-Node package checks with a trusted release gate', () => {
    const workflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const publishCheck = readFileSync(resolve(root, 'scripts', 'check-publish.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    const publishScript = String(packageJson.scripts?.['check:publish'])
    const workflowCheckScript = String(packageJson.scripts?.['check:workflows'])
    const eventsStart = workflow.indexOf('\non:\n') + 1
    const permissionsStart = workflow.indexOf('\npermissions:\n', eventsStart)
    const jobsStart = workflow.indexOf('\njobs:\n')
    const releaseStart = workflow.indexOf('\n  release:\n', jobsStart)
    const workflowConfiguration = workflow.slice(0, jobsStart)
    const verificationJob = workflow.slice(jobsStart, releaseStart)
    const releaseJob = workflow.slice(releaseStart)
    const matrixStart = verificationJob.indexOf('      matrix:\n')
    const runnerStart = verificationJob.indexOf('    runs-on:', matrixStart)
    const matrixBlock = verificationJob.slice(matrixStart, runnerStart)
    const verificationStepsStart = verificationJob.indexOf('    steps:\n')
    const verificationHeader = verificationJob.slice(0, matrixStart)
    const verificationRunner = verificationJob.slice(runnerStart, verificationStepsStart)
    const verificationSteps = verificationJob.slice(verificationStepsStart)
    const releaseStepsStart = releaseJob.indexOf('    steps:\n')
    const releaseHeader = releaseJob.slice(0, releaseStepsStart)
    const releaseSteps = releaseJob.slice(releaseStepsStart)
    const uploadStart = releaseJob.indexOf('      - name: Upload release-equivalent package artifact\n')
    const uploadStep = releaseJob.slice(uploadStart)

    assert.equal(
      workflow.slice(eventsStart, permissionsStart),
      `on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
    types: [opened, reopened, synchronize, edited]
`,
    )
    assert.doesNotMatch(workflow.slice(eventsStart, permissionsStart), /paths|ignore|workflow_dispatch|schedule/)
    assert.match(workflowConfiguration, /permissions:\n\s+contents: read/)
    assert.match(
      workflowConfiguration,
      /concurrency:\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n\s+cancel-in-progress: true/,
    )

    assert.equal(
      verificationHeader,
      `
jobs:
  verify:
    name: verify (\${{ matrix.context }})
    strategy:
      fail-fast: false
`,
    )
    assert.equal(
      matrixBlock,
      `      matrix:
        include:
          - context: ubuntu-latest
            os: ubuntu-latest
            node: 24.15.0
          - context: macos-latest
            os: macos-latest
            node: 24.15.0
          - context: windows-latest
            os: windows-latest
            node: 24.15.0
          - context: ubuntu-current
            os: ubuntu-latest
            node: 26
`,
    )
    assert.match(verificationRunner, /^ {4}runs-on: \$\{\{ matrix\.os \}\}\n$/)
    assert.doesNotMatch(verificationJob, /^ {4}(?:if|continue-on-error):/m)
    assert.match(verificationSteps, /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+persist-credentials: false/)
    assert.match(
      verificationSteps,
      /uses: actions\/setup-node@[^\n]+\n\s+with:\n\s+node-version: \$\{\{ matrix\.node \}\}/,
    )
    assert.deepEqual(
      [...verificationSteps.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map(match => match[1]),
      [
        'bun install --frozen-lockfile',
        'bun run check:workflows',
        'bun run check:generated',
        'bun run typecheck',
        'bun run test',
        'bun run lint',
        'bun run benchmark:check',
        'bun run build',
        'bun run check:package',
      ],
    )
    assert.equal(verificationSteps.match(/^\s+(?:- )?run:/gm)?.length, 9)
    assert.match(verificationSteps, /- name: Check committed package version\n\s+run: bun run check:generated/)
    assert.doesNotMatch(verificationSteps, /^\s{8}(?:if|continue-on-error):/m)

    assert.equal(
      releaseHeader,
      `
  release:
    name: Release-equivalent package gate
    needs: verify
    runs-on: ubuntu-latest
`,
    )
    assert.match(releaseSteps, /uses: actions\/checkout@[^\n]+\n\s+with:\n\s+persist-credentials: false/)
    assert.match(releaseSteps, /uses: actions\/setup-node@[^\n]+\n\s+with:\n\s+node-version: 24\.15\.0/)
    assert.deepEqual(
      [...releaseSteps.matchAll(/^\s{6}- run: (.+)$/gm)].map(match => match[1]),
      ['bun install --frozen-lockfile', 'bun run check:workflows', 'bun run build', 'bun run check:package'],
    )
    assert.equal(releaseSteps.match(/^\s+(?:- )?run:/gm)?.length, 7)
    assert.match(releaseSteps, /- name: Check committed package version\n\s+run: bun run check:generated/)
    assert.equal(releaseSteps.match(/^\s{8}if:/gm)?.length, 1)
    assert.doesNotMatch(releaseSteps, /^\s{8}continue-on-error:/m)
    assert.match(
      releaseJob,
      /- name: Create release-equivalent package artifact\n\s+shell: bash\n\s+run: \|\n\s+mkdir -p package-artifacts\n\s+npm pack --dry-run=false --ignore-scripts --json --pack-destination package-artifacts > package-artifacts\/npm-pack\.json/,
    )
    assert.equal(releaseJob.match(/npm pack --dry-run=false/g)?.length, 1)
    assert.match(releaseJob, /- name: Check npm publish dry run\n\s+run: bun run check:publish/)
    assert.equal(releaseJob.match(/bun run check:publish/g)?.length, 1)
    assert.equal(releaseJob.match(/actions\/upload-artifact/g)?.length, 1)
    assert.equal(
      uploadStep
        .split('\n')
        .filter(line => !line.includes('uses: actions/upload-artifact@'))
        .slice(1)
        .join('\n'),
      `        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        with:
          name: encephalon-npm-package
          path: package-artifacts/*
          if-no-files-found: error
          retention-days: 7
`,
    )
    assert.equal(
      [
        'bun run check:generated',
        'bun run build',
        'bun run check:package',
        'npm pack',
        'bun run check:publish',
        'actions/upload-artifact',
      ]
        .map(step => releaseJob.indexOf(step))
        .every(
          (position, index, positions) =>
            position >= 0 && (index === 0 || position > (positions[index - 1] ?? Number.POSITIVE_INFINITY)),
        ),
      true,
    )
    assert.match(readme, /four verification lanes/)
    assert.match(readme, /trusted pushes to `main`/)
    assert.match(readme, /release-equivalent package gate/)
    assert.equal(workflowCheckScript, 'bun test scripts/workflow-policy.test.ts && bun run scripts/workflow-policy.ts')
    assert.equal(publishScript, 'bun run scripts/check-publish.ts')
    assert.equal(publishCheck.includes("'--dry-run'"), true)
    assert.equal(publishCheck.includes("'--ignore-scripts'"), true)
    assert.equal(publishCheck.includes('You cannot publish over the previously published versions'), true)
  })
})
