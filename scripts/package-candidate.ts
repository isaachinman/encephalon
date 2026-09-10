import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { assertReviewedManifest, type PackageManifest, preflightExactPackageArtifact } from './package-preflight.ts'
import {
  packageArtifactFilename,
  readPackageTarEntries,
  snapshotPackageTarball,
  verifyPackageArtifactMetadata,
} from './package-tarball.ts'
import { assertPackageVersionSource, readPackageVersionSource } from './package-version.ts'

export const restorePackageCandidate = (root: string, expectedSha256: string) => {
  const version = assertReviewedManifest(
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageManifest,
  )
  assertPackageVersionSource(version, readPackageVersionSource(resolve(root, 'src/generated/version.ts')))
  const filename = packageArtifactFilename(version)
  const tarballPath = resolve(root, 'package-artifacts', filename)
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  }).trim()
  const metadata = verifyPackageArtifactMetadata(tarballPath, {
    packageVersion: version,
    sourceCommit,
    tarball: `package-artifacts/${filename}`,
  })
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || metadata.sha256 !== expectedSha256) {
    throw new Error('The candidate differs from the producer SHA-256 digest.')
  }
  const temporary = mkdtempSync(resolve(tmpdir(), 'encephalon-candidate-'))
  const output = resolve(root, 'dist')
  let installed = false
  try {
    const snapshotDirectory = resolve(temporary, 'snapshot')
    mkdirSync(snapshotDirectory)
    const snapshot = snapshotPackageTarball(tarballPath, snapshotDirectory)
    if (snapshot.digests.sha256 !== expectedSha256) {
      throw new Error('The candidate changed from the producer SHA-256 digest before restoration.')
    }
    const runtime = readPackageTarEntries(snapshot.path).filter(entry => entry.path.startsWith('package/dist/'))
    if (runtime.some(entry => !/^package\/dist\/[a-zA-Z0-9_-]+\.(?:mjs|d\.ts)$/.test(entry.path))) {
      throw new Error('The candidate has an unsupported runtime output path.')
    }
    mkdirSync(output)
    installed = true
    for (const entry of runtime) {
      writeFileSync(resolve(root, entry.path.slice('package/'.length)), entry.content, { flag: 'wx', mode: entry.mode })
    }
    const checked = preflightExactPackageArtifact({ root, snapshotDirectory: temporary, tarballPath })
    if (checked.metadata.sha256 !== expectedSha256) {
      throw new Error('The candidate changed from the producer SHA-256 digest during restoration.')
    }
    return checked.metadata
  } catch (error) {
    if (installed) {
      rmSync(output, { force: true, recursive: true })
    }
    throw error
  } finally {
    rmSync(temporary, { force: true, recursive: true })
  }
}
