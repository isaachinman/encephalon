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
    assert.match(contract, /## Cache Compatibility/)
    assert.match(contract, /## Package and Release Gates/)
    assert.match(contract, /## Historical Plan Divergence Checklist/)
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
    const jobsStart = workflow.indexOf('\njobs:\n')
    const releaseStart = workflow.indexOf('\n  release:\n', jobsStart)
    const workflowConfiguration = workflow.slice(0, jobsStart)
    const verificationJob = workflow.slice(jobsStart, releaseStart)
    const releaseJob = workflow.slice(releaseStart)
    const uploadStart = releaseJob.indexOf('      - name: Upload release-equivalent package artifact\n')
    const uploadStep = releaseJob.slice(uploadStart)

    assert.equal(
      workflowConfiguration,
      `name: CI

on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
    types: [opened, reopened, synchronize, edited]

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
`,
    )
    assert.equal(
      verificationJob,
      `
jobs:
  verify:
    name: verify (\${{ matrix.context }})
    strategy:
      fail-fast: false
      matrix:
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
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: \${{ matrix.node }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.1
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run test
      - run: bun run lint
      - run: bun run benchmark:check
      - run: bun run build
      - run: bun run check:package
`,
    )

    assert.match(
      releaseJob,
      /release:\n\s+name: Release-equivalent package gate\n\s+if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n\s+needs: verify/,
    )
    assert.match(releaseJob, /uses: actions\/checkout@v7\n\s+with:\n\s+persist-credentials: false/)
    assert.equal(
      ['bun install --frozen-lockfile', 'bun run build', 'bun run check:package'].every(command =>
        releaseJob.includes(`- run: ${command}`),
      ),
      true,
    )
    assert.match(releaseJob, /npm pack --dry-run=false --ignore-scripts --json --pack-destination package-artifacts/)
    assert.match(releaseJob, /- name: Check npm publish dry run\n\s+run: bun run check:publish/)
    assert.equal(releaseJob.match(/bun run check:publish/g)?.length, 1)
    assert.equal(releaseJob.match(/actions\/upload-artifact/g)?.length, 1)
    assert.equal(
      uploadStep,
      `      - name: Upload release-equivalent package artifact
        uses: actions/upload-artifact@v4
        with:
          name: encephalon-npm-package
          path: package-artifacts/*
          if-no-files-found: error
          retention-days: 7
`,
    )
    assert.equal(
      releaseJob.indexOf('npm pack') < releaseJob.indexOf('bun run check:publish') &&
        releaseJob.indexOf('bun run check:publish') < releaseJob.indexOf('actions/upload-artifact'),
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
