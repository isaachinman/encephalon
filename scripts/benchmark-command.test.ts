import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runBenchmarkCommand } from './benchmark-command.ts'

test('benchmark timeout terminates descendants before they can outlive the failed operation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-tree-'))
  const sentinel = join(root, 'survived')
  const descendant = `setTimeout(() => {require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive')}, 2000)`
  try {
    await assert.rejects(
      runBenchmarkCommand(
        process.execPath,
        [
          '-e',
          `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore', detached: true}); setInterval(() => {}, 1000)`,
        ],
        { cwd: root, timeoutMilliseconds: 1000 },
      ),
      /timed out/,
    )
    await delay(1500)
    assert.equal(existsSync(sentinel), false)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('benchmark command reports elapsed startup and refuses unsuccessful or unbounded output', async () => {
  const result = await runBenchmarkCommand(process.execPath, ['-e', 'process.stdout.write("ready")'], {
    cwd: tmpdir(),
    timeoutMilliseconds: 5000,
  })
  assert.equal(result.stdout, 'ready')
  assert.ok(result.elapsedMs > 0)
  await assert.rejects(
    runBenchmarkCommand(process.execPath, ['-e', 'process.exit(3)'], { cwd: tmpdir(), timeoutMilliseconds: 5000 }),
    /failed/,
  )
  await assert.rejects(
    runBenchmarkCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], {
      cwd: tmpdir(),
      maximumOutputBytes: 100,
      timeoutMilliseconds: 5000,
    }),
    /output/,
  )
  if (process.platform !== 'win32') {
    const originalPath = process.env.PATH
    try {
      process.env.PATH = ''
      await assert.rejects(
        runBenchmarkCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: tmpdir(),
          timeoutMilliseconds: 100,
        }),
        /process-tree cleanup failed/,
      )
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
    }
  }
})
