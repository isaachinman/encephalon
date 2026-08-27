import { spawnSync } from 'node:child_process'
import { type BigIntStats, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  type PackageArtifactMetadata,
  type PackageTarballSnapshot,
  packageArtifactMetadataPath,
  readPackageTarEntries,
  snapshotPackageTarball,
  verifyPackageArtifactMetadata,
} from './package-tarball.ts'
import { assertPackageVersionSource, readPackageVersionSource } from './package-version.ts'

export const REVIEWED_PACKAGE_FILES = Object.freeze([
  'dist',
  'skills',
  'assets/encephalon.png',
  'docs/performance.md',
  'docs/performance-baseline.json',
  'docs/performance-budgets.json',
  'README.md',
  'LICENSE',
] as const)

const REVIEWED_PACKAGE_ROOT_FILES = Object.freeze(
  REVIEWED_PACKAGE_FILES.filter(path => path !== 'dist' && path !== 'skills'),
)

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  'dist/cli.mjs',
  'dist/index.mjs',
  'dist/index.d.ts',
  'skills/encephalon/SKILL.md',
  ...REVIEWED_PACKAGE_ROOT_FILES,
] as const)

export type PackageManifest = Readonly<{
  name?: unknown
  version?: unknown
  license?: unknown
  type?: unknown
  engines?: unknown
  bin?: unknown
  exports?: unknown
  files?: unknown
  bundleDependencies?: unknown
  bundledDependencies?: unknown
  dependencies?: unknown
  optionalDependencies?: unknown
  peerDependencies?: unknown
  peerDependenciesMeta?: unknown
  scripts?: Record<string, unknown>
}>

export type ExactPackagePreflight = Readonly<{
  metadata: PackageArtifactMetadata
  packageVersion: string
  snapshot: PackageTarballSnapshot
  sourceCommit: string
}>

const maximumGitOutputBytes = 4 * 1024 * 1024
const gitTimeoutMilliseconds = 10_000

const runGit = (root: string, arguments_: readonly string[]) => {
  const result = spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: maximumGitOutputBytes,
    timeout: gitTimeoutMilliseconds,
  })
  if (result.error !== undefined) {
    throw result.error
  }
  if (result.status === 0 && result.stderr === '') {
    return result.stdout ?? ''
  }
  throw new Error(`git ${arguments_.join(' ')} failed during package preflight.`)
}

const sameIdentity = (expected: BigIntStats, actual: BigIntStats) =>
  expected.dev === actual.dev &&
  expected.ino === actual.ino &&
  expected.mode === actual.mode &&
  expected.nlink === actual.nlink &&
  expected.size === actual.size &&
  expected.mtimeNs === actual.mtimeNs &&
  expected.ctimeNs === actual.ctimeNs

export const assertReviewedManifest = (packageJson: PackageManifest) => {
  if (typeof packageJson.version !== 'string') {
    throw new Error('Package version must be a string.')
  }
  if (
    packageJson.name !== 'encephalon' ||
    packageJson.license !== 'MIT' ||
    packageJson.type !== 'module' ||
    JSON.stringify(packageJson.engines) !== JSON.stringify({ node: '>=24.15.0' }) ||
    JSON.stringify(packageJson.bin) !== JSON.stringify({ encephalon: 'dist/cli.mjs' }) ||
    JSON.stringify(packageJson.exports) !==
      JSON.stringify({
        '.': { import: './dist/index.mjs', types: './dist/index.d.ts' },
      }) ||
    JSON.stringify(packageJson.files) !== JSON.stringify(REVIEWED_PACKAGE_FILES) ||
    packageJson.bundleDependencies !== undefined ||
    packageJson.bundledDependencies !== undefined ||
    packageJson.dependencies !== undefined ||
    packageJson.optionalDependencies !== undefined ||
    packageJson.peerDependencies !== undefined ||
    packageJson.peerDependenciesMeta !== undefined
  ) {
    throw new Error('Package identity, exports, engine, files, or zero-runtime-dependency contract is invalid.')
  }
  const forbiddenLifecycleScripts = ['install', 'preinstall', 'postinstall', 'prepare']
  if (forbiddenLifecycleScripts.some(name => packageJson.scripts?.[name] !== undefined)) {
    throw new Error('The package contains a forbidden installation lifecycle script.')
  }
  return packageJson.version
}

