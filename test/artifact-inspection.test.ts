import assert from 'node:assert/strict'
import { closeSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { ArtifactChangedError, inspectArtifactFiles } from '../src/artifact-inspection.ts'

const temporaryRoots: string[] = []

const createArtifact = () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-artifact-inspection-test-'))
  temporaryRoots.push(root)
  const brainDirectory = join(root, 'encephalon')
  const artifact = '_artifacts/decision/artifact-inspection/evidence.txt'
  const path = join(brainDirectory, ...artifact.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'verified evidence')
  return { artifact, brainDirectory, path, root }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

test('rejects a final artifact replacement between lstat and descriptor open', () => {
  const { artifact, brainDirectory, path, root } = createArtifact()
  const captured = join(root, 'captured.txt')
  const replacement = join(root, 'replacement.txt')
  writeFileSync(replacement, 'replacement evidence')

  assert.throws(
    () =>
      inspectArtifactFiles(brainDirectory, [artifact], {
        fault: point => {
          if (point === 'after-artifact-lstat') {
            renameSync(path, captured)
            renameSync(replacement, path)
          }
        },
      }),
    ArtifactChangedError,
  )
})

test('rejects same-inode mutation between final lstat and descriptor open', () => {
  const { artifact, brainDirectory, path } = createArtifact()

  assert.throws(
    () =>
      inspectArtifactFiles(brainDirectory, [artifact], {
        fault: point => {
          if (point === 'after-artifact-lstat') {
            writeFileSync(path, 'mutated before open')
          }
        },
      }),
    ArtifactChangedError,
  )
})

test('returns immutable manifest fields from the verified descriptor and closes it', () => {
  const { artifact, brainDirectory } = createArtifact()
  let descriptorsClosed = 0
  const [result] = inspectArtifactFiles(brainDirectory, [artifact], {
    close: descriptor => {
      descriptorsClosed += 1
      closeSync(descriptor)
    },
  })

  assert.equal(result?.kind, 'stable')
  if (result?.kind === 'stable') {
    assert.deepEqual(result.observation.manifest, {
      ctimeNanoseconds: result.observation.metadata.ctimeNs.toString(),
      mtimeNanoseconds: result.observation.metadata.mtimeNs.toString(),
      size: '17',
      type: 'file',
    })
    assert.equal(Object.isFrozen(result.observation), true)
    assert.equal(Object.isFrozen(result.observation.manifest), true)
  }
  assert.equal(descriptorsClosed, 1)
})

test('preserves an inspection failure when descriptor close also fails', () => {
  const { artifact, brainDirectory } = createArtifact()
  const primary = new Error('primary inspection failure')
  assert.throws(
    () =>
      inspectArtifactFiles(brainDirectory, [artifact], {
        close: descriptor => {
          closeSync(descriptor)
          throw new Error('secondary close failure')
        },
        fault: point => {
          if (point === 'after-artifact-fstat') {
            throw primary
          }
        },
      }),
    error => error === primary,
  )
})

test('rejects file mutation and path replacement after descriptor identity is established', () => {
  for (const mutation of ['content', 'replacement'] as const) {
    const { artifact, brainDirectory, path, root } = createArtifact()
    const captured = join(root, 'captured.txt')
    const replacement = join(root, 'replacement.txt')
    writeFileSync(replacement, 'replacement evidence')

    assert.throws(
      () =>
        inspectArtifactFiles(brainDirectory, [artifact], {
          fault: point => {
            if (point === 'after-artifact-fstat') {
              if (mutation === 'content') {
                writeFileSync(path, 'mutated evidence content')
              } else {
                renameSync(path, captured)
                renameSync(replacement, path)
              }
            }
          },
        }),
      ArtifactChangedError,
      mutation,
    )
  }
})

test('rejects ancestor replacement immediately after child witness capture', () => {
  const { artifact, brainDirectory, root } = createArtifact()
  const artifactsDirectory = join(brainDirectory, '_artifacts')
  const captured = join(root, 'captured-artifacts')
  const replacement = join(root, 'replacement-artifacts')
  mkdirSync(replacement)

  assert.throws(
    () =>
      inspectArtifactFiles(brainDirectory, [artifact], {
        fault: point => {
          if (point === 'after-ancestor-capture') {
            renameSync(artifactsDirectory, captured)
            renameSync(replacement, artifactsDirectory)
          }
        },
      }),
    ArtifactChangedError,
  )
})

test('distinguishes a stable missing ancestor from concurrent ancestor removal', () => {
  const stable = createArtifact()
  rmSync(join(stable.brainDirectory, '_artifacts'), { recursive: true })
  assert.deepEqual(
    inspectArtifactFiles(stable.brainDirectory, [stable.artifact]).map(result => result.kind),
    ['invalid'],
  )

  const changing = createArtifact()
  const artifactsDirectory = join(changing.brainDirectory, '_artifacts')
  assert.throws(
    () =>
      inspectArtifactFiles(changing.brainDirectory, [changing.artifact], {
        fault: point => {
          if (point === 'before-ancestor-lstat') {
            rmSync(artifactsDirectory, { recursive: true })
          }
        },
      }),
    ArtifactChangedError,
  )
})

test('reports static missing, non-regular, and symlink artifact paths as invalid', () => {
  const { artifact, brainDirectory, path, root } = createArtifact()
  rmSync(path)
  mkdirSync(path)
  const missing = artifact.replace('evidence.txt', 'missing.txt')
  const linked = artifact.replace('evidence.txt', 'linked.txt')
  let linkCreated = false
  try {
    symlinkSync(join(root, 'outside.txt'), join(brainDirectory, ...linked.split('/')), 'file')
    linkCreated = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw error
    }
  }

  const paths = linkCreated ? [artifact, missing, linked] : [artifact, missing]
  const results = inspectArtifactFiles(brainDirectory, paths)
  assert.deepEqual(
    results.map(result => result.kind),
    paths.map(() => 'invalid'),
  )
})

test('propagates operational descriptor errors without exposing the artifact path', () => {
  const { artifact, brainDirectory, root } = createArtifact()
  const failure = Object.assign(new Error('simulated I/O failure'), { code: 'EIO' })
  assert.throws(
    () =>
      inspectArtifactFiles(brainDirectory, [artifact], {
        fault: point => {
          if (point === 'after-artifact-fstat') {
            throw failure
          }
        },
      }),
    error => {
      assert.equal(error, failure)
      assert.equal((error as Error).message.includes(root), false)
      return true
    },
  )
})
