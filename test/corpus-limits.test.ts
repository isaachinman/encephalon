import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { scanBaseline } from '../src/baseline.ts'
import {
  MAX_CANONICAL_BRAIN_ROOT_ENTRIES,
  MAX_CANONICAL_KIND_DIRECTORIES,
  MAX_CANONICAL_KIND_ENTRIES,
} from '../src/canonical-layout.ts'
import type { EncephalonError } from '../src/errors.ts'
import * as api from '../src/index.ts'
import { initEncephalonWithHooks } from '../src/init.ts'
import {
  addRecordResolved,
  assertRecordGraph,
  MAX_ARTIFACT_REFERENCES,
  MAX_CANONICAL_RECORD_BYTES,
  MAX_CANONICAL_RECORDS,
  MAX_SUPERSESSION_EDGES,
  planRecordAddition,
  validateRecordsResolved,
} from '../src/records.ts'
import { MAX_RECORD_BYTES } from '../src/schema.ts'
import type { BrainRecordFile } from '../src/types.ts'
import { createTestRepository, ensureParent, removeTestRepository } from '../test/helpers.ts'

// Each test here fills a canonical corpus limit: tens of thousands of files or about 128 MiB of records.
// `scripts/test-selection.ts` classifies this file `linux-source`, so it never runs on the Windows or macOS jobs.

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

const timestampAt = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString()

