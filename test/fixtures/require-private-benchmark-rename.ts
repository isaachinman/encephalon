import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const { renameSync } = fs

fs.renameSync = (source, destination) => {
  if (source.toString().endsWith('.benchmark.tmp')) {
    const mode = fs.statSync(source).mode & 0o777
    if (mode !== 0o600) {
      throw new Error('Benchmark temporary output became readable before publication.')
    }
  }
  return renameSync(source, destination)
}

syncBuiltinESMExports()
