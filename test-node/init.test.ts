import { afterEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as api from "../src/index.ts"
import { createTestRepository, ensureParent, removeTestRepository } from "../test/helpers.ts"

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

describe("initialisation", () => {
  test("creates a safe deterministic baseline and exactly reversible instruction blocks", () => {
    const root = createRoot()
    const originalAgents = "# Existing agent guidance"
    writeFileSync(join(root, "AGENTS.md"), originalAgents)
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "sample-project",
      packageManager: "npm@11.0.0",
      scripts: {
        test: "SECRET_TOKEN=never-store-this node --test",
        build: "sensitive-command --registry=https://registry.example.invalid",
      },
      workspaces: ["packages/*"],
    }))
    writeFileSync(join(root, "package-lock.json"), "{}")
    writeFileSync(join(root, ".env"), "SECRET_TOKEN=never-store-this")
    writeFileSync(join(root, "README.md"), "Run sensitive-command --password hidden")
    ensureParent(join(root, ".github", "workflows", "checks.yml"))
    writeFileSync(join(root, ".github", "workflows", "checks.yml"), "env:\n  SECRET_TOKEN: never-store-this\n")
    ensureParent(join(root, "src", "index.ts"))
    writeFileSync(join(root, "src", "index.ts"), "export const secret = 'never-store-this'")

    const result = api.initEncephalon({ root })
    assert.equal(result.recordsCreated.length, 3)
    assert.deepEqual(result.skippedConflicts, [])
    assert.match(result.nextAction, /skills\/encephalon\/SKILL\.md/)

    const records = api.listRecords({ root, includeSuperseded: true, limit: 20 })
    assert.equal(records.length, 3)
    assert.deepEqual(records.map((record) => record.subject).sort(), [
      "encephalon:init/commands-ci",
      "encephalon:init/repository-overview",
      "encephalon:init/tooling-layout",
    ])
    assert.equal(records.every((record) => record.source === "encephalon:init"), true)
    const serialized = JSON.stringify(records)
    assert.doesNotMatch(serialized, /never-store-this|sensitive-command|registry\.example\.invalid|SECRET_TOKEN/)
    assert.match(serialized, /npm run test/)
    assert.match(serialized, /checks\.yml/)

    const agentsWithBlock = readFileSync(join(root, "AGENTS.md"), "utf8")
    const claudeWithBlock = readFileSync(join(root, "CLAUDE.md"), "utf8")
    assert.match(agentsWithBlock, /\.\/node_modules\/encephalon\/skills\/encephalon\/SKILL\.md/)
    assert.match(claudeWithBlock, /\.\/node_modules\/encephalon\/skills\/encephalon\/SKILL\.md/)

    const removed = api.initEncephalon({ root, remove: true })
    assert.deepEqual(removed.recordsCreated, [])
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), originalAgents)
    assert.equal(existsSync(join(root, "CLAUDE.md")), false)
    assert.equal(records.every((record) => existsSync(join(root, record.path))), true)
  })

  test("is idempotent and refreshes only changed generated facts by superseding the active head", () => {
    const root = createRoot()
    const packagePath = join(root, "package.json")
    writeFileSync(packagePath, JSON.stringify({ name: "sample-project", scripts: { test: "node --test" } }))

    const first = api.initEncephalon({ root })
    const second = api.initEncephalon({ root })
    assert.equal(first.recordsCreated.length, 3)
    assert.deepEqual(second.recordsCreated, [])
    assert.equal(api.listRecords({ root, includeSuperseded: true, limit: 20 }).length, 3)

    writeFileSync(packagePath, JSON.stringify({ name: "sample-project", scripts: { test: "node --test", lint: "lint-private-body" } }))
    const refreshed = api.initEncephalon({ root, refreshBaseline: true })
    assert.equal(refreshed.recordsCreated.length, 1)
    const all = api.listRecords({ root, includeSuperseded: true, limit: 20 })
    const workflow = all.filter((record) => record.subject === "encephalon:init/commands-ci")
    assert.equal(workflow.length, 2)
    assert.deepEqual(workflow[0]?.supersedes, [workflow[1]?.id])
    assert.match(JSON.stringify(workflow[0]?.payload), /npm run lint/)
    assert.doesNotMatch(JSON.stringify(workflow[0]?.payload), /lint-private-body/)
    assert.equal(api.listRecords({ root, limit: 20 }).length, 3)
  })

  test("skips a reserved subject owned by an agent-authored active record", () => {
    const root = createRoot()
    api.addRecord({
      root,
      id: "agent-overview",
      kind: "context",
      subject: "encephalon:init/repository-overview",
      source: "human",
      payload: { summary: "Curated overview" },
    })

    const result = api.initEncephalon({ root })
    assert.deepEqual(result.skippedConflicts, [{
      kind: "context",
      subject: "encephalon:init/repository-overview",
      activeRecordIds: ["agent-overview"],
    }])
    assert.equal(api.listRecords({ root, includeSuperseded: true, limit: 20 }).filter((record) => record.subject === "encephalon:init/repository-overview").length, 1)
  })

  test("preflights both instruction files before writing anything", () => {
    const root = createRoot()
    const malformed = "before\n<!-- encephalon:managed-instructions:start {} -->\nafter"
    writeFileSync(join(root, "AGENTS.md"), malformed)
    writeFileSync(join(root, "CLAUDE.md"), "untouched")

    assert.throws(() => api.initEncephalon({ root }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "VALIDATION_FAILED")
      return true
    })
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), malformed)
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "untouched")
    assert.equal(existsSync(join(root, "encephalon")), false)
  })

  test("rejects symlinked instruction files before changing records or link targets", {
    skip: process.platform === "win32" ? "Windows runners may not permit file symlink creation." : false,
  }, () => {
    const root = createRoot()
    const target = join(root, "outside-agents.md")
    const original = "# Outside guidance\n"
    writeFileSync(target, original)
    symlinkSync(target, join(root, "AGENTS.md"))

    assert.throws(() => api.initEncephalon({ root }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "VALIDATION_FAILED")
      return true
    })
    assert.equal(readFileSync(target, "utf8"), original)
    assert.equal(existsSync(join(root, "encephalon")), false)
  })

  test("rejects managed metadata containing a separator Encephalon never emits", () => {
    const root = createRoot()
    const separator = "forged-separator"
    const metadata = Buffer.from(JSON.stringify({
      formatVersion: 1,
      originalFileExisted: true,
      separatorBase64: Buffer.from(separator, "utf8").toString("base64"),
      lineEnding: "LF",
    }), "utf8").toString("base64url")
    writeFileSync(join(root, "AGENTS.md"), [
      separator + `<!-- encephalon:managed-instructions:start ${metadata} -->`,
      "## Encephalon",
      "Read and follow the repository-memory skill before making repository assumptions or recording durable knowledge:",
      "./node_modules/encephalon/skills/encephalon/SKILL.md",
      "<!-- encephalon:managed-instructions:end -->",
      "",
    ].join("\n"))

    assert.throws(() => api.initEncephalon({ root, remove: true }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "VALIDATION_FAILED")
      return true
    })
  })

  test("round-trips CRLF files byte-for-byte and preserves user content added after the block", () => {
    const root = createRoot()
    const original = "# Existing guidance\r\n\r\nKeep this exactly.\r\n"
    const path = join(root, "AGENTS.md")
    writeFileSync(path, original)
    api.initEncephalon({ root })
    const installed = readFileSync(path, "utf8")
    assert.match(installed, /\r\n## Encephalon\r\n/)
    writeFileSync(path, `${installed}User addition.\r\n`)

    api.initEncephalon({ root, remove: true })
    assert.equal(readFileSync(path, "utf8"), `${original}User addition.\r\n`)
  })
})
