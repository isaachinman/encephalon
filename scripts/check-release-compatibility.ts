import { parsePackageCheckArguments } from './package-tarball.ts'
import { CompatibilityCommandError, runReleaseCompatibility } from './release-compatibility.ts'

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
  const report = runReleaseCompatibility({ candidateTarball: candidateTarball(process.argv.slice(2)) })
  process.stdout.write(`${JSON.stringify(report)}\n`)
} catch (error) {
  if (error instanceof CompatibilityCommandError) {
    process.stderr.write(error.stdout)
    process.stderr.write(error.stderr)
  }
  process.stderr.write(`${error instanceof Error ? error.message : 'The release compatibility check failed.'}\n`)
  process.exitCode = 1
}
