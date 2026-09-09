import { spawn, spawnSync } from 'node:child_process'

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

const drainProcessGroup = pid => {
  const deadline = performance.now() + 5000
  let emptySnapshots = 0
  while (emptySnapshots < 2) {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining <= 0) {
      throw new Error('Compatibility process-group cleanup timed out.')
    }
    let permissionError
    if (emptySnapshots === 0) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (error) {
        if (error?.code === 'EPERM') {
          permissionError = error
        } else if (error?.code !== 'ESRCH') {
          throw error
        }
      }
    }
    const snapshot = spawnSync('ps', ['-A', '-o', 'pgid=,stat='], {
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      timeout: remaining,
    })
    if (snapshot.status !== 0) {
      throw new Error('Compatibility process-group inspection failed.', {
        cause: snapshot.error ?? { signal: snapshot.signal, status: snapshot.status, stderr: snapshot.stderr },
      })
    }
    const active = snapshot.stdout
      .trim()
      .split('\n')
      .some(line => {
        const [group, state] = line.trim().split(/\s+/)
        return Number(group) === pid && !state?.startsWith('Z')
      })
    // Darwin can reject signalling a zombie-only group; a live member still makes this fatal.
    if (active && permissionError !== undefined) {
      throw permissionError
    }
    // A second fresh snapshot starts after the first has observed the leader exited.
    emptySnapshots = active ? 0 : emptySnapshots + 1
    if (emptySnapshots < 2) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
}

const terminateTree = () => {
  if (!terminationStarted && child?.pid !== undefined) {
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
      // A fork can outlive the first group signal. Drain before close, which may await inherited pipes.
      drainProcessGroup(child.pid)
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
