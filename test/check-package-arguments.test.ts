import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

test('rejects absolute and out-of-repository retained-tarball directories', () => {
  const absoluteContainedDirectory = resolve(root, 'test', `.encephalon-retained-package-${randomUUID()}`)
  const outsideDirectory = resolve(root, '..', `.encephalon-retained-package-${randomUUID()}`)
  const invalidDirectories = [absoluteContainedDirectory, outsideDirectory, join('..', basename(outsideDirectory))]

  for (const directory of invalidDirectories) {
    const result = spawnSync(process.execPath, ['./scripts/check-package.ts', '--retain-tarball', directory], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Usage: check-package\.ts \[--retain-tarball <repository-relative-directory>\]/)
    assert.equal(existsSync(resolve(root, directory)), false)
  }
})

test('rejects retained-tarball directories beneath a symlinked parent', { timeout: 30_000 }, () => {
  const outsideDirectory = mkdtempSync(join(tmpdir(), 'encephalon-retained-package-'))
  const symlink = resolve(root, 'test', `.retained-package-link-${randomUUID()}`)
  const retainedDirectory = join(symlink, 'nested')
  try {
    symlinkSync(outsideDirectory, symlink, 'junction')
    const result = spawnSync(
      process.execPath,
      ['./scripts/check-package.ts', '--retain-tarball', relative(root, retainedDirectory)],
      { cwd: root, encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Usage: check-package\.ts \[--retain-tarball <repository-relative-directory>\]/)
    assert.equal(existsSync(join(outsideDirectory, 'nested')), false)
  } finally {
    rmSync(symlink, { force: true })
    rmSync(outsideDirectory, { force: true, recursive: true })
  }
})
