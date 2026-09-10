import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Plugin, rollup } from 'rollup'
import { renderPackageVersionSource } from './package-version.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The plugin supports TypeScript 7 via typescript6, but its declaration still imports the removed legacy API.
const { dts } = createRequire(import.meta.url)('rollup-plugin-dts') as { dts: () => Plugin }
const outputDirectory = resolve(root, 'dist')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }
if (typeof packageJson.version !== 'string') {
  throw new Error('package.json must declare a string version.')
}
const generatedDirectory = resolve(root, 'src', 'generated')
mkdirSync(generatedDirectory, { recursive: true })
writeFileSync(resolve(generatedDirectory, 'version.ts'), renderPackageVersionSource(packageJson.version), 'utf8')

rmSync(outputDirectory, { force: true, recursive: true })
mkdirSync(outputDirectory, { recursive: true })

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'node' })
const runtime = await rollup({
  external: specifier => specifier.startsWith('node:'),
  input: { cli: resolve(root, 'src/cli.ts'), index: resolve(root, 'src/index.ts') },
  plugins: [
    {
      name: 'typescript',
      transform: (source, id) => (id.endsWith('.ts') ? { code: transpiler.transformSync(source), map: null } : null),
    },
  ],
})
try {
  const emitted = await runtime.write({
    banner: chunk => (chunk.isEntry && chunk.name === 'cli' ? '#!/usr/bin/env node' : ''),
    chunkFileNames: '[name]-[hash].mjs',
    dir: outputDirectory,
    entryFileNames: '[name].mjs',
    format: 'es',
    manualChunks: id =>
      [resolve(root, 'src/cache.ts'), resolve(root, 'src/records.ts')].includes(resolve(id))
        ? 'cache-records'
        : undefined,
    onlyExplicitManualChunks: true,
  })
  process.stdout.write(
    `${JSON.stringify({
      runtime: emitted.output.map(chunk => {
        if (chunk.type === 'chunk') {
          return {
            bytes: Buffer.byteLength(chunk.code),
            dynamicImports: chunk.dynamicImports,
            file: chunk.fileName,
            imports: chunk.imports,
            sources: Object.keys(chunk.modules)
              .map(path => relative(root, path).replaceAll('\\', '/'))
              .sort(),
          }
        }
        throw new Error('The runtime build emitted an unexpected non-JavaScript asset.')
      }),
    })}\n`,
  )
} finally {
  await runtime.close()
}

const declarationDirectory = mkdtempSync(resolve(tmpdir(), 'encephalon-declarations-'))
try {
  const typeScript = Bun.spawnSync({
    cmd: [
      process.execPath,
      resolve(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      resolve(root, 'tsconfig.build.json'),
      '--declarationDir',
      declarationDirectory,
    ],
    cwd: root,
    stderr: 'inherit',
    stdout: 'inherit',
  })

  if (typeScript.exitCode !== 0) {
    throw new Error(`Declaration generation failed with exit code ${typeScript.exitCode}.`)
  }

  for (const filename of readdirSync(declarationDirectory).filter(entry => entry.endsWith('.d.ts'))) {
    const path = resolve(declarationDirectory, filename)
    const declaration = readFileSync(path, 'utf8').replaceAll(/(from\s+["'][^"']+)\.ts(["'])/g, '$1.js$2')
    writeFileSync(path, declaration, 'utf8')
  }
  const declarations = await rollup({
    input: resolve(declarationDirectory, 'index.d.ts'),
    plugins: [dts()],
  })
  try {
    await declarations.write({ file: resolve(outputDirectory, 'index.d.ts'), format: 'es' })
  } finally {
    await declarations.close()
  }
} finally {
  rmSync(declarationDirectory, { force: true, recursive: true })
}

chmodSync(resolve(outputDirectory, 'cli.mjs'), 0o755)
