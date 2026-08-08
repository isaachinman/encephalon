import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

  test('redacts CLI details that contain absolute repository paths', () => {
    const root = createRoot()
    const prepared = run(root, ['prepare', '--root', root])
    assert.equal(prepared.status, 0)

    const database = new DatabaseSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'))
    database
      .prepare("UPDATE metadata SET value = ? WHERE key = 'repositoryRealpath'")
      .run(join(root, '..', 'other-repository'))
    database.close()

    const result = run(root, ['prepare', '--root', root])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes(root), false)
    assert.equal(result.stderr.includes('Error:'), false)
    assert.deepEqual(JSON.parse(result.stderr), {
      error: {
        code: 'CACHE_SCOPE_MISMATCH',
        details: {},
        message: 'The Encephalon cache belongs to a different repository.',
      },
    })
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
