import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname } from 'node:path'

const { chmodSync, fchmodSync, renameSync } = fs
let published = false

fs.chmodSync = (path, mode) => {
  if (path.toString().endsWith('report.json')) {
    throw new Error('Benchmark output permissions used the replaceable destination pathname.')
  }
  return chmodSync(path, mode)
}

fs.renameSync = (source, destination) => {
  if (source.toString().endsWith('.benchmark.tmp')) {
    if (dirname(source.toString()) === dirname(destination.toString())) {
      throw new Error('Benchmark temporary output was not protected by private staging.')
    }
    const parentMode = fs.statSync(dirname(source.toString())).mode & 0o777
    if (parentMode !== 0o700) {
      throw new Error('Benchmark temporary output staging was not private.')
    }
    const mode = fs.statSync(source).mode & 0o777
    if (mode !== 0o640) {
      throw new Error('Benchmark output mode was not final before publication.')
    }
  }
  const result = renameSync(source, destination)
  if (source.toString().endsWith('.benchmark.tmp')) {
    published = true
  }
  return result
}

fs.fchmodSync = (descriptor, mode) => {
  if (published) {
    throw new Error('Benchmark output mode changed after publication.')
  }
  return fchmodSync(descriptor, mode)
}

syncBuiltinESMExports()
