# Bounded Cache Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every untrusted SQLite cache-integrity read count-, type-, and byte-bounded before text materialisation, then quarantine and rebuild one exact corrupt cache generation at most once.

**Architecture:** A dependency-free canonical-budget module supplies the 1,000-record, 1 MiB-per-record, and 8 MiB corpus authorities without deepening the cache/records cycle. `src/cache.ts` owns two-phase numeric probes followed by bounded text iteration in one verified SQLite transaction, then one central recovery coordinator quarantines the captured database identity and retries once.

**Tech Stack:** TypeScript 7, Node.js 24.15+ built-in `node:sqlite`, Bun 1.3.1 scripts, Node test runner, existing cache-location quarantine and operation-lock authorities.

## Global Constraints

- Preserve public TypeScript input/result shapes, package exports, CLI behaviour, cache schema, and canonical files.
- The canonical authorities are exactly 1,000 records, 1 MiB per canonical record file, and 8 MiB aggregate canonical JSON.
- Cached `record_json` may use at most 4 KiB fixed runtime-path overhead per record: 1 MiB + 4 KiB per row and 12 MiB aggregate.
- Every hostile-table probe must aggregate over an inner `LIMIT maximum + 1`; a limit applied after `COUNT(*)` is forbidden.
- Measure complete stored text with `length(CAST(value AS BLOB))`, including bytes after embedded NUL.
- Probe result rows contain only bounded counts and exact `0 | 1` flags; never return hostile stored integers or byte lengths to JavaScript.
- Text iteration occurs only after the corresponding numeric probe succeeds, inside the same SQLite transaction.
- Quarantine and recovery use captured no-follow database/sidecar identities under the operation lock; retry the original operation once and rebuild at most once.
- Valid `CACHE_SCOPE_MISMATCH`, repository changes, contention, and operational I/O retain their existing fail-closed classifications.
- Schema semantics remain MAR-2553; FTS text equality remains MAR-2550; cache-generation memoisation remains MAR-2552.
- Tests must generate oversized values and row sets in SQLite, not as large JavaScript strings or arrays.
- Keep `bunfig.toml` exact with `telemetry = false`, `install.exact = true`, and `install.saveTextLockfile = true`; `bun.lock` remains plaintext JSON.

---

### Task 1: Bound canonical limits, schema reads, and metadata reads

**Files:**
- Create: `src/canonical-budgets.ts`
- Modify: `src/schema.ts:7-16`
- Modify: `src/records.ts:270-278`
- Modify: `src/cache.ts:45-270`
- Modify: `src/cache.ts:450-585`
- Test: `test/cache.test.ts:2490-2555`

**Interfaces:**
- Consumes: existing `CacheSchemaMismatch`, `DatabaseSync`, `METADATA_KEYS`, `cacheReadTestHooks`, `parseCacheJson`, and cache schema expectations.
- Produces: `CANONICAL_BUDGETS`; unchanged internal aliases `MAX_RECORD_BYTES`, `MAX_CANONICAL_RECORDS`, and `MAX_CANONICAL_RECORD_BYTES`; `readIntegrityProbe`; bounded schema and metadata validation; internal `afterIntegrityProbe` and `beforeIntegrityTextRead` hooks used by later tasks.

- [ ] **Step 1: Add focused failing metadata and schema tests**

Extend `CacheReadTestHooks` imports already used by `test/cache.test.ts` and add a helper that records only probe names/row counts and text-read names. Add one table-driven test with these corrupt cache generations:

```ts
test('bounds schema and metadata before transferring untrusted text', () => {
  const cases = [
    {
      name: 'seventh metadata row',
      mutate: (database: DatabaseSync) => {
        database.exec(`
          CREATE TABLE replacement_metadata(key TEXT, value TEXT);
          INSERT INTO replacement_metadata SELECT key, value FROM metadata;
          DROP TABLE metadata;
          ALTER TABLE replacement_metadata RENAME TO metadata;
          INSERT INTO metadata(key, value) VALUES ('duplicate', 'private-metadata-sentinel');
        `)
      },
      expectedProbe: { name: 'metadata', rows: 7 },
    },
    {
      name: 'oversized metadata value containing NUL',
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE metadata SET value = CAST(zeroblob(?) AS TEXT) WHERE key = 'manifest'")
          .run(1024 * 1024 + 1)
      },
      expectedProbe: { name: 'metadata', rows: 6 },
    },
  ]
  // For each case: prepare once, assert one canonical record after rebuild,
  // assert expected numeric probe, and assert no corrupt-generation metadata text-read hook.
})
```

