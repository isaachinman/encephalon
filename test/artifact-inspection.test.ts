import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { ArtifactChangedError, inspectArtifactFiles } from '../src/artifact-inspection.ts'

const temporaryRoots: string[] = []

const filesystemCapabilities = (() => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-artifact-capability-test-'))
  try {
    const target = join(root, 'target')
    const link = join(root, 'link')
    const fifo = join(root, 'fifo')
    mkdirSync(target)
    let directoryLink = true
    try {
      symlinkSync(target, link, 'junction')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        directoryLink = false
      } else {
        throw error
      }
    }
    return { directoryLink, fifo: spawnSync('mkfifo', [fifo]).status === 0 }
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})()

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

test('returns immutable verified path metadata and closes its descriptor', () => {
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
    assert.equal(result.observation.path, artifact)
    assert.equal(result.observation.metadata.size, 17n)
    assert.equal(Object.isFrozen(result.observation), true)
    assert.equal(Object.isFrozen(result.observation.metadata), true)
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

test('rejects an observed ancestor that becomes a link or disappears before capture', () => {
  const capabilityRoot = createArtifact().root
  const linkProbe = join(capabilityRoot, 'ancestor-link-probe')
  let linkSupported = true
  try {
    symlinkSync(capabilityRoot, linkProbe, 'junction')
    rmSync(linkProbe)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      linkSupported = false
    } else {
      throw error
    }
  }
  const mutations = linkSupported ? (['link', 'missing'] as const) : (['missing'] as const)
  for (const mutation of mutations) {
    const { artifact, brainDirectory, root } = createArtifact()
    const artifactsDirectory = join(brainDirectory, '_artifacts')
    const captured = join(root, `captured-${mutation}`)
    const outside = join(root, `outside-${mutation}`)
    mkdirSync(outside)
    assert.throws(
      () =>
        inspectArtifactFiles(brainDirectory, [artifact], {
          fault: point => {
            if (point === 'after-ancestor-lstat') {
              renameSync(artifactsDirectory, captured)
              if (mutation === 'link') {
                symlinkSync(outside, artifactsDirectory, 'junction')
              }
            }
          },
        }),
      ArtifactChangedError,
    )
  }
})

test('rejects brain-root disappearance between preliminary lstat and witness capture', () => {
  const { artifact, brainDirectory, root } = createArtifact()
  const captured = join(root, 'captured-brain')
  assert.throws(
    () =>
      inspectArtifactFiles(brainDirectory, [artifact], {
        fault: point => {
          if (point === 'after-brain-lstat') {
            renameSync(brainDirectory, captured)
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

  const paths = linkCreated ? [artifact, missing, linked, ''] : [artifact, missing, '']
  const results = inspectArtifactFiles(brainDirectory, paths)
  assert.deepEqual(
    results.map(result => result.kind),
    paths.map(() => 'invalid'),
  )
})

test('rejects replacement and restoration of an artifact ancestor', {
  skip: !filesystemCapabilities.directoryLink,
}, () => {
  const { artifact, brainDirectory, root } = createArtifact()
  const artifactDirectory = join(brainDirectory, '_artifacts', 'decision', 'artifact-inspection')
  const captured = join(root, 'captured-artifact-directory')
  const outside = join(root, 'outside-artifact-directory')
  mkdirSync(outside)
  writeFileSync(join(outside, 'evidence.txt'), 'outside evidence')
  assert.throws(
    () =>
      inspectArtifactFiles(brainDirectory, [artifact], {
        fault: point => {
          if (point === 'after-artifact-lstat') {
            renameSync(artifactDirectory, captured)
            symlinkSync(outside, artifactDirectory, 'junction')
          }
          if (point === 'after-artifact-open') {
            rmSync(artifactDirectory)
            renameSync(captured, artifactDirectory)
          }
        },
      }),
    ArtifactChangedError,
  )
})

test('does not block when a final artifact is replaced by a FIFO', { skip: !filesystemCapabilities.fifo }, () => {
  const { artifact, brainDirectory, path } = createArtifact()
  const script = `
    import { spawnSync } from 'node:child_process'
    import { rmSync } from 'node:fs'
    import { ArtifactChangedError, inspectArtifactFiles } from ${JSON.stringify(new URL('../src/artifact-inspection.ts', import.meta.url).href)}
    try {
      inspectArtifactFiles(process.argv[1], [process.argv[2]], {
        fault: point => {
          if (point === 'after-artifact-lstat') {
            rmSync(process.argv[3])
            const result = spawnSync('mkfifo', [process.argv[3]])
            if (result.status !== 0) throw result.error ?? new Error('mkfifo failed')
          }
        },
      })
      process.exitCode = 2
    } catch (error) {
      process.exitCode = error instanceof ArtifactChangedError ? 0 : 3
    }
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, brainDirectory, artifact, path], {
    timeout: 2000,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr.toString())
})

test('rejects replacement or truncation after the final descriptor metadata check', () => {
  for (const mutation of ['replacement', 'truncation'] as const) {
    const { artifact, brainDirectory, path, root } = createArtifact()
    const captured = join(root, `captured-${mutation}.txt`)
    const replacement = join(root, `replacement-${mutation}.txt`)
    writeFileSync(replacement, 'replacement evidence')
    assert.throws(
      () =>
        inspectArtifactFiles(brainDirectory, [artifact], {
          fault: point => {
            if (point === 'after-final-artifact-fstat') {
              if (mutation === 'replacement') {
                renameSync(path, captured)
                renameSync(replacement, path)
              } else {
                writeFileSync(path, '')
              }
            }
          },
        }),
      ArtifactChangedError,
      mutation,
    )
  }
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

test('reclassifies open failure only when the final entry changed', () => {
  for (const changed of [false, true]) {
    const { artifact, brainDirectory, path, root } = createArtifact()
    const captured = join(root, `captured-open-${changed}.txt`)
    const failure = Object.assign(new Error('simulated open I/O failure'), { code: 'EIO' })
    const operation = () =>
      inspectArtifactFiles(brainDirectory, [artifact], {
        open: () => {
          if (changed) {
            renameSync(path, captured)
          }
          throw failure
        },
      })
    if (changed) {
      assert.throws(operation, ArtifactChangedError)
    } else {
      assert.throws(operation, error => error === failure)
    }
  }
})
