import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import * as packageTarballAuthority from './package-tarball.ts'
import {
  packageTarballDigests,
  parsePackageCheckArguments,
  readPackageTarEntries,
  snapshotPackageTarball,
} from './package-tarball.ts'

const root = resolve(import.meta.dirname, '..')
const repositoryRelative = (path: string) => relative(root, path).split(sep).join('/')

const writeTarString = (header: Buffer, offset: number, length: number, value: string) => {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

const writeTarOctal = (header: Buffer, offset: number, length: number, value: number) => {
  writeTarString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

const tarEntry = (path: string, mode: number, content: Buffer, type = '0') => {
  const header = Buffer.alloc(512)
  writeTarString(header, 0, 100, path)
  writeTarOctal(header, 100, 8, mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, content.length)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = type.charCodeAt(0)
  writeTarString(header, 257, 8, 'ustar\0')
  writeTarString(header, 265, 2, '00')
  writeTarOctal(
    header,
    148,
    8,
    header.reduce((checksum, byte) => checksum + byte, 0),
  )
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, content, padding])
}

describe('package tarball authority', () => {
  test('parses package-check creation, retention, and supplied-tarball modes', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-parser-'))
    const tarball = resolve(fixtureDirectory, 'encephalon-0.3.0.tgz')
    try {
      writeFileSync(tarball, 'fixture')

      assert.deepEqual(parsePackageCheckArguments([]), {})
      assert.deepEqual(parsePackageCheckArguments(['--retain-tarball', 'package-artifacts']), {
        retainedDirectory: resolve(root, 'package-artifacts'),
      })
      assert.deepEqual(parsePackageCheckArguments(['--tarball', repositoryRelative(tarball)]), {
        suppliedTarball: tarball,
      })
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('rejects ambiguous, missing, absolute, and traversing package-check arguments', () => {
    assert.throws(() =>
      parsePackageCheckArguments([
        '--retain-tarball',
        'package-artifacts',
        '--tarball',
        'package-artifacts/encephalon-0.3.0.tgz',
      ]),
    )
    assert.throws(() => parsePackageCheckArguments(['--retain-tarball']))
    assert.throws(() => parsePackageCheckArguments(['--tarball']))
    assert.throws(() => parsePackageCheckArguments(['--retain-tarball', resolve(root, 'package-artifacts')]))
    assert.throws(() => parsePackageCheckArguments(['--tarball', resolve(root, 'package-artifacts.tgz')]))
    assert.throws(() => parsePackageCheckArguments(['--retain-tarball', '../package-artifacts']))
    assert.throws(() => parsePackageCheckArguments(['--tarball', 'package-artifacts/../candidate.tgz']))
  })

  test('rejects symlink ancestors, non-regular tarballs, and multiply linked tarballs', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-paths-'))
    const realDirectory = resolve(fixtureDirectory, 'real')
    const symlinkDirectory = resolve(fixtureDirectory, 'symlink')
    const regularTarball = resolve(realDirectory, 'regular.tgz')
    const hardLink = resolve(realDirectory, 'hard-link.tgz')
    const directoryTarball = resolve(fixtureDirectory, 'directory.tgz')
    try {
      mkdirSync(realDirectory)
      mkdirSync(directoryTarball)
      writeFileSync(regularTarball, 'fixture')
      symlinkSync(realDirectory, symlinkDirectory, 'junction')
      assert.throws(() =>
        parsePackageCheckArguments(['--tarball', repositoryRelative(resolve(symlinkDirectory, 'regular.tgz'))]),
      )
      assert.throws(() => parsePackageCheckArguments(['--tarball', repositoryRelative(directoryTarball)]))

      linkSync(regularTarball, hardLink)
      assert.throws(() => parsePackageCheckArguments(['--tarball', repositoryRelative(regularTarball)]))
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('reads normalised package tar entry paths, modes, and sizes', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-entries-'))
    const tarball = resolve(fixtureDirectory, `fixture-${randomUUID()}.tgz`)
    try {
      const archive = Buffer.concat([
        tarEntry('./package/dist/cli.mjs', 0o755, Buffer.from('#!/usr/bin/env node\n')),
        tarEntry('package/README.md', 0o644, Buffer.from('read me\n')),
        Buffer.alloc(1024),
      ])
      writeFileSync(tarball, gzipSync(archive))

      const entries = readPackageTarEntries(tarball)
      assert.deepEqual(entries, [
        {
          content: Buffer.from('#!/usr/bin/env node\n'),
          mode: 0o755,
          path: 'package/dist/cli.mjs',
          size: 20,
        },
        { content: Buffer.from('read me\n'), mode: 0o644, path: 'package/README.md', size: 8 },
      ])
      assert.equal(Object.isFrozen(entries), true)
      assert.equal(
        entries.every(entry => Object.isFrozen(entry)),
        true,
      )
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('preserves legitimate trailing spaces in tar entry paths', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-padding-'))
    const tarball = resolve(fixtureDirectory, 'fixture.tgz')
    try {
      writeFileSync(
        tarball,
        gzipSync(
          Buffer.concat([tarEntry('package/trailing-space ', 0o644, Buffer.from('bytes\n')), Buffer.alloc(1024)]),
        ),
      )

      assert.deepEqual(readPackageTarEntries(tarball), [
        {
          content: Buffer.from('bytes\n'),
          mode: 0o644,
          path: 'package/trailing-space ',
          size: 6,
        },
      ])
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('rejects source growth and ancestor replacement while snapshotting supplied bytes', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-snapshot-race-'))
    const sourceDirectory = resolve(fixtureDirectory, 'source')
    const movedDirectory = resolve(fixtureDirectory, 'source-moved')
    const snapshotDirectory = resolve(fixtureDirectory, 'snapshot')
    const source = resolve(sourceDirectory, 'candidate.tgz')
    try {
      mkdirSync(sourceDirectory)
      mkdirSync(snapshotDirectory)
      writeFileSync(source, 'candidate bytes')

      assert.throws(
        () =>
          snapshotPackageTarball(source, snapshotDirectory, {
            afterSourceOpen: () => appendFileSync(source, '!'),
          }),
        /unchanged regular file|changed while/u,
      )

      rmSync(resolve(snapshotDirectory, 'package.tgz'), { force: true })
      writeFileSync(source, 'candidate bytes')
      assert.throws(
        () =>
          snapshotPackageTarball(source, snapshotDirectory, {
            afterSourceOpen: () => {
              renameSync(sourceDirectory, movedDirectory)
              mkdirSync(sourceDirectory)
              writeFileSync(source, 'replacement bytes')
            },
          }),
        /ancestor|changed while|unchanged regular file/u,
      )
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('rejects destination-ancestor replacement before retained artifact installation', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-retention-race-'))
    const source = resolve(fixtureDirectory, 'candidate.tgz')
    const snapshotDirectory = resolve(fixtureDirectory, 'snapshot')
    const retainedParent = resolve(fixtureDirectory, 'retained-parent')
    const retainedDirectory = resolve(retainedParent, 'package-artifacts')
    const movedParent = resolve(fixtureDirectory, 'retained-parent-moved')
    const { retainPackageArtifact } = packageTarballAuthority as typeof packageTarballAuthority & {
      retainPackageArtifact?: (
        snapshot: ReturnType<typeof snapshotPackageTarball>,
        options: {
          filename: string
          packageVersion: string
          retainedDirectory: string
          sourceCommit: string
        },
        hooks?: { beforeInstall?: () => void },
      ) => unknown
    }
    try {
      mkdirSync(snapshotDirectory)
      mkdirSync(retainedDirectory, { recursive: true })
      writeFileSync(source, 'candidate bytes')
      const snapshot = snapshotPackageTarball(source, snapshotDirectory)

      assert.equal(typeof retainPackageArtifact, 'function')
      assert.throws(
        () =>
          retainPackageArtifact?.(
            snapshot,
            {
              filename: 'encephalon-0.3.0.tgz',
              packageVersion: '0.3.0',
              retainedDirectory,
              sourceCommit: 'a'.repeat(40),
            },
            {
              beforeInstall: () => {
                renameSync(retainedParent, movedParent)
                mkdirSync(retainedDirectory, { recursive: true })
              },
            },
          ),
        /destination|directory changed/u,
      )
      assert.equal(existsSync(resolve(retainedDirectory, 'encephalon-0.3.0.tgz')), false)
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('replaces a stale exact artifact only through the verified retention flow', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-retention-replace-'))
    const retainedDirectory = resolve(fixtureDirectory, 'package-artifacts')
    const firstSnapshotDirectory = resolve(fixtureDirectory, 'first-snapshot')
    const secondSnapshotDirectory = resolve(fixtureDirectory, 'second-snapshot')
    const firstSource = resolve(fixtureDirectory, 'first.tgz')
    const secondSource = resolve(fixtureDirectory, 'second.tgz')
    try {
      mkdirSync(retainedDirectory)
      mkdirSync(firstSnapshotDirectory)
      mkdirSync(secondSnapshotDirectory)
      writeFileSync(firstSource, 'stale candidate bytes')
      writeFileSync(secondSource, 'reviewed candidate bytes')
      packageTarballAuthority.retainPackageArtifact(snapshotPackageTarball(firstSource, firstSnapshotDirectory), {
        filename: 'encephalon-0.3.0.tgz',
        packageVersion: '0.3.0',
        retainedDirectory,
        sourceCommit: 'a'.repeat(40),
      })

      const retained = packageTarballAuthority.retainPackageArtifact(
        snapshotPackageTarball(secondSource, secondSnapshotDirectory),
        {
          filename: 'encephalon-0.3.0.tgz',
          packageVersion: '0.3.0',
          retainedDirectory,
          sourceCommit: 'b'.repeat(40),
        },
      )

      assert.equal(readFileSync(retained.path, 'utf8'), 'reviewed candidate bytes')
      assert.equal(retained.metadata.sourceCommit, 'b'.repeat(40))
      assert.deepEqual(readdirSync(retainedDirectory).sort(), [
        'encephalon-0.3.0.tgz',
        'encephalon-0.3.0.tgz.metadata.json',
      ])
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('rejects non-regular package tar entries', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-entry-type-'))
    const tarball = resolve(fixtureDirectory, 'fixture.tgz')
    try {
      writeFileSync(
        tarball,
        gzipSync(
          Buffer.concat([tarEntry('package/dist/cli.mjs', 0o777, Buffer.from('target'), '2'), Buffer.alloc(1024)]),
        ),
      )
      assert.throws(() => readPackageTarEntries(tarball))
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('rejects traversing package tar entry paths instead of normalising them into the manifest', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-entry-path-'))
    const tarball = resolve(fixtureDirectory, 'fixture.tgz')
    try {
      writeFileSync(
        tarball,
        gzipSync(
          Buffer.concat([tarEntry('package/dist/../package.json', 0o644, Buffer.from('{}\n')), Buffer.alloc(1024)]),
        ),
      )
      assert.throws(() => readPackageTarEntries(tarball))
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('requires two zero end blocks and rejects non-zero trailing archive bytes', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-termination-'))
    const entry = tarEntry('package/package.json', 0o644, Buffer.from('{}\n'))
    const invalidArchives = [
      Buffer.concat([entry, Buffer.alloc(512)]),
      Buffer.concat([entry, Buffer.alloc(1024), Buffer.from('non-zero trailing bytes')]),
    ]
    try {
      invalidArchives.forEach((archive, index) => {
        const tarball = resolve(fixtureDirectory, `invalid-${index}.tgz`)
        writeFileSync(tarball, gzipSync(archive))
        assert.throws(() => readPackageTarEntries(tarball))
      })
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })

  test('derives all package digests and size from the literal tarball bytes', () => {
    const fixtureDirectory = mkdtempSync(resolve(root, 'scripts', '.package-tarball-digests-'))
    const tarball = resolve(fixtureDirectory, `fixture-${randomUUID()}.tgz`)
    try {
      writeFileSync(tarball, Buffer.from('encephalon tarball fixture\n', 'utf8'))

      const digests = packageTarballDigests(tarball)
      assert.deepEqual(digests, {
        bytes: 27,
        integrity: 'sha512-dfFLXs/7y0JWboOFnSz2fruFPSyx5piLjpkIiNqn7IyMdxOupfVNyACYibik4vgoUcZnDxWr4qA+zuDfXWzbkg==',
        sha1: 'b47ab816ffbef6fab9940a47195643b0b072c225',
        sha256: 'f70a76930b0cd5a22ef75b58c58880df2b62b826c5e8848119ad66915abc29d2',
        sha512:
          '75f14b5ecffbcb42566e83859d2cf67ebb853d2cb1e6988b8e990888daa7ec8c8c7713aea5f54dc8009889b8a4e2f82851c6670f15abe2a03ecee0df5d6cdb92',
      })
      assert.equal(Object.isFrozen(digests), true)
    } finally {
      rmSync(fixtureDirectory, { force: true, recursive: true })
    }
  })
})