Extend the existing metadata-value cases with canonical control `'1'` and rejected encodings `'-1'`, `'1.5'`, `'1e0'`, `'01'`, `' 1'`, `'1 '`, an SQLite BLOB, and `'1001'`. Assert every rejected value rebuilds to the one canonical record and never appears in a public error.

- [ ] **Step 2: Run the focused tests and witness RED**

Run:

```bash
node --test --test-name-pattern='bounds schema and metadata|canonical recordsIndexed' test/cache.test.ts
```

Expected: FAIL because the numeric/text hooks do not exist, metadata still uses unbounded `.all()`, and `Number(recordsIndexed)` accepts noncanonical encodings.

- [ ] **Step 3: Add the dependency-free canonical authority**

Create `src/canonical-budgets.ts`:

```ts
/** @internal */
export const CANONICAL_BUDGETS = Object.freeze({
  recordBytes: 1024 * 1024,
  recordJsonBytes: 8 * 1024 * 1024,
  records: 1000,
} as const)
```

Derive the existing internal aliases in `src/schema.ts` and `src/records.ts` from these fields. Do not export the authority from `src/index.ts`.

- [ ] **Step 4: Implement a bounded numeric-probe authority in `src/cache.ts`**

Add exact internal types:

```ts
type CacheIntegrityProbeName =
  | 'metadata'
  | 'metadata-columns'
  | 'records'
  | 'records-columns'
  | 'record-search'
  | 'record-search-columns'
  | 'record-search-schema'

type CacheIntegrityProbe = {
  exceeds_aggregate_bytes?: unknown
  has_invalid_type?: unknown
  has_oversized_value?: unknown
  row_count?: unknown
}

type CacheIntegrityObservation = {
  exceedsAggregateBytes: 0 | 1
  hasInvalidType: 0 | 1
  hasOversizedValue: 0 | 1
  name: CacheIntegrityProbeName
  rows: number
}
```

Extend `CacheReadTestHooks` with:

```ts
afterIntegrityProbe?: ((observation: CacheIntegrityObservation) => void) | undefined
beforeIntegrityTextRead?: ((name: CacheIntegrityProbeName) => void) | undefined
```

Implement `readIntegrityProbe(name, row, maximumRows)` to accept only a safe integer from `0..maximumRows` and exact `0 | 1` flags. Any other result throws a fixed `CacheSchemaMismatch` without including values.

- [ ] **Step 5: Replace schema and metadata `.all()` reads with two-phase validation**

For each expected table, use a numeric aggregate over `SELECT name FROM pragma_table_info(?) LIMIT expected + 1`, then iterate at most `expected + 1` bounded names only on success. Probe `sqlite_master.sql` with `LIMIT 2` and a 4 KiB BLOB-byte maximum before reading its one text value. Preserve the current ordered column-name and FTS5 regex semantics.

For metadata, probe at most seven rows with these guarantees before `.iterate()`:

```sql
SELECT
  COUNT(*) AS row_count,
  CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
  CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value,
  CASE WHEN TOTAL(value_bytes) > ? THEN 1 ELSE 0 END AS exceeds_aggregate_bytes
FROM (
  SELECT
    CASE WHEN typeof(key) = 'text' AND typeof(value) = 'text' THEN 0 ELSE 1 END AS invalid_type,
    CASE WHEN typeof(key) = 'text' AND length(CAST(key AS BLOB)) <= ?
               AND typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ?
         THEN 0 ELSE 1 END AS oversized,
    CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ?
         THEN length(CAST(value AS BLOB)) ELSE 0 END AS value_bytes
  FROM metadata
  LIMIT ?
)
```

Require fewer than seven rows before `beforeIntegrityTextRead('metadata')`, then iterate `LIMIT 7`. Require exactly six known keys. Parse `recordsIndexed` only after matching `^(?:0|[1-9]\d*)$`, and enforce `0..CANONICAL_BUDGETS.records`. Keep each metadata value at 1 MiB and aggregate values at 6 MiB.

