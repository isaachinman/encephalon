import assert from 'node:assert/strict'
import type { BigIntStats } from 'node:fs'
import { describe, test } from 'node:test'
import * as filesystemEntryModule from '../src/filesystem-entry.ts'

type EntryIdentity = {
  readonly dev: bigint
  readonly ino: bigint
}

type EntryMetadata = EntryIdentity & {
  readonly birthtimeNs: bigint
  readonly ctimeNs: bigint
  readonly mode: bigint
  readonly mtimeNs: bigint
  readonly size: bigint
}

type ManifestEntryMetadata = {
  readonly ctimeNanoseconds: string
  readonly mtimeNanoseconds: string
  readonly size: string
  readonly type: 'directory' | 'file' | 'other' | 'symlink'
}

type FilesystemEntryModule = typeof filesystemEntryModule & {
  entryIdentityFrom?: (metadata: BigIntStats) => EntryIdentity
  entryMetadataFrom?: (metadata: BigIntStats) => EntryMetadata
  manifestEntryMetadataFrom?: (metadata: BigIntStats) => ManifestEntryMetadata
  sameStableEntryMetadataExceptCtime?: (first: EntryMetadata, second: EntryMetadata) => boolean
}

type EntryType = ManifestEntryMetadata['type']

const filesystemEntry: FilesystemEntryModule = filesystemEntryModule

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
    assert.equal(typeof filesystemEntry.entryIdentityFrom, 'function')
    const { entryIdentityFrom } = filesystemEntry
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
      assert.equal(filesystemEntry.sameEntryIdentity(entryIdentityFrom(first), entryIdentityFrom(second)), false)
    }
  })

  test('compares complete stable metadata at nanosecond precision', () => {
    assert.equal(typeof filesystemEntry.entryMetadataFrom, 'function')
    const { entryMetadataFrom } = filesystemEntry
    const baseline = entryMetadataFrom(metadata())
    const timestampCases = [
      entryMetadataFrom(metadata({ mtimeNs: 128n })),
      entryMetadataFrom(metadata({ ctimeNs: 104n })),
    ] as const

    assert.deepEqual(baseline, {
      birthtimeNs: 101n,
      ctimeNs: 103n,
      dev: 107n,
      ino: 109n,
      mode: 0o100_644n,
      mtimeNs: 127n,
      size: 131n,
    })
    for (const changed of timestampCases) {
      assert.equal(filesystemEntry.sameStableEntryMetadata(baseline, changed), false)
    }
  })

  test('post-rename comparison omits only ctime nanoseconds', () => {
    assert.equal(typeof filesystemEntry.entryMetadataFrom, 'function')
    assert.equal(typeof filesystemEntry.sameStableEntryMetadataExceptCtime, 'function')
    const { entryMetadataFrom, sameStableEntryMetadataExceptCtime } = filesystemEntry
    const baseline = entryMetadataFrom(metadata())
    const cases = [
      { changes: { ctimeNs: 104n }, expected: true },
      { changes: { dev: 108n }, expected: false },
      { changes: { ino: 110n }, expected: false },
      { changes: { birthtimeNs: 102n }, expected: false },
      { changes: { mode: 0o100_600n }, expected: false },
      { changes: { mtimeNs: 128n }, expected: false },
      { changes: { size: 132n }, expected: false },
    ] as const

    for (const { changes, expected } of cases) {
      const changed = entryMetadataFrom(metadata(changes))
      assert.equal(sameStableEntryMetadataExceptCtime(baseline, changed), expected)
    }
  })

  test('projects canonical manifest strings and independently derived entry types', () => {
    assert.equal(typeof filesystemEntry.manifestEntryMetadataFrom, 'function')
    const { manifestEntryMetadataFrom } = filesystemEntry
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
