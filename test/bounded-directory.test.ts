import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type DirectoryReader, readBoundedDirectoryEntries } from '../src/bounded-directory.ts'

type Entry = Readonly<{ name: string }>

const readerFor = (entries: readonly Entry[], failureAt?: number) => {
  let closes = 0
  let reads = 0
  const reader: DirectoryReader<Entry> = {
    closeSync: () => {
      closes += 1
    },
    readSync: () => {
      if (reads === failureAt) {
        throw new Error('injected bounded read failure')
      }
      const entry = entries[reads] ?? null
      reads += 1
      return entry
    },
  }
  return { reader, state: () => ({ closes, reads }) }
}

describe('bounded directory reader', () => {
  test('performs zero reads for a zero maximum and leaves closing to its caller', () => {
    const fixture = readerFor([{ name: 'unread' }])

    assert.deepEqual(readBoundedDirectoryEntries(fixture.reader, 0), { entries: [], exhausted: false })
    assert.deepEqual(fixture.state(), { closes: 0, reads: 0 })
  })

  test('stops at the exact limit without probing for EOF', () => {
    const fixture = readerFor([{ name: 'first' }, { name: 'second' }])
    let observed = 0

    assert.deepEqual(
      readBoundedDirectoryEntries(fixture.reader, 2, () => {
        observed += 1
      }),
      { entries: [{ name: 'first' }, { name: 'second' }], exhausted: false },
    )
    assert.deepEqual(fixture.state(), { closes: 0, reads: 2 })
    assert.equal(observed, 2)
  })

  test('reports exhaustion only after observing EOF', () => {
    const fixture = readerFor([{ name: 'only' }])

    assert.deepEqual(readBoundedDirectoryEntries(fixture.reader, 4), {
      entries: [{ name: 'only' }],
      exhausted: true,
    })
    assert.deepEqual(fixture.state(), { closes: 0, reads: 2 })
  })

  test('lazily bounds a conceptual 100,000-entry directory', () => {
    let reads = 0
    const reader: DirectoryReader<Entry> = {
      closeSync: () => undefined,
      readSync: () => {
        reads += 1
        if (reads === 65) {
          throw new Error('read beyond bound')
        }
        return { name: `entry-${reads}` }
      },
    }

    assert.equal(readBoundedDirectoryEntries(reader, 64).entries.length, 64)
    assert.equal(reads, 64)
  })

  test('propagates read failures without closing the caller-owned reader', () => {
    const fixture = readerFor([{ name: 'first' }], 1)

    assert.throws(() => readBoundedDirectoryEntries(fixture.reader, 4), /injected bounded read failure/)
    assert.deepEqual(fixture.state(), { closes: 0, reads: 1 })
  })
})