- [ ] **Step 6: Run focused and affected GREEN checks**

Run:

```bash
node --test --test-name-pattern='bounds schema and metadata|canonical recordsIndexed|invalid cache metadata|incompatible table schema' test/cache.test.ts
bun run lint
bun run typecheck
```

Expected: focused tests pass, lint reports no changes, and all four TypeScript projects pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/canonical-budgets.ts src/schema.ts src/records.ts src/cache.ts test/cache.test.ts
git commit -m "[MAR-2549] Bound cache metadata validation"
```

---

### Task 2: Bound record and FTS validation within one verified snapshot

**Files:**
- Modify: `src/cache.ts:285-355`
- Modify: `src/cache.ts:585-675`
- Modify: `src/cache.ts:930-1010`
- Modify: `src/cache.ts:1190-1325`
- Test: `test/cache.test.ts:2310-2585`

**Interfaces:**
- Consumes: `CANONICAL_BUDGETS`, `readIntegrityProbe`, `CacheIntegrityProbeName`, `openVerifiedCacheDatabase`, `parseCachedRecord`, existing record/FTS consistency checks, and Task 1 hooks.
- Produces: `readVerifiedCacheTransaction<Result>(location, read)`; bounded record and FTS preflights; transaction-consistent validation plus actual public read; unchanged public list/show/search/gather results.

- [ ] **Step 1: Add focused failing record and FTS overflow tests**

Use recursive SQL CTEs rather than JavaScript arrays:

```ts
database.exec(`
  WITH RECURSIVE generated(value) AS (
    SELECT 1
    UNION ALL
    SELECT value + 1 FROM generated WHERE value < 1001
  )
  INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
  SELECT
    printf('overflow-%04d', value), 'context', 'cache.overflow', 'test',
    '2026-08-16T00:00:00.000Z', printf('encephalon/context/overflow-%04d.json', value),
    1, NULL, '{}'
  FROM generated;
`)
```

Add complementary cases for:

- 1,001 record rows: `records` probe reports 1,001 and no record text-read hook fires;
- 1,001 FTS rows: `record-search` probe reports 1,001 and no FTS relationship query runs;
- one `record_json = CAST(zeroblob(1052673) AS TEXT)`;
- one FTS `text = CAST(zeroblob(1052673) AS TEXT)`;
- individually bounded record rows with aggregate `record_json` above `12 * 1024 * 1024`;
- `active = 9223372036854775807`, FTS integer ID, and FTS BLOB ID, all rebuilding without exposing `ERR_OUT_OF_RANGE`.

Each test calls `prepare({ root })`, expects one rebuilt canonical record, asserts the numeric probe, and asserts no corrupt-generation text-materialisation hook.

- [ ] **Step 2: Add a failing snapshot-race test**

During `afterIntegrityProbe` for records, open a second `DatabaseSync` connection to the cache in WAL mode, update the current record to a different valid bounded JSON generation, and commit. Assert the operation either sees the original complete snapshot or retries/rebuilds; it must never combine the original numeric probe with successor text. Record the exact returned ID/generation rather than relying on timing or sleep.

- [ ] **Step 3: Run the focused tests and witness RED**

Run:

```bash
node --test --test-name-pattern='bounds cached record|bounds FTS|pins cache validation' test/cache.test.ts
```

Expected: FAIL because record rows still materialise with `.all()`, FTS lacks type/byte probes, hostile integers can escape Node conversion, and freshness validation is not uniformly transaction-pinned.

- [ ] **Step 4: Implement record and FTS numeric preflights**

Define cache-specific bounds:

```ts
const MAX_CACHE_RECORD_OVERHEAD_BYTES = 4096
const MAX_CACHE_RECORD_BYTES = CANONICAL_BUDGETS.recordBytes + MAX_CACHE_RECORD_OVERHEAD_BYTES
const MAX_CACHE_RECORD_JSON_BYTES =
  CANONICAL_BUDGETS.recordJsonBytes + CANONICAL_BUDGETS.records * MAX_CACHE_RECORD_OVERHEAD_BYTES
