import { readFileSync } from 'node:fs'

const staleGeneratedVersionMessage =
  'Generated runtime package version is stale. Run `bun run build` and commit src/generated/version.ts.'

export const createStaleGeneratedVersionError = (): Error => new Error(staleGeneratedVersionMessage)

export const renderPackageVersionSource = (version: string): string =>
  `// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = ${JSON.stringify(version)}\n`

export const readPackageVersionSource = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw createStaleGeneratedVersionError()
    }
    throw error
  }
}

export const assertPackageVersionSource = (version: string, source: string): void => {
  const expectedSource = renderPackageVersionSource(version)
  const expectedWindowsSource = expectedSource.replaceAll('\n', '\r\n')
  if (source !== expectedSource && source !== expectedWindowsSource) {
    throw createStaleGeneratedVersionError()
  }
}

export const packageArtifactFilename = (version: unknown) => {
  if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    return `encephalon-${version}.tgz`
  }
  throw new Error('The package version cannot form a safe candidate filename.')
}
