import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { restorePackageCandidate } from './package-candidate.ts'
import { preflightExactPackageArtifact } from './package-preflight.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'encephalon-package-metadata-'))
try {
  const args = process.argv.slice(2)
  if (!(args.length === 0 || (args.length === 1 && args[0] === '--restore'))) {
    throw new Error('Usage: check-package-metadata.ts [--restore]')
  }
  const metadata =
    args[0] === '--restore'
      ? restorePackageCandidate(root, process.env.CANDIDATE_SHA256 ?? '')
      : preflightExactPackageArtifact({ root, snapshotDirectory: temporaryDirectory }).metadata
  if (process.env.CANDIDATE_SHA256 !== undefined && metadata.sha256 !== process.env.CANDIDATE_SHA256) {
    throw new Error('The candidate differs from the producer SHA-256 digest.')
  }
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${metadata.tarball}\nsha256=${metadata.sha256}\n`)
  }
  process.stdout.write(`${JSON.stringify(metadata)}\n`)
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
