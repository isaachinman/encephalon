import assert from 'node:assert/strict'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { discoverRepository, repositoryTestHooks, resolveRepository } from '../src/repository.ts'
import { createTestRepository } from './helpers.ts'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoots: string[] = []

const createIsolatedPackage = (options: { packageManifest?: boolean } = {}) => {
  const testRoot = mkdtempSync(join(tmpdir(), 'encephalon-repository-test-'))
  const executingPath = join(testRoot, 'executing')
  mkdirSync(join(executingPath, 'src', 'generated'), { recursive: true })
  const executingRoot = realpathSync.native(executingPath)
  for (const file of [
    'directory-witness.ts',
    'errors.ts',
    'filesystem-entry.ts',
    'repository.ts',
    'sqlite-error.ts',
    'verified-file.ts',
  ]) {
    copyFileSync(join(sourceRoot, 'src', file), join(executingRoot, 'src', file))
  }
  copyFileSync(
    join(sourceRoot, 'src', 'generated', 'version.ts'),
    join(executingRoot, 'src', 'generated', 'version.ts'),
  )
  if (options.packageManifest !== false) {
    writeFileSync(join(executingRoot, 'package.json'), '{"name":"encephalon","type":"module","version":"0.2.0"}\n')
  }

  const repositoryRoot = join(testRoot, 'repository')
  mkdirSync(join(repositoryRoot, 'node_modules'), { recursive: true })
  symlinkSync(
    executingRoot,
    join(repositoryRoot, 'node_modules', 'encephalon'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  temporaryRoots.push(testRoot)
  return { executingRoot, repositoryRoot }
}

afterEach(() => {
  repositoryTestHooks.afterGitDirectoryLstat = undefined
  repositoryTestHooks.afterGitMarkerDecision = undefined
  repositoryTestHooks.afterExecutingManifestRead = undefined
  repositoryTestHooks.afterExecutingParentCapture = undefined
  repositoryTestHooks.afterInstalledManifestRead = undefined
  repositoryTestHooks.afterRepositoryParentCapture = undefined
  repositoryTestHooks.afterRootInstallation = undefined
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

test('classifies an explicit regular-file root as an invalid repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-regular-root-test-'))
  temporaryRoots.push(root)
  const file = join(root, 'root-file')
  writeFileSync(file, 'not a directory')

  assert.throws(
    () => discoverRepository({ root: file }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'INVALID_REPOSITORY')
      return true
    },
  )
})

test('rejects a child generation change while ascending to a repository parent', () => {
  const root = createTestRepository()
  temporaryRoots.push(root)
  const child = join(root, 'packages', 'app')
  const captured = join(root, 'packages', 'captured-app')
  mkdirSync(child, { recursive: true })
  let replaced = false
  repositoryTestHooks.afterRepositoryParentCapture = (path: string) => {
    if (!replaced && path === child) {
      replaced = true
      renameSync(child, captured)
      mkdirSync(child)
    }
  }

  assert.throws(
    () => discoverRepository({ start: child }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'INVALID_REPOSITORY')
      return true
    },
  )
  assert.equal(replaced, true)
})

test('preserves operational failures while revalidating a repository ascent', () => {
  const root = createTestRepository()
  temporaryRoots.push(root)
  const child = join(root, 'packages', 'app')
  mkdirSync(child, { recursive: true })
  repositoryTestHooks.afterRepositoryParentCapture = () => {
    throw Object.assign(new Error('simulated input/output failure'), { code: 'EIO' })
  }

  assert.throws(
    () => discoverRepository({ start: child }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
      assert.equal((error as Error).message.includes(root), false)
      return true
    },
  )
})

