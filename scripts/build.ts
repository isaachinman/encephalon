import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const outputDirectory = resolve(root, 'dist')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: unknown }
if (typeof packageJson.version !== 'string') {
  throw new Error('package.json must declare a string version.')
}
const generatedDirectory = resolve(root, 'src', 'generated')
mkdirSync(generatedDirectory, { recursive: true })
writeFileSync(
  resolve(generatedDirectory, 'version.ts'),
  `// Generated from package.json by scripts/build.ts.\nexport const PACKAGE_VERSION = ${JSON.stringify(packageJson.version)}\n`,
  'utf8',
)

rmSync(outputDirectory, { force: true, recursive: true })
mkdirSync(outputDirectory, { recursive: true })

const build = await Bun.build({
  entrypoints: [resolve(root, 'src', 'index.ts'), resolve(root, 'src', 'cli.ts')],
  format: 'esm',
  minify: false,
  naming: '[name].mjs',
  outdir: outputDirectory,
  sourcemap: 'none',
  splitting: false,
  target: 'node',
})

if (!build.success) {
  for (const log of build.logs) {
    process.stderr.write(`${log}\n`)
  }
  throw new Error('The Node ESM bundle could not be built.')
}

const typeScript = Bun.spawnSync({
  cmd: [
    process.execPath,
    resolve(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    resolve(root, 'tsconfig.build.json'),
  ],
  cwd: root,
  stderr: 'inherit',
  stdout: 'inherit',
})

if (typeScript.exitCode !== 0) {
  throw new Error(`Declaration generation failed with exit code ${typeScript.exitCode}.`)
}

for (const filename of readdirSync(outputDirectory).filter(entry => entry.endsWith('.d.ts'))) {
  const path = resolve(outputDirectory, filename)
  const declaration = readFileSync(path, 'utf8').replaceAll(/(from\s+["'][^"']+)\.ts(["'])/g, '$1.js$2')
  writeFileSync(path, declaration, 'utf8')
}

chmodSync(resolve(outputDirectory, 'cli.mjs'), 0o755)
