import assert from 'node:assert/strict'
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import * as api from '../src/index.ts'
import { applyInstructionChanges, planInstructionChanges } from '../src/instructions.ts'
import type { BrainRecord, BrainRecordFile } from '../src/types.ts'
import { createTestRepository, ensureParent, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const MAX_INSTRUCTION_FILE_BYTES = 1024 * 1024

const assertErrorCode = (operation: () => unknown, code: string, message?: RegExp) => {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code)
    if (message) {
      assert.match((error as Error).message, message)
    }
    return true
  })
}

const createDeletePlan = (root: string) => {
  api.initEncephalon({ root })
  const [agentsPlan] = planInstructionChanges(root, true)
  assert.equal(agentsPlan?.action, 'delete')
  return agentsPlan
}

const recordsForSubject = (root: string, subject: string) =>
  api.listRecords({ includeSuperseded: true, limit: 50, root }).filter(record => record.subject === subject)

const activeRecordsForSubject = (root: string, subject: string) =>
  api.listRecords({ limit: 50, root }).filter(record => record.subject === subject)

const generatedRecord = (root: string, subject: string) => {
  const record = api
    .listRecords({ includeSuperseded: true, limit: 20, root })
    .find(candidate => candidate.subject === subject)
  assert.ok(record)
  return record
}

const readRecordFile = (root: string, record: BrainRecord): BrainRecordFile =>
  JSON.parse(readFileSync(join(root, record.path), 'utf8')) as BrainRecordFile

const writeRecordFile = (root: string, record: BrainRecordFile) => {
  const path = join(root, 'encephalon', record.kind, `${record.id}.json`)
  ensureParent(path)
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
}

const rawRecordFilesForSubject = (root: string, kind: string, subject: string) =>
  readdirSync(join(root, 'encephalon', kind))
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(root, 'encephalon', kind, name), 'utf8')) as BrainRecordFile)
    .filter(record => record.subject === subject)

