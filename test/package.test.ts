import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

describe('package contract', () => {
  test('declares a zero-runtime-dependency Node ESM package', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>

    assert.equal(packageJson.name, 'encephalon')
    assert.equal(packageJson.version, '0.1.0')
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

  test('ships the generic repository-memory skill', () => {
    const skill = readFileSync(resolve(root, 'skills', 'encephalon', 'SKILL.md'), 'utf8')
    assert.equal(skill.includes('npx --no-install encephalon search'), true)
    assert.equal(skill.includes('--supersedes'), true)
    assert.equal(skill.includes('npx --no-install encephalon validate'), true)
    assert.equal(skill.includes('Do not stage, commit, push'), true)
  })

  test('runs package and publish-contract checks in CI without publishing', () => {
    const workflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const publishCheck = readFileSync(resolve(root, 'scripts', 'check-publish.ts'), 'utf8')
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    const publishScript = String(packageJson.scripts?.['check:publish'])

    assert.equal(workflow.includes('bun run check:package'), true)
    assert.equal(workflow.includes('bun run check:publish'), true)
    assert.equal(workflow.includes("matrix.os == 'ubuntu-latest'"), true)
    assert.equal(workflow.includes('actions/upload-artifact'), true)
    assert.equal(publishScript, 'bun run scripts/check-publish.ts')
    assert.equal(publishCheck.includes("'--dry-run'"), true)
    assert.equal(publishCheck.includes("'--ignore-scripts'"), true)
    assert.equal(publishCheck.includes('You cannot publish over the previously published versions'), true)
  })
})