const MAX_CACHE_RECORD_TEXT_BYTES = MAX_CACHE_RECORD_JSON_BYTES * 2
const MAX_CACHE_FTS_ID_BYTES = CANONICAL_BUDGETS.records * 255
```

Probe `records` through an inner `LIMIT 1001`. Return only row count and flags proving expected SQLite types, `active` integer membership in `0 | 1`, per-column sizes, per-row `record_json <= MAX_CACHE_RECORD_BYTES`, aggregate JSON `<= MAX_CACHE_RECORD_JSON_BYTES`, and aggregate denormalised text `<= MAX_CACHE_RECORD_TEXT_BYTES`. Reject before `beforeIntegrityTextRead('records')`, then iterate at most 1,001 rows and retain existing semantic comparisons.

Probe `record_search` through an inner `LIMIT 1001`. Prove both columns are text, each ID is at most 255 bytes, each text is at most `MAX_CACHE_RECORD_BYTES`, aggregate IDs are at most `MAX_CACHE_FTS_ID_BYTES`, and aggregate text is at most `MAX_CACHE_RECORD_JSON_BYTES`. Only then run the current distinct/missing/orphan relationship checks. Do not compare FTS text semantics.

- [ ] **Step 5: Move validation and actual reads into one verified transaction**

Replace `openReaderDatabase`, `readFreshDatabase`, and duplicated transaction handling with:

```ts
const readVerifiedCacheTransaction = <Result>(
  location: CacheLocation,
  read: (database: DatabaseSync) => Result,
): Result => {
  let result: Result | undefined
  const database = openVerifiedCacheDatabase({
    afterVerifiedOpen: opened => {
      opened.exec('BEGIN')
      try {
        assertCacheSchema(opened)
        result = read(opened)
        opened.exec('ROLLBACK')
      } catch (error) {
        try {
          opened.exec('ROLLBACK')
        } catch {
          // Preserve the original validation/read error.
        }
        throw error
      }
    },
    create: false,
    DatabaseConstructor: loadSQLite().DatabaseSync,
    location,
    missing: () => {
      throw new CacheSchemaMismatch('The cache database disappeared before it was opened.')
    },
    name: 'brain.sqlite',
    openOptions: { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MILLISECONDS },
  })
  database.close()
  if (result === undefined) {
    return fail('INTERNAL_ERROR', 'The verified cache read returned no result.')
  }
  return result
}
```

Use a private sentinel rather than `undefined` if a legitimate operation result may be undefined. Make `readFreshMetadata`, normal prepared reads, and gather reads call this helper so schema/content validation and actual result production share the transaction and captured database identity.

- [ ] **Step 6: Run focused, cache, lint, and type checks**

Run:

```bash
node --test --test-name-pattern='bounds cached record|bounds FTS|pins cache validation|invalid cached row JSON|missing and duplicate FTS' test/cache.test.ts
node --test test/cache.test.ts
bun run lint
bun run typecheck
```

Expected: focused tests pass; the complete cache suite passes; lint and all TypeScript projects pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/cache.ts test/cache.test.ts
git commit -m "[MAR-2549] Bound cache record validation"
```

---

### Task 3: Quarantine one exact corrupt generation and retry once

**Files:**
- Modify: `src/cache.ts:145-175`
- Modify: `src/cache.ts:740-970`
- Modify: `src/cache.ts:930-1010`
- Modify: `src/cache.ts:1260-1335`
- Test: `test/cache.test.ts:2360-2585`
- Test: `test/sqlite-policy.test.ts:35-125`

**Interfaces:**
- Consumes: `CacheDatabaseFailure.database`, `isRecoverableCacheFailure`, `quarantineCacheDatabase`, `withOperationLock`, `rebuildCache`, `readVerifiedCacheTransaction`, and existing public error wrapping.
- Produces: one private `recoverDisposableCacheOnce` authority shared by prepare/list/show/search/gather; exact quarantine for validation corruption; stable one-rebuild/one-retry behaviour; bounded privacy-preserving terminal errors.

- [ ] **Step 1: Add failing exact-recovery and privacy tests**

Add one representative `listRecords` corruption test that:

- creates an oversized `record_json` inside SQLite with a short private sentinel concatenated after an embedded NUL;
- counts `beforeQuarantineRename` for `brain.sqlite` and `duringDatabaseInitialisation('writer')`;
- expects exactly one primary quarantine, one writer rebuild, and one canonical returned record.

Add a recovery-failure test that injects one `EIO` during writer initialisation. Assert:

