import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { collectBoundedDirectoryEntries } from '../src/canonical-layout.ts'

type Entry = { name: string }

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

    assert.deepEqual(collectBoundedDirectoryEntries('ignored', 2, first.open), { entries: [], overflow: true })
    assert.deepEqual(collectBoundedDirectoryEntries('ignored', 2, second.open), { entries: [], overflow: true })
    assert.deepEqual(first.state(), { closed: 1, entriesRead: 3 })
    assert.deepEqual(second.state(), { closed: 1, entriesRead: 3 })
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
