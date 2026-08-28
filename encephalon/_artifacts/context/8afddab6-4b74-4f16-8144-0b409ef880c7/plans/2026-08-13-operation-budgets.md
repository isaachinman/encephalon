# Operation Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralise fixed operation budgets and reject over-limit result counts and arrays before item validation, repository discovery, or cache work.

**Architecture:** A dependency-free `src/operation-budgets.ts` owns immutable budget specifications. API/schema parsers enforce them first, cache execution retains matching defensive checks, and CLI/help/package/docs consume the same values without expanding the public export surface.

**Tech Stack:** TypeScript ESM, Node 24 test runner, Bun scripts, SQLite cache integration.

## Global Constraints

- Full list and full search accept result limits from 1 through 50; compact search and gather accept 1 through 100; all keep a default of 20.
- Gather accepts at most 16 searches and 64 shows; supersedes accepts at most 1,000 entries before item validation.
- Existing query limits remain 1,024 UTF-8 bytes and 32 literal terms; existing full-response limit remains 4 MiB.
- Every budget failure is `INVALID_ARGUMENT` with bounded details `{ field, budget, maximum }` and no input contents.
- Stable budget names are `fullResultLimit`, `compactResultLimit`, `queryBytes`, `queryTerms`, `gatherSearches`, `gatherShows`, `fullResponseBytes`, and `supersessionEdges`.
- Public TypeScript input/result shapes and `src/index.ts` exports do not change.
- Cache assertions remain as defence in depth and use the same specifications as parsing.
- Use ordinary dense arrays in tests; sparse/accessor/proxy behaviour remains MAR-2572 scope.
- `bunfig.toml` retains `telemetry = false`, `[install] exact = true`, and `saveTextLockfile = true`; `bun.lock` remains plaintext and unchanged.
- Commit titles use `[MAR-2561] Plain English title` with British English prose.

---

### Task 1: Establish the authority and operation-specific API parsing

**Files:**
- Create: `src/operation-budgets.ts`
- Modify: `src/errors.ts`
- Modify: `src/api-input.ts`
- Create: `test/api-input.test.ts`

**Interfaces:**
- Produces: `OPERATION_BUDGETS` with the exact keys and values in the design.
- Produces: `failBudget(field: string, budget: string, maximum: number, message: string): never` in `src/errors.ts`.
- Produces: `parseFullSearchRecordsInput(value): SearchRecordsInput` and `parseCompactSearchRecordsInput(value): SearchRecordsInput` backed by one private common parser.
- Consumes: existing `fail('INVALID_ARGUMENT', ...)`; no imports are permitted in `src/operation-budgets.ts`.

- [ ] **Step 1: Write the failing authority/parser test**

Create `test/api-input.test.ts` with a table that imports the wished-for `OPERATION_BUDGETS`, `parseListRecordsInput`, `parseFullSearchRecordsInput`, `parseCompactSearchRecordsInput`, and `parseGatherInput`. Use literal expectations:

```ts
const limitCases = [
  { accept: 50, budget: 'fullResultLimit', maximum: 50, parse: () => parseListRecordsInput({ limit: 50 }) },
  {
    accept: 50,
    budget: 'fullResultLimit',
    maximum: 50,
    parse: () => parseFullSearchRecordsInput({ limit: 50, query: 'x' }),
  },
  {
    accept: 100,
    budget: 'compactResultLimit',
    maximum: 100,
    parse: () => parseCompactSearchRecordsInput({ limit: 100, query: 'x' }),
  },
  { accept: 100, budget: 'compactResultLimit', maximum: 100, parse: () => parseGatherInput({ limit: 100 }) },
] as const
```

For each case assert the exact maximum succeeds, maximum + 1 throws `INVALID_ARGUMENT`, and details equal `{ field: 'limit', budget, maximum }`. The literal behavioural expectations protect the authority's values; do not add a separate constant-value change-detector test.

Add dense oversized gather arrays whose first element is an ordinary invalid value:

```ts
assertBudget(
  () => parseGatherInput({ searches: [42, ...Array.from({ length: 16 }, () => 'x')] }),
  { budget: 'gatherSearches', field: 'searches', maximum: 16 },
)
assertBudget(
  () => parseGatherInput({ shows: ['not a valid id!', ...Array.from({ length: 64 }, () => 'valid-id')] }),
  { budget: 'gatherShows', field: 'shows', maximum: 64 },
)
```

- [ ] **Step 2: Run the focused test and witness RED**

Run: `node --test test/api-input.test.ts`

Expected: FAIL because `src/operation-budgets.ts` and the full/compact parser split do not exist, the generic parser accepts one-over limits, and gather validates invalid items before count budgets.

- [ ] **Step 3: Add the minimal authority and bounded error helper**

Create the import-free authority:

```ts
export const OPERATION_BUDGETS = {
  compactResultLimit: { default: 20, field: 'limit', maximum: 100, minimum: 1 },
  fullResponseBytes: { field: 'response', maximum: 4 * 1024 * 1024 },
  fullResultLimit: { default: 20, field: 'limit', maximum: 50, minimum: 1 },
  gatherSearches: { field: 'searches', maximum: 16 },
  gatherShows: { field: 'shows', maximum: 64 },
  queryBytes: { field: 'query', maximum: 1024 },
  queryTerms: { field: 'query', maximum: 32 },
  supersessionEdges: { field: 'supersedes', maximum: 1000 },
} as const
```

Add `failBudget` to `src/errors.ts` as the sole constructor for bounded budget details:

```ts
export const failBudget = (field: string, budget: string, maximum: number, message: string): never =>
  fail('INVALID_ARGUMENT', message, { budget, field, maximum })
```

Do not export either symbol from `src/index.ts`.

In `src/api-input.ts`:

- replace `optionalLimit(value)` with a private helper receiving either the full or compact budget spec;
- make `parseListRecordsInput` use full;
- split search into full/compact wrappers around a private common parser;
- make gather use compact;
- replace eager `optionalStringArray` use for gather with a helper that checks array shape and `length > maximum` before `.every` and `.map`, then validates items.

Every new failure uses `failBudget` with the exact names and details from Global Constraints.

- [ ] **Step 4: Run focused/static verification**

Run:

```bash
node --test test/api-input.test.ts
bun run lint
bun run typecheck
```

Expected: the focused parser test is GREEN; the new authority, error helper, and parsers compile and lint cleanly.

- [ ] **Step 5: Commit the authority and parser tests**

```bash
git add src/operation-budgets.ts src/errors.ts src/api-input.ts test/api-input.test.ts
git commit -m "[MAR-2561] Parse authoritative operation budgets"
```