```ts
assert.throws(() => listRecords({ root }), (error: unknown) => {
  const publicError = error as { cause?: unknown; code?: unknown; details?: unknown; message?: unknown }
  assert.ok(publicError.code === 'IO_ERROR' || publicError.code === 'INTERNAL_ERROR')
  assert.doesNotMatch(JSON.stringify({
    cause: publicError.cause instanceof Error ? publicError.cause.message : publicError.cause,
    details: publicError.details ?? null,
    message: publicError.message,
  }), /private-cache-sentinel/)
  return true
})
assert.equal(writerAttempts, 1)
assert.equal(resultsServed, 0)
```

Add a valid foreign `repositoryRealpath` test asserting `CACHE_SCOPE_MISMATCH`, zero quarantine calls, and zero writer rebuilds.

- [ ] **Step 2: Run the focused tests and witness RED**

Run:

```bash
node --test --test-name-pattern='quarantines one exact corrupt cache|bounds failed cache recovery|does not quarantine a foreign cache' test/cache.test.ts
```

Expected: FAIL because content `CacheSchemaMismatch` is rebuilt in place, prepare and read layers own separate recovery paths, and failure counts are not centrally bounded.

- [ ] **Step 3: Implement central exact-generation recovery**

Add:

```ts
const recoverDisposableCacheOnce = (
  root: string,
  location: CacheLocation,
  failure: unknown,
): PrepareResult => {
  if (!isRecoverableCacheFailure(failure)) {
    throw failure
  }
  return withOperationLock(
    root,
    captured => {
      if (failure instanceof CacheDatabaseFailure) {
        quarantineCacheDatabase(captured, failure.database)
      } else {
        throw failure
      }
      return rebuildCache(root, captured)
    },
    {},
    location,
  )
}
```

All schema/content validation failures should now arrive as `CacheDatabaseFailure` because Task 2 runs them inside `openVerifiedCacheDatabase.afterVerifiedOpen`. Preserve valid `EncephalonError` values such as `CACHE_SCOPE_MISMATCH` before recoverability checks.

- [ ] **Step 4: Consolidate prepare and read retry ownership**

Make prepare, ordinary reads, and gather use one shared operation shape:

```ts
const runWithDisposableCacheRecovery = <Result>(
  root: string,
  location: CacheLocation,
  operation: () => Result,
): Result => {
  try {
    return operation()
  } catch (failure) {
    if (failure instanceof EncephalonError || !isRecoverableCacheFailure(failure)) {
      throw failure
    }
    recoverDisposableCacheOnce(root, location, failure)
    return operation()
  }
}
```

The retry call must be outside another recovery wrapper. If it fails, propagate it to the existing public `wrapIo` boundary without another quarantine or rebuild. Remove duplicate prepare/gather recovery branches and any now-dead in-place corruption cleanup helper. Hydrate remains an explicit rebuild operation rather than a retry wrapper.

- [ ] **Step 5: Preserve error priority and retry policy tests**

Extend `test/sqlite-policy.test.ts` only where needed to prove:

- cache recovery still accepts corrupt/notadb/schema/readonly/cantopen categories;
- busy/locked/io/unknown remain terminal;
- a second recoverable validation failure does not cause a second rebuild;
- `CACHE_SCOPE_MISMATCH` remains terminal and unmodified.

- [ ] **Step 6: Run affected and full static checks**

Run:

```bash
node --test --test-name-pattern='quarantines one exact corrupt cache|bounds failed cache recovery|foreign cache|cache recovery accepts' test/cache.test.ts test/sqlite-policy.test.ts
node --test test/cache.test.ts test/sqlite-policy.test.ts test/errors.test.ts
bun run lint
bun run typecheck
```

