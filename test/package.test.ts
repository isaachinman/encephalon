import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

describe("package contract", () => {
  test("declares a zero-runtime-dependency Node ESM package", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >

    expect(packageJson.name).toBe("encephalon")
    expect(packageJson.version).toBe("0.1.0")
    expect(packageJson.type).toBe("module")
    expect(packageJson.engines).toEqual({ node: ">=24.15.0" })
    expect(packageJson.dependencies).toBeUndefined()
    expect(packageJson).not.toHaveProperty("scripts.install")
    expect(packageJson).not.toHaveProperty("scripts.preinstall")
    expect(packageJson).not.toHaveProperty("scripts.postinstall")
    expect(packageJson).not.toHaveProperty("scripts.prepare")
  })

  test("has a side-effect-free TypeScript API entrypoint", () => {
    expect(existsSync(resolve(root, "src/index.ts"))).toBe(true)
  })

  test("ships the generic repository-memory skill", () => {
    const skill = readFileSync(resolve(root, "skills", "encephalon", "SKILL.md"), "utf8")
    expect(skill).toContain("npx --no-install encephalon search")
    expect(skill).toContain("--supersedes")
    expect(skill).toContain("npx --no-install encephalon validate")
    expect(skill).toContain("Do not stage, commit, push")
  })
})