### Task 2: Enforce record and cache budgets before repository access

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/records.ts`
- Modify: `test/cache.test.ts`
- Modify: `test/records.test.ts`

**Interfaces:**
- Consumes: `OPERATION_BUDGETS`, `failBudget` from Task 1.
- Consumes: operation-specific parsers from Task 1.
- Preserves: `validateAddRecordInput`, `parseRecordFile`, and public API type shapes.

- [ ] **Step 1: Add failing count-before-item-validation tests**

Add one `test/records.test.ts` public `addRecord` case with 1,001 supersedes whose first string is invalid. Set `repositoryTestHooks.afterGitMarkerDecision` to throw or increment a counter, then assert:

- the failure is `INVALID_ARGUMENT`;
- details equal `{ budget: 'supersessionEdges', field: 'supersedes', maximum: 1000 }`;
- neither the invalid ID text nor any array contents appear in message/details;
- repository hook count is zero and no `encephalon` or cache state exists.

Strengthen `assertBudgetError` in `test/cache.test.ts` to accept literal `field`, `budget`, and `maximum`, and assert all three. Keep existing exact/max+1 and no-cache cases; add 17-search and 65-show cases with an invalid first ordinary element so the count budget wins.

- [ ] **Step 2: Run focused tests and witness RED**

Run:

```bash
node --test --test-name-pattern="request budget boundaries|supersedes count" test/cache.test.ts test/records.test.ts
```

Expected: FAIL because supersedes has no per-record count guard and cache budget assertions do not yet consume all exact shared details.

- [ ] **Step 3: Implement supersedes count-before-map validation**

In `src/schema.ts`, extend the string-array path used for supersedes with the shared maximum. Both candidate input and canonical record parsing must check array length before `map(validateId)` or `new Set`. Leave artifacts' existing 256-before-map behaviour local.

In `src/records.ts`, remove the local numeric `MAX_SUPERSESSION_EDGES = 1000` definition and alias/import the shared `OPERATION_BUDGETS.supersessionEdges.maximum` so aggregate graph validation uses the same authority. Preserve the internal exported constant if tests or internal consumers import its name.

Every new failure uses `failBudget` with the exact names and details from Global Constraints.

- [ ] **Step 4: Retain cache defence-in-depth with the same values**

Update `src/cache.ts` to import the authority and split parser names. Remove local request/query/response numeric declarations while retaining internal exported compatibility aliases where existing internal tests consume them. Replace local `budgetFailure` with `failBudget` and make all defensive checks use the shared values.

Order remains parser/count checks, query checks, repository resolution, cache inspection, then SQLite work.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```bash
node --test --test-name-pattern="request budget boundaries|supersedes count" test/cache.test.ts test/records.test.ts
bun run lint
bun run typecheck
```

Expected: all selected tests pass; lint and all four TypeScript projects exit zero.

- [ ] **Step 6: Run affected suites and commit**

Run: `node --test test/api-input.test.ts test/cache.test.ts test/records.test.ts`

Expected: zero failures, with only established capability skips if any.

```bash
git add src/schema.ts src/records.ts src/cache.ts test/cache.test.ts test/records.test.ts
git commit -m "[MAR-2561] Reject oversized operations before mapping"
```

### Task 3: Align CLI and packed behaviour with the authority

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`
- Modify: `scripts/check-package.ts`

**Interfaces:**
- Consumes: `OPERATION_BUDGETS` only; CLI does not import cache internals.
- Produces: mode-specific CLI parsing/help and packed error behaviour.

- [ ] **Step 1: Write failing CLI/help tests**

Extend `test/cli.test.ts` so `--help` independently asserts literal fragments for:

- list limit `1..50`;
- full search limit `1..50`;
- compact search limit `1..100`;
- gather limit `1..100`, at most 16 searches, and at most 64 shows;
- add at most 1,000 supersedes.

Add a compact table using a real repository:

```ts
const cases = [
  { accepted: ['list', '--limit=50'], rejected: ['list', '--limit=51'], budget: 'fullResultLimit', maximum: 50 },
  { accepted: ['search', '--limit=50', 'x'], rejected: ['search', '--limit=51', 'x'], budget: 'fullResultLimit', maximum: 50 },
  { accepted: ['search', '--compact', '--limit=100', 'x'], rejected: ['search', '--compact', '--limit=101', 'x'], budget: 'compactResultLimit', maximum: 100 },
  { accepted: ['gather', '--limit=100'], rejected: ['gather', '--limit=101'], budget: 'compactResultLimit', maximum: 100 },
] as const
```

For accepted cases assert status 0. For rejected cases assert status 2 and exact JSON `{ field: 'limit', budget, maximum }`; derive expectations from literals, not imported constants.

Add two count-precedence CLI cases:

- 17 `--search` values where the first query would independently exceed the query-term budget must fail as `gatherSearches`/16;
- 1,001 `--supersedes` values combined with invalid `--data` JSON must fail as `supersessionEdges`/1,000 before payload parsing or API invocation.

Assert exact bounded details and absence of input contents.

- [ ] **Step 2: Run CLI tests and witness RED**

Run: `bun run build && node --test --test-name-pattern="help and version|operation-specific limit" test/cli.test.ts`