test('rejects a worktree target replaced after inspection', () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-worktree-test-'))
  temporaryRoots.push(root)
  const administrationRoot = mkdtempSync(join(tmpdir(), 'encephalon-worktree-administration-test-'))
  temporaryRoots.push(administrationRoot)
  const administrationDirectory = join(administrationRoot, 'administration')
  const capturedDirectory = join(root, 'captured-administration')
  const outsideDirectory = join(root, 'outside')
  mkdirSync(administrationDirectory)
  mkdirSync(outsideDirectory)
  writeFileSync(join(root, '.git'), `gitdir: ${administrationDirectory}\n`)

  assert.equal(discoverRepository({ root }), realpathSync.native(root))
  let symlinksSupported = false
  try {
    symlinkSync(outsideDirectory, join(root, 'symlink-check'), process.platform === 'win32' ? 'junction' : 'dir')
    rmSync(join(root, 'symlink-check'))
    symlinksSupported = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw error
    }
  }

  let replaced = false
  if (symlinksSupported) {
    repositoryTestHooks.afterGitDirectoryLstat = path => {
      if (!replaced && path === administrationDirectory) {
        replaced = true
        renameSync(administrationDirectory, capturedDirectory)
        symlinkSync(outsideDirectory, administrationDirectory, process.platform === 'win32' ? 'junction' : 'dir')
      }
    }

    assert.throws(
      () => discoverRepository({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INVALID_REPOSITORY')
        return true
      },
    )
    assert.equal(replaced, true)
  }
})

test('rejects unsafe Git marker inputs with the stable explicit-root error', () => {
  const cases = [
    {
      name: 'empty target',
      write: (root: string) => writeFileSync(join(root, '.git'), 'gitdir: \n'),
    },
    {
      name: 'NUL target',
      write: (root: string) => writeFileSync(join(root, '.git'), 'gitdir: administration\0\n'),
    },
    {
      name: 'oversized',
      write: (root: string) =>
        writeFileSync(join(root, '.git'), `gitdir: ${join(root, 'administration')}${' '.repeat(16_384)}\n`),
    },
    {
      name: 'invalid UTF-8',
      write: (root: string) => writeFileSync(join(root, '.git'), Buffer.from([0x67, 0x69, 0x74, 0xc3, 0x28])),
    },
    {
      name: 'symlink',
      write: (root: string) => {
        const target = join(root, 'marker-target')
        writeFileSync(target, 'gitdir: administration\n')
        symlinkSync(target, join(root, '.git'), 'file')
      },
    },
  ]

  for (const markerCase of cases) {
    const root = mkdtempSync(join(tmpdir(), `encephalon-marker-${markerCase.name.replaceAll(' ', '-')}-`))
    temporaryRoots.push(root)
    mkdirSync(join(root, 'administration'))
    let markerCreated = false
    try {
      markerCase.write(root)
      markerCreated = true
    } catch (error) {
      if (!(markerCase.name === 'symlink' && (error as NodeJS.ErrnoException).code === 'EPERM')) {
        throw error
      }
    }
    if (markerCreated) {
      assert.throws(
        () => discoverRepository({ root }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'INVALID_REPOSITORY')
          assert.equal((error as Error).message.includes(root), false)
          return true
        },
      )
    }
  }
})

test('rejects a repository generation replaced after its Git marker decision', () => {
  const root = createTestRepository()
  const captured = `${root}-captured`
  temporaryRoots.push(root, captured)
  let replaced = false
  repositoryTestHooks.afterGitMarkerDecision = () => {
    if (!replaced) {
      replaced = true
      renameSync(root, captured)
      mkdirSync(root)
    }
  }

  assert.throws(
    () => discoverRepository({ root }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'INVALID_REPOSITORY')
      return true
    },
  )
  assert.equal(replaced, true)
})

test('memoizes verified executing package identity but reverifies the installed manifest', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  writeFileSync(join(executingRoot, 'src', 'package.json'), '{"name":"unrelated","type":"module","version":"1.0.0"}\n')
  const repositoryModule = await import(
    `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?test=${Date.now()}`
  )

  assert.equal(repositoryModule.assertRootInstallation(repositoryRoot), realpathSync.native(executingRoot))

  writeFileSync(join(executingRoot, 'src', 'package.json'), '{not-json')
  assert.equal(repositoryModule.assertRootInstallation(repositoryRoot), realpathSync.native(executingRoot))

  writeFileSync(join(executingRoot, 'package.json'), '{not-json')
  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'ROOT_INSTALL_REQUIRED')
      return true
    },
  )
})

test('rejects an oversized installed manifest after executing identity is cached', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  writeFileSync(join(executingRoot, 'src', 'package.json'), '{"name":"unrelated","type":"module"}\n')
  const repositoryModule = await import(
    `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?installed-bound=${Date.now()}`
  )
  assert.equal(repositoryModule.assertRootInstallation(repositoryRoot), realpathSync.native(executingRoot))

  writeFileSync(
    join(executingRoot, 'package.json'),
    JSON.stringify({ name: 'encephalon', padding: 'x'.repeat(1024 * 1024), version: '0.2.0' }),
  )
  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'ROOT_INSTALL_REQUIRED')
      return true
    },
  )
})

