import { type ChildProcess, spawn, spawnSync } from 'node:child_process'

export const terminateBenchmarkTree = (child: ChildProcess): void => {
  if (child.pid !== undefined) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 })
    } else {
      // Stop the controller before enumerating children so it cannot fork past the snapshot.
      try {
        process.kill(child.pid, 'SIGSTOP')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error
        }
      }
      const snapshot = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      })
      const processes = (snapshot.stdout ?? '')
        .trim()
        .split('\n')
        .map(line => line.trim().split(/\s+/).map(Number))
      const descendants = [child.pid]
      for (const parent of descendants) {
        descendants.push(
          ...processes.flatMap(([pid, parentPid]) => (parentPid === parent && pid !== undefined ? [pid] : [])),
        )
      }
      // Workers have their own process groups, so killing only the controller's group is insufficient.
      for (const pid of descendants.reverse()) {
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, 'SIGKILL')
          } catch (error) {
            const { code } = error as NodeJS.ErrnoException
            if (code !== 'ESRCH' && !(target < 0 && code === 'EPERM')) {
              throw error
            }
          }
        }
      }
      if (snapshot.status !== 0) {
        throw new Error('Benchmark process-tree inspection failed.')
      }
    }
  }
}

export const runBenchmarkCommand = async (
  command: string,
  arguments_: string[],
  options: {
    cwd: string
    timeoutMilliseconds: number
    maximumOutputBytes?: number
    signal?: AbortSignal
    environment?: NodeJS.ProcessEnv
    windowsVerbatimArguments?: boolean
  },
): Promise<{ stdout: string; elapsedMs: number }> => {
  if (options.signal?.aborted) {
    throw new Error('Benchmark command aborted.')
  }
  const start = performance.now()
  const child = spawn(command, arguments_, {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: { ...(options.environment ?? process.env), NODE_OPTIONS: undefined, NODE_PATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  const maximumOutputBytes = options.maximumOutputBytes ?? 4 * 1024 * 1024
  let bytes = 0
  let failure: string | undefined
  const stop = (reason: string) => {
    failure ??= reason
    try {
      terminateBenchmarkTree(child)
    } catch {
      failure = 'Benchmark command process-tree cleanup failed.'
      child.kill('SIGKILL')
    }
  }
  const abort = () => stop('Benchmark command aborted.')
  options.signal?.addEventListener('abort', abort, { once: true })
  const consume = (chunk: Buffer, stdout: boolean) => {
    bytes += chunk.length
    if (bytes <= maximumOutputBytes) {
      if (stdout) {
        chunks.push(chunk)
      } else {
        errors.push(chunk)
      }
    } else {
      stop('Benchmark command exceeded its output bound.')
    }
  }
  child.stdout.on('data', (chunk: Buffer) => consume(chunk, true))
  child.stderr.on('data', (chunk: Buffer) => consume(chunk, false))
  const timeout = setTimeout(() => stop('Benchmark command timed out.'), options.timeoutMilliseconds)
  try {
    const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', () => {
        failure ??= 'Benchmark command failed to start.'
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const stderr = Buffer.concat(errors).toString('utf8')
    if (failure !== undefined || closed.code !== 0) {
      const exit = closed.signal === null ? `code ${String(closed.code)}` : `signal ${closed.signal}`
      throw new Error(failure ?? `Benchmark command failed with ${exit}: ${stderr.trim() || 'no stderr'}`)
    }
    return { elapsedMs: performance.now() - start, stdout: Buffer.concat(chunks).toString('utf8') }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