Expected: FAIL because help and CLI parsing still advertise/accept 1–1,000.

- [ ] **Step 3: Implement shared CLI parsing and help**

Import `OPERATION_BUDGETS` directly in `src/cli.ts`. Parameterise `parseLimit` with a budget key/spec and use `failBudget` so CLI/API details match. Select full for list and ordinary search; compact for `search --compact` and gather.

Interpolate numeric help values from the authority while keeping readable command-specific lines. Count repeated gather searches/shows and add supersedes before parsing payload or invoking public APIs; use the same budget failures. Do not change unrelated option parsing.

- [ ] **Step 4: Add packed behavioural checks**

In `scripts/check-package.ts`, capture packed `--help` once and assert the same literal fragments. Add a helper that runs an expected failing CLI command without the existing success-only `run` wrapper. Exercise packed `list --limit=51` and packed compact search `--limit=101`; assert exit 2 and exact structured details for the full and compact budgets.

- [ ] **Step 5: Verify and commit**

Run:

```bash
bun run build
node --test test/cli.test.ts
bun run lint
bun run typecheck
bun run check:package
```

Expected: all commands exit zero and packed source behaviour matches installed behaviour.

```bash
git add src/cli.ts test/cli.test.ts scripts/check-package.ts
git commit -m "[MAR-2561] Align CLI operation budgets"
```

### Task 4: Document, audit, and verify the complete branch

**Files:**
- Modify: `README.md`
- Modify: `docs/contract.md`
- Modify: `docs/superpowers/specs/2026-08-13-operation-budgets-design.md`
- Modify: `test/package.test.ts`

**Interfaces:**
- Consumes: exact code/test commit SHA from Tasks 1–3.
- Produces: maintained human contract and exact reviewed provenance; no runtime or public declaration changes.

- [ ] **Step 1: Add the provenance RED**

Extend the existing maintained-contract package test to require a concise operation-budget section and the exact Tasks 1–3 code/test SHA. Do not duplicate the entire schema in the test; assert the maintained section and exact provenance marker.

Run: `node --test test/package.test.ts`

Expected: FAIL because the maintained documentation and provenance are absent.

- [ ] **Step 2: Update maintained documentation**

Update README and `docs/contract.md` with the mode-specific 50/100 result limits, 16/64 gather input counts, 1,000 supersedes input count, fixed query/full-response budgets, bounded error details, and count-before-item-validation/no-I/O guarantee. Do not edit historical plan statements that are already numerically accurate.

Update the design's reviewed implementation provenance to the exact code/test SHA from Tasks 1–3.

- [ ] **Step 3: Run the complete verification matrix sequentially**

Run each command sequentially:

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
git status --short
```

Expected: zero failures; the test suite reports only established capability skips; publish check exits zero while reporting the expected already-published-version refusal; frozen install changes nothing; worktree is clean except the intended documentation/test changes before commit.

- [ ] **Step 4: Audit separation of concerns and package surface**

Verify:

- `src/operation-budgets.ts` has no imports and is absent from `src/index.ts`/public declarations;
- no request maximum remains duplicated in API/cache/CLI code;
- parsing/count failures precede repository/cache hooks;
- cache keeps defensive checks;
- no dead generic `optionalLimit`, stale 1–1,000 help, experimental hook, TODO, or unrelated refactor remains;
- README, maintained contract, packed CLI, and code describe the same values;
- `bunfig.toml` has the required plaintext-lock settings and `bun.lock` is unchanged plaintext JSON.

- [ ] **Step 5: Commit documentation/provenance**

```bash
git add README.md docs/contract.md docs/superpowers/specs/2026-08-13-operation-budgets-design.md test/package.test.ts
git commit -m "[MAR-2561] Document authoritative operation budgets"
```

Rerun `node --test test/package.test.ts`, `bun run check:package`, `git diff --check origin/main...HEAD`, and `git status --short --branch` after the commit.