test('does not memoize executing identity across a package-directory generation change', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  writeFileSync(join(executingRoot, 'src', 'package.json'), '{"name":"unrelated","type":"module"}\n')
  const repositoryModule = await import(
    `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?executing-generation=${Date.now()}`
  )
  const capturedRoot = `${executingRoot}-captured`
  const expectedManifest = join(executingRoot, 'package.json')
  let replaced = false
  repositoryModule.repositoryTestHooks.afterExecutingManifestRead = (path: string) => {
    if (!replaced && path === expectedManifest) {
      replaced = true
      renameSync(executingRoot, capturedRoot)
      mkdirSync(join(executingRoot, 'src'), { recursive: true })
      writeFileSync(join(executingRoot, 'package.json'), '{"name":"encephalon","version":"0.2.0"}\n')
      writeFileSync(join(executingRoot, 'src', 'package.json'), '{"name":"unrelated","type":"module"}\n')
    }
  }

  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
      return true
    },
  )
  assert.equal(replaced, true)
  repositoryModule.repositoryTestHooks.afterExecutingManifestRead = undefined
  assert.equal(repositoryModule.assertRootInstallation(repositoryRoot), executingRoot)
})

test('rejects an executing child generation change while accepting its package parent', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  const sourceDirectory = join(executingRoot, 'src')
  const capturedSource = join(executingRoot, 'captured-src')
  writeFileSync(join(sourceDirectory, 'package.json'), '{"name":"unrelated","type":"module"}\n')
  const repositoryModule = await import(
    `${pathToFileURL(join(sourceDirectory, 'repository.ts')).href}?executing-transition=${Date.now()}`
  )
  let replaced = false
  repositoryModule.repositoryTestHooks.afterExecutingParentCapture = (path: string) => {
    if (!replaced && path === sourceDirectory) {
      replaced = true
      renameSync(sourceDirectory, capturedSource)
      mkdirSync(sourceDirectory)
    }
  }

  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
      return true
    },
  )
  assert.equal(replaced, true)
})

test('preserves root-install-required when no executing package can be found', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage({ packageManifest: false })
  const repositoryModule = await import(
    `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?missing-executing=${Date.now()}`
  )

  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'ROOT_INSTALL_REQUIRED')
      return true
    },
  )
})

test('normalises an initial executing-directory failure', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  const sourceDirectory = join(executingRoot, 'src')
  const capturedSource = join(executingRoot, 'captured-src')
  const repositoryModule = await import(
    `${pathToFileURL(join(sourceDirectory, 'repository.ts')).href}?initial-executing=${Date.now()}`
  )
  renameSync(sourceDirectory, capturedSource)

  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
      assert.equal((error as Error).message.includes(executingRoot), false)
      return true
    },
  )
})

test('treats a looping installed package link as a malformed installation', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  const repositoryModule = await import(
    `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?installed-loop=${Date.now()}`
  )
  const installedPath = join(repositoryRoot, 'node_modules', 'encephalon')
  rmSync(installedPath)
  let linkCreated = false
  try {
    symlinkSync(installedPath, installedPath, process.platform === 'win32' ? 'junction' : 'dir')
    linkCreated = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw error
    }
  }

  if (linkCreated) {
    assert.throws(
      () => repositoryModule.assertRootInstallation(repositoryRoot),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'ROOT_INSTALL_REQUIRED')
        return true
      },
    )
  }
})

test('requires the installed root to retain the memoized executing generation between calls', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  writeFileSync(join(executingRoot, 'src', 'package.json'), '{"name":"unrelated","type":"module"}\n')
  const repositoryModule = await import(
    `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?memo-generation=${Date.now()}`
  )
  assert.equal(repositoryModule.assertRootInstallation(repositoryRoot), executingRoot)

  const capturedRoot = `${executingRoot}-captured`
  renameSync(executingRoot, capturedRoot)
  mkdirSync(executingRoot)
  writeFileSync(join(executingRoot, 'package.json'), '{"name":"encephalon","version":"0.2.0"}\n')

  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'ROOT_INSTALL_REQUIRED')
      return true
    },
  )
})

