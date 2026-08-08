import assert from 'node:assert/strict'
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  ftruncateSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import * as api from '../src/index.ts'
import { initEncephalonWithHooks } from '../src/init.ts'
import { applyInstructionChanges, planInstructionChanges } from '../src/instructions.ts'
import { createTestRepository, ensureParent, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []

type InitCounts = {
  baselineScans: number
  canonicalScans: number
  graphValidations: number
  hydrations: number
}

type InitFaultPoint =
  | 'after-publication'
  | 'before-publication'
  | 'during-cleanup'
  | 'during-hydration'
  | 'during-publication-flush'
  | 'during-staging-write'

const initWithCounts = (
  input: Parameters<typeof initEncephalonWithHooks>[0],
  fault?: (point: InitFaultPoint) => void,
) => {
  const counts: InitCounts = {
    baselineScans: 0,
    canonicalScans: 0,
    graphValidations: 0,
    hydrations: 0,
  }
  const result = initEncephalonWithHooks(input, {
    baselineScan: () => {
      counts.baselineScans += 1
    },
    canonicalScan: () => {
      counts.canonicalScans += 1
    },
    graphValidation: () => {
      counts.graphValidations += 1
    },
    hydration: cacheResult => {
      if (cacheResult.hydrated) {
        counts.hydrations += 1
      }
    },
    ...(fault === undefined ? {} : { recordWriteHooks: { fault } }),
  })
  return { counts, result }
}

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
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
    const serialized = JSON.stringify(records)
    assert.doesNotMatch(serialized, /never-store-this|sensitive-command|registry\.example\.invalid|SECRET_TOKEN/)
    assert.match(serialized, /npm run test/)
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
    assert.match(JSON.stringify(workflow[0]?.payload), /npm run lint/)
    assert.doesNotMatch(JSON.stringify(workflow[0]?.payload), /lint-private-body/)
    assert.equal(api.listRecords({ limit: 20, root }).length, 3)
  })

  test('plans first and idempotent baseline additions against one canonical snapshot', () => {
    const root = createRoot()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )

    const first = initWithCounts({ root })
    assert.equal(first.result.recordsCreated.length, 3)
    assert.deepEqual(first.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      graphValidations: 2,
      hydrations: 1,
    })

    const second = initWithCounts({ root })
    assert.deepEqual(second.result.recordsCreated, [])
    assert.deepEqual(second.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      graphValidations: 1,
      hydrations: 0,
    })
  })

  test('refreshes one or three changed generated subjects with one planning scan', () => {
    const root = createRoot()
    const packagePath = join(root, 'package.json')
    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )
    initWithCounts({ root })

    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'sample-project',
        scripts: { lint: 'lint-private-body', test: 'node --test' },
      }),
    )
    const oneChanged = initWithCounts({ refreshBaseline: true, root })
    assert.equal(oneChanged.result.recordsCreated.length, 1)
    assert.deepEqual(oneChanged.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      graphValidations: 2,
      hydrations: 1,
    })

    writeFileSync(
      packagePath,
      JSON.stringify({
        name: 'renamed-project',
        scripts: { build: 'private-build-command', lint: 'lint-private-body', test: 'node --test' },
      }),
    )
    ensureParent(join(root, 'src', 'index.ts'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1')
    const threeChanged = initWithCounts({ refreshBaseline: true, root })
    assert.equal(threeChanged.result.recordsCreated.length, 3)
    assert.deepEqual(threeChanged.counts, {
      baselineScans: 1,
      canonicalScans: 1,
      graphValidations: 2,
      hydrations: 1,
    })
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test('reruns safely after a mid-batch baseline publication failure', () => {
    const root = createRoot()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        scripts: { test: 'node --test' },
      }),
    )
    let publicationAttempts = 0
    assert.throws(
      () =>
        initWithCounts({ root }, point => {
          if (point === 'before-publication') {
            publicationAttempts += 1
            if (publicationAttempts === 2) {
              throw new Error('Injected mid-batch failure')
            }
          }
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        return true
      },
    )

    assert.equal(api.validateRecords({ root }).valid, true)
    assert.equal(api.listRecords({ includeSuperseded: true, limit: 20, root }).length, 1)

    const rerun = initWithCounts({ root })
    assert.equal(rerun.result.recordsCreated.length, 2)
    assert.equal(api.validateRecords({ root }).valid, true)
    const records = api.listRecords({ includeSuperseded: true, limit: 20, root })
    assert.equal(records.length, 3)
    assert.deepEqual(new Set(records.map(record => record.subject)).size, 3)
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
              throw new Error('Injected publication failure')
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
                throw new Error(`Injected ${point}`)
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