Expected: all selected and affected tests pass; lint and all four TypeScript projects pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/cache.ts test/cache.test.ts test/sqlite-policy.test.ts
git commit -m "[MAR-2549] Recover exact corrupt cache generations"
```

---

### Task 4: Document the bounded cache contract and run release-equivalent gates

**Files:**
- Modify: `README.md`
- Modify: `docs/contract.md`
- Modify: `docs/superpowers/specs/2026-08-16-bounded-cache-validation-design.md`
- Modify: `docs/superpowers/plans/2026-08-16-bounded-cache-validation.md`
- Modify: `test/package.test.ts`
- Create ignored report: `.superpowers/sdd/2026-08-16-bounded-cache-validation/task-report.md`

**Interfaces:**
- Consumes: exact Task 3 code/test commit SHA, completed behavioural evidence, existing maintained-contract provenance convention, and package documentation tests.
- Produces: current README/contract semantics, exact implementation provenance, completed plan evidence, release-gate report, and a clean ticket branch ready for the six-role review wave.

- [ ] **Step 1: Witness documentation provenance RED**

Extend `test/package.test.ts` to require a `## Bounded Disposable Cache Validation` contract section and the exact Task 3 code/test SHA in the maintained contract and design provenance. Run:

```bash
node --test test/package.test.ts
```

Expected: FAIL because the section and exact implementation provenance are absent.

- [ ] **Step 2: Update public and maintained documentation**

Document:

- numeric probes before text transfer;
- metadata 7-row observation ceiling and records/FTS 1,001-row observation ceilings;
- 1 MiB canonical record, 8 MiB canonical corpus, and fixed 4 KiB-per-record derived cache overhead;
- one verified transaction for validation plus read;
- exact-identity quarantine, one rebuild, and one retry;
- `CACHE_SCOPE_MISMATCH` and operational error policies;
- semantic-schema and FTS-equality exclusions assigned to MAR-2553 and MAR-2550.

Add the exact Task 3 SHA as the design's reviewed implementation/test provenance. Mark every completed plan checkbox and add concise RED/GREEN evidence beneath each task without changing historical requirements.

- [ ] **Step 3: Run documentation GREEN and Encephalon validation**

Run:

```bash
node --test test/package.test.ts
npx --no-install encephalon validate
```

Expected: package test passes. If the repository package still refuses self-root execution with `ROOT_INSTALL_REQUIRED`, record that established tooling limitation in the ignored report; do not inspect or edit Encephalon record JSON directly.

- [ ] **Step 4: Run the complete verification matrix**

Run sequentially:

```bash
bun run lint
bun run typecheck
bun run test
bun run benchmark
bun run benchmark:check
bun run build
bun run check:package
bun run check:publish
bun install --frozen-lockfile
git diff --check origin/main...HEAD
```

Expected: lint passes; all four TypeScript projects pass; full tests have zero failures with only established capability skips; both benchmarks pass; build/package pass; publish-contract exits zero with the expected already-published `0.2.0` refusal; frozen install changes nothing; diff check is clean.

- [ ] **Step 5: Audit package, declarations, Bun files, and scope**

Verify:

```bash
git diff --exit-code origin/main...HEAD -- bunfig.toml bun.lock package.json
rg -n "CANONICAL_BUDGETS|CacheIntegrityProbe|afterIntegrityProbe|beforeIntegrityTextRead" dist/index.d.ts
git status --short
```

Expected: Bun/package diff is empty; no internal budget/probe/hook symbol appears in public declarations; the tracked worktree contains only intentional ticket changes; `bun.lock` remains plaintext JSON.

- [ ] **Step 6: Write the ignored task report**

Record exact branch/base/merge-base, commits, RED/GREEN commands, test counts, benchmark results, release gates, declaration/config audits, scope exclusions, and any platform capability skips in `.superpowers/sdd/2026-08-16-bounded-cache-validation/task-report.md`. Confirm it remains ignored with `git check-ignore`.

- [ ] **Step 7: Commit Task 4**

```bash
git add README.md docs/contract.md docs/superpowers/specs/2026-08-16-bounded-cache-validation-design.md docs/superpowers/plans/2026-08-16-bounded-cache-validation.md test/package.test.ts
git commit -m "[MAR-2549] Document bounded cache validation"
```

- [ ] **Step 8: Prepare the branch review package without merging**

Create the PR from the exact Linear branch, keep it unmerged, and provide the base SHA, head SHA, diff, plan, spec, report, and acceptance criteria to six parallel GPT-5.6 Terra reviewers: security, correctness, data/race, tests, maintainability, and UX/API. Apply no more than three review waves, fix all high/medium-confidence findings, rerun affected/full gates, perform the main-thread SoC/tidy/docs audit, and leave the reviewed PR open until every ticket in the supplied sequence is complete.
