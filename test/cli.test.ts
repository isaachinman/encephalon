import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, before, describe, test } from 'node:test'
import { createTestRepository, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []
const projectRoot = join(import.meta.dirname, '..')
const cliPath = join(projectRoot, 'dist', 'cli.mjs')

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

before(() => {
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
})

const run = (root: string, arguments_: string[]) =>
  spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd: root,
    encoding: 'utf8',
  })

const outputJson = (result: ReturnType<typeof run>) => JSON.parse(result.stdout) as unknown
const errorJson = (result: ReturnType<typeof run>) => JSON.parse(result.stderr) as { error: { message: string } }

describe('command-line interface', () => {
  test('emits exactly one JSON value for successful commands', () => {
    const root = createRoot()
    const added = run(root, [
      `--root=${root}`,
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
    assert.equal((outputJson(added) as { id?: unknown }).id, 'cli-decision')
    assert.equal(added.stdout.endsWith('\n'), true)

    const shown = run(root, ['show', '--root', root, '--id', 'missing'])
    assert.equal(shown.status, 0)
    assert.equal(outputJson(shown), null)

    const searched = run(root, ['search', '--root', root, 'nothing matches'])
    assert.equal(searched.status, 0)
    assert.deepEqual(outputJson(searched), [])
  })

  test('emits expected failures as structured stderr JSON with exit status 2', () => {
    const root = createRoot()
    const result = run(root, ['add', '--root', root, '--kind', 'decision'])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.deepEqual(errorJson(result), {
      error: {
        code: 'INVALID_ARGUMENT',
        details: {},
        message: 'add requires --kind, --subject, --source, and --data.',
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
    assert.equal((outputJson(result) as { valid?: unknown }).valid, false)
  })

  test('supports help and version without JSON framing', () => {
    const root = createRoot()
    const help = run(root, ['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /^Usage: encephalon/m)
    const version = run(root, ['--version'])
    assert.equal(version.status, 0)
    assert.equal(version.stdout, '0.1.0\n')
  })

  test('parses terminators, hyphen-leading queries, and repeated options predictably', () => {
    const root = createRoot()
    const first = run(root, [
      '--root',
      root,
      'add',
      '--id',
      'help-query',
      '--kind',
      'decision',
      '--subject',
      'cli.help-query',
      '--source',
      'agent',
      '--data',
      '{"summary":"Help query"}',
      '--text',
      'help version alpha beta',
    ])
    assert.equal(first.status, 0)

    const repeatOne = run(root, [
      'add',
      '--root',
      root,
      '--id',
      'repeat-one',
      '--kind',
      'decision',
      '--subject',
      'cli.repeated',
      '--source',
      'agent',
      '--data',
      '{"summary":"Repeat one"}',
    ])
    assert.equal(repeatOne.status, 0)
    const repeatTwo = run(root, [
      'add',
      '--root',
      root,
      '--id',
      'repeat-two',
      '--kind',
      'decision',
      '--subject',
      'cli.repeated',
      '--source',
      'agent',
      '--data',
      '{"summary":"Repeat two"}',
      '--supersedes',
      'repeat-one',
    ])
    assert.equal(repeatTwo.status, 0)
    mkdirSync(join(root, 'encephalon', '_artifacts', 'decision', 'with-repeated-options'), { recursive: true })
    writeFileSync(join(root, 'encephalon', '_artifacts', 'decision', 'with-repeated-options', 'first.txt'), 'first')
    writeFileSync(join(root, 'encephalon', '_artifacts', 'decision', 'with-repeated-options', 'second.txt'), 'second')
    const repeated = run(root, [
      'add',
      '--root',
      root,
      '--id',
      'with-repeated-options',
      '--kind',
      'decision',
      '--subject',
      'cli.repeated',
      '--source',
      'agent',
      '--data',
      '{"summary":"Repeated options"}',
      '--supersedes',
      'repeat-two',
      '--supersedes',
      'repeat-one',
      '--artifact',
      '_artifacts/decision/with-repeated-options/first.txt',
      '--artifact',
      '_artifacts/decision/with-repeated-options/second.txt',
    ])
    assert.equal(repeated.status, 0)
    const repeatedRecord = outputJson(repeated) as { artifacts?: string[]; supersedes?: string[] }
    assert.deepEqual(repeatedRecord.supersedes, ['repeat-two', 'repeat-one'])
    assert.deepEqual(repeatedRecord.artifacts, [
      '_artifacts/decision/with-repeated-options/first.txt',
      '_artifacts/decision/with-repeated-options/second.txt',
    ])

    const helpQuery = run(root, ['search', '--root', root, '--', '--help'])
    assert.equal(helpQuery.status, 0)
    assert.deepEqual(
      (outputJson(helpQuery) as Array<{ id?: unknown }>).map(record => record.id),
      ['help-query'],
    )

    const versionQuery = run(root, ['search', '--root', root, '--', '--version'])
    assert.equal(versionQuery.status, 0)
    assert.deepEqual(
      (outputJson(versionQuery) as Array<{ id?: unknown }>).map(record => record.id),
      ['help-query'],
    )

    const gathered = run(root, [
      'gather',
      '--root',
      root,
      '--search',
      'alpha',
      '--search=beta',
      '--show',
      'missing-a',
      '--show',
      'missing-b',
    ])
    assert.equal(gathered.status, 0)
    const payload = outputJson(gathered) as {
      records: Array<{ id: string }>
      searches: Array<{ query: string }>
    }
    assert.deepEqual(
      payload.searches.map(search => search.query),
      ['alpha', 'beta'],
    )
    assert.deepEqual(
      payload.records.map(record => record.id),
      ['missing-a', 'missing-b'],
    )
  })

  test('rejects invalid option forms with stable messages', () => {
    const root = createRoot()
    const cases = [
      { arguments_: ['list', '--root', root, '--unknown'], message: 'Unknown option --unknown.' },
      {
        arguments_: ['list', '--root', root, '--kind', 'decision', '--kind', 'context'],
        message: '--kind may be supplied only once.',
      },
      { arguments_: ['list', '--root', root, '--kind='], message: '--kind requires a value.' },
      {
        arguments_: ['list', '--root', root, '--include-superseded=true'],
        message: '--include-superseded does not take a value.',
      },
      { arguments_: ['show', '--root', root, '--id', '--missing'], message: '--id requires a value.' },
      { arguments_: ['list', '--root', root, '--limit=-1'], message: '--limit must be an integer between 1 and 1000.' },
    ]

    for (const entry of cases) {
      const result = run(root, entry.arguments_)
      assert.equal(result.status, 2, entry.message)
      assert.equal(errorJson(result).error.message, entry.message)
    }
  })
})
