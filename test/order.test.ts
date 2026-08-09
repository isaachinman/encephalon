import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { ordinalStringCompare } from '../src/order.ts'
import { createTestRepository, ensureParent, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

const baselineModule = new URL('../src/baseline.ts', import.meta.url).href
const indexModule = new URL('../src/index.ts', import.meta.url).href

const localeProbeScript = `
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalPayload, scanBaseline } from ${JSON.stringify(baselineModule)}
import { hydrate, listRecords, searchRecords } from ${JSON.stringify(indexModule)}

const root = process.argv[1]
rmSync(join(root, 'node_modules', '.cache', 'encephalon'), { force: true, recursive: true })
const baseline = scanBaseline(root).map(record => ({
  payload: record.payload,
  subject: record.subject,
}))
const canonical = canonicalPayload({
  '10': true,
  '2': true,
  A: true,
  I: true,
  Z: true,
  a: true,
  'e\\u0301': true,
  i: true,
  item10: true,
  item2: true,
  z: true,
  'ä': true,
  'é': true,
  'İ': true,
  'ı': true,
  '💡': true,
  '😀': true,
})
hydrate({ root })
const database = new DatabaseSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'))
const manifest = database.prepare("SELECT value FROM metadata WHERE key = 'manifest'").get().value
const artifactPaths = JSON.parse(database.prepare("SELECT value FROM metadata WHERE key = 'artifactPaths'").get().value)
database.close()
const listIds = listRecords({ includeSuperseded: true, limit: 10, root }).map(record => record.id)
const searchIds = searchRecords({ includeSuperseded: true, limit: 10, query: 'needle', root }).map(record => record.id)

console.log(JSON.stringify({ artifactPaths, baseline, canonical, listIds, manifest, searchIds }))
`

const probeLocale = (root: string, locale: string) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', localeProbeScript, root], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LANG: locale,
      LC_ALL: locale,
      LC_COLLATE: locale,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout) as {
    artifactPaths: string[]
    baseline: Array<{ payload: Record<string, unknown>; subject: string }>
    canonical: string
    listIds: string[]
    manifest: string
    searchIds: string[]
  }
}

describe('ordinal ordering', () => {
  test('sorts strings by UTF-16 code units without locale collation', () => {
    assert.deepEqual(
      ['é', 'item2', 'I', 'ı', '😀', '10', 'Z', 'a', 'e\u0301', '💡', '2', 'A', 'İ', 'z', 'i', 'item10', 'ä'].sort(
        ordinalStringCompare,
      ),
      ['10', '2', 'A', 'I', 'Z', 'a', 'e\u0301', 'i', 'item10', 'item2', 'z', 'ä', 'é', 'İ', 'ı', '💡', '😀'],
    )
  })

  test('keeps canonical outputs identical across process locale settings', () => {
    const root = createRoot()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'locale-ordering',
        packageManager: 'npm@11.0.0',
        scripts: {
          Build: 'node build.js',
          build: 'node build.js',
          'e\u0301': 'node decomposed.js',
          istanbul: 'node lower.js',
          item2: 'node two.js',
          item10: 'node ten.js',
          é: 'node composed.js',
          İstanbul: 'node dotted.js',
          '💡': 'node idea.js',
        },
        workspaces: ['packages/e\u0301', 'packages/é', 'packages/item10', 'packages/item2', 'packages/İ'],
      }),
    )
    writeFileSync(join(root, 'package-lock.json'), '{}')
    for (const directory of ['10', '2', 'A', 'item10', 'item2', 'é', 'İ', 'ı', '💡']) {
      mkdirSync(join(root, directory))
    }
    ensureParent(join(root, '.github', 'workflows', 'é.yml'))
    writeFileSync(join(root, '.github', 'workflows', 'é.yml'), 'name: composed\n')
    writeFileSync(join(root, '.github', 'workflows', 'item10.yml'), 'name: ten\n')
    writeFileSync(join(root, '.github', 'workflows', 'item2.yml'), 'name: two\n')
    ensureParent(join(root, 'src', 'index.ts'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1\n')

    const records = ['Zed', 'alpha', 'item10', 'item2'].map(id => ({
      ...(id === 'Zed' ? { artifacts: ['_artifacts/decision/Zed/é.txt'] } : {}),
      createdAt: '2026-08-08T00:00:00.000Z',
      id,
      kind: 'decision',
      payload: { summary: `needle ${id}` },
      source: 'agent',
      subject: `locale.ordering.${id}`,
    }))
    ensureParent(join(root, 'encephalon', 'decision', 'Zed.json'))
    for (const record of records) {
      writeFileSync(join(root, 'encephalon', 'decision', `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`)
    }
    ensureParent(join(root, 'encephalon', '_artifacts', 'decision', 'Zed', 'é.txt'))
    writeFileSync(join(root, 'encephalon', '_artifacts', 'decision', 'Zed', 'é.txt'), 'artifact\n')

    const outputs = ['C', 'en_US.UTF-8', 'tr_TR.UTF-8', 'sv_SE.UTF-8'].map(locale => probeLocale(root, locale))
    const [referenceOutput, ...otherOutputs] = outputs
    assert.ok(referenceOutput)
    assert.deepEqual(
      otherOutputs,
      otherOutputs.map(() => referenceOutput),
    )

    const workflowPayload = referenceOutput.baseline.find(record => record.subject === 'encephalon:init/commands-ci')
      ?.payload as { scriptKeys?: string[]; workflowFiles?: string[] }
    assert.deepEqual(workflowPayload.scriptKeys, [
      'Build',
      'build',
      'e\u0301',
      'istanbul',
      'item10',
      'item2',
      'é',
      'İstanbul',
      '💡',
    ])
    assert.deepEqual(workflowPayload.workflowFiles, [
      '.github/workflows/item10.yml',
      '.github/workflows/item2.yml',
      '.github/workflows/é.yml',
    ])
    assert.deepEqual(referenceOutput.listIds, ['item2', 'item10', 'alpha', 'Zed'])
    assert.deepEqual(referenceOutput.searchIds, ['item2', 'item10', 'alpha', 'Zed'])
  })
})
