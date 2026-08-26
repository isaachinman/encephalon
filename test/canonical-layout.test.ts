import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import type { CanonicalDirectorySnapshot } from '../src/canonical-layout.ts'
import * as canonicalLayout from '../src/canonical-layout.ts'
import { collectBoundedDirectoryEntries } from '../src/canonical-layout.ts'

type Entry = { name: string }

type SameCanonicalDirectoryGeneration = (
  first: CanonicalDirectorySnapshot,
  second: CanonicalDirectorySnapshot,
) => boolean

type RecaptureCanonicalDirectoryGeneration = (snapshot: CanonicalDirectorySnapshot) => CanonicalDirectorySnapshot

const sameCanonicalDirectoryGeneration = Reflect.get(canonicalLayout, 'sameCanonicalDirectoryGeneration') as
  | SameCanonicalDirectoryGeneration
  | undefined
const recaptureCanonicalDirectoryGeneration = Reflect.get(canonicalLayout, 'recaptureCanonicalDirectoryGeneration') as
  | RecaptureCanonicalDirectoryGeneration
  | undefined

const temporaryRoots: string[] = []

const createGenerationDirectory = () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-canonical-generation-test-'))
  temporaryRoots.push(root)
  const directory = join(root, 'canonical')
  mkdirSync(directory)
  writeFileSync(join(directory, 'alpha'), '')
  writeFileSync(join(directory, 'beta'), '')
  return { directory, root }
}

const generationExports = () => {
  assert.equal(
    typeof sameCanonicalDirectoryGeneration,
    'function',
    'sameCanonicalDirectoryGeneration export is missing',
  )
  assert.equal(
    typeof recaptureCanonicalDirectoryGeneration,
    'function',
    'recaptureCanonicalDirectoryGeneration export is missing',
  )
  return {
    recapture: recaptureCanonicalDirectoryGeneration as RecaptureCanonicalDirectoryGeneration,
    same: sameCanonicalDirectoryGeneration as SameCanonicalDirectoryGeneration,
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

const readerFor = (entries: Entry[], failureAt?: number, closeFailure = false) => {
  let closed = 0
  let entriesRead = 0
  let index = 0
  return {
    open: () => ({
      closeSync: () => {
        closed += 1
        if (closeFailure) {
          throw new Error('injected directory close failure')
        }
      },
      readSync: () => {
        if (index === failureAt) {
          throw new Error('injected directory read failure')
        }
        const entry = entries[index] ?? null
        index += 1
        if (entry !== null) {
          entriesRead += 1
        }
        return entry
      },
    }),
    state: () => ({ closed, entriesRead }),
  }
}

describe('bounded canonical directory collection', () => {
  test('reads no more than limit plus one and hides order and names on overflow', () => {
    const first = readerFor([{ name: 'z' }, { name: 'secret-excess' }, { name: 'a' }, { name: 'unread' }])
    const second = readerFor([{ name: 'a' }, { name: 'z' }, { name: 'different-excess' }, { name: 'unread' }])
    let observedEntries = 0

    assert.deepEqual(
      collectBoundedDirectoryEntries('ignored', 2, first.open, () => {
        observedEntries += 1
      }),
      { entries: [], overflow: true },
    )
    assert.deepEqual(collectBoundedDirectoryEntries('ignored', 2, second.open), { entries: [], overflow: true })
    assert.deepEqual(first.state(), { closed: 1, entriesRead: 3 })
    assert.deepEqual(second.state(), { closed: 1, entriesRead: 3 })
    assert.equal(observedEntries, 3)
  })

  test('does not inspect entry names after detecting overflow', () => {
    const entries = [
      { name: 'first' },
      { name: 'second' },
      {
        get name(): string {
          throw new Error('overflow name accessed')
        },
      },
    ]
    const reader = readerFor(entries)

    assert.deepEqual(collectBoundedDirectoryEntries('ignored', 2, reader.open), { entries: [], overflow: true })
    assert.deepEqual(reader.state(), { closed: 1, entriesRead: 3 })
  })

  test('sorts only bounded results and closes readers after success and failure', () => {
    const success = readerFor([{ name: 'z' }, { name: 'a' }])
    assert.deepEqual(collectBoundedDirectoryEntries('ignored', 2, success.open), {
      entries: [{ name: 'a' }, { name: 'z' }],
      overflow: false,
    })
    assert.deepEqual(success.state(), { closed: 1, entriesRead: 2 })

    const failure = readerFor([{ name: 'a' }], 1)
    assert.throws(() => collectBoundedDirectoryEntries('ignored', 2, failure.open), /injected directory read failure/)
    assert.deepEqual(failure.state(), { closed: 1, entriesRead: 1 })
  })

  test('preserves a directory read failure when closing also fails', () => {
    const dualFailure = readerFor([{ name: 'a' }], 1, true)
    assert.throws(
      () => collectBoundedDirectoryEntries('ignored', 2, dualFailure.open),
      /injected directory read failure/,
    )
    assert.deepEqual(dualFailure.state(), { closed: 1, entriesRead: 1 })

    const closeFailure = readerFor([], undefined, true)
    assert.throws(
      () => collectBoundedDirectoryEntries('ignored', 2, closeFailure.open),
      /injected directory close failure/,
    )
  })
})

describe('canonical directory generation', () => {
  const mutationCases = [
    {
      mutate: (directory: string) => writeFileSync(join(directory, 'gamma'), ''),
      name: 'added entry',
    },
    {
      mutate: (directory: string) => rmSync(join(directory, 'beta')),
      name: 'removed entry',
    },
    {
      mutate: (directory: string) => renameSync(join(directory, 'beta'), join(directory, 'gamma')),
      name: 'renamed entry',
    },
    {
      mutate: (directory: string) => {
        rmSync(join(directory, 'beta'))
        mkdirSync(join(directory, 'beta'))
      },
      name: 'changed entry type',
    },
  ]

  for (const mutationCase of mutationCases) {
    test(`detects an independently ${mutationCase.name}`, () => {
      const { recapture, same } = generationExports()
      const { directory } = createGenerationDirectory()
      const first = canonicalLayout.captureCanonicalDirectory(directory, 3)

      const unchanged = recapture(first)
      assert.equal(unchanged.maximum, 3)
      assert.equal(same(first, unchanged), true)

      mutationCase.mutate(directory)

      assert.equal(same(first, recapture(first)), false)
    })
  }

  test('detects a replaced directory inode with identical entry names and types', () => {
    const { recapture, same } = generationExports()
    const { directory, root } = createGenerationDirectory()
    const first = canonicalLayout.captureCanonicalDirectory(directory, 2)

    renameSync(directory, join(root, 'captured'))
    mkdirSync(directory)
    writeFileSync(join(directory, 'alpha'), '')
    writeFileSync(join(directory, 'beta'), '')

    assert.equal(same(first, recapture(first)), false)
  })

  test('retains the exact enumeration boundary and detects overflow', () => {
    const { recapture, same } = generationExports()
    const { directory } = createGenerationDirectory()
    const first = canonicalLayout.captureCanonicalDirectory(directory, 2)

    assert.equal(first.maximum, 2)
    assert.equal(first.overflow, false)
    assert.deepEqual(
      first.entries.map(entry => entry.name),
      ['alpha', 'beta'],
    )
    assert.equal(same(first, recapture(first)), true)

    writeFileSync(join(directory, 'gamma'), '')
    const overflow = recapture(first)

    assert.equal(overflow.maximum, 2)
    assert.equal(overflow.overflow, true)
    assert.deepEqual(overflow.entries, [])
    assert.equal(same(first, overflow), false)
  })
})
