import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preflightExactPackageArtifact } from './package-preflight.ts'
import { parsePackageCheckArguments } from './package-tarball.ts'
import { CompatibilityCommandError, runReleaseCompatibility } from './release-compatibility.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const usage = (options?: ErrorOptions) =>
  new Error('Usage: check-release-compatibility.ts <repository-relative-candidate.tgz>', options)

const candidateTarball = (arguments_: readonly string[]) => {
  if (arguments_.length === 1) {
    try {
      const parsed = parsePackageCheckArguments(['--tarball', arguments_[0] ?? ''])
      if (parsed.suppliedTarball !== undefined) {
        return parsed.suppliedTarball
      }
    } catch (error) {
      throw usage({ cause: error })
    }
  }
  throw usage()
}

try {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'encephalon-compatibility-preflight-'))
  try {
    const preflight = preflightExactPackageArtifact({
      root,
      snapshotDirectory: temporaryDirectory,
      tarballPath: candidateTarball(process.argv.slice(2)),
    })
    const report = runReleaseCompatibility({ candidateTarball: preflight.snapshot.path })
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
} catch (error) {
  if (error instanceof CompatibilityCommandError) {
    process.stderr.write(error.stdout)
    process.stderr.write(error.stderr)
  }
  process.stderr.write(`${error instanceof Error ? error.message : 'The release compatibility check failed.'}\n`)
  process.exitCode = 1
}
