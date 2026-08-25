import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

test('rejects absolute and out-of-repository retained-tarball directories', () => {
  const outsideDirectory = resolve(root, '..', `.encephalon-retained-package-${randomUUID()}`)
  const invalidDirectories = [outsideDirectory, join('..', basename(outsideDirectory))]

  for (const directory of invalidDirectories) {
    const result = spawnSync(process.execPath, ['./scripts/check-package.ts', '--retain-tarball', directory], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Usage: check-package\.ts \[--retain-tarball <repository-relative-directory>\]/)
    assert.equal(existsSync(outsideDirectory), false)
  }
})