const readmeReferences = (content: string) => {
  const pattern = /(?:!?\[[^\]]*\]\(([^)]+)\)|<img\b[^>]*\bsrc=["']([^"']+)["'])/giu
  return [...content.matchAll(pattern)]
    .map(match => match[1] ?? match[2] ?? '')
    .map(reference => reference.trim())
    .filter(
      reference =>
        reference.length > 0 &&
        !reference.startsWith('#') &&
        !reference.startsWith('/') &&
        !/^[a-z][a-z0-9+.-]*:/iu.test(reference),
    )
    .map(reference => {
      const [path = ''] = reference.split(/[?#]/u, 1)
      return path.startsWith('./') ? path.slice(2) : path
    })
}

const decodeUtf8 = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

export const reviewedPackageArchiveMode = (
  path: string,
  mode: number,
  platform: NodeJS.Platform = process.platform,
) => {
  const expectedMode = path === 'dist/cli.mjs' ? 0o755 : 0o644
  return mode === expectedMode || (platform === 'win32' && path === 'dist/cli.mjs' && mode === 0o644)
}

const packageIdentity = (root: string) => {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageManifest
  const packageVersion = assertReviewedManifest(packageJson)
  const generatedVersionSource = readPackageVersionSource(resolve(root, 'src', 'generated', 'version.ts'))
  assertPackageVersionSource(packageVersion, generatedVersionSource)
  const sourceCommit = runGit(root, ['rev-parse', 'HEAD']).trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)) {
    throw new Error('The reviewed source commit is not a full Git object identity.')
  }
  return Object.freeze({ packageVersion, sourceCommit })
}

export const validateReviewedPackageSnapshot = (root: string, snapshot: PackageTarballSnapshot) => {
  for (const path of REQUIRED_PACKAGE_FILES) {
    if (!existsSync(resolve(root, path))) {
      throw new Error(`Required package file ${path} is missing.`)
    }
  }
  const cliPath = resolve(root, 'dist', 'cli.mjs')
  const lacksNodeShebang = !readFileSync(cliPath, 'utf8').startsWith('#!/usr/bin/env node\n')
  const lacksExecutableMode = process.platform !== 'win32' && (lstatSync(cliPath).mode & 0o111) === 0
  if (lacksNodeShebang || lacksExecutableMode) {
    throw new Error('The CLI must have a Node shebang and executable mode.')
  }

  const entries = readPackageTarEntries(snapshot.path)
  const allowedTrackedFiles = new Set([...REVIEWED_PACKAGE_ROOT_FILES, 'package.json'])
  const reviewedInputs = runGit(root, ['ls-files', '--cached', '-z', '--'])
    .split('\0')
    .filter(path => path.length > 0)
  const expectedPackagePaths = new Set([
    ...reviewedInputs.filter(path => allowedTrackedFiles.has(path) || path.startsWith('skills/')),
    ...reviewedInputs
      .filter(path => path.startsWith('src/') && path.endsWith('.ts') && !path.endsWith('.d.ts'))
      .map(path => `dist/${path.slice('src/'.length, -'.ts'.length)}.d.ts`),
    'dist/cli.mjs',
    'dist/index.mjs',
  ])
  const packedEntries = entries.map(entry => {
    if (entry.path.startsWith('package/') && entry.path.length > 'package/'.length) {
      return Object.freeze({ ...entry, path: entry.path.slice('package/'.length) })
    }
    throw new Error('The tarball differs from the reviewed package file manifest.')
  })
  const packedPaths = new Set(packedEntries.map(entry => entry.path))
  const differsFromReviewedManifest =
    packedEntries.length !== packedPaths.size ||
    packedEntries.some(entry => !expectedPackagePaths.has(entry.path)) ||
    [...expectedPackagePaths].some(path => !packedPaths.has(path))
  if (differsFromReviewedManifest) {
    throw new Error('The tarball differs from the reviewed package file manifest.')
  }

  const packedManifest = packedEntries.find(entry => entry.path === 'package.json')
  if (packedManifest === undefined) {
    throw new Error('The packed package manifest is missing from the reviewed package contents.')
  }
  try {
    const reviewedManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageManifest
    const packedPackageJson = JSON.parse(decodeUtf8(packedManifest.content)) as PackageManifest
    if (
      assertReviewedManifest(packedPackageJson) !== assertReviewedManifest(reviewedManifest) ||
      !isDeepStrictEqual(packedPackageJson, reviewedManifest)
    ) {
      throw new Error('The packed manifest bytes differ from the reviewed manifest.')
    }
  } catch (error) {
    throw new Error('The packed package manifest differs from the reviewed package manifest.', { cause: error })
  }

  const contentMismatch = packedEntries.find(entry => {
    const expectedContent = readFileSync(resolve(root, entry.path))
    return !(reviewedPackageArchiveMode(entry.path, entry.mode) && entry.content.equals(expectedContent))
  })
  if (contentMismatch !== undefined) {
    throw new Error(`The reviewed package bytes or mode differ for ${contentMismatch.path}.`)
  }
  const missingReadmeReferences = readmeReferences(readFileSync(resolve(root, 'README.md'), 'utf8')).filter(
    path => !packedPaths.has(path),
  )
  if (missingReadmeReferences.length > 0) {
    throw new Error(`The packed README references missing files: ${missingReadmeReferences.join(', ')}`)
  }
  return Object.freeze({
    entries: packedEntries,
    packageVersion: assertReviewedManifest(
      JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageManifest,
    ),
  })
}

