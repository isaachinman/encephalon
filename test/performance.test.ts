import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { scanBaseline } from '../src/baseline.ts'
import * as api from '../src/index.ts'
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

const writeRecord = (
  root: string,
  record: {
    createdAt: string
    id: string
    supersedes?: string[]
  },
) => {
  const directory = join(root, 'encephalon', 'context')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${record.id}.json`),
    `${JSON.stringify(
      {
        createdAt: record.createdAt,
        id: record.id,
        kind: 'context',
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
  test('preserves validation issue order for a dense same-subject history', () => {
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

    assert.deepEqual(api.validateRecords({ root }), {
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
  })

  test('preserves baseline output order while scanning many files', () => {
    const root = createRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample-project' }))
    ensureParent(join(root, 'src', 'alpha.ts'))
    writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1')
    writeFileSync(join(root, 'src', 'beta.js'), 'export const beta = 2')
    ensureParent(join(root, 'scripts', 'build.sh'))
    writeFileSync(join(root, 'scripts', 'build.sh'), 'echo build')

    assert.deepEqual(
      scanBaseline(root).map(record => {
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
          topLevelDirectories: ['scripts', 'src'],
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
  })

  test('does not reintroduce persistent accumulator copying in hot loops', () => {
    const recordsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'records.ts'), 'utf8')
    const baselineSource = readFileSync(join(import.meta.dirname, '..', 'src', 'baseline.ts'), 'utf8')

    assert.doesNotMatch(recordsSource, /\.\.\.(?:result|kindResult)\.(?:errors|records)/)
    assert.doesNotMatch(recordsSource, /groups\.set\(key,\s*\[\.\.\./)
    assert.doesNotMatch(baselineSource, /new Map\(current\.languageCounts\)/)
    assert.doesNotMatch(baselineSource, /\.\.\.facts\.(?:directories|recognisedFiles)/)
  })
})
