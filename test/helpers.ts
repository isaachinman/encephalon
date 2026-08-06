import { mkdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { mkdtempSync } from "node:fs"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export const createTestRepository = () => {
  const root = mkdtempSync(join(tmpdir(), "encephalon-test-"))
  mkdirSync(join(root, ".git"))
  mkdirSync(join(root, "node_modules"))
  symlinkSync(packageRoot, join(root, "node_modules", "encephalon"), process.platform === "win32" ? "junction" : "dir")
  return root
}

export const removeTestRepository = (root: string) => {
  rmSync(root, { force: true, recursive: true })
}

export const ensureParent = (path: string) => {
  mkdirSync(dirname(path), { recursive: true })
}
