import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preflightExactPackageArtifact } from './package-preflight.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tarball = resolve(root, 'package-artifacts', 'encephalon-0.3.0.tgz')
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'encephalon-package-metadata-'))
try {
  const preflight = preflightExactPackageArtifact({ root, snapshotDirectory: temporaryDirectory, tarballPath: tarball })
  process.stdout.write(`${JSON.stringify(preflight.metadata)}\n`)
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
