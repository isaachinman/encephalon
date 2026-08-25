import assert from 'node:assert/strict'
import type { BigIntStats } from 'node:fs'
import { describe, test } from 'node:test'
import {
  entryIdentityFrom,
  entryIdentityKey,
  entryMetadataFrom,
  type ManifestEntryMetadata,
  manifestEntryMetadataFrom,
  sameEntryIdentity,
  sameStableEntryMetadata,
  sameStableEntryMetadataExceptCtime,
  sameStableEntryMetadataExceptCtimeAndMode,
  sameStableEntryMetadataExceptMode,
} from '../src/filesystem-entry.ts'

type EntryType = ManifestEntryMetadata['type']

const date = new Date(0)

const metadata = (
  overrides: Partial<Pick<BigIntStats, 'birthtimeNs' | 'ctimeNs' | 'dev' | 'ino' | 'mode' | 'mtimeNs' | 'size'>> = {},
  type: EntryType = 'file',
): BigIntStats => ({
  atime: date,
  atimeMs: 0n,
  atimeNs: 0n,
  birthtime: date,
  birthtimeMs: 0n,
  birthtimeNs: 101n,
  blksize: 4_096n,
  blocks: 8n,
  ctime: date,
  ctimeMs: 0n,
  ctimeNs: 103n,
  dev: 107n,
  gid: 0n,
  ino: 109n,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isDirectory: () => type === 'directory',
  isFIFO: () => false,
  isFile: () => type === 'file',
  isSocket: () => false,
  isSymbolicLink: () => type === 'symlink',
  mode: 0o100_644n,
  mtime: date,
  mtimeMs: 0n,
  mtimeNs: 127n,
  nlink: 1n,
  rdev: 0n,
  size: 131n,
  uid: 0n,
  ...overrides,
})

describe('lossless filesystem entry metadata', () => {
  test('keeps device and inode identities distinct beyond Number precision', () => {
    const roundedCases = [
      {
        first: metadata({ dev: 9_007_199_254_740_992n }),
        second: metadata({ dev: 9_007_199_254_740_993n }),
      },
      {
        first: metadata({ ino: 9_007_199_254_740_992n }),
        second: metadata({ ino: 9_007_199_254_740_993n }),
      },
    ] as const

    for (const { first, second } of roundedCases) {
      assert.equal(Number(first.dev), Number(second.dev))
      assert.equal(Number(first.ino), Number(second.ino))
      assert.deepEqual(entryIdentityFrom(first), { dev: first.dev, ino: first.ino })
      assert.deepEqual(entryIdentityFrom(second), { dev: second.dev, ino: second.ino })
      assert.equal(sameEntryIdentity(entryIdentityFrom(first), entryIdentityFrom(second)), false)
      assert.notEqual(entryIdentityKey(entryIdentityFrom(first)), entryIdentityKey(entryIdentityFrom(second)))
    }

    assert.equal(
      sameEntryIdentity(
        entryMetadataFrom(metadata()),
        entryMetadataFrom(
          metadata({
            birthtimeNs: 102n,
            ctimeNs: 104n,
            mode: 0o100_600n,
            mtimeNs: 128n,
            size: 132n,
          }),
        ),
      ),
      true,
    )
  })

  test('compares complete stable metadata at nanosecond precision', () => {
    const roundedIdentity = 9_007_199_254_740_992n
    const baseline = entryMetadataFrom(metadata({ dev: roundedIdentity, ino: roundedIdentity }))
    const changedMetadata = (
      changes: Partial<Pick<BigIntStats, 'birthtimeNs' | 'ctimeNs' | 'dev' | 'ino' | 'mode' | 'mtimeNs' | 'size'>>,
    ) => entryMetadataFrom(metadata({ dev: roundedIdentity, ino: roundedIdentity, ...changes }))
    const changedCases = [
      changedMetadata({ birthtimeNs: 102n }),
      changedMetadata({ mtimeNs: 128n }),
      changedMetadata({ ctimeNs: 104n }),
      changedMetadata({ dev: roundedIdentity + 1n }),
      changedMetadata({ ino: roundedIdentity + 1n }),
      changedMetadata({ mode: 0o100_600n }),
      changedMetadata({ size: 132n }),
    ] as const

    assert.deepEqual(baseline, {
      birthtimeNs: 101n,
      ctimeNs: 103n,
      dev: roundedIdentity,
      ino: roundedIdentity,
      mode: 0o100_644n,
      mtimeNs: 127n,
      size: 131n,
    })
    assert.equal(Number(roundedIdentity), Number(roundedIdentity + 1n))
    for (const changed of changedCases) {
      assert.equal(sameStableEntryMetadata(baseline, changed), false)
    }
  })

  test('post-rename comparison omits only ctime nanoseconds', () => {
    const roundedIdentity = 9_007_199_254_740_992n
    const baseline = entryMetadataFrom(metadata({ dev: roundedIdentity, ino: roundedIdentity }))
    const cases = [
      { changes: { ctimeNs: 104n }, expected: true },
      { changes: { dev: roundedIdentity + 1n, ino: roundedIdentity }, expected: false },
      { changes: { dev: roundedIdentity, ino: roundedIdentity + 1n }, expected: false },
      { changes: { birthtimeNs: 102n }, expected: false },
      { changes: { mode: 0o100_600n }, expected: false },
      { changes: { mtimeNs: 128n }, expected: false },
      { changes: { size: 132n }, expected: false },
    ] as const

    for (const { changes, expected } of cases) {
      const changed = entryMetadataFrom(metadata({ dev: roundedIdentity, ino: roundedIdentity, ...changes }))
      assert.equal(sameStableEntryMetadataExceptCtime(baseline, changed), expected)
    }
  })

  test('instruction comparisons omit only their explicit metadata fields', () => {
    const baseline = entryMetadataFrom(metadata())

    assert.equal(sameStableEntryMetadataExceptMode(baseline, entryMetadataFrom(metadata({ mode: 0o100_600n }))), true)
    assert.equal(sameStableEntryMetadataExceptMode(baseline, entryMetadataFrom(metadata({ ctimeNs: 104n }))), false)
    assert.equal(
      sameStableEntryMetadataExceptCtimeAndMode(
        baseline,
        entryMetadataFrom(metadata({ ctimeNs: 104n, mode: 0o100_600n })),
      ),
      true,
    )
    assert.equal(
      sameStableEntryMetadataExceptCtimeAndMode(baseline, entryMetadataFrom(metadata({ mtimeNs: 128n }))),
      false,
    )
  })

  test('projects canonical manifest strings and independently derived entry types', () => {
    const cases = [
      { expectedType: 'file', type: 'file' },
      { expectedType: 'directory', type: 'directory' },
      { expectedType: 'symlink', type: 'symlink' },
      { expectedType: 'other', type: 'other' },
    ] as const

    for (const { expectedType, type } of cases) {
      assert.deepEqual(
        manifestEntryMetadataFrom(
          metadata(
            {
              ctimeNs: 9_007_199_254_740_993n,
              mode: 0n,
              mtimeNs: 9_007_199_254_740_995n,
              size: 9_007_199_254_740_997n,
            },
            type,
          ),
        ),
        {
          ctimeNanoseconds: '9007199254740993',
          mtimeNanoseconds: '9007199254740995',
          size: '9007199254740997',
          type: expectedType,
        },
      )
    }
  })
})