const writeCanonicalRecord = (
  root: string,
  record: {
    id: string
    kind?: string
    subject?: string
    payload?: Record<string, unknown>
    supersedes?: string[]
    artifacts?: string[]
    createdAt?: string
  },
) => {
  const kind = record.kind ?? 'decision'
  const path = join(root, 'encephalon', kind, `${record.id}.json`)
  ensureParent(path)
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        createdAt: record.createdAt ?? timestampAt(0),
        id: record.id,
        kind,
        payload: record.payload ?? {},
        source: 'test',
        subject: record.subject ?? 'validation.corpus',
        ...(record.artifacts === undefined ? {} : { artifacts: record.artifacts }),
        ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
      },
      null,
      2,
    )}\n`,
  )
}

const writeRecordFile = (root: string, record: BrainRecordFile) => {
  const path = join(root, 'encephalon', record.kind, `${record.id}.json`)
  ensureParent(path)
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
}

const writeRecord = (root: string, record: { createdAt: string; id: string; supersedes?: string[] }) =>
  writeRecordFile(root, {
    createdAt: record.createdAt,
    id: record.id,
    kind: 'context',
    payload: { summary: record.id },
    source: 'test',
    subject: 'dense.history',
    ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
  })

const assertErrorCode = (operation: () => unknown, code: string) => {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code)
    return true
  })
}

const assertValidationFailureCode = (operation: () => unknown, code: string) => {
  assert.throws(operation, (error: unknown) => {
    const typed = error as { code?: unknown; details?: { errors?: Array<{ code?: unknown }> } }
    assert.equal(typed.code, 'VALIDATION_FAILED')
    assert.equal(
      typed.details?.errors?.some(validationIssue => validationIssue.code === code),
      true,
    )
    return true
  })
}

const committedBaselineIds = (root: string) =>
  scanBaseline(root).flatMap(({ kind, subject }) => {
    const directory = join(root, 'encephalon', kind)
    if (!existsSync(directory)) {
      return []
    }
    const record = readdirSync(directory)
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as BrainRecordFile)
      .find(candidate => candidate.subject === subject)
    return record === undefined ? [] : [record.id]
  })

describe('canonical corpus limits', () => {
  test('validates planned graph bytes without counting runtime paths', () => {
    const root = createRoot()
    const plans = Array.from({ length: MAX_CANONICAL_RECORD_BYTES / (1024 * 1024) }, (_, index) =>
      planRecordAddition(root, {
        createdAt: timestampAt(index),
        id: `planned-byte-accounting-${index}`,
        kind: 'decision',
        payload: { summary: 'x'.repeat(1_048_350) },
        source: 'agent',
        subject: `planning.bytes.${index}`,
      }),
    )
    const canonicalBytes = plans.reduce((total, plan) => total + Buffer.byteLength(plan.formatted, 'utf8'), 0)
    const runtimeBytes = plans.reduce(
      (total, plan) => total + Buffer.byteLength(`${JSON.stringify(plan.record, null, 2)}\n`, 'utf8'),
      0,
    )

    assert.equal(canonicalBytes <= MAX_CANONICAL_RECORD_BYTES, true)
    assert.equal(runtimeBytes > MAX_CANONICAL_RECORD_BYTES, true)
    assert.doesNotThrow(() =>
      assertRecordGraph(
        root,
        plans.map(plan => plan.record),
      ),
    )
    assert.doesNotThrow(() =>
      assertRecordGraph(
        root,
        plans.map(plan => plan.record),
        'Canonical records are invalid.',
        {},
        canonicalBytes,
      ),
    )
  })

  test('reports baseline corpus limits before a canonical timestamp ceiling', () => {
    const root = createRoot()
    for (const index of Array.from({ length: MAX_CANONICAL_RECORDS }, (_, position) => position)) {
      writeCanonicalRecord(root, {
        createdAt: index === MAX_CANONICAL_RECORDS - 1 ? '9999-12-31T23:59:59.999Z' : timestampAt(index),
        id: `baseline-limit-${index.toString().padStart(4, '0')}`,
        subject: `baseline.limit.${index}`,
      })
    }

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown
          details?: { errors?: Array<{ code?: unknown }> }
        }
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(
          actual.details?.errors?.some(issue => issue.code === 'CORPUS_RECORD_LIMIT'),
          true,
        )
        return true
      },
    )
  })

  test('reports corpus budget overflows deterministically', () => {
    const recordCountRoot = createRoot()
    for (const index of Array.from({ length: MAX_CANONICAL_RECORDS + 1 }, (_, value) => value)) {
      writeCanonicalRecord(recordCountRoot, {
        createdAt: timestampAt(index),
        id: `count-${index}`,
        ...(index === MAX_CANONICAL_RECORDS ? { kind: 'context' } : {}),
        subject: `validation.count.${index}`,
      })
    }
    const recordCountResult = api.validateRecords({ root: recordCountRoot })
    assert.equal(recordCountResult.valid, false)
    assert.equal(recordCountResult.errors[0]?.code, 'CORPUS_RECORD_LIMIT')
    assert.equal(recordCountResult.recordsChecked, MAX_CANONICAL_RECORDS)

    const byteRoot = createRoot()
    for (const index of Array.from(
      { length: Math.ceil(MAX_CANONICAL_RECORD_BYTES / (900 * 1024)) + 1 },
      (_, value) => value,
    )) {
      writeCanonicalRecord(byteRoot, {
        createdAt: timestampAt(index),
        id: `bytes-${index}`,
        payload: { text: 'x'.repeat(900 * 1024) },
        subject: `validation.bytes.${index}`,
      })
    }
    const byteResult = api.validateRecords({ root: byteRoot })
    assert.equal(byteResult.valid, false)
    assert.equal(byteResult.errors[0]?.code, 'CORPUS_BYTE_LIMIT')

    const edgeRoot = createRoot()
    const edgesPerRecord = 1000
    for (const recordIndex of Array.from({ length: MAX_SUPERSESSION_EDGES / edgesPerRecord }, (_, value) => value)) {
      writeCanonicalRecord(edgeRoot, {
        createdAt: timestampAt(recordIndex),
        id: `edge-budget-${recordIndex}`,
        subject: `validation.edges.${recordIndex}`,
        supersedes: Array.from({ length: edgesPerRecord }, (_, index) => `missing-${recordIndex}-${index}`),
      })
    }
    writeCanonicalRecord(edgeRoot, {
      createdAt: timestampAt(MAX_SUPERSESSION_EDGES / edgesPerRecord),
      id: 'edge-budget-overflow',
      supersedes: ['one-more-missing-edge'],
    })
    const edgeResult = api.validateRecords({ root: edgeRoot })
    assert.equal(edgeResult.valid, false)
    assert.equal(edgeResult.errors[0]?.code, 'CORPUS_SUPERSEDES_LIMIT')

    const artifactRoot = createRoot()
    for (const recordIndex of Array.from({ length: MAX_ARTIFACT_REFERENCES / 5 + 1 }, (_, value) => value)) {
      const id = `artifact-${recordIndex}`
      writeCanonicalRecord(artifactRoot, {
        artifacts: Array.from(
          { length: 5 },
          (_, artifactIndex) => `_artifacts/decision/${id}/file-${artifactIndex}.txt`,
        ),
        id,
        subject: `validation.artifacts.${recordIndex}`,
      })
    }
    const artifactResult = api.validateRecords({ root: artifactRoot })
    assert.equal(artifactResult.valid, false)
    assert.equal(artifactResult.errors[0]?.code, 'CORPUS_ARTIFACT_LIMIT')
  })

  test('accepts canonical directory limits exactly and rejects one excess kind entry without reading it', () => {
    const root = createRoot()
    const brainDirectory = join(root, 'encephalon')
    mkdirSync(join(brainDirectory, '_artifacts'), { recursive: true })
    mkdirSync(join(brainDirectory, '_staging'))
    for (const index of Array.from({ length: 999 }, (_, value) => value)) {
      mkdirSync(join(brainDirectory, `kind-${String(index).padStart(4, '0')}`))
    }
    writeCanonicalRecord(root, { id: 'first-boundary-record' })
    for (const index of Array.from({ length: MAX_CANONICAL_KIND_ENTRIES - 1 }, (_, value) => value)) {
      writeCanonicalRecord(root, {
        id: `boundary-${String(index).padStart(5, '0')}`,
        subject: `validation.boundary.${index}`,
      })
    }
    assert.equal(api.validateRecords({ root }).valid, true)

    writeFileSync(join(brainDirectory, 'decision', 'zzzz-excess-entry'), 'not JSON')
    const overflow = api.validateRecords({ root })
    assert.deepEqual(overflow.errors, [
      {
        code: 'CORPUS_DIRECTORY_ENTRY_LIMIT',
        message: `encephalon/decision may contain at most ${MAX_CANONICAL_KIND_ENTRIES} directory entries.`,
        path: 'encephalon/decision',
      },
    ])
    assert.equal(overflow.recordsChecked, 0)
  })

  test('rejects addRecord when the candidate would exceed corpus count or byte budgets', () => {
    const countRoot = createRoot()
    for (const index of Array.from({ length: MAX_CANONICAL_RECORDS }, (_, value) => value)) {
      writeCanonicalRecord(countRoot, {
        createdAt: timestampAt(index),
        id: `count-existing-${index}`,
        subject: `validation.count-existing.${index}`,
      })
    }

    assertValidationFailureCode(
      () =>
        api.addRecord({
          id: 'count-overflow',
          kind: 'decision',
          payload: {},
          root: countRoot,
          source: 'test',
          subject: 'validation.count-overflow',
        }),
      'CORPUS_RECORD_LIMIT',
    )
    assert.equal(existsSync(join(countRoot, 'encephalon', 'decision', 'count-overflow.json')), false)

    // Near-maximum records leave about 512 KiB of the corpus byte budget, which the candidate exceeds.
    const byteRoot = createRoot()
    for (const index of Array.from({ length: MAX_CANONICAL_RECORD_BYTES / (1024 * 1024) }, (_, value) => value)) {
      writeCanonicalRecord(byteRoot, {
        createdAt: timestampAt(index),
        id: `byte-existing-${index}`,
        payload: { text: 'x'.repeat(1020 * 1024) },
        subject: `validation.byte-existing.${index}`,
      })
    }
    assert.equal(api.validateRecords({ root: byteRoot }).valid, true)

    assertValidationFailureCode(
      () =>
        api.addRecord({
          id: 'byte-overflow',
          kind: 'decision',
          payload: { text: 'x'.repeat(600 * 1024) },
          root: byteRoot,
          source: 'test',
          subject: 'validation.byte-overflow',
        }),
      'CORPUS_BYTE_LIMIT',
    )
    assert.equal(existsSync(join(byteRoot, 'encephalon', 'decision', 'byte-overflow.json')), false)
  })

  test('retries root and kind directory overflows that settle within their exact bounds', () => {
    const rootOverflow = createRoot()
    const rootDirectory = join(rootOverflow, 'encephalon')
    mkdirSync(join(rootDirectory, '_artifacts'), { recursive: true })
    mkdirSync(join(rootDirectory, '_staging'))
    const kindNames = Array.from(
      { length: MAX_CANONICAL_KIND_DIRECTORIES + 1 },
      (_, index) => `kind${index.toString().padStart(4, '0')}`,
    )
    for (const name of kindNames) {
      mkdirSync(join(rootDirectory, name))
    }
    assert.equal(kindNames.length + 2, MAX_CANONICAL_BRAIN_ROOT_ENTRIES + 1)
    let rootGraphValidations = 0

    const rootResult = validateRecordsResolved(rootOverflow, {
      hooks: {
        graphValidation: () => {
          rootGraphValidations += 1
          if (rootGraphValidations === 1) {
            rmSync(join(rootDirectory, kindNames.at(-1) as string), { recursive: true })
          }
        },
      },
    })

    assert.deepEqual(rootResult, { errors: [], recordsChecked: 0, truncated: false, valid: true })
    assert.equal(rootGraphValidations, 2)

    const kindOverflow = createRoot()
    for (const index of Array.from({ length: MAX_CANONICAL_KIND_ENTRIES + 1 }, (_, entryIndex) => entryIndex)) {
      writeCanonicalRecord(kindOverflow, {
        createdAt: timestampAt(index),
        id: `overflow${index.toString().padStart(4, '0')}`,
        subject: `overflow.kind.${index}`,
      })
    }
    const overflowPath = join(
      kindOverflow,
      'encephalon',
      'decision',
      `overflow${MAX_CANONICAL_KIND_ENTRIES.toString().padStart(4, '0')}.json`,
    )
    let kindGraphValidations = 0

    const kindResult = validateRecordsResolved(kindOverflow, {
      hooks: {
        graphValidation: () => {
          kindGraphValidations += 1
          if (kindGraphValidations === 1) {
            rmSync(overflowPath)
          }
        },
      },
    })

    assert.deepEqual(kindResult, {
      errors: [],
      recordsChecked: MAX_CANONICAL_KIND_ENTRIES,
      truncated: false,
      valid: true,
    })
    assert.equal(kindGraphValidations, 2)
  })

  test('retries rejected per-file and aggregate byte evidence after it shrinks to a valid generation', () => {
    const oversizedRoot = createRoot()
    const oversizedPath = join(oversizedRoot, 'encephalon', 'decision', 'oversized-repair.json')
    ensureParent(oversizedPath)
    writeFileSync(oversizedPath, 'x'.repeat(MAX_RECORD_BYTES + 1))
    let oversizedGraphValidations = 0

    const oversizedResult = validateRecordsResolved(oversizedRoot, {
      hooks: {
        graphValidation: () => {
          oversizedGraphValidations += 1
          if (oversizedGraphValidations === 1) {
            writeCanonicalRecord(oversizedRoot, {
              id: 'oversized-repair',
              subject: 'overflow.per-file.repaired',
            })
          }
        },
      },
    })

    assert.deepEqual(oversizedResult, {
      errors: [],
      recordsChecked: 1,
      truncated: false,
      valid: true,
    })
    assert.equal(oversizedGraphValidations, 2)

    const aggregateRoot = createRoot()
    const payloadLength = MAX_RECORD_BYTES - 512
    const largeRecordCount = MAX_CANONICAL_RECORD_BYTES / (1024 * 1024)
    const largePaths = Array.from({ length: largeRecordCount }, (_, index) => {
      const id = `aggregate${index}`
      writeCanonicalRecord(aggregateRoot, {
        createdAt: timestampAt(index),
        id,
        payload: { text: 'x'.repeat(payloadLength) },
        subject: `overflow.aggregate.${index}`,
      })
      return join(aggregateRoot, 'encephalon', 'decision', `${id}.json`)
    })
    const acceptedBytes = largePaths.reduce((total, largePath) => total + statSync(largePath).size, 0)
    assert.equal(acceptedBytes < MAX_CANONICAL_RECORD_BYTES, true)
    const rejectedId = 'aggregate-rejected'
    writeCanonicalRecord(aggregateRoot, {
      createdAt: timestampAt(largeRecordCount),
      id: rejectedId,
      payload: { text: 'y'.repeat(MAX_CANONICAL_RECORD_BYTES - acceptedBytes + 1024) },
      subject: 'overflow.aggregate.rejected',
    })
    const rejectedPath = join(aggregateRoot, 'encephalon', 'decision', `${rejectedId}.json`)
    assert.equal(statSync(rejectedPath).size <= MAX_RECORD_BYTES, true)
    assert.equal(acceptedBytes + statSync(rejectedPath).size > MAX_CANONICAL_RECORD_BYTES, true)
    let aggregateGraphValidations = 0

    const aggregateResult = validateRecordsResolved(aggregateRoot, {
      hooks: {
        graphValidation: () => {
          aggregateGraphValidations += 1
          if (aggregateGraphValidations === 1) {
            writeCanonicalRecord(aggregateRoot, {
              createdAt: timestampAt(largeRecordCount),
              id: rejectedId,
              subject: 'overflow.aggregate.repaired',
            })
          }
        },
      },
    })

    assert.equal(aggregateResult.valid, true)
    assert.equal(aggregateResult.recordsChecked, largeRecordCount + 1)
    assert.equal(aggregateGraphValidations, 2)
  })

  test('charges aggregate bytes from the accepted descriptor generation after pathname growth', () => {
    const root = createRoot()
    const payloadLength = MAX_RECORD_BYTES - 512
    const largeRecordCount = MAX_CANONICAL_RECORD_BYTES / (1024 * 1024)
    const largePaths = Array.from({ length: largeRecordCount }, (_, index) => {
      const id = `descriptor-bound${index}`
      writeCanonicalRecord(root, {
        createdAt: timestampAt(index),
        id,
        payload: { text: 'x'.repeat(payloadLength) },
        subject: `descriptor.bound.${index}`,
      })
      return join(root, 'encephalon', 'decision', `${id}.json`)
    })
    const acceptedBytes = largePaths.reduce((total, largePath) => total + statSync(largePath).size, 0)
    const id = 'zz-descriptor-growth'
    writeCanonicalRecord(root, {
      createdAt: timestampAt(largeRecordCount),
      id,
      subject: 'descriptor.bound.growth',
    })
    const path = join(root, 'encephalon', 'decision', `${id}.json`)
    const growthPayload = MAX_CANONICAL_RECORD_BYTES - acceptedBytes + 1024
    assert.equal(growthPayload < MAX_RECORD_BYTES - 512, true)
    let changed = false
    let canonicalScans = 0

    const result = validateRecordsResolved(root, {
      hooks: {
        canonicalScan: () => {
          canonicalScans += 1
        },
        fault: (point, faultPath) => {
          if (point === 'after-record-lstat' && faultPath === path && !changed) {
            changed = true
            writeCanonicalRecord(root, {
              createdAt: timestampAt(largeRecordCount),
              id,
              payload: { text: 'y'.repeat(growthPayload) },
              subject: 'descriptor.bound.growth',
            })
          }
        },
      },
    })

    assert.equal(changed, true)
    assert.equal(canonicalScans, 2)
    assert.equal(result.valid, false)
    assert.equal(
      result.errors.some(error => error.code === 'CORPUS_BYTE_LIMIT'),
      true,
    )
  })

  test('preserves a stable batch-limit failure after a complete replan', () => {
    const root = createRoot()
    for (const index of Array.from({ length: MAX_CANONICAL_RECORDS - 3 }, (_, value) => value)) {
      const suffix = String(index).padStart(5, '0')
      writeRecordFile(root, {
        createdAt: '2026-01-01T00:00:00.000Z',
        id: `existing-init-record-${suffix}`,
        kind: 'decision',
        payload: {},
        source: 'test',
        subject: `existing.init-record-${suffix}`,
      })
    }
    let changed = false

    assert.throws(
      () =>
        initEncephalonWithHooks(
          { root },
          {
            recordWriteHooks: {
              fault: point => {
                if (point === 'before-publication' && !changed) {
                  changed = true
                  writeRecordFile(root, {
                    createdAt: '2026-01-01T00:00:00.001Z',
                    id: 'concurrent-init-record-limit',
                    kind: 'decision',
                    payload: {},
                    source: 'test',
                    subject: 'concurrent.init-record-limit',
                  })
                }
              },
            },
          },
        ),
      error => {
        const actual = error as EncephalonError
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(
          (actual.details.errors as Array<{ code?: unknown }>).some(issue => issue.code === 'CORPUS_RECORD_LIMIT'),
          true,
        )
        return true
      },
    )

    assert.equal(changed, true)
    assert.deepEqual(committedBaselineIds(root), [])
    assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')), false)
    assert.equal(existsSync(join(root, 'AGENTS.md')), false)
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false)
  })

  test('uses disk hydration when baseline additions exceed actual corpus bytes', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'actual-byte-overflow' }))
    const directory = join(root, 'encephalon', 'context')
    mkdirSync(directory, { recursive: true })
    // Near-maximum padded records leave 640 bytes of the corpus byte budget, less than the baseline records need.
    const paddingRecords = MAX_CANONICAL_RECORD_BYTES / 1_048_576
    const bytesPerRecord = 1_048_571
    for (const index of Array.from({ length: paddingRecords }, (_, value) => value)) {
      const id = `padding-${index}`
      const json = JSON.stringify({
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        id,
        kind: 'context',
        payload: {},
        source: 'test',
        subject: `padding.${index}`,
      })
      assert.equal(Buffer.byteLength(json, 'utf8') < bytesPerRecord, true)
      writeFileSync(join(directory, `${id}.json`), `${json}${' '.repeat(bytesPerRecord - Buffer.byteLength(json))}`)
    }
    assert.equal(bytesPerRecord * paddingRecords, MAX_CANONICAL_RECORD_BYTES - 640)
    assert.equal(api.validateRecords({ root }).valid, true)

    assert.throws(
      () => api.initEncephalon({ root }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown
          details?: { initProgress?: { cacheState?: unknown; committedRecordIds?: unknown; phase?: unknown } }
          message?: unknown
        }
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(actual.message, 'Canonical records are invalid.')
        assert.equal(actual.details?.initProgress?.phase, 'cachePreparation')
        assert.equal(actual.details?.initProgress?.cacheState, 'disposable')
        assert.equal(
          Array.isArray(actual.details?.initProgress?.committedRecordIds) &&
            actual.details.initProgress.committedRecordIds.length,
          3,
        )
        return true
      },
    )
    assert.equal(api.validateRecords({ root }).valid, false)
    assertErrorCode(() => api.prepare({ root }), 'VALIDATION_FAILED')
  })

  test('stable add planning uses one pipeline through the corpus record boundary', () => {
    ;[0, 100, MAX_CANONICAL_RECORDS - 1, MAX_CANONICAL_RECORDS].reduce<undefined>((verified, recordCount) => {
      const root = createRoot()
      mkdirSync(join(root, 'encephalon', '_staging'), { recursive: true })
      mkdirSync(join(root, 'encephalon', 'context'), { recursive: true })
      Array.from({ length: recordCount }, (_, index) =>
        writeRecord(root, {
          createdAt: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
          id: `stable-add-${index.toString().padStart(5, '0')}`,
          ...(index === 0 ? {} : { supersedes: [`stable-add-${(index - 1).toString().padStart(5, '0')}`] }),
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
              : { supersedes: [`stable-add-${(recordCount - 1).toString().padStart(5, '0')}`] }),
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

      if (recordCount < MAX_CANONICAL_RECORDS) {
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
})
