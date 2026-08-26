import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnNpmCommand } from './npm-command.ts'
import { isPublishedVersionConflictOutput } from './npm-publish-conflict.ts'
import { parsePackageCheckArguments } from './package-tarball.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { suppliedTarball: tarball } = parsePackageCheckArguments(['--tarball', ...process.argv.slice(2)])
if (tarball === undefined) {
  throw new Error('Usage: check-publish.ts <repository-relative-tarball>')
}
const npmArguments = ['publish', tarball, '--dry-run', '--ignore-scripts', '--access', 'public', '--json']
const result = spawnNpmCommand(npmArguments, { cwd: root })
if (result.error !== undefined) {
  throw result.error
}
const exitCode = result.status ?? 1
const stdout = result.stdout ?? ''
const stderr = result.stderr ?? ''

process.stdout.write(stdout)
process.stderr.write(stderr)

if (result.signal !== null) {
  throw new Error(`npm publish dry-run terminated with signal ${result.signal}.`)
}

if (exitCode === 0) {
  process.exit(0)
}

if (exitCode === 1 && isPublishedVersionConflictOutput(stdout, stderr)) {
  process.exit(0)
}

throw new Error(`npm publish dry-run failed with exit code ${exitCode}.`)
