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
    const publishCheck = readFileSync(resolve(root, 'scripts', 'check-publish.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    const publishScript = String(packageJson.scripts?.['check:publish'])
    const [verificationJob = ''] = workflow.split('\n  release:\n', 1)

    assert.match(workflow, /push:\n\s+branches:\n\s+- main\n\s+- release\/\*\*/)
    assert.match(workflow, /pull_request:\n\s+branches:\n\s+- main/)
    assert.match(workflow, /permissions:\n\s+contents: read/)
    assert.match(
      workflow,
      /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
    )
    assert.equal(workflow.includes('cancel-in-progress: true'), true)
    assert.match(verificationJob, /label: Ubuntu \/ Node 24\.15\.0\n\s+os: ubuntu-latest\n\s+node: 24\.15\.0/)
    assert.match(verificationJob, /label: macOS \/ Node 24\.15\.0\n\s+os: macos-latest\n\s+node: 24\.15\.0/)
    assert.match(verificationJob, /label: Windows \/ Node 24\.15\.0\n\s+os: windows-latest\n\s+node: 24\.15\.0/)
    assert.match(verificationJob, /label: Ubuntu \/ Node 26\n\s+os: ubuntu-latest\n\s+node: 26/)
    assert.equal(
      [
        'bun install --frozen-lockfile',
        'bun run typecheck',
        'bun run test',
        'bun run lint',
        'bun run benchmark:check',
        'bun run build',
        'bun run check:package',
      ].every(command => verificationJob.includes(command)),
      true,
    )
    assert.equal(workflow.match(/bun run check:package/g)?.length, 2)
    assert.equal(workflow.match(/bun run check:publish/g)?.length, 1)
    assert.equal(workflow.match(/actions\/upload-artifact/g)?.length, 1)
    assert.match(workflow, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/)
    assert.match(workflow, /retention-days: 7/)
    assert.equal(publishScript, 'bun run scripts/check-publish.ts')
    assert.equal(publishCheck.includes("'--dry-run'"), true)
    assert.equal(publishCheck.includes("'--ignore-scripts'"), true)
    assert.equal(publishCheck.includes('You cannot publish over the previously published versions'), true)
  })
})
