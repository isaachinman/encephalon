import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { decodeVerifiedUtf8, readVerifiedRegularFile, VerifiedFileError } from '../src/verified-file.ts'

const temporaryRoots: string[] = []

const createRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-verified-file-test-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

test('reads only bounded regular files and decodes UTF-8 fatally', () => {
  const root = createRoot()
  const file = join(root, 'marker')
  writeFileSync(file, 'gitdir: admin\n')

  assert.equal(readVerifiedRegularFile(join(root, 'missing'), 64), undefined)
  const bytes = readVerifiedRegularFile(file, 64)
  if (bytes !== undefined) {
    assert.equal(decodeVerifiedUtf8(bytes), 'gitdir: admin\n')
  }
  assert.notEqual(bytes, undefined)
  let oversizedDescriptorReached = false
  assert.throws(
    () =>
      readVerifiedRegularFile(file, 4, {
        fault: point => {
          if (point === 'after-fstat') {
            oversizedDescriptorReached = true
          }
        },
      }),
    VerifiedFileError,
  )
  assert.equal(oversizedDescriptorReached, false)

  const directory = join(root, 'directory')
  mkdirSync(directory)
  assert.throws(() => readVerifiedRegularFile(directory, 64), VerifiedFileError)
  assert.throws(() => decodeVerifiedUtf8(Buffer.from([0xc3, 0x28])), VerifiedFileError)

  const link = join(root, 'link')
  let linkCreated = false
  try {
    symlinkSync(file, link, 'file')
    linkCreated = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw error
    }
  }
  if (linkCreated) {
    assert.throws(() => readVerifiedRegularFile(link, 64), VerifiedFileError)
  }
})

test('rejects a path replaced between lstat and descriptor verification', () => {
  const root = createRoot()
  const marker = join(root, 'marker')
  const captured = join(root, 'captured')
  const outside = join(root, 'outside')
  writeFileSync(marker, 'gitdir: expected\n')
  writeFileSync(outside, 'gitdir: attacker-controlled\n')

  let symlinksSupported = false
  try {
    symlinkSync(outside, join(root, 'symlink-check'), 'file')
    rmSync(join(root, 'symlink-check'))
    symlinksSupported = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw error
    }
  }

  if (symlinksSupported) {
    let descriptorReached = false
    assert.throws(
      () =>
        readVerifiedRegularFile(marker, 64, {
          fault: point => {
            if (point === 'after-lstat') {
              renameSync(marker, captured)
              symlinkSync(outside, marker, 'file')
            }
            if (point === 'after-fstat') {
              descriptorReached = true
            }
          },
        }),
      (error: unknown) => {
        assert.equal(error instanceof VerifiedFileError, true)
        assert.equal((error as Error).message.includes(root), false)
        return true
      },
    )
    assert.equal(descriptorReached, false)
  }
})

test('rejects a pathname replacement after the descriptor final metadata check', () => {
  const root = createRoot()
  const manifest = join(root, 'package.json')
  const captured = join(root, 'captured.json')
  writeFileSync(manifest, '{"name":"encephalon"}')

  assert.throws(
    () =>
      readVerifiedRegularFile(manifest, 1024, {
        fault: point => {
          if (point === 'before-final-path-lstat') {
            renameSync(manifest, captured)
            linkSync(captured, manifest)
          }
        },
      }),
    VerifiedFileError,
  )
})

test('rejects a file whose descriptor changes after its initial metadata check', () => {
  const root = createRoot()
  const manifest = join(root, 'package.json')
  writeFileSync(manifest, '{"name":"encephalon"}')

  assert.throws(
    () =>
      readVerifiedRegularFile(manifest, 1024, {
        fault: point => {
          if (point === 'after-fstat') {
            writeFileSync(manifest, '{"name":"encephalon","changed":true}')
          }
        },
      }),
    VerifiedFileError,
  )
})
