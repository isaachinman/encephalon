import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, mock, test } from 'node:test'
import { scanBaseline, scanBaselineWithHooks } from '../src/baseline.ts'
import { addRecordResolved, readRecordsResolved, validateRecordsResolved } from '../src/records.ts'
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
  test('bounds retained payload values before rejecting wide objects', () => {
    const run = (mode: 'bounded' | 'retained-values') =>
      JSON.parse(
        execFileSync(process.execPath, ['--expose-gc', payloadValidationWorkFixture, mode], {
          encoding: 'utf8',
        }),
      ) as {
        descriptorMapCalls: number
        mode: string
        oversizedArrayWork: { descriptors: string[]; ownKeys: number }
        propertyCount: number
        retainedHeapBytes: number
        retainedValueCount: number
        work: { descriptors: number; ownKeys: number }
      }

    const bounded = run('bounded')
    const unbounded = run('retained-values')

    assert.equal(bounded.descriptorMapCalls, 0)
    assert.deepEqual(bounded.work, { descriptors: bounded.propertyCount, ownKeys: 1 })
    assert.deepEqual(bounded.oversizedArrayWork, { descriptors: ['length'], ownKeys: 0 })
    assert.equal(unbounded.descriptorMapCalls, 0)
    assert.deepEqual(unbounded.work, {
      descriptors: unbounded.propertyCount,
      ownKeys: 1,
    })
    assert.equal(unbounded.retainedValueCount, unbounded.propertyCount)
    assert.ok(unbounded.retainedHeapBytes > bounded.retainedHeapBytes + unbounded.propertyCount * 128)
  })

  test('preserves dense-history issue order and allowed active heads', () => {
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

    const result = validateRecordsResolved(root)

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

    assert.equal(
      readRecordsResolved(root, {}, [{ kind: 'context', source: 'test', subject: 'dense.history' }]).length,
      4,
    )
  })

  test('stable canonical snapshot work is one scan and graph pass for 0, 100, and 1,000 records', () => {
    ;[0, 100, 1000].reduce<undefined>((verified, recordCount) => {
      const root = createRoot()
      Array.from({ length: recordCount }, (_, index) =>
        writeRecord(root, {
          createdAt: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
          id: `stable-work-${index.toString().padStart(4, '0')}`,
        }),
      )
      const work = { canonicalScans: 0, graphValidations: 0 }

      const result = validateRecordsResolved(root, {
        hooks: {
          canonicalScan: () => {
            work.canonicalScans += 1
          },
          graphValidation: () => {
            work.graphValidations += 1
          },
        },
      })

      assert.equal(result.recordsChecked, recordCount)
      assert.deepEqual(work, {
        canonicalScans: 1,
        graphValidations: 1,
      })
      return verified
    }, undefined)
  })

  test('stable add planning uses one pipeline through the 1,000-record boundary', () => {
    ;[0, 100, 999, 1000].reduce<undefined>((verified, recordCount) => {
      const root = createRoot()
      mkdirSync(join(root, 'encephalon', '_staging'), { recursive: true })
      mkdirSync(join(root, 'encephalon', 'context'), { recursive: true })
      Array.from({ length: recordCount }, (_, index) =>
        writeRecord(root, {
          createdAt: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
          id: `stable-add-${index.toString().padStart(4, '0')}`,
          ...(index === 0 ? {} : { supersedes: [`stable-add-${(index - 1).toString().padStart(4, '0')}`] }),
        }),
      )
      const work = { canonicalScans: 0, graphValidations: 0 }
      const add = () =>
        addRecordResolved(
          root,
          {
            id: `stable-add-candidate-${recordCount}`,
            kind: 'context',
            payload: {},
            source: 'test',
            subject: 'dense.history',
            ...(recordCount === 0
              ? {}
              : { supersedes: [`stable-add-${(recordCount - 1).toString().padStart(4, '0')}`] }),
          },
          {
            hydrate: false,
            readHooks: {
              canonicalScan: () => {
                work.canonicalScans += 1
              },
              graphValidation: () => {
                work.graphValidations += 1
              },
            },
          },
        )

      if (recordCount < 1000) {
        assert.equal(add().id, `stable-add-candidate-${recordCount}`)
      } else {
        assert.throws(add, (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
          return true
        })
      }
      assert.deepEqual(work, {
        canonicalScans: 1,
        graphValidations: 1,
      })
      return verified
    }, undefined)
  })

  test('canonical snapshot retry work adds one complete scan and graph pass without per-directory retries', () => {
    ;[0, 100, 1000].reduce<undefined>((verified, recordCount) => {
      const root = createRoot()
      Array.from({ length: recordCount }, (_, index) =>
        writeRecord(root, {
          createdAt: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
          id: `retry-work-${index.toString().padStart(4, '0')}`,
        }),
      )
      const firstRecordPath = join(root, 'encephalon', 'context', 'retry-work-0000.json')
      const firstRecordMetadata = recordCount === 0 ? undefined : statSync(firstRecordPath)
      const work = { canonicalScans: 0, graphValidations: 0 }

      const result = validateRecordsResolved(root, {
        hooks: {
          canonicalScan: () => {
            work.canonicalScans += 1
          },
          graphValidation: () => {
            work.graphValidations += 1
            if (work.graphValidations === 1) {
              if (firstRecordMetadata === undefined) {
                mkdirSync(join(root, 'encephalon', 'context'), { recursive: true })
              } else {
                const original = readFileSync(firstRecordPath, 'utf8')
                const replacement = original.replace('retry-work-0000', 'retry-work-xxxx')
                assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original))
                writeFileSync(firstRecordPath, replacement)
                utimesSync(firstRecordPath, firstRecordMetadata.atime, firstRecordMetadata.mtime)
              }
            }
          },
        },
      })

      assert.equal(result.recordsChecked, recordCount)
      assert.deepEqual(work, {
        canonicalScans: 2,
        graphValidations: 2,
      })
      return verified
    }, undefined)
  })

  test('keeps baseline work shallow as nested source inventory grows', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample-project' }))
    ensureParent(join(root, 'src', 'alpha.ts'))
    writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1')
    writeFileSync(join(root, 'src', 'beta.js'), 'export const beta = 2')
    ensureParent(join(root, 'scripts', 'build.sh'))
    writeFileSync(join(root, 'scripts', 'build.sh'), 'echo build')
    ensureParent(join(root, '.github', 'workflows', 'ci.yml'))
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: CI')

    // Native resolution expands Windows short-name aliases just as the directory witness does.
    const canonicalRoot = fs.realpathSync.native(root)
    const directoryReads = mock.method(fs, 'opendirSync')
    syncBuiltinESMExports()
    try {
      const established = scanBaseline(root)
      assert.deepEqual(
        directoryReads.mock.calls.map(call => call.arguments[0]),
        [canonicalRoot, join(canonicalRoot, '.github', 'workflows')],
      )
      directoryReads.mock.resetCalls()
      for (const directory of Array.from({ length: 40 }, (_, index) => index)) {
        const nested = join(root, 'src', `package-${directory}`)
        mkdirSync(nested)
        for (const file of Array.from({ length: 100 }, (_, fileIndex) => fileIndex)) {
          writeFileSync(join(nested, `source-${file}.ts`), 'private body')
        }
      }
      let attempts = 0
      const observed = scanBaselineWithHooks(root, {
        afterBaselineSources: () => {
          attempts += 1
        },
      })

      assert.equal(attempts, 1)
      assert.deepEqual(observed, established)
      assert.deepEqual(Buffer.from(JSON.stringify(observed)), Buffer.from(JSON.stringify(established)))
      assert.deepEqual(
        observed.map(record => {
          const payload = record.payload as Record<string, unknown>
          return {
            recognisedFiles: payload.recognisedTopLevelFiles ?? payload.recognisedFiles,
            subject: record.subject,
            topLevelDirectories: payload.topLevelDirectories,
          }
        }),
        [
          {
            recognisedFiles: ['package.json'],
            subject: 'encephalon:init/repository-overview',
            topLevelDirectories: ['.github', 'scripts', 'src'],
          },
          {
            recognisedFiles: ['package.json'],
            subject: 'encephalon:init/tooling-layout',
            topLevelDirectories: undefined,
          },
          {
            recognisedFiles: undefined,
            subject: 'encephalon:init/commands-ci',
            topLevelDirectories: undefined,
          },
        ],
      )
      assert.deepEqual(
        directoryReads.mock.calls.map(call => call.arguments[0]),
        [canonicalRoot, join(canonicalRoot, '.github', 'workflows')],
      )
      const overview = observed[0]?.payload as Record<string, unknown>
      assert.equal(Object.hasOwn(overview, 'languageCounts'), false)
      assert.equal(Object.hasOwn(overview, 'scannedRegularFiles'), false)
    } finally {
      directoryReads.mock.restore()
      syncBuiltinESMExports()
    }
  })
})
