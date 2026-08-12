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
import { discoverRepository, repositoryTestHooks } from '../src/repository.ts'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoots: string[] = []

const createIsolatedPackage = () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'encephalon-repository-test-'))
  const executingRoot = join(testRoot, 'executing')
  mkdirSync(join(executingRoot, 'src', 'generated'), { recursive: true })
  for (const file of ['errors.ts', 'repository.ts', 'sqlite-error.ts', 'verified-file.ts']) {
    copyFileSync(join(sourceRoot, 'src', file), join(executingRoot, 'src', file))
  }
  copyFileSync(
    join(sourceRoot, 'src', 'generated', 'version.ts'),
    join(executingRoot, 'src', 'generated', 'version.ts'),
  )
  writeFileSync(join(executingRoot, 'package.json'), '{"name":"encephalon","version":"0.2.0"}\n')

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
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

test('rejects a worktree target replaced after inspection', () => {
  const root = mkdtempSync(join(tmpdir(), 'encephalon-worktree-test-'))
  temporaryRoots.push(root)
  const administrationDirectory = join(root, 'administration')
  const capturedDirectory = join(root, 'captured-administration')
  const outsideDirectory = join(root, 'outside')
  mkdirSync(administrationDirectory)
  mkdirSync(outsideDirectory)
  writeFileSync(join(root, '.git'), 'gitdir: administration\n')

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
      if (!replaced && path.endsWith('/administration')) {
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
      name: 'oversized',
      write: (root: string) => writeFileSync(join(root, '.git'), `gitdir: ${'a'.repeat(16_384)}\n`),
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
      assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
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
