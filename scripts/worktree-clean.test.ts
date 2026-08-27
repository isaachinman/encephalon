import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { assertCleanReleaseWorktree } from './worktree-clean.ts'

test('rejects untracked output and permits only the exact ignored artifact pair at the retention phase', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'encephalon-worktree-clean-'))
  try {
    writeFileSync(
      resolve(root, '.gitignore'),
      [
        '/node_modules/',
        '/dist/',
        '/.superpowers/',
        '/.vscode/',
        '*.tgz',
        '*.tgz.metadata.json',
        '/coverage/',
        '/encephalon/_staging/',
        '',
      ].join('\n'),
    )
    writeFileSync(resolve(root, 'tracked.txt'), 'tracked\n')
    const initialise = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' })
    assert.equal(initialise.status, 0, `${initialise.stdout}${initialise.stderr}`)
    const stage = spawnSync('git', ['add', '--', '.gitignore', 'tracked.txt'], { cwd: root, encoding: 'utf8' })
    assert.equal(stage.status, 0, `${stage.stdout}${stage.stderr}`)
    const commit = spawnSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Encephalon Test',
        '-c',
        'user.email=encephalon-test@example.invalid',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'Fixture',
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(commit.status, 0, `${commit.stdout}${commit.stderr}`)
    assert.doesNotThrow(() => assertCleanReleaseWorktree(root, false))

    for (const path of [
      'node_modules/package/index.js',
      'dist/index.mjs',
      '.superpowers/evidence.md',
      '.vscode/settings.json',
    ]) {
      mkdirSync(resolve(root, path, '..'), { recursive: true })
      writeFileSync(resolve(root, path), 'intentional ignored output\n')
    }
    assert.doesNotThrow(() => assertCleanReleaseWorktree(root, false))

    writeFileSync(resolve(root, 'untracked.txt'), 'unexpected\n')
    assert.throws(() => assertCleanReleaseWorktree(root, false), /tracked or untracked/u)
    rmSync(resolve(root, 'untracked.txt'))

    const artifacts = resolve(root, 'package-artifacts')
    mkdirSync(artifacts)
    writeFileSync(resolve(artifacts, 'encephalon-0.3.0.tgz'), 'tarball')
    writeFileSync(resolve(artifacts, 'encephalon-0.3.0.tgz.metadata.json'), '{}\n')
    assert.throws(() => assertCleanReleaseWorktree(root, false), /retention phase/u)
    assert.doesNotThrow(() => assertCleanReleaseWorktree(root, true))

    writeFileSync(resolve(artifacts, 'unexpected.txt'), 'unexpected\n')
    assert.throws(() => assertCleanReleaseWorktree(root, true), /tracked or untracked|unexpected/u)
    rmSync(resolve(artifacts, 'unexpected.txt'))

    for (const path of [
      'rogue.tgz',
      'rogue.tgz.metadata.json',
      'coverage/report.json',
      'encephalon/_staging/leftover',
    ]) {
      mkdirSync(resolve(root, path, '..'), { recursive: true })
      writeFileSync(resolve(root, path), 'rogue ignored output\n')
      assert.throws(() => assertCleanReleaseWorktree(root, true), /ignored output/u, path)
      rmSync(resolve(root, path))
    }
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
