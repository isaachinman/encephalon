import { spawn } from 'node:child_process'

const request = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8'))
const { maximumOutputBytes } = request
let child
let stdout = Buffer.alloc(0)
let stderr = Buffer.alloc(0)
let overflow = false
let timedOut = false
let spawnError
let terminationPromise = Promise.resolve()
let terminationStarted = false

const terminateTree = () => {
  if (!terminationStarted && child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    terminationStarted = true
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      terminationPromise = new Promise(resolve => {
        killer.on('error', resolve)
        killer.on('close', resolve)
      })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          throw error
        }
      }
    }
  }
}

const appendBounded = (current, chunk) => {
  const remaining = maximumOutputBytes - current.length
  if (remaining >= chunk.length) {
    return Buffer.concat([current, chunk])
  }
  overflow = true
  terminateTree()
  return remaining > 0 ? Buffer.concat([current, chunk.subarray(0, remaining)]) : current
}

const cancellation = () => {
  terminateTree()
}
process.once('SIGINT', cancellation)
process.once('SIGTERM', cancellation)

try {
  child = spawn(request.executable, request.arguments, {
    cwd: request.cwd,
    detached: process.platform !== 'win32',
    env: request.environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: request.windowsVerbatimArguments === true,
  })
  child.stdout.on('data', chunk => {
    stdout = appendBounded(stdout, chunk)
  })
  child.stderr.on('data', chunk => {
    stderr = appendBounded(stderr, chunk)
  })
  child.on('error', error => {
    spawnError = { code: error.code, message: error.message }
  })
  const timer = setTimeout(() => {
    timedOut = true
    terminateTree()
  }, request.timeoutMilliseconds)
  const result = await new Promise(resolve => {
    child.on('close', (status, signal) => resolve({ signal, status }))
  })
  await terminationPromise
  clearTimeout(timer)
  process.stdout.write(
    `${JSON.stringify({
      error: spawnError,
      overflow,
      signal: result.signal,
      status: result.status,
      stderr: stderr.toString('base64'),
      stdout: stdout.toString('base64'),
      timedOut,
    })}\n`,
  )
} finally {
  process.removeListener('SIGINT', cancellation)
  process.removeListener('SIGTERM', cancellation)
}
