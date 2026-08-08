import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { PACKAGE_VERSION } from '../src/generated/version.ts'
import { createTestRepository, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

const run = (root: string, arguments_: string[]) =>
  spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...arguments_], {
    cwd: root,
    encoding: 'utf8',
  })

describe('command-line interface', () => {
  test('emits exactly one JSON value for successful commands', () => {
    const root = createRoot()
    const added = run(root, [
      '--root',
      root,
      'add',
      '--id',
      'cli-decision',
      '--kind',
      'decision',
      '--subject',
      'api.style',
      '--source',
      'agent',
      '--data',
      '{"summary":"Use JSON"}',
      '--text',
      'portable output',
    ])
    assert.equal(added.status, 0)
    assert.equal(added.stderr, '')
    assert.equal(JSON.parse(added.stdout).id, 'cli-decision')
    assert.equal(added.stdout.endsWith('\n'), true)

    const shown = run(root, ['show', '--root', root, '--id', 'missing'])
    assert.equal(shown.status, 0)
    assert.equal(JSON.parse(shown.stdout), null)

    const searched = run(root, ['search', '--root', root, 'nothing matches'])
    assert.equal(searched.status, 0)
    assert.deepEqual(JSON.parse(searched.stdout), [])
  })

  test('emits expected failures as structured stderr JSON with exit status 2', () => {
    const root = createRoot()
    const result = run(root, ['add', '--root', root, '--kind', 'decision'])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), {
      error: {
        code: 'INVALID_ARGUMENT',
        details: {},
        message: 'add requires --kind, --subject, --source, and --data.',
      },
    })
  })

  test('reports post-commit add failures with committed record details', () => {
    const root = createRoot()
    mkdirSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'), { recursive: true })

    const result = run(root, [
      'add',
      '--root',
      root,
      '--id',
      'cli-post-commit',
      '--kind',
      'decision',
      '--subject',
      'post.commit',
      '--source',
      'agent',
      '--data',
      '{"summary":"Published"}',
    ])

    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), {
      error: {
        code: 'IO_ERROR',
        details: {
          canonicalCommitted: true,
          path: 'encephalon/decision/cli-post-commit.json',
          postCommitPhase: 'cacheHydration',
          recordId: 'cli-post-commit',
          recoveryAction: 'Run prepare to rebuild disposable cache state, then validate before retrying this add.',
        },
        message:
          'Record cli-post-commit was committed, but the cacheHydration post-commit phase failed. Run prepare to rebuild disposable cache state, then validate before retrying this add.',
      },
    })
    assert.equal(existsSync(join(root, 'encephalon', 'decision', 'cli-post-commit.json')), true)

    const retry = run(root, [
      'add',
      '--root',
      root,
      '--id',
      'cli-post-commit',
      '--kind',
      'decision',
      '--subject',
      'post.commit',
      '--source',
      'agent',
      '--data',
      '{"summary":"Retry"}',
    ])
    assert.equal(retry.status, 2)
    assert.equal(JSON.parse(retry.stderr).error.code, 'RECORD_EXISTS')
  })

  test('prints invalid validation results once to stdout and exits 2', () => {
    const root = createRoot()
    const path = join(root, 'encephalon', 'decision')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'invalid.json'), '{invalid')

    const result = run(root, ['validate', '--root', root])
    assert.equal(result.status, 2)
    assert.equal(result.stderr, '')
    assert.equal(JSON.parse(result.stdout).valid, false)
  })

  test('supports help and version without JSON framing', () => {
    const root = createRoot()
    const help = run(root, ['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /^Usage: encephalon/m)
    const version = run(root, ['--version'])
    assert.equal(version.status, 0)
    assert.equal(version.stdout, `${PACKAGE_VERSION}\n`)
  })
})
