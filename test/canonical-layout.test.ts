import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { collectBoundedDirectoryEntries } from '../src/canonical-layout.ts'

type Entry = { name: string }

const readerFor = (entries: Entry[], failureAt?: number) => {
  let closed = 0
  let entriesRead = 0
  let index = 0
  return {
    open: () => ({
      closeSync: () => {
        closed += 1
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
})
