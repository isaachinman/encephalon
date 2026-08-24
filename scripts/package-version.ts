const staleGeneratedVersionMessage =
  'Generated runtime package version is stale. Run `bun run build` and commit src/generated/version.ts.'

export const renderPackageVersionSource = (version: string): string =>
  `// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = ${JSON.stringify(version)}\n`

export const assertPackageVersionSource = (version: string, source: string): void => {
  if (source.replaceAll('\r\n', '\n') !== renderPackageVersionSource(version)) {
    throw new Error(staleGeneratedVersionMessage)
  }
}
