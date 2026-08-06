import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const temporaryDirectory = mkdtempSync(join(tmpdir(), "encephalon-package-check-"))

const run = (command: string[], cwd = root) => {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode === 0) return result.stdout.toString()
  process.stderr.write(result.stderr.toString())
  throw new Error(`${command[0]} failed with exit code ${result.exitCode}.`)
}

const collectFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : [path]
  })

try {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    name?: unknown
    version?: unknown
    license?: unknown
    type?: unknown
    engines?: unknown
    bin?: unknown
    exports?: unknown
    files?: unknown
    dependencies?: unknown
    scripts?: Record<string, unknown>
  }
  if (
    packageJson.name !== "encephalon" ||
    packageJson.version !== "0.1.0" ||
    packageJson.license !== "MIT" ||
    packageJson.type !== "module" ||
    JSON.stringify(packageJson.engines) !== JSON.stringify({ node: ">=24.15.0" }) ||
    JSON.stringify(packageJson.bin) !== JSON.stringify({ encephalon: "./dist/cli.mjs" }) ||
    JSON.stringify(packageJson.exports) !== JSON.stringify({ ".": { types: "./dist/index.d.ts", import: "./dist/index.mjs" } }) ||
    JSON.stringify(packageJson.files) !== JSON.stringify(["dist", "skills", "README.md", "LICENSE"]) ||
    packageJson.dependencies !== undefined
  ) {
    throw new Error("Package identity, exports, engine, files, or zero-runtime-dependency contract is invalid.")
  }
  const forbiddenLifecycleScripts = ["install", "preinstall", "postinstall", "prepare"]
  if (forbiddenLifecycleScripts.some((name) => packageJson.scripts?.[name] !== undefined)) {
    throw new Error("The package contains a forbidden installation lifecycle script.")
  }

  const requiredFiles = ["dist/cli.mjs", "dist/index.mjs", "dist/index.d.ts", "skills/encephalon/SKILL.md", "README.md", "LICENSE"]
  requiredFiles.forEach((path) => {
    if (!existsSync(resolve(root, path))) throw new Error(`Required package file ${path} is missing.`)
  })
  const cliPath = resolve(root, "dist", "cli.mjs")
  const lacksNodeShebang = !readFileSync(cliPath, "utf8").startsWith("#!/usr/bin/env node\n")
  const lacksExecutableMode = process.platform !== "win32" && (lstatSync(cliPath).mode & 0o111) === 0
  if (lacksNodeShebang || lacksExecutableMode) {
    throw new Error("The CLI must have a Node shebang and executable mode.")
  }
  const bundledSource = collectFiles(resolve(root, "dist"))
    .filter((path) => /\.mjs$/.test(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
  if (/\bbun:|\bBun\.|from\s+["']typescript["']/.test(bundledSource)) {
    throw new Error("The Node distribution contains an unresolved development-runtime import.")
  }
  const declarations = collectFiles(resolve(root, "dist"))
    .filter((path) => path.endsWith(".d.ts"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
  if (/from\s+["'][^"']+\.ts["']/.test(declarations)) {
    throw new Error("The declarations contain unresolved TypeScript source imports.")
  }

  const packOutput = run(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", temporaryDirectory])
  const pack = (JSON.parse(packOutput) as Array<{ filename: string; files: Array<{ path: string; mode?: number }> }>)[0]
  if (pack === undefined) throw new Error("npm pack did not return package metadata.")
  const allowedRootFiles = new Set(["LICENSE", "README.md", "package.json"])
  const unexpected = pack.files
    .map((file) => file.path)
    .filter((path) => !allowedRootFiles.has(path) && !path.startsWith("dist/") && !path.startsWith("skills/"))
  if (unexpected.length > 0) throw new Error(`The tarball contains unexpected files: ${unexpected.join(", ")}`)
  const packedCli = pack.files.find((file) => file.path === "dist/cli.mjs")
  if (packedCli === undefined || (packedCli.mode !== undefined && (packedCli.mode & 0o111) === 0)) {
    throw new Error("The packed CLI is missing or not executable.")
  }

  const consumer = resolve(temporaryDirectory, "consumer")
  mkdirSync(resolve(consumer, ".git"), { recursive: true })
  writeFileSync(resolve(consumer, "package.json"), '{"name":"encephalon-smoke","private":true,"type":"module"}\n')
  const tarball = resolve(temporaryDirectory, pack.filename)
  run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-dev", tarball], consumer)
  run([
    "node",
    "--input-type=module",
    "--eval",
    "const api = await import('encephalon'); if (typeof api.prepare !== 'function' || typeof api.initEncephalon !== 'function') process.exitCode = 1",
  ], consumer)
  writeFileSync(resolve(consumer, "smoke.ts"), [
    "import { EncephalonError, type BrainRecordFile, type SearchRecordsInput } from 'encephalon'",
    "const record: BrainRecordFile = { id: 'x', kind: 'context', subject: 'x', source: 'test', createdAt: '2026-08-06T00:00:00.000Z', payload: {} }",
    "const search: SearchRecordsInput = { query: record.subject }",
    "const error: EncephalonError = new EncephalonError('INVALID_ARGUMENT', search.query)",
    "if (error.code !== 'INVALID_ARGUMENT') throw error",
    "",
  ].join("\n"))
  writeFileSync(resolve(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2024",
    },
    files: ["smoke.ts"],
  }, null, 2)}\n`)
  run([
    process.execPath,
    resolve(root, "node_modules", "typescript", "bin", "tsc"),
    "--project",
    resolve(consumer, "tsconfig.json"),
  ], consumer)
  const prepared = JSON.parse(run([
    "node",
    resolve(consumer, "node_modules", "encephalon", "dist", "cli.mjs"),
    "--root",
    consumer,
    "prepare",
  ], consumer)) as { hydrated?: unknown; recordsIndexed?: unknown }
  if (prepared.hydrated !== true || prepared.recordsIndexed !== 0) {
    throw new Error("The packed Node-only CLI smoke test returned an unexpected result.")
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
