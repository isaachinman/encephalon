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

    assert.match(workflowConfiguration, /push:\n\s+branches:\n\s+- main\n\s+- release\/\*\*/)
    assert.match(
      workflowConfiguration,
      /pull_request:\n\s+branches:\n\s+- main\n\s+types: \[opened, reopened, synchronize, edited\]/,
    )
    assert.match(workflowConfiguration, /permissions:\n\s+contents: read/)
    assert.match(
      workflowConfiguration,
      /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}-\$\{\{ github\.head_ref \|\| github\.ref_name \}\}/,
    )
    assert.equal(workflowConfiguration.includes('cancel-in-progress: true'), true)

    assert.match(verificationJob, /name: verify \(\$\{\{ matrix\.context \}\}\)/)
    assert.equal(verificationJob.match(/\n\s+- context:/g)?.length, 4)
    assert.match(verificationJob, /context: ubuntu-latest\n\s+os: ubuntu-latest\n\s+node: 24\.15\.0/)
    assert.match(verificationJob, /context: macos-latest\n\s+os: macos-latest\n\s+node: 24\.15\.0/)
    assert.match(verificationJob, /context: windows-latest\n\s+os: windows-latest\n\s+node: 24\.15\.0/)
    assert.match(verificationJob, /context: ubuntu-current\n\s+os: ubuntu-latest\n\s+node: 26/)
    assert.match(verificationJob, /runs-on: \$\{\{ matrix\.os \}\}/)
    assert.match(verificationJob, /node-version: \$\{\{ matrix\.node \}\}/)
    assert.match(verificationJob, /uses: actions\/checkout@v7\n\s+with:\n\s+persist-credentials: false/)
    const verificationCommands = [
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run test',
      'bun run lint',
      'bun run benchmark:check',
      'bun run build',
      'bun run check:package',
    ]
    assert.equal(
      verificationCommands.every(command => verificationJob.includes(`- run: ${command}`)),
      true,
    )
    assert.equal(verificationJob.includes('actions/upload-artifact'), false)
    assert.equal(verificationJob.includes('bun run check:publish'), false)

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
    assert.match(
      releaseJob,
      /uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: encephalon-npm-package\n\s+path: package-artifacts\/\*\n\s+if-no-files-found: error\n\s+retention-days: 7/,
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
