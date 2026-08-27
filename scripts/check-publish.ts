import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { spawnNpmCommand } from './npm-command.ts'
import { isPublishedVersionConflictOutput } from './npm-publish-conflict.ts'
import { parsePackageCheckArguments, snapshotPackageTarball, verifyPackageArtifactMetadata } from './package-tarball.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publishUsage = () => new Error('Usage: check-publish.ts <repository-relative-tarball>')
const parsePublishTarball = (args: readonly string[]) => {
  if (args.length === 1) {
    const suppliedTarball = (() => {
      try {
        return parsePackageCheckArguments(['--tarball', args[0] ?? '']).suppliedTarball
      } catch {}
    })()
    if (suppliedTarball !== undefined) {
      return suppliedTarball
    }
  }
  throw publishUsage()
}

const sourceTarball = parsePublishTarball(process.argv.slice(2))
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'encephalon-publish-check-'))
try {
  const metadata = verifyPackageArtifactMetadata(sourceTarball)
  const snapshot = snapshotPackageTarball(sourceTarball, temporaryDirectory)
  if (
    !isDeepStrictEqual(snapshot.digests, {
      bytes: metadata.bytes,
      integrity: metadata.integrity,
      sha1: metadata.sha1,
      sha256: metadata.sha256,
      sha512: metadata.sha512,
    })
  ) {
    throw new Error('The publish candidate changed after metadata verification.')
  }
  const tarball = snapshot.path
  const npmArguments = ['publish', tarball, '--dry-run', '--ignore-scripts', '--access', 'public', '--json']
  const result = spawnNpmCommand(npmArguments, { cwd: root, timeoutMilliseconds: 120_000 })
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

  if (exitCode !== 0 && !(exitCode === 1 && isPublishedVersionConflictOutput(stdout, stderr))) {
    throw new Error(`npm publish dry-run failed with exit code ${exitCode}.`)
  }
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
