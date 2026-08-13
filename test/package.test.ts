import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

    const scripts = packageJson.scripts as Record<string, unknown> | undefined
    assert.equal(scripts?.install, undefined)
    assert.equal(scripts?.preinstall, undefined)
    assert.equal(scripts?.postinstall, undefined)
    assert.equal(scripts?.prepare, undefined)
  })

  test('has a side-effect-free TypeScript API entrypoint', () => {
    assert.equal(existsSync(resolve(root, 'src/index.ts')), true)
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

    assert.match(implementationPlan, /Status: historical design input; not the maintained normative contract/)
    assert.match(implementationPlan, /\[`docs\/contract\.md`]\(\.\/contract\.md\)/)
    assert.match(contract, /## Public API and CLI/)
    assert.match(contract, /## Canonical Storage/)
    assert.match(contract, /## Partial Initialisation Progress/)
    assert.match(contract, /## Cache Compatibility/)
    assert.match(contract, /## Package and Release Gates/)
    assert.match(contract, /## Historical Plan Divergence Checklist/)
    assert.match(
      contract,
      /MAR-2548 restart-safe partial initialisation progress and convergence: `f388a67819e2bebcabcaa5051bab6fe8985dd4ab`\./,
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

  test('runs pull-request and current-Node package checks with a trusted release gate', () => {
    const workflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    const publishCheck = readFileSync(resolve(root, 'scripts', 'check-publish.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    const publishScript = String(packageJson.scripts?.['check:publish'])
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
    assert.match(verificationSteps, /uses: actions\/checkout@\S+\n\s+with:\n\s+persist-credentials: false/)
    assert.match(
      verificationSteps,
      /uses: actions\/setup-node@\S+\n\s+with:\n\s+node-version: \$\{\{ matrix\.node \}\}/,
    )
    assert.deepEqual(
      [...verificationSteps.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map(match => match[1]),
      [
        'bun install --frozen-lockfile',
        'bun run typecheck',
        'bun run test',
        'bun run lint',
        'bun run benchmark:check',
        'bun run build',
        'bun run check:package',
      ],
    )
    assert.equal(verificationSteps.match(/^\s+(?:- )?run:/gm)?.length, 7)
    assert.doesNotMatch(verificationSteps, /^\s{8}(?:if|continue-on-error):/m)

    assert.equal(
      releaseHeader,
      `
  release:
    name: Release-equivalent package gate
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: verify
    runs-on: ubuntu-latest
`,
    )
    assert.match(releaseSteps, /uses: actions\/checkout@\S+\n\s+with:\n\s+persist-credentials: false/)
    assert.match(releaseSteps, /uses: actions\/setup-node@\S+\n\s+with:\n\s+node-version: 24\.15\.0/)
    assert.deepEqual(
      [...releaseSteps.matchAll(/^\s{6}- run: (.+)$/gm)].map(match => match[1]),
      ['bun install --frozen-lockfile', 'bun run build', 'bun run check:package'],
    )
    assert.equal(releaseSteps.match(/^\s+(?:- )?run:/gm)?.length, 5)
    assert.doesNotMatch(releaseSteps, /^\s{8}(?:if|continue-on-error):/m)
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
      `        with:
          name: encephalon-npm-package
          path: package-artifacts/*
          if-no-files-found: error
          retention-days: 7
`,
    )
    assert.equal(
      ['bun run build', 'bun run check:package', 'npm pack', 'bun run check:publish', 'actions/upload-artifact']
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
    assert.equal(publishScript, 'bun run scripts/check-publish.ts')
    assert.equal(publishCheck.includes("'--dry-run'"), true)
    assert.equal(publishCheck.includes("'--ignore-scripts'"), true)
    assert.equal(publishCheck.includes('You cannot publish over the previously published versions'), true)
  })
})
