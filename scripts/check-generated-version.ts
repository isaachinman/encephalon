import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackageVersionSource } from './package-version.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }
if (typeof packageJson.version !== 'string') {
  throw new Error('package.json must declare a string version.')
}
const generatedVersionSource = readFileSync(resolve(root, 'src', 'generated', 'version.ts'), 'utf8')
assertPackageVersionSource(packageJson.version, generatedVersionSource)
