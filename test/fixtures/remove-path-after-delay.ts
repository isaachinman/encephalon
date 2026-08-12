import { existsSync, rmSync, writeFileSync } from 'node:fs'

const [path, resultPath, delayText] = process.argv.slice(2)

if (path === undefined || resultPath === undefined || delayText === undefined) {
  throw new Error('Expected a path, result path, and delay.')
}

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(delayText))
const existed = existsSync(path)
rmSync(path, { force: true, recursive: true })
writeFileSync(resultPath, existed ? 'removed' : 'missing')