test('rejects an installed package-directory generation change after its manifest read', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  writeFileSync(join(executingRoot, 'src', 'package.json'), '{"name":"unrelated","type":"module"}\n')
  const repositoryModule = await import(
    `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?installed-generation=${Date.now()}`
  )
  assert.equal(repositoryModule.assertRootInstallation(repositoryRoot), realpathSync.native(executingRoot))
  const capturedRoot = `${executingRoot}-captured`
  let replaced = false
  repositoryModule.repositoryTestHooks.afterInstalledManifestRead = () => {
    if (!replaced) {
      replaced = true
      renameSync(executingRoot, capturedRoot)
      mkdirSync(executingRoot)
      writeFileSync(join(executingRoot, 'package.json'), '{"name":"encephalon","version":"0.2.0"}\n')
    }
  }

  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'ROOT_INSTALL_REQUIRED')
      return true
    },
  )
  assert.equal(replaced, true)
})

test('preserves operational installed-manifest failures as I/O errors', async () => {
  const { executingRoot, repositoryRoot } = createIsolatedPackage()
  writeFileSync(join(executingRoot, 'src', 'package.json'), '{"name":"unrelated","type":"module"}\n')
  const repositoryModule = await import(
    `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?installed-io=${Date.now()}`
  )
  repositoryModule.repositoryTestHooks.afterInstalledManifestRead = () => {
    throw Object.assign(new Error('simulated input/output failure'), { code: 'EIO' })
  }

  assert.throws(
    () => repositoryModule.assertRootInstallation(repositoryRoot),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
      return true
    },
  )
})

test('revalidates the discovered repository generation after installation succeeds', () => {
  const root = createTestRepository()
  temporaryRoots.push(root)
  const captured = `${root}-captured`
  temporaryRoots.push(captured)
  repositoryTestHooks.afterRootInstallation = () => {
    renameSync(root, captured)
    mkdirSync(root)
  }

  assert.throws(
    () => resolveRepository({ root }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'INVALID_REPOSITORY')
      return true
    },
  )
})

test('preserves operational failures while revalidating the resolved repository', () => {
  const root = createTestRepository()
  temporaryRoots.push(root)
  repositoryTestHooks.afterRootInstallation = () => {
    throw Object.assign(new Error('simulated input/output failure'), { code: 'EIO' })
  }

  assert.throws(
    () => resolveRepository({ root }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
      assert.equal((error as Error).message.includes(root), false)
      return true
    },
  )
})

test('rejects unsafe executing package manifests with a stable internal error', async () => {
  const cases = [
    {
      name: 'invalid JSON',
      write: (path: string) => writeFileSync(path, '{not-json'),
    },
    {
      name: 'invalid UTF-8',
      write: (path: string) => writeFileSync(path, Buffer.from([0x7b, 0xc3, 0x28, 0x7d])),
    },
    {
      name: 'oversized',
      write: (path: string) =>
        writeFileSync(path, JSON.stringify({ name: 'encephalon', padding: 'x'.repeat(1024 * 1024), version: '0.2.0' })),
    },
    {
      name: 'symlink',
      write: (path: string) => {
        const target = `${path}.target`
        writeFileSync(target, '{"name":"encephalon","version":"0.2.0"}\n')
        rmSync(path)
        symlinkSync(target, path, 'file')
      },
    },
  ]

  await Promise.all(
    cases.map(async manifestCase => {
      const { executingRoot, repositoryRoot } = createIsolatedPackage()
      writeFileSync(
        join(executingRoot, 'src', 'package.json'),
        '{"name":"unrelated","type":"module","version":"1.0.0"}\n',
      )
      let manifestWritten = false
      try {
        manifestCase.write(join(executingRoot, 'package.json'))
        manifestWritten = true
      } catch (error) {
        if (!(manifestCase.name === 'symlink' && (error as NodeJS.ErrnoException).code === 'EPERM')) {
          throw error
        }
      }
      if (manifestWritten) {
        const repositoryModule = await import(
          `${pathToFileURL(join(executingRoot, 'src', 'repository.ts')).href}?unsafe=${manifestCase.name}`
        )
        assert.throws(
          () => repositoryModule.assertRootInstallation(repositoryRoot),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
            assert.equal((error as Error).message.includes(executingRoot), false)
            return true
          },
        )
      }
    }),
  )
})
