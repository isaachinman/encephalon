import { afterEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
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

const functionFromApi = <T>(name: string) => (api as unknown as Record<string, T>)[name] as T

describe("SQLite cache and reads", () => {
  test("prepares an empty repository before a cache directory exists", () => {
    const root = createRoot()
    const prepare = functionFromApi<(input: Record<string, unknown>) => { hydrated: boolean; recordsIndexed: number }>("prepare")
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test("automatically prepares active list, show, search, compact search, and gather reads", () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>("addRecord")
    const first = addRecord({
      root,
      id: "database-v1",
      kind: "decision",
      subject: "backend.database",
      source: "agent",
      payload: { summary: "Use a remote database", detail: "database storage" },
    })
    const second = addRecord({
      root,
      id: "database-v2",
      kind: "decision",
      subject: "backend.database",
      source: "agent",
      supersedes: [first.id],
      payload: { summary: "Use SQLite", detail: "local database storage" },
      searchText: "portable persistence",
    })

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Array<Record<string, unknown>>>("listRecords")
    assert.deepEqual(listRecords({ root }).map((record) => record.id), [second.id])
    assert.deepEqual(listRecords({ root, includeSuperseded: true }).map((record) => record.id), [second.id, first.id])

    const showRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown> | null>("showRecord")
    assert.equal(showRecord({ root, id: first.id, activeOnly: true }), null)
    assert.equal(showRecord({ root, id: first.id })?.id, first.id)

    const searchRecords = functionFromApi<(input: Record<string, unknown>) => Array<Record<string, unknown>>>("searchRecords")
    assert.deepEqual(searchRecords({ root, query: "database/storage" }).map((record) => record.id), [second.id])
    assert.deepEqual(searchRecords({ root, query: "   " }), [])

    const searchCompactRecords = functionFromApi<(input: Record<string, unknown>) => Array<Record<string, unknown>>>("searchCompactRecords")
    const compact = searchCompactRecords({ root, query: "portable persistence" })
    assert.deepEqual(Object.keys(compact[0] ?? {}).sort(), ["id", "kind", "path", "rank", "snippet", "subject", "summary"])
    assert.equal(compact[0]?.summary, "Use SQLite")
    assert.match(String(compact[0]?.snippet), /\[(portable|persistence)\]/i)
    assert.equal(compact[0]?.path, "encephalon/decision/database-v2.json")

    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>("gatherRecords")
    const gathered = gatherRecords({
      root,
      searches: ["SQLite", "SQLite"],
      shows: [second.id, first.id, "missing", second.id],
    }) as {
      hydrated: { recordsIndexed: number } | null
      searches: Array<{ query: string; results: Array<{ id: string }> }>
      records: Array<{ id: string; record: { id: string } | null }>
    }
    assert.deepEqual(gathered.searches.map((entry) => entry.query), ["SQLite", "SQLite"])
    assert.equal((gathered as { hydrated?: unknown }).hydrated, null)
    assert.deepEqual(gathered.records.map((entry) => [entry.id, entry.record?.id ?? null]), [
      [second.id, second.id],
      [first.id, null],
      ["missing", null],
      [second.id, second.id],
    ])
    assert.deepEqual(gatherRecords({ root, hydrate: true }), {
      hydrated: { recordsIndexed: 2 },
      searches: [],
      records: [],
    })

    functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>("addRecord")({
      root,
      id: "without-summary",
      kind: "context",
      subject: "no.summary",
      source: "agent",
      payload: { detail: "searchable marker" },
    })
    assert.equal(searchCompactRecords({ root, query: "searchable marker" })[0]?.summary, null)
  })

  test("tracks record and referenced-artifact freshness", () => {
    const root = createRoot()
    const id = "architecture-with-artifact"
    const artifact = `_artifacts/architecture/${id}/diagram.svg`
    const artifactPath = join(root, "encephalon", ...artifact.split("/"))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, "<svg>one</svg>")

    functionFromApi<(input: Record<string, unknown>) => unknown>("addRecord")({
      root,
      id,
      kind: "architecture",
      subject: "system.overview",
      source: "agent",
      artifacts: [artifact],
      payload: { summary: "System overview" },
    })
    const prepare = functionFromApi<(input: Record<string, unknown>) => { hydrated: boolean; recordsIndexed: number }>("prepare")
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 1 })

    const recordPath = join(root, "encephalon", "architecture", `${id}.json`)
    writeFileSync(recordPath, `${readFileSync(recordPath, "utf8")} `)
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 1 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 1 })

    writeFileSync(artifactPath, "<svg>two</svg>")
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 1 })
  })

  test("does not serve a preserved stale cache after canonical validation fails", () => {
    const root = createRoot()
    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>("addRecord")({
      root,
      id: "valid-before-corruption",
      kind: "context",
      subject: "repository.overview",
      source: "agent",
      payload: { summary: "Valid" },
    })
    const listRecords = functionFromApi<(input: Record<string, unknown>) => Array<Record<string, unknown>>>("listRecords")
    assert.equal(listRecords({ root }).length, 1)
    writeFileSync(join(root, String(record.path)), "{not-json")

    assert.throws(() => listRecords({ root }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "VALIDATION_FAILED")
      return true
    })
  })

  test("rebuilds a corrupt disposable cache", () => {
    const root = createRoot()
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>("prepare")
    prepare({ root })
    writeFileSync(join(root, "node_modules", ".cache", "encephalon", "brain.sqlite"), "not a sqlite database")

    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test("rebuilds a disposable cache with an incompatible table schema", () => {
    const root = createRoot()
    const cachePath = join(root, "node_modules", ".cache", "encephalon", "brain.sqlite")
    mkdirSync(join(root, "node_modules", ".cache", "encephalon"), { recursive: true })
    const database = new DatabaseSync(cachePath)
    database.exec("CREATE TABLE metadata (wrong_column TEXT)")
    database.close()

    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>("prepare")
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test("recovers an ownerless or malformed operation lock", () => {
    const root = createRoot()
    const lockPath = join(root, "node_modules", ".cache", "encephalon", "operation.lock")
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, "owner.json"), "not-json")
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>("prepare")
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
  })

  test("serialises two contenders that both observed the same stale lock", async () => {
    const root = createRoot()
    const cachePath = join(root, "node_modules", ".cache", "encephalon")
    const lockPath = join(cachePath, "operation.lock")
    const releasePath = join(root, "release-contenders")
    const activePath = join(root, "active-contender")
    const firstObserved = join(root, "first-observed")
    const secondObserved = join(root, "second-observed")
    const firstEntered = join(root, "first-entered")
    const secondEntered = join(root, "second-entered")
    const deadProcess = spawnSync(process.execPath, ["-e", ""])
    const deadPid = deadProcess.pid
    assert.equal(deadProcess.status, 0)
    assert.ok(deadPid !== undefined)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      token: "dead-owner",
      pid: deadPid,
      acquiredAt: "2026-08-06T10:00:00.000Z",
    })}\n`)

    const fixture = join(import.meta.dirname, "fixtures", "contend-for-stale-lock.ts")
    const first = spawn(process.execPath, [
      fixture,
      root,
      firstObserved,
      releasePath,
      activePath,
      firstEntered,
      "0",
    ], { stdio: "inherit" })
    const second = spawn(process.execPath, [
      fixture,
      root,
      secondObserved,
      releasePath,
      activePath,
      secondEntered,
      "75",
    ], { stdio: "inherit" })

    const deadline = Date.now() + 5_000
    while (
      (!existsSync(firstObserved) || !existsSync(secondObserved)) &&
      first.exitCode === null &&
      second.exitCode === null &&
      Date.now() < deadline
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    assert.equal(existsSync(firstObserved), true)
    assert.equal(existsSync(secondObserved), true)
    writeFileSync(releasePath, "release")

    if (first.exitCode === null) await once(first, "exit")
    if (second.exitCode === null) await once(second, "exit")
    assert.equal(first.exitCode, 0)
    assert.equal(second.exitCode, 0)
    assert.equal(existsSync(firstEntered), true)
    assert.equal(existsSync(secondEntered), true)
    assert.equal(existsSync(join(cachePath, "operation-lock.sqlite")), true)
  })

  test("rejects a symlinked canonical root without traversing it", {
    skip: process.platform === "win32" ? "Windows runners may not permit directory symlink creation." : false,
  }, () => {
    const root = createRoot()
    const target = createRoot()
    symlinkSync(target, join(root, "encephalon"), "dir")
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>("prepare")
    assert.throws(() => prepare({ root }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "VALIDATION_FAILED")
      return true
    })
  })

  test("serialises cache mutations across processes", async () => {
    const root = createRoot()
    const readyPath = join(root, "lock-ready")
    const holder = spawn(process.execPath, [
      join(import.meta.dirname, "fixtures", "hold-operation-lock.ts"),
      root,
      readyPath,
    ], { stdio: "inherit" })
    const deadline = Date.now() + 5_000
    while (!existsSync(readyPath) && holder.exitCode === null && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    assert.equal(existsSync(readyPath), true)

    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>("addRecord")({
      root,
      id: "added-after-external-lock",
      kind: "context",
      subject: "cache.locking",
      source: "test",
      payload: { summary: "Cross-process serialisation" },
    })
    assert.equal(record.id, "added-after-external-lock")
    if (holder.exitCode === null) await once(holder, "exit")
    assert.equal(holder.exitCode, 0)
  })

  test("rejects a cache shared by two repository realpaths", () => {
    const firstRoot = createRoot()
    const secondRoot = createRoot()
    functionFromApi<(input: Record<string, unknown>) => unknown>("addRecord")({
      root: firstRoot,
      id: "first-scope-record",
      kind: "context",
      subject: "repository.scope",
      source: "agent",
      payload: { summary: "First repository" },
    })

    rmSync(join(secondRoot, "node_modules"), { recursive: true })
    symlinkSync(join(firstRoot, "node_modules"), join(secondRoot, "node_modules"), "dir")
    const listRecords = functionFromApi<(input: Record<string, unknown>) => unknown>("listRecords")
    assert.throws(() => listRecords({ root: secondRoot }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "CACHE_SCOPE_MISMATCH")
      return true
    })
  })
})