const cloneBaselineRecord = (
  root: string,
  subject: string,
  id: string,
  overrides: Partial<Pick<BrainRecordFile, 'payload' | 'source' | 'supersedes'>> = {},
) => {
  const [record] = recordsForSubject(root, subject)
  assert.ok(record)
  const cloned = {
    ...readRecordFile(root, record),
    id,
    ...overrides,
  }
  writeRecordFile(root, cloned)
  return { cloned, original: record }
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

describe('initialisation', () => {
  test('creates a safe deterministic baseline and exactly reversible instruction blocks', () => {
    const root = createRoot()
    const originalAgents = '# Existing agent guidance'
    writeFileSync(join(root, 'AGENTS.md'), originalAgents)
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        packageManager: 'npm@11.0.0',
        scripts: {
          build: 'sensitive-command --registry=https://registry.example.invalid',
          test: 'SECRET_TOKEN=never-store-this node --test',
        },
        workspaces: ['packages/*'],
      }),
    )
    writeFileSync(join(root, 'package-lock.json'), '{}')
    writeFileSync(join(root, '.env'), 'SECRET_TOKEN=never-store-this')
    writeFileSync(join(root, 'README.md'), 'Run sensitive-command --password hidden')
    ensureParent(join(root, '.github', 'workflows', 'checks.yml'))
    writeFileSync(join(root, '.github', 'workflows', 'checks.yml'), 'env:\n  SECRET_TOKEN: never-store-this\n')
    ensureParent(join(root, 'src', 'index.ts'))
    writeFileSync(join(root, 'src', 'index.ts'), "export const secret = 'never-store-this'")

    const result = api.initEncephalon({ root })
    assert.equal(result.recordsCreated.length, 3)
    assert.deepEqual(result.skippedConflicts, [])
    assert.match(result.nextAction, /skills\/encephalon\/SKILL\.md/)

    const records = api.listRecords({
      includeSuperseded: true,
      limit: 20,
      root,
    })
    assert.equal(records.length, 3)
    assert.deepEqual(
      records.map(record => record.subject).sort((left, right) => left.localeCompare(right)),
      ['encephalon:init/commands-ci', 'encephalon:init/repository-overview', 'encephalon:init/tooling-layout'],
    )
    assert.equal(
      records.every(record => record.source === 'encephalon:init'),
      true,
    )
    const workflow = records.find(record => record.subject === 'encephalon:init/commands-ci')
    assert.ok(workflow)
    assert.deepEqual(workflow.payload, {
      scriptInvocations: [
        { arguments: ['run', 'build'], executable: 'npm', scriptKey: 'build' },
        { arguments: ['run', 'test'], executable: 'npm', scriptKey: 'test' },
      ],
      scriptKeys: ['build', 'test'],
      sources: ['package.json', '.github/workflows/checks.yml'],
      summary:
        'Derived package-script entry points and CI workflow filenames; use scriptInvocations as argv and treat scriptKeys as discovery-only.',
      workflowFiles: ['.github/workflows/checks.yml'],
    })
    const serialized = JSON.stringify(records)
    assert.doesNotMatch(serialized, /never-store-this|sensitive-command|registry\.example\.invalid|SECRET_TOKEN/)
    assert.doesNotMatch(serialized, /npm run|sensitive-command --password/)
    assert.match(serialized, /checks\.yml/)

    const agentsWithBlock = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    const claudeWithBlock = readFileSync(join(root, 'CLAUDE.md'), 'utf8')
    assert.match(agentsWithBlock, /\.\/node_modules\/encephalon\/skills\/encephalon\/SKILL\.md/)
    assert.match(claudeWithBlock, /\.\/node_modules\/encephalon\/skills\/encephalon\/SKILL\.md/)

    const removed = api.initEncephalon({ remove: true, root })
    assert.deepEqual(removed.recordsCreated, [])
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), originalAgents)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
    assert.equal(
      records.every(record => existsSync(join(root, record.path))),
      true,
    )
  })

  test('is idempotent and refreshes only changed generated facts by superseding the active head', () => {
    const root = createRoot()
    const packagePath = join(root, 'package.json')
    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )

    const first = api.initEncephalon({ root })
    const second = api.initEncephalon({ root })
    assert.equal(first.recordsCreated.length, 3)
    assert.deepEqual(second.recordsCreated, [])
    assert.equal(api.listRecords({ includeSuperseded: true, limit: 20, root }).length, 3)

    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'sample-project',
        scripts: { lint: 'lint-private-body', test: 'node --test' },
      }),
    )
    const refreshed = api.initEncephalon({ refreshBaseline: true, root })
    assert.equal(refreshed.recordsCreated.length, 1)
    const all = api.listRecords({ includeSuperseded: true, limit: 20, root })
    const workflow = all.filter(record => record.subject === 'encephalon:init/commands-ci')
    assert.equal(workflow.length, 2)
    assert.deepEqual(workflow[0]?.supersedes, [workflow[1]?.id])
    const [refreshedWorkflow] = workflow
    assert.ok(refreshedWorkflow)
    assert.deepEqual((refreshedWorkflow.payload as { scriptKeys?: unknown }).scriptKeys, ['lint', 'test'])
    assert.deepEqual((refreshedWorkflow.payload as { scriptInvocations?: unknown }).scriptInvocations, [
      { arguments: ['run', 'lint'], executable: 'npm', scriptKey: 'lint' },
      { arguments: ['run', 'test'], executable: 'npm', scriptKey: 'test' },
    ])
    assert.doesNotMatch(JSON.stringify(workflow[0]?.payload), /lint-private-body/)
    assert.equal(api.listRecords({ limit: 20, root }).length, 3)
  })

  test('records package scripts as structured argv data instead of shell strings', () => {
    const root = createRoot()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        packageManager: 'yarn@1.22.22',
        scripts: {
          '--version': 'echo leading-option',
          '`tick`': 'echo backticks',
          '$(date)': 'echo command-substitution',
          'ci:unit': 'echo colon',
          'line\nbreak': 'echo control',
          'path/name': 'echo slash',
          'quote"key': 'echo quote',
          'semi;colon': 'echo semicolon',
          'space name': 'echo space',
          test: 'node --test',
          unicodé: 'echo unicode',
        },
      }),
    )

    api.initEncephalon({ root })

    const [workflow] = api
      .listRecords({ includeSuperseded: true, limit: 20, root })
      .filter(record => record.subject === 'encephalon:init/commands-ci')
    assert.ok(workflow)
    const payload = workflow.payload as {
      commands?: unknown
      scriptInvocations?: unknown
      scriptKeys?: unknown
    }
    assert.equal(payload.commands, undefined)
    assert.deepEqual(payload.scriptKeys, [
      '--version',
      '`tick`',
      '$(date)',
      'ci:unit',
      'path/name',
      'quote"key',
      'semi;colon',
      'space name',
      'test',
      'unicodé',
    ])
    assert.deepEqual(payload.scriptInvocations, [
      { arguments: ['run', '`tick`'], executable: 'yarn', scriptKey: '`tick`' },
      { arguments: ['run', '$(date)'], executable: 'yarn', scriptKey: '$(date)' },
      { arguments: ['run', 'ci:unit'], executable: 'yarn', scriptKey: 'ci:unit' },
      { arguments: ['run', 'path/name'], executable: 'yarn', scriptKey: 'path/name' },
      { arguments: ['run', 'quote"key'], executable: 'yarn', scriptKey: 'quote"key' },
      { arguments: ['run', 'semi;colon'], executable: 'yarn', scriptKey: 'semi;colon' },
      { arguments: ['run', 'space name'], executable: 'yarn', scriptKey: 'space name' },
      { arguments: ['run', 'test'], executable: 'yarn', scriptKey: 'test' },
      { arguments: ['run', 'unicodé'], executable: 'yarn', scriptKey: 'unicodé' },
    ])
  })

  test('refresh resolves equivalent generated baseline heads from branch merges', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const subject = 'encephalon:init/repository-overview'
    const { cloned, original } = cloneBaselineRecord(root, subject, 'parallel-overview')

    const refreshed = api.initEncephalon({ refreshBaseline: true, root })

    assert.equal(refreshed.recordsCreated.length, 1)
    const [resolver] = refreshed.recordsCreated
    assert.ok(resolver)
    assert.equal(resolver.subject, subject)
    assert.deepEqual(
      resolver.supersedes,
      [cloned.id, original.id].sort((first, second) => first.localeCompare(second)),
    )
    assert.equal(api.validateRecords({ root }).valid, true)
    assert.equal(activeRecordsForSubject(root, subject).length, 1)
    assert.equal(recordsForSubject(root, subject).length, 3)
  })

  test('refresh resolves differing generated baseline heads', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const subject = 'encephalon:init/tooling-layout'
    const { cloned, original } = cloneBaselineRecord(root, subject, 'parallel-tooling', {
      payload: {
        summary: 'Branch-specific generated tooling payload.',
      },
    })

    const refreshed = api.initEncephalon({ refreshBaseline: true, root })

    assert.equal(refreshed.recordsCreated.length, 1)
    const [resolver] = refreshed.recordsCreated
    assert.ok(resolver)
    assert.equal(resolver.subject, subject)
    assert.deepEqual(
      resolver.supersedes,
      [cloned.id, original.id].sort((first, second) => first.localeCompare(second)),
    )
    assert.equal(api.validateRecords({ root }).valid, true)
    assert.equal(activeRecordsForSubject(root, subject).length, 1)
  })

  test('refresh returns a structured conflict for a single human-owned baseline head', () => {
    const root = createRoot()
    api.addRecord({
      id: 'human-overview',
      kind: 'context',
      payload: { summary: 'Curated overview' },
      root,
      source: 'human',
      subject: 'encephalon:init/repository-overview',
    })

    const refreshed = api.initEncephalon({ refreshBaseline: true, root })

    assert.deepEqual(
      refreshed.recordsCreated.map(record => record.subject).sort((first, second) => first.localeCompare(second)),
      ['encephalon:init/commands-ci', 'encephalon:init/tooling-layout'],
    )
    assert.deepEqual(refreshed.skippedConflicts, [
      {
        activeRecordIds: ['human-overview'],
        kind: 'context',
        subject: 'encephalon:init/repository-overview',
      },
    ])
  })

  test('refresh rejects mixed generated and human baseline heads without repairing them', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const subject = 'encephalon:init/repository-overview'
    cloneBaselineRecord(root, subject, 'human-parallel-overview', { source: 'human' })
    const before = rawRecordFilesForSubject(root, 'context', subject).length

    assert.throws(
      () => api.initEncephalon({ refreshBaseline: true, root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(rawRecordFilesForSubject(root, 'context', subject).length, before)
  })

  test('refresh rejects unrelated active-head conflicts while repairing no baseline subject', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    api.addRecord({
      id: 'custom-head-one',
      kind: 'decision',
      payload: { summary: 'One' },
      root,
      source: 'human',
      subject: 'custom.subject',
    })
    const [custom] = api
      .listRecords({ includeSuperseded: true, limit: 50, root })
      .filter(record => record.id === 'custom-head-one')
    assert.ok(custom)
    writeRecordFile(root, {
      ...readRecordFile(root, custom),
      id: 'custom-head-two',
    })

    assert.throws(
      () => api.initEncephalon({ refreshBaseline: true, root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(api.validateRecords({ root }).valid, false)
  })

  test('refresh rejects malformed supersession graphs while repairing no baseline subject', () => {
    const root = createRoot()
    api.initEncephalon({ root })
    const subject = 'encephalon:init/commands-ci'
    cloneBaselineRecord(root, subject, 'parallel-commands')
    writeRecordFile(root, {
      createdAt: '2026-08-08T00:00:00.000Z',
      id: 'missing-supersedes-target',
      kind: 'decision',
      payload: { summary: 'Broken graph' },
      source: 'human',
      subject: 'broken.graph',
      supersedes: ['does-not-exist'],
    })

    assert.throws(
      () => api.initEncephalon({ refreshBaseline: true, root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(rawRecordFilesForSubject(root, 'workflow', subject).length, 2)
  })

  test('skips a reserved subject owned by an agent-authored active record', () => {
    const root = createRoot()
    api.addRecord({
      id: 'agent-overview',
      kind: 'context',
      payload: { summary: 'Curated overview' },
      root,
      source: 'human',
      subject: 'encephalon:init/repository-overview',
    })

    const result = api.initEncephalon({ root })
    assert.deepEqual(result.skippedConflicts, [
      {
        activeRecordIds: ['agent-overview'],
        kind: 'context',
        subject: 'encephalon:init/repository-overview',
      },
    ])
    assert.equal(
      api
        .listRecords({ includeSuperseded: true, limit: 20, root })
        .filter(record => record.subject === 'encephalon:init/repository-overview').length,
      1,
    )
  })

  test('bounds baseline scanning and records deterministic truncation reasons', () => {
    const root = createRoot()
    for (let index = 0; index < 600; index += 1) {
      writeFileSync(join(root, `file-${String(index).padStart(3, '0')}.ts`), 'export {}\n')
    }

    api.initEncephalon({ root })
    const overview = generatedRecord(root, 'encephalon:init/repository-overview')

    assert.equal((overview.payload as { scannedRegularFiles?: unknown }).scannedRegularFiles, 512)
    assert.deepEqual((overview.payload as { scanTruncationReasons?: unknown }).scanTruncationReasons, [
      'directory-entry-limit',
    ])
  })

  test('applies directory entry caps after sorting so truncation is deterministic', () => {
    const root = createRoot()
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(join(root, `z-${String(index).padStart(3, '0')}.py`), 'pass\n')
      writeFileSync(join(root, `a-${String(index).padStart(3, '0')}.ts`), 'export {}\n')
    }

    api.initEncephalon({ root })
    const overview = generatedRecord(root, 'encephalon:init/repository-overview')
    const payload = overview.payload as {
      languageCounts?: Array<{ files: number; language: string }>
      scannedRegularFiles?: unknown
      scanTruncationReasons?: unknown
    }

    assert.equal(payload.scannedRegularFiles, 512)
    assert.deepEqual(payload.scanTruncationReasons, ['directory-entry-limit'])
    assert.deepEqual(payload.languageCounts, [
      { files: 212, language: 'Python' },
      { files: 300, language: 'TypeScript' },
    ])
  })

  test('bounds baseline scanner depth without following deep chains forever', () => {
    const root = createRoot()
    let current = root
    for (let index = 0; index < 30; index += 1) {
      current = join(current, `level-${String(index).padStart(2, '0')}`)
      ensureParent(join(current, 'placeholder'))
    }
    writeFileSync(join(current, 'deep.ts'), 'export {}\n')

    api.initEncephalon({ root })
    const overview = generatedRecord(root, 'encephalon:init/repository-overview')

    assert.deepEqual((overview.payload as { scanTruncationReasons?: unknown }).scanTruncationReasons, ['max-depth'])
  })

  test('does not enumerate workflows through a symlinked .github ancestor', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit directory symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const outside = createRoot()
    ensureParent(join(outside, '.github', 'workflows', 'leaked.yml'))
    writeFileSync(join(outside, '.github', 'workflows', 'leaked.yml'), 'name: leaked\n')
    symlinkSync(join(outside, '.github'), join(root, '.github'))

    api.initEncephalon({ root })
    const workflow = generatedRecord(root, 'encephalon:init/commands-ci')

    assert.deepEqual((workflow.payload as { workflowFiles?: unknown }).workflowFiles, [])
  })

  test('preflights both instruction files before writing anything', () => {
    const root = createRoot()
    const malformed = 'before\n<!-- encephalon:managed-instructions:start {} -->\nafter'
    writeFileSync(join(root, 'AGENTS.md'), malformed)
    writeFileSync(join(root, 'CLAUDE.md'), 'untouched')

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), malformed)
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), 'untouched')
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('rejects symlinked instruction files before changing records or link targets', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit file symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const target = join(root, 'outside-agents.md')
    const original = '# Outside guidance\n'
    writeFileSync(target, original)
    symlinkSync(target, join(root, 'AGENTS.md'))

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    assert.equal(readFileSync(target, 'utf8'), original)
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  const invalidUtf8Cases = [
    ['overlong sequence', Buffer.from([0xc0, 0xaf])],
    ['lone continuation byte', Buffer.from([0x80])],
    ['truncated multibyte sequence', Buffer.from([0xe2, 0x82])],
    ['malformed surrogate encoding', Buffer.from([0xed, 0xa0, 0x80])],
  ] as const

  for (const [name, bytes] of invalidUtf8Cases) {
    test(`rejects instruction files containing invalid UTF-8: ${name}`, () => {
      const root = createRoot()
      const agentsPath = join(root, 'AGENTS.md')
      const claudePath = join(root, 'CLAUDE.md')
      const originalAgents = Buffer.concat([Buffer.from('# Guidance\n'), bytes, Buffer.from('\n')])
      const originalClaude = Buffer.from('untouched')
      writeFileSync(agentsPath, originalAgents)
      writeFileSync(claudePath, originalClaude)

      assertErrorCode(() => api.initEncephalon({ root }), 'VALIDATION_FAILED')

      assert.deepEqual(readFileSync(agentsPath), originalAgents)
      assert.deepEqual(readFileSync(claudePath), originalClaude)
      assert.equal(existsSync(join(root, 'encephalon')), false)
    })
  }

  test('rejects embedded NUL bytes without changing either instruction file', () => {
    const root = createRoot()
    const agentsPath = join(root, 'AGENTS.md')
    const claudePath = join(root, 'CLAUDE.md')
    const originalAgents = Buffer.from('before\0after')
    const originalClaude = Buffer.from('untouched')
    writeFileSync(agentsPath, originalAgents)
    writeFileSync(claudePath, originalClaude)

    assertErrorCode(() => api.initEncephalon({ root }), 'VALIDATION_FAILED')

    assert.deepEqual(readFileSync(agentsPath), originalAgents)
    assert.deepEqual(readFileSync(claudePath), originalClaude)
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('rejects an instruction file that cannot fit the managed block without mutation', () => {
    const root = createRoot()
    const agentsPath = join(root, 'AGENTS.md')
    const claudePath = join(root, 'CLAUDE.md')
    const originalAgents = Buffer.alloc(MAX_INSTRUCTION_FILE_BYTES, 0x61)
    const originalClaude = Buffer.from('untouched')
    writeFileSync(agentsPath, originalAgents)
    writeFileSync(claudePath, originalClaude)

    assertErrorCode(
      () => api.initEncephalon({ root }),
      'VALIDATION_FAILED',
      /cannot fit the Encephalon managed block within the 1 MiB instruction-file limit/,
    )

    assert.deepEqual(readFileSync(agentsPath), originalAgents)
    assert.deepEqual(readFileSync(claudePath), originalClaude)
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('round-trips an instruction file whose managed bytes exactly reach the size limit', () => {
    const root = createRoot()
    const agentsPath = join(root, 'AGENTS.md')
    writeFileSync(agentsPath, Buffer.from('a'))
    const [samplePlan] = planInstructionChanges(root, false)
    if (samplePlan?.action !== 'write' || samplePlan.contentBytes === undefined) {
      assert.fail('Expected a write plan for a non-empty instruction file.')
    }
    const managedOverheadBytes = samplePlan.contentBytes.length - 1
    const originalAgents = Buffer.alloc(MAX_INSTRUCTION_FILE_BYTES - managedOverheadBytes, 0x61)
    writeFileSync(agentsPath, originalAgents)

    api.initEncephalon({ root })

    assert.equal(readFileSync(agentsPath).length, MAX_INSTRUCTION_FILE_BYTES)

    api.initEncephalon({ remove: true, root })

    assert.deepEqual(readFileSync(agentsPath), originalAgents)
  })

  test('rejects an instruction file over the preflight size limit without mutation', () => {
    const root = createRoot()
    const agentsPath = join(root, 'AGENTS.md')
    const claudePath = join(root, 'CLAUDE.md')
    const originalAgents = Buffer.alloc(MAX_INSTRUCTION_FILE_BYTES + 1, 0x61)
    const originalClaude = Buffer.from('untouched')
    writeFileSync(agentsPath, originalAgents)
    writeFileSync(claudePath, originalClaude)

    assertErrorCode(() => api.initEncephalon({ root }), 'VALIDATION_FAILED')

    assert.deepEqual(readFileSync(agentsPath), originalAgents)
    assert.deepEqual(readFileSync(claudePath), originalClaude)
    assert.equal(existsSync(join(root, 'encephalon')), false)
  })

  test('rejects managed metadata containing a separator Encephalon never emits', () => {
    const root = createRoot()
    const separator = 'forged-separator'
    const metadata = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        lineEnding: 'LF',
        originalFileExisted: true,
        separatorBase64: Buffer.from(separator, 'utf8').toString('base64'),
      }),
      'utf8',
    ).toString('base64url')
    writeFileSync(
      join(root, 'AGENTS.md'),
      [
        `${separator}<!-- encephalon:managed-instructions:start ${metadata} -->`,
        '## Encephalon',
        'Read and follow the repository-memory skill before making repository assumptions or recording durable knowledge:',
        './node_modules/encephalon/skills/encephalon/SKILL.md',
        '<!-- encephalon:managed-instructions:end -->',
        '',
      ].join('\n'),
    )

    assert.throws(
      () => api.initEncephalon({ remove: true, root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
  })

  test('round-trips CRLF files byte-for-byte and preserves user content added after the block', () => {
    const root = createRoot()
    const original = '# Existing guidance\r\n\r\nKeep this exactly.\r\n'
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, original)
    api.initEncephalon({ root })
    const installed = readFileSync(path, 'utf8')
    assert.match(installed, /\r\n## Encephalon\r\n/)
    writeFileSync(path, `${installed}User addition.\r\n`)

    api.initEncephalon({ remove: true, root })
    assert.equal(readFileSync(path, 'utf8'), `${original}User addition.\r\n`)
  })

  test('round-trips mixed line endings and no-final-newline files byte-for-byte', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = Buffer.from('\uFEFF# Existing guidance\r\nKeep café\nNo final newline')
    writeFileSync(path, original)

    api.initEncephalon({ root })
    api.initEncephalon({ remove: true, root })

    assert.deepEqual(readFileSync(path), original)
  })

  test('atomically publishes instruction replacements and preserves the existing file mode', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    chmodSync(path, 0o744)

    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)
    applyInstructionChanges(root, [agentsPlan])

    assert.match(readFileSync(path, 'utf8'), /## Encephalon/)
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o744)
    }
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.includes('.AGENTS.md.') && filename.endsWith('.tmp')),
      [],
    )
  })

  test('preserves instruction-file mode changes made after planning', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    chmodSync(path, 0o600)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)
    chmodSync(path, 0o744)

    applyInstructionChanges(root, [agentsPlan])

    assert.match(readFileSync(path, 'utf8'), /## Encephalon/)
    assert.equal(statSync(path).mode & 0o777, 0o744)
  })

  test('detects instruction-file changes observed before atomic publication', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = '# Existing guidance\n'
    const changed = '# Concurrent guidance\n'
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)
    writeFileSync(path, changed)

    assert.throws(
      () => applyInstructionChanges(root, [agentsPlan]),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(readFileSync(path, 'utf8'), changed)
  })

  test('does not overwrite instruction-file changes made during atomic publication', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = '# Existing guidance\n'
    const changed = '# Concurrent guidance during publication\n'
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'during-publication') {
              writeFileSync(path, changed)
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(readFileSync(path, 'utf8'), changed)
  })

  test('does not delete an instruction file replaced after global plan validation', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const replacement = '# Replacement guidance\n'

    assertErrorCode(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-plan-validation') {
              writeFileSync(path, replacement)
            }
          },
        }),
      'REPOSITORY_CHANGED',
    )
    assert.equal(readFileSync(path, 'utf8'), replacement)
  })

  const preDeletionReplacementCases = [
    {
      assertReplacement: (path: string, replacement: string) => assert.equal(readFileSync(path, 'utf8'), replacement),
      name: 'regular file',
      replace: (path: string, replacement: string) => writeFileSync(path, replacement),
      skip: false,
    },
    {
      assertReplacement: (path: string, replacement: string) => assert.equal(readFileSync(path, 'utf8'), replacement),
      name: 'different file containing identical bytes',
      replace: (path: string, replacement: string) => {
        rmSync(path)
        writeFileSync(path, replacement)
      },
      skip: false,
    },
    {
      assertReplacement: (path: string, replacement: string) => assert.equal(readFileSync(path, 'utf8'), replacement),
      name: 'symlink',
      replace: (path: string, replacement: string) => {
        const target = join(dirname(path), 'replacement-target.md')
        rmSync(path)
        writeFileSync(target, replacement)
        symlinkSync(target, path)
      },
      skip: process.platform === 'win32',
    },
    {
      assertReplacement: (path: string) => assert.equal(statSync(path).isDirectory(), true),
      name: 'directory',
      replace: (path: string) => {
        rmSync(path)
        mkdirSync(path)
      },
      skip: false,
    },
  ] as const

  for (const replacementCase of preDeletionReplacementCases) {
    test(`does not delete a ${replacementCase.name} replacement immediately before deletion`, {
      skip: replacementCase.skip ? 'Windows runners may not permit file symlink creation.' : false,
    }, () => {
      const root = createRoot()
      const path = join(root, 'AGENTS.md')
      const agentsPlan = createDeletePlan(root)
      const replacement =
        replacementCase.name === 'regular file' ? '# Replacement guidance\n' : readFileSync(path, 'utf8')

      assertErrorCode(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'before-deletion') {
                replacementCase.replace(path, replacement)
              }
            },
          }),
        'REPOSITORY_CHANGED',
      )
      replacementCase.assertReplacement(path, replacement)
    })
  }

  test('does not delete a replacement created after deletion quarantine', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const replacement = '# Replacement after quarantine\n'

    applyInstructionChanges(root, [agentsPlan], {
      fault: point => {
        if (point === 'after-delete-quarantine') {
          writeFileSync(path, replacement)
        }
      },
    })

    assert.equal(readFileSync(path, 'utf8'), replacement)
  })

  test('does not delete a replacement created after deletion verification', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const replacement = '# Replacement after verification\n'

    applyInstructionChanges(root, [agentsPlan], {
      fault: point => {
        if (point === 'after-delete-verification') {
          writeFileSync(path, replacement)
        }
      },
    })

    assert.equal(readFileSync(path, 'utf8'), replacement)
  })

  test('restores the quarantined instruction file when final unlink fails', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const original = readFileSync(path, 'utf8')

    assertErrorCode(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-delete-verification') {
              throw new Error('Injected final unlink failure')
            }
          },
        }),
      'INTERNAL_ERROR',
    )

    assert.equal(readFileSync(path, 'utf8'), original)
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.includes('.AGENTS.md.') && filename.endsWith('.delete')),
      [],
    )
  })

  test('keeps old-descriptor writes recoverable after delete verification', {
    skip: process.platform === 'win32' ? 'Windows does not allow this POSIX descriptor race.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const changed = '# Descriptor delete edit\n'
    const descriptor = openSync(path, 'r+')

    try {
      assertErrorCode(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'after-delete-verification') {
                ftruncateSync(descriptor, 0)
                writeSync(descriptor, changed, 0, 'utf8')
              }
            },
          }),
        'REPOSITORY_CHANGED',
      )
    } finally {
      closeSync(descriptor)
    }

    assert.equal(readFileSync(path, 'utf8'), changed)
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.includes('.AGENTS.md.') && filename.endsWith('.delete')),
      [],
    )
  })

  test('does not misreport directory flush failure after committed delete', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)

    applyInstructionChanges(root, [agentsPlan], {
      fault: point => {
        if (point === 'during-delete-flush') {
          throw new Error('Injected delete flush failure')
        }
      },
    })

    assert.equal(existsSync(path), false)
    assert.deepEqual(
      readdirSync(root).filter(filename => filename.includes('.AGENTS.md.') && filename.endsWith('.delete')),
      [],
    )
  })

  test('keeps old-descriptor writes recoverable after backup validation', {
    skip: process.platform === 'win32' ? 'Windows does not allow this POSIX descriptor race.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = '# Existing guidance\n'
    const changed = '# Descriptor edit\n'
    writeFileSync(path, original)
    const descriptor = openSync(path, 'r+')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    try {
      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'after-backup-validation') {
                ftruncateSync(descriptor, 0)
                writeSync(descriptor, changed, 0, 'utf8')
              }
            },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
    } finally {
      closeSync(descriptor)
    }

    const [backupName] = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    assert.ok(backupName)
    assert.equal(readFileSync(join(root, backupName), 'utf8'), changed)
  })

  test('does not overwrite files created while restoring a backup', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const original = '# Existing guidance\n'
    const changed = '# Concurrent restore guidance\n'
    writeFileSync(path, original)
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    assert.throws(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-backup-validation') {
              throw Object.assign(new Error('Injected publication failure'), { code: 'EIO' })
            }
            if (point === 'during-backup-restore') {
              writeFileSync(path, changed)
            }
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        return true
      },
    )

    const [backupName] = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    assert.ok(backupName)
    assert.equal(readFileSync(path, 'utf8'), changed)
    assert.equal(readFileSync(join(root, backupName), 'utf8'), original)
  })

  test('does not overwrite files created while restoring a quarantined delete', () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    const agentsPlan = createDeletePlan(root)
    const original = readFileSync(path, 'utf8')
    const replacement = '# Concurrent delete restore guidance\n'

    assertErrorCode(
      () =>
        applyInstructionChanges(root, [agentsPlan], {
          fault: point => {
            if (point === 'after-delete-verification') {
              throw new Error('Injected deletion failure')
            }
            if (point === 'during-quarantine-restore') {
              writeFileSync(path, replacement)
            }
          },
        }),
      'INTERNAL_ERROR',
    )

    const [quarantineName] = readdirSync(root).filter(
      name => name.startsWith('.AGENTS.md.') && name.endsWith('.delete'),
    )
    assert.ok(quarantineName)
    assert.equal(readFileSync(path, 'utf8'), replacement)
    assert.equal(readFileSync(join(root, quarantineName), 'utf8'), original)
  })

  test('reports old-descriptor mode changes after backup validation', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    chmodSync(path, 0o600)
    const descriptor = openSync(path, 'r+')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    try {
      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === 'after-backup-validation') {
                fchmodSync(descriptor, 0o744)
              }
            },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
    } finally {
      closeSync(descriptor)
    }

    const [backupName] = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    assert.ok(backupName)
    assert.match(readFileSync(path, 'utf8'), /## Encephalon/)
    assert.equal(statSync(join(root, backupName)).mode & 0o777, 0o744)
  })

  test('does not overwrite mode changes after final backup validation', {
    skip: process.platform === 'win32' ? 'Windows does not expose POSIX mode changes consistently.' : false,
  }, () => {
    const root = createRoot()
    const path = join(root, 'AGENTS.md')
    writeFileSync(path, '# Existing guidance\n')
    chmodSync(path, 0o600)
    const descriptor = openSync(path, 'r+')
    const [agentsPlan] = planInstructionChanges(root, false)
    assert.ok(agentsPlan)

    try {
      applyInstructionChanges(root, [agentsPlan], {
        fault: point => {
          if (point === 'after-final-backup-validation') {
            fchmodSync(descriptor, 0o744)
          }
        },
      })
    } finally {
      closeSync(descriptor)
    }

    const [backupName] = readdirSync(root).filter(name => name.startsWith('.AGENTS.md.') && name.endsWith('.backup'))
    assert.ok(backupName)
    assert.match(readFileSync(path, 'utf8'), /## Encephalon/)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(statSync(join(root, backupName)).mode & 0o777, 0o744)
  })

  const faultPoints = [
    ['before-temp-create', 'old'],
    ['during-temp-write', 'old'],
    ['during-file-flush', 'old'],
    ['during-publication', 'old'],
    ['after-publication', 'new'],
    ['during-temp-cleanup', 'new'],
  ] as const

  for (const [faultPoint, expectedContent] of faultPoints) {
    test(`keeps instruction writes whole when fault injection fails ${faultPoint}`, () => {
      const root = createRoot()
      const path = join(root, 'AGENTS.md')
      const original = '# Existing guidance\n'
      writeFileSync(path, original)
      const [agentsPlan] = planInstructionChanges(root, false)
      assert.ok(agentsPlan?.content)

      assert.throws(
        () =>
          applyInstructionChanges(root, [agentsPlan], {
            fault: point => {
              if (point === faultPoint) {
                throw Object.assign(new Error(`Injected ${point}`), { code: 'EIO' })
              }
            },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
          return true
        },
      )

      const content = readFileSync(path, 'utf8')
      assert.equal(content, expectedContent === 'old' ? original : agentsPlan.content)
      assert.notEqual(content, '')
      assert.notEqual(content, original.slice(0, 4))
    })
  }
})
