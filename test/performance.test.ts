import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { scanBaseline, scanBaselineWithHooks } from '../src/baseline.ts'
import { assertRecordGraph, readRecordsResolved, validateRecordsResolved } from '../src/records.ts'
import { createTestRepository, ensureParent, removeTestRepository } from '../test/helpers.ts'

const roots: string[] = []
const payloadValidationWorkFixture = join(import.meta.dirname, 'fixtures', 'payload-validation-work.ts')

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

const writeRecord = (
  root: string,
  record: {
    createdAt: string
    id: string
    kind?: string
    supersedes?: string[]
  },
) => {
  const kind = record.kind ?? 'context'
  const directory = join(root, 'encephalon', kind)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${record.id}.json`),
    `${JSON.stringify(
      {
        createdAt: record.createdAt,
        id: record.id,
        kind,
        payload: { summary: record.id },
        source: 'test',
        subject: 'dense.history',
        ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
      },
      null,
      2,
    )}\n`,
  )
}

describe('hot scan performance regressions', () => {
  test('avoids descriptor-map allocation before payload budgets', () => {
    const run = (mode: 'bounded' | 'descriptor-map') =>
      JSON.parse(
        execFileSync(process.execPath, ['--expose-gc', payloadValidationWorkFixture, mode], {
          encoding: 'utf8',
        }),
      ) as {
        acceptedOutputWrites: number
        descriptorMapCalls: number
        heapGrowthBytes: number
        mode: string
        oversizedArrayWork: { descriptors: string[]; ownKeys: number }
        propertyCount: number
        rejectedOutputWrites: number
        retainedDescriptorCount: number
        work: { descriptors: number; ownKeys: number }
      }

    const bounded = run('bounded')
    const descriptorMap = run('descriptor-map')

    assert.equal(bounded.descriptorMapCalls, 0)
    assert.ok(bounded.acceptedOutputWrites > 0)
    assert.equal(bounded.rejectedOutputWrites, 0)
    assert.deepEqual(bounded.work, { descriptors: bounded.propertyCount, ownKeys: 1 })
    assert.deepEqual(bounded.oversizedArrayWork, { descriptors: ['length'], ownKeys: 0 })
    assert.equal(descriptorMap.descriptorMapCalls, 2)
    assert.deepEqual(descriptorMap.work, {
      descriptors: descriptorMap.propertyCount,
      ownKeys: 1,
    })
    assert.deepEqual(descriptorMap.oversizedArrayWork, { descriptors: ['length'], ownKeys: 1 })
    assert.equal(bounded.retainedDescriptorCount, 0)
    assert.equal(descriptorMap.retainedDescriptorCount, descriptorMap.propertyCount)
    assert.ok(descriptorMap.heapGrowthBytes > bounded.heapGrowthBytes + descriptorMap.propertyCount * 32)
  })

  test('leaves returned baseline results free of instrumentation wrappers', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample-project' }))

    assert.doesNotThrow(() => structuredClone(scanBaseline(root)))
    assert.doesNotThrow(() =>
      structuredClone(
        scanBaselineWithHooks(root, {
          onWork: () => undefined,
        }),
      ),
    )
  })

  test('propagates internal work observer failures unchanged', () => {
    const baselineRoot = createRoot()
    writeFileSync(join(baselineRoot, 'package.json'), JSON.stringify({ name: 'sample-project' }))
    const baselineFailure = new Error('baseline observer failed')

    assert.throws(
      () =>
        scanBaselineWithHooks(baselineRoot, {
          onWork: () => {
            throw baselineFailure
          },
        }),
      error => error === baselineFailure,
    )

    const recordsRoot = createRoot()
    writeRecord(recordsRoot, {
      createdAt: '2026-08-08T00:00:00.000Z',
      id: 'observed-record',
    })
    const recordFailure = new Error('record observer failed')

    assert.throws(
      () =>
        validateRecordsResolved(recordsRoot, {
          hooks: {
            onWork: () => {
              throw recordFailure
            },
          },
        }),
      error => error === recordFailure,
    )
    assert.throws(
      () =>
        readRecordsResolved(recordsRoot, {
          onWork: () => {
            throw recordFailure
          },
        }),
      error => error === recordFailure,
    )

    const records = readRecordsResolved(recordsRoot)
    assert.throws(
      () =>
        assertRecordGraph(recordsRoot, records, 'Observed records are invalid.', {
          onWork: () => {
            throw recordFailure
          },
        }),
      error => error === recordFailure,
    )
  })

  test('bounds validation work while preserving dense-history issue order', () => {
    const root = createRoot()
    writeRecord(root, {
      createdAt: '2026-08-08T00:00:00.000Z',
      id: 'history-001',
    })
    writeRecord(root, {
      createdAt: '2026-08-08T00:00:01.000Z',
      id: 'history-002',
      supersedes: ['history-001'],
    })
    writeRecord(root, {
      createdAt: '2026-08-08T00:00:02.000Z',
      id: 'history-003',
      supersedes: ['history-002'],
    })
    writeRecord(root, {
      createdAt: '2026-08-08T00:00:03.000Z',
      id: 'history-004',
      supersedes: ['history-001'],
    })

    const validationWork = new Map<string, number>()
    const result = validateRecordsResolved(root, {
      hooks: {
        onWork: operation => validationWork.set(operation, (validationWork.get(operation) ?? 0) + 1),
      },
    })

    assert.deepEqual(result, {
      errors: [
        {
          code: 'MULTIPLE_ACTIVE_HEADS',
          message: 'Multiple active records exist for context/dense.history.',
          path: 'encephalon/context/history-003.json',
          recordId: 'history-003',
        },
        {
          code: 'MULTIPLE_ACTIVE_HEADS',
          message: 'Multiple active records exist for context/dense.history.',
          path: 'encephalon/context/history-004.json',
          recordId: 'history-004',
        },
      ],
      recordsChecked: 4,
      truncated: false,
      valid: false,
    })

    assert.deepEqual(Object.fromEntries(validationWork), {
      'active-group-read': 2,
      'active-group-write': 2,
      'active-issue-read': 2,
      'active-issue-write': 2,
      'canonical-entry': 4,
      'cycle-edge': 3,
      'duplicate-record': 4,
      'edge-validation': 3,
      'superseded-edge': 3,
    })

    const allowedWork = new Map<string, number>()
    assert.equal(
      readRecordsResolved(
        root,
        {
          onWork: operation => allowedWork.set(operation, (allowedWork.get(operation) ?? 0) + 1),
        },
        [{ kind: 'context', source: 'test', subject: 'dense.history' }],
      ).length,
      4,
    )
    assert.equal(allowedWork.get('allowed-group-write'), 2, 'allowed group work exceeded active records')
    assert.equal(allowedWork.get('allowed-id-write'), 2, 'allowed id work exceeded accepted active records')
  })

  test('counts duplicate issue accumulator work from collection operations', () => {
    const root = createRoot()
    writeRecord(root, {
      createdAt: '2026-08-08T00:00:00.000Z',
      id: 'duplicate-record',
      kind: 'context',
    })
    writeRecord(root, {
      createdAt: '2026-08-08T00:00:01.000Z',
      id: 'duplicate-record',
      kind: 'decision',
    })

    const work = new Map<string, number>()
    const result = validateRecordsResolved(root, {
      hooks: {
        onWork: operation => work.set(operation, (work.get(operation) ?? 0) + 1),
      },
    })

    assert.equal(result.errors[0]?.code, 'DUPLICATE_RECORD_ID')
    assert.equal(work.get('duplicate-issue-read'), 1)
    assert.equal(work.get('duplicate-issue-write'), 1)
  })

  test('bounds baseline accumulator work while preserving output order', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample-project' }))
    ensureParent(join(root, 'src', 'alpha.ts'))
    writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1')
    writeFileSync(join(root, 'src', 'beta.js'), 'export const beta = 2')
    ensureParent(join(root, 'scripts', 'build.sh'))
    writeFileSync(join(root, 'scripts', 'build.sh'), 'echo build')
    ensureParent(join(root, '.github', 'workflows', 'ci.yml'))
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: CI')

    const work = new Map<string, number>()
    assert.deepEqual(
      scanBaselineWithHooks(root, {
        onWork: operation => work.set(operation, (work.get(operation) ?? 0) + 1),
      }).map(record => {
        const payload = record.payload as Record<string, unknown>
        return {
          languageCounts: payload.languageCounts,
          recognisedFiles: payload.recognisedTopLevelFiles ?? payload.recognisedFiles,
          subject: record.subject,
          topLevelDirectories: payload.topLevelDirectories,
        }
      }),
      [
        {
          languageCounts: [
            { files: 1, language: 'JavaScript' },
            { files: 1, language: 'Shell' },
            { files: 1, language: 'TypeScript' },
          ],
          recognisedFiles: ['package.json'],
          subject: 'encephalon:init/repository-overview',
          topLevelDirectories: ['.github', 'scripts', 'src'],
        },
        {
          languageCounts: undefined,
          recognisedFiles: ['package.json'],
          subject: 'encephalon:init/tooling-layout',
          topLevelDirectories: undefined,
        },
        {
          languageCounts: undefined,
          recognisedFiles: undefined,
          subject: 'encephalon:init/commands-ci',
          topLevelDirectories: undefined,
        },
      ],
    )
    assert.deepEqual(Object.fromEntries(work), {
      'language-count-write': 3,
      'language-entry': 11,
      'top-level-entry': 6,
      'top-level-fact-write': 4,
      'workflow-entry': 1,
    })
  })
})
