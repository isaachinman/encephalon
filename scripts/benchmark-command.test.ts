import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runBenchmarkCommand } from './benchmark-command.ts'

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const waitUntil = async <Value>(read: () => Value | undefined, deadline: number): Promise<Value | undefined> => {
  const value = read()
  if (value !== undefined || performance.now() >= deadline) {
    return value
  }
  await delay(20)
  return waitUntil(read, deadline)
}

const waitFor = <Value>(read: () => Value | undefined, milliseconds: number) =>
  waitUntil(read, performance.now() + milliseconds)

test('benchmark termination stops descendants before they can outlive the failed operation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-tree-'))
  const pidPath = join(root, 'descendant.pid')
  const controller = [
    "const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', detached: true})",
    `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, descendant.pid + '\\n')`,
    'setInterval(() => {}, 1000)',
  ].join('; ')
  const abort = new AbortController()
  let descendantPid: number | undefined
  try {
    const rejected = assert.rejects(
      runBenchmarkCommand(process.execPath, ['-e', controller], {
        cwd: root,
        signal: abort.signal,
        timeoutMilliseconds: 60_000,
      }),
      /aborted/,
    )
    // Windows taskkill cannot pause a controller that is still spawning, so terminate once the descendant exists.
    descendantPid = await waitFor(() => {
      const contents = existsSync(pidPath) ? readFileSync(pidPath, 'utf8') : ''
      return /^\d+\n$/.test(contents) ? Number(contents) : undefined
    }, 30_000)
    abort.abort()
    await rejected
    const pid = descendantPid
    assert.ok(pid !== undefined)
    assert.equal(await waitFor(() => (processIsAlive(pid) ? undefined : true), 5000), true)
  } finally {
    abort.abort()
    if (descendantPid !== undefined && processIsAlive(descendantPid)) {
      process.kill(descendantPid, 'SIGKILL')
    }
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
    runBenchmarkCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmpdir(),
      timeoutMilliseconds: 100,
    }),
    /timed out/,
  )
  await assert.rejects(
    runBenchmarkCommand(
      process.execPath,
      ['-e', 'process.stderr.write("fixture could not be prepared"); process.exit(3)'],
      {
        cwd: tmpdir(),
        timeoutMilliseconds: 5000,
      },
    ),
    /failed with code 3: fixture could not be prepared/,
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
