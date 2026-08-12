import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepare } from '../../src/cache.ts'

const [root, resultPath, readyPath, releasePath] = process.argv.slice(2)

if (root === undefined || resultPath === undefined || readyPath === undefined || releasePath === undefined) {
  throw new Error('Expected repository, result, ready, and release paths.')
}

writeFileSync(readyPath, 'ready')
while (!existsSync(releasePath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
}

const result = prepare({ root })
const cache = statSync(join(root, 'node_modules', '.cache', 'encephalon'), { bigint: true })
writeFileSync(
  resultPath,
  JSON.stringify({
    cacheIdentity: { dev: cache.dev.toString(), ino: cache.ino.toString() },
    result,
  }),
)
