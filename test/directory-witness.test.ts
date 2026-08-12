import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureDirectoryWitness, DirectoryWitnessError, revalidateDirectoryWitness } from '../src/directory-witness.ts'

test('revalidation rejects replacement at its final input boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-directory-witness-test-'))
  try {
    const directory = join(root, 'directory')
    const captured = join(root, 'captured')
    mkdirSync(directory)
    const witness = captureDirectoryWitness(directory, { allowLink: false })

    assert.throws(
      () =>
        revalidateDirectoryWitness(witness, {
          afterCanonicalisation: () => {
            renameSync(directory, captured)
            mkdirSync(directory)
          },
        }),
      DirectoryWitnessError,
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
