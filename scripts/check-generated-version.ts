import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackageVersionSource, createStaleGeneratedVersionError } from './package-version.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }
if (typeof packageJson.version !== 'string') {
  throw new Error('package.json must declare a string version.')
}
const generatedVersionSource = (() => {
  try {
    return readFileSync(resolve(root, 'src', 'generated', 'version.ts'), 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw createStaleGeneratedVersionError()
    }
    throw error
  }
})()
assertPackageVersionSource(packageJson.version, generatedVersionSource)