export const preflightExactPackageArtifact = (
  options: Readonly<{
    root: string
    snapshotDirectory: string
    tarballPath?: string
  }>,
): ExactPackagePreflight => {
  const identity = packageIdentity(options.root)
  const expectedTarball = resolve(options.root, 'package-artifacts', `encephalon-${identity.packageVersion}.tgz`)
  const tarballPath = resolve(options.tarballPath ?? expectedTarball)
  const expectedMetadataPath = `${expectedTarball}.metadata.json`
  const artifactDirectory = resolve(options.root, 'package-artifacts')
  const artifactDirectoryEntry = lstatSync(artifactDirectory, { bigint: true })
  const tarballEntry = lstatSync(tarballPath, { bigint: true })
  const metadataEntry = lstatSync(packageArtifactMetadataPath(tarballPath), { bigint: true })
  const artifactDirectoryCanonicalPath = realpathSync.native(artifactDirectory)
  const expectedArtifactDirectoryCanonicalPath = resolve(
    realpathSync.native(options.root),
    relative(options.root, artifactDirectory),
  )
  const safeArtifactEntries =
    artifactDirectoryEntry.isDirectory() &&
    !artifactDirectoryEntry.isSymbolicLink() &&
    artifactDirectoryCanonicalPath === expectedArtifactDirectoryCanonicalPath &&
    tarballEntry.isFile() &&
    !tarballEntry.isSymbolicLink() &&
    tarballEntry.nlink === 1n &&
    metadataEntry.isFile() &&
    !metadataEntry.isSymbolicLink() &&
    metadataEntry.nlink === 1n
  if (!safeArtifactEntries) {
    throw new Error('The exact package artifact pair is not one canonical directory with single-link files.')
  }
  const artifactEntries = readdirSync(artifactDirectory).sort()
  const expectedEntries = [
    relative(resolve(options.root, 'package-artifacts'), expectedTarball),
    relative(resolve(options.root, 'package-artifacts'), expectedMetadataPath),
  ].sort()
  if (
    tarballPath !== expectedTarball ||
    artifactEntries.length !== expectedEntries.length ||
    artifactEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error('The exact package artifact directory must contain only the fixed tarball and metadata pair.')
  }
  const metadata = verifyPackageArtifactMetadata(tarballPath, {
    packageVersion: identity.packageVersion,
    sourceCommit: identity.sourceCommit,
    tarball: relative(options.root, tarballPath).split(sep).join('/'),
  })
  const snapshot = snapshotPackageTarball(tarballPath, options.snapshotDirectory)
  if (
    !isDeepStrictEqual(snapshot.digests, {
      bytes: metadata.bytes,
      integrity: metadata.integrity,
      sha1: metadata.sha1,
      sha256: metadata.sha256,
      sha512: metadata.sha512,
    })
  ) {
    throw new Error('The package artifact changed between metadata verification and private snapshotting.')
  }
  const validated = validateReviewedPackageSnapshot(options.root, snapshot)
  const finalDirectoryEntry = lstatSync(artifactDirectory, { bigint: true })
  const finalTarballEntry = lstatSync(tarballPath, { bigint: true })
  const finalMetadataEntry = lstatSync(packageArtifactMetadataPath(tarballPath), { bigint: true })
  if (
    validated.packageVersion !== identity.packageVersion ||
    !sameIdentity(artifactDirectoryEntry, finalDirectoryEntry) ||
    !sameIdentity(tarballEntry, finalTarballEntry) ||
    !sameIdentity(metadataEntry, finalMetadataEntry) ||
    realpathSync.native(artifactDirectory) !== artifactDirectoryCanonicalPath
  ) {
    throw new Error('The reviewed package identity changed during exact artifact preflight.')
  }
  return Object.freeze({
    metadata,
    packageVersion: identity.packageVersion,
    snapshot,
    sourceCommit: identity.sourceCommit,
  })
}
