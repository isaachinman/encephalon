import { afterEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as api from "../src/index.ts"
import { discoverRepository } from "../src/repository.ts"
import { createTestRepository, ensureParent, removeTestRepository } from "../test/helpers.ts"

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const assertErrorCode = (operation: () => unknown, code: string) => {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code)
    return true
  })
}

afterEach(() => {
  roots.splice(0).forEach(removeTestRepository)
})

describe("canonical records", () => {
  test("adds a formatted append-only record and returns a relative runtime path", () => {
    const root = createRoot()
    const record = api.addRecord({
      root,
      id: "550e8400-e29b-41d4-a716-446655440000",
      kind: "decision",
      subject: "backend.database",
      source: "agent",
      confidence: 0.9,
      payload: { summary: "Use SQLite", reasons: ["Portable", "Fast"] },
      searchText: "storage persistence",
    })

    assert.equal(record.path, "encephalon/decision/550e8400-e29b-41d4-a716-446655440000.json")
    const filePath = join(root, record.path)
    assert.equal(existsSync(filePath), true)
    assert.equal(readFileSync(filePath, "utf8"), `${JSON.stringify({
      id: "550e8400-e29b-41d4-a716-446655440000",
      kind: "decision",
      subject: "backend.database",
      source: "agent",
      createdAt: record.createdAt,
      confidence: 0.9,
      payload: { summary: "Use SQLite", reasons: ["Portable", "Fast"] },
      searchText: "storage persistence",
    }, null, 2)}\n`)

    assertErrorCode(() => api.addRecord({
      root,
      id: record.id,
      kind: "decision",
      subject: "backend.database",
      source: "agent",
      payload: { summary: "Overwrite" },
    }), "RECORD_EXISTS")
  })

  test("does not create a canonical file when the formatted record exceeds its size limit", () => {
    const root = createRoot()
    const id = "oversized-record"
    assertErrorCode(() => api.addRecord({
      root,
      id,
      kind: "context",
      subject: "record.size-limit",
      source: "test",
      payload: { value: "x".repeat(1024 * 1024) },
    }), "INVALID_ARGUMENT")
    assert.equal(existsSync(join(root, "encephalon", "context", `${id}.json`)), false)
  })

  test("supports artifact-first creation with a caller-supplied id", () => {
    const root = createRoot()
    const id = "550e8400-e29b-41d4-a716-446655440001"
    const artifact = `_artifacts/architecture/${id}/diagram.svg`
    const artifactPath = join(root, "encephalon", ...artifact.split("/"))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, "<svg/>")

    const record = api.addRecord({
      root,
      id,
      kind: "architecture",
      subject: "system.overview",
      source: "agent",
      artifacts: [artifact],
      payload: { summary: "System boundaries" },
    })

    assert.deepEqual(record.artifacts, [artifact])
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test("validates supersession graphs and permits a multi-head resolver", () => {
    const root = createRoot()
    const first = api.addRecord({ root, id: "record-a", kind: "decision", subject: "api.style", source: "agent", payload: { summary: "REST" } })
    const second = api.addRecord({ root, id: "record-b", kind: "decision", subject: "api.style", source: "agent", supersedes: [first.id], payload: { summary: "GraphQL" } })
    const parallelPath = join(root, "encephalon", "decision", "record-c.json")
    writeFileSync(parallelPath, `${JSON.stringify({
      id: "record-c",
      kind: "decision",
      subject: "api.style",
      source: "agent",
      createdAt: "2026-08-06T10:00:00.000Z",
      supersedes: [first.id],
      payload: { summary: "RPC" },
    }, null, 2)}\n`)

    const conflicted = api.validateRecords({ root })
    assert.equal(conflicted.valid, false)
    assert.equal(conflicted.errors.some((error) => error.code === "MULTIPLE_ACTIVE_HEADS"), true)

    api.addRecord({ root, id: "record-d", kind: "decision", subject: "api.style", source: "agent", supersedes: [second.id, "record-c"], payload: { summary: "GraphQL with RPC internally" } })
    assert.equal(api.validateRecords({ root }).valid, true)
  })

  test("rejects non-JSON payloads and unsafe portable paths", () => {
    const root = createRoot()

    assertErrorCode(() => api.addRecord({ root, kind: "Decision", subject: "x", source: "agent", payload: {} }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, id: "CON", kind: "decision", subject: "x", source: "agent", payload: {} }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, kind: "decision", subject: "x", source: "agent", payload: { invalid: Number.NaN } }), "INVALID_ARGUMENT")
    const sparse: unknown[] = []
    sparse.length = 1
    assertErrorCode(() => api.addRecord({ root, kind: "decision", subject: "x", source: "agent", payload: sparse as never }), "INVALID_ARGUMENT")
    const symbolKeyed = { summary: "Hidden symbol" } as Record<PropertyKey, unknown>
    symbolKeyed[Symbol("hidden")] = "not JSON"
    assertErrorCode(() => api.addRecord({ root, kind: "decision", subject: "x", source: "agent", payload: symbolKeyed as never }), "INVALID_ARGUMENT")
    const symbolArray = ["value"] as unknown[] & Record<PropertyKey, unknown>
    symbolArray[Symbol("hidden")] = "not JSON"
    assertErrorCode(() => api.addRecord({ root, kind: "decision", subject: "x", source: "agent", payload: symbolArray as never }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, kind: "decision", subject: "x", source: "agent", supersedes: null as never, payload: {} }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, id: "record-safe", kind: "decision", subject: "x", source: "agent", artifacts: ["_artifacts/decision/record-safe/../secret.txt"], payload: {} }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, id: "record-safe", kind: "decision", subject: "x", source: "agent", artifacts: ["_artifacts/decision/record-safe/bad:name.txt"], payload: {} }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, id: " record-safe", kind: "decision", subject: "x", source: "agent", payload: {} }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, id: "record-safe", kind: "decision", subject: " x", source: "agent", payload: {} }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, id: "record-safe", kind: "decision", subject: "x", source: "agent", artifacts: [" _artifacts/decision/record-safe/file.txt"], payload: {} }), "INVALID_ARGUMENT")
    assertErrorCode(() => api.addRecord({ root, id: "record-safe", kind: "decision", subject: "x", source: "agent", artifacts: ["_artifacts/decision/record-safe/cafe\u0301.txt"], payload: {} }), "INVALID_ARGUMENT")
  })

  test("reports malformed files without rewriting them", () => {
    const root = createRoot()
    const path = join(root, "encephalon", "decision", "wrong-name.json")
    ensureParent(path)
    const original = JSON.stringify({
      id: "actual-id",
      kind: "decision",
      subject: "broken",
      source: "manual",
      createdAt: "2026-08-06T10:00:00.000Z",
      payload: {},
    })
    writeFileSync(path, original)

    const result = api.validateRecords({ root })
    assert.equal(result.valid, false)
    assert.equal(result.errors.some((error) => error.code === "RECORD_PATH_MISMATCH"), true)
    assert.equal(readFileSync(path, "utf8"), original)
  })

  test("discovers a worktree-style git root and rejects an invalid explicit root", () => {
    const root = createRoot()
    const nested = join(root, "packages", "app")
    mkdirSync(nested, { recursive: true })
    assert.equal(discoverRepository({ start: nested }), realpathSync.native(root))
    assertErrorCode(() => discoverRepository({ root: join(root, "packages") }), "INVALID_REPOSITORY")
  })

  test("rejects execution when the package is not installed at the repository root", () => {
    const root = createRoot()
    rmSync(join(root, "node_modules", "encephalon"), { recursive: true })
    assertErrorCode(() => api.prepare({ root }), "ROOT_INSTALL_REQUIRED")
  })
})
