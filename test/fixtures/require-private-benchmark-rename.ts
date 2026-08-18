import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const { chmodSync, renameSync } = fs

fs.chmodSync = (path, mode) => {
  if (path.toString().endsWith('report.json')) {
    throw new Error('Benchmark output permissions used the replaceable destination pathname.')
  }
  return chmodSync(path, mode)
}

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
