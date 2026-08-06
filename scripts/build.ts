import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const outputDirectory = resolve(root, "dist")

rmSync(outputDirectory, { recursive: true, force: true })
mkdirSync(outputDirectory, { recursive: true })

const build = await Bun.build({
  entrypoints: [resolve(root, "src", "index.ts"), resolve(root, "src", "cli.ts")],
  outdir: outputDirectory,
  target: "node",
  format: "esm",
  naming: "[name].mjs",
  splitting: false,
  minify: false,
  sourcemap: "none",
})

if (!build.success) {
  build.logs.forEach((log) => process.stderr.write(`${log}\n`))
  throw new Error("The Node ESM bundle could not be built.")
}

const typeScript = Bun.spawnSync({
  cmd: [process.execPath, resolve(root, "node_modules", "typescript", "bin", "tsc"), "--project", resolve(root, "tsconfig.build.json")],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})

if (typeScript.exitCode !== 0) {
  throw new Error(`Declaration generation failed with exit code ${typeScript.exitCode}.`)
}

readdirSync(outputDirectory)
  .filter((filename) => filename.endsWith(".d.ts"))
  .forEach((filename) => {
    const path = resolve(outputDirectory, filename)
    const declaration = readFileSync(path, "utf8").replaceAll(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2")
    writeFileSync(path, declaration, "utf8")
  })

chmodSync(resolve(outputDirectory, "cli.mjs"), 0o755)
