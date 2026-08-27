import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPackageArtifactMetadata } from './package-tarball.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tarball = resolve(root, 'package-artifacts', 'encephalon-0.3.0.tgz')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }
if (packageJson.version !== '0.3.0') {
  throw new Error('The fixed release artifact version does not match the reviewed package manifest.')
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  killSignal: 'SIGKILL',
  maxBuffer: 8192,
  timeout: 10_000,
})
if (revision.error !== undefined) {
  throw revision.error
}
if (revision.status !== 0 || revision.stderr !== '') {
  throw new Error(`Unable to identify the reviewed source commit: ${revision.stderr}`)
}
const metadata = verifyPackageArtifactMetadata(tarball, {
  packageVersion: packageJson.version,
  sourceCommit: revision.stdout.trim(),
  tarball: 'package-artifacts/encephalon-0.3.0.tgz',
})
process.stdout.write(`${JSON.stringify(metadata)}\n`)
