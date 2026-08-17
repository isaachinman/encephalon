# Response Byte Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one deterministic 4 MiB logical response ceiling for standalone compact search and the complete gather result before unbounded materialisation.

**Architecture:** Extend the dependency-free operation-budget authority, add one internal response-ledger module, and pass a per-read-attempt ledger through compact and gather readers. Compact SQLite rows become lazily iterated, validated, charged, and only then retained inside the existing transaction.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Node test runner, Bun repository scripts.

## Global Constraints

- `fullResponseBytes`, `compactResponseBytes`, and `gatherResponseBytes` each use a fixed 4 MiB maximum and `field: 'response'`.
- Count UTF-8 bytes for string values and object keys plus an eight-byte allowance for numbers, booleans, nulls, arrays, and objects.
- Exact maximum succeeds; maximum plus one fails with `INVALID_ARGUMENT` and only `{ field, budget, maximum }`.
- Compact rows are validated before charging and are consumed with `StatementSync.iterate()` inside the current read transaction.
- One gather ledger covers metadata, envelopes, shows, compact results, nulls, and duplicate requests.
- Public inputs, outputs, exports, ordering, ranking, and cache schema remain unchanged.

---

### Task 1: Internal response-budget authority

**Files:**
- Create: `src/response-budget.ts`
- Modify: `src/operation-budgets.ts`
- Create: `test/response-budget.test.ts`

**Interfaces:**
- Consumes: `OPERATION_BUDGETS` and `failBudget`.
- Produces: internal `ResponseBudgetKey`, `ResponseByteBudget`, `logicalResponseBytes(value)`, and `createResponseByteBudget(key)` with `charge(value)` and `chargeBytes(bytes)`.

- [x] **Step 1: Write the failing pure tests**

Add a table proving UTF-8 strings and keys, fixed node allowances, nested values, and reordered-object equality. Add exact-boundary and one-byte-over assertions for `compactResponseBytes` and `gatherResponseBytes`, including exact stable error details.

- [x] **Step 2: Run the pure test and verify RED**

Run: `node --test test/response-budget.test.ts`

Expected: module-not-found or missing-budget failures before production code exists.

- [x] **Step 3: Implement the immutable limits and contained ledger**

Add the two stable keys to `OPERATION_BUDGETS`. Recursively calculate logical bytes without serialization, reject unsupported internal values as `INTERNAL_ERROR`, and fail only when cumulative bytes exceed the selected maximum. Mark every helper `@internal` and do not export it from `src/index.ts`.

- [x] **Step 4: Run the pure test and static checks**

Run: `node --test test/response-budget.test.ts && bun run lint && bun run typecheck`

Expected: all pass.

### Task 2: Lazy compact and shared gather accounting

**Files:**
- Modify: `src/cache.ts`
- Modify: `test/cache.test.ts`

**Interfaces:**
- Consumes: `createResponseByteBudget` and `ResponseByteBudget` from Task 1.
- Produces: a compact reader that accepts the caller ledger; standalone compact and gather readers that allocate their correct per-attempt ledger.

- [x] **Step 1: Write the focused behavioural tests**

Add one compact exact/+1 boundary fixture that traps `StatementSync.prototype.all`, and one complete gather exact/+1 fixture containing repeated shows, a missing show, repeated searches, multibyte text, full records, compact summaries, numeric hydration metadata, containers, and envelopes. Update the existing show-only gather overflow expectation to `gatherResponseBytes`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="streams compact rows|shares one 4 MiB gather|stops full-record responses" test/cache.test.ts`

Expected: compact calls the throwing `.all()` sentinel and gather reports the old or absent budget.

- [x] **Step 3: Centralise the existing full-record ledger**

Replace `FullResponseBudget` and direct byte mutation with `createResponseByteBudget('fullResponseBytes')` and `chargeBytes(recordRowBytes(row))`. Keep parsing after a successful charge and keep list/show/full-search behaviour unchanged.

- [x] **Step 4: Implement compact streaming**

Make `createCompactSearchReader` accept a response ledger, charge the results-array container once per query, consume `statement.iterate(...)`, convert each row with `compactRecordFromRow`, charge the validated compact record, and then retain it. Allocate standalone compact ledgers inside the database callback.

- [x] **Step 5: Implement the gather ledger**

Make the show reader return parsed records without owning a budget. Allocate one gather ledger in `readGatherFromDatabase`, charge the root skeleton once, then charge every show envelope and every search envelope while passing the same ledger to compact result iteration. Preserve shows-before-searches and current object shapes.

- [x] **Step 6: Run focused, cache, and mutation checks**

Run the focused command, then `node --test test/cache.test.ts`. Temporarily mutate `.iterate()` to `.all()`, UTF-8 length to code-unit length, `>` to `>=`, and shared gather state to per-reader state; each focused test must fail before restoring production.

Expected: restored production passes all focused and cache tests.

### Task 3: Contract, package, and release verification

**Files:**
- Modify: `README.md`
- Modify: `docs/contract.md`
- Modify: `docs/implementation-plan.md`
- Modify: `test/package.test.ts`
- Modify: `docs/superpowers/specs/2026-08-17-response-byte-budgets-design.md`
- Modify: `docs/superpowers/plans/2026-08-17-response-byte-budgets.md`

**Interfaces:**
- Consumes: the stable code/test commit SHA from Tasks 1 and 2.
- Produces: maintained contract, exact reviewed provenance, and package-level documentation assertions.

- [x] **Step 1: Commit code and tests**

Stage only the response-budget authority, cache implementation, and complementary tests. Commit with `[MAR-2554] Bound compact and gather responses`.

- [x] **Step 2: Write the documentation provenance RED**

Extend the package contract test to require the operation-budget documentation and exact code/test SHA. Run `node --test test/package.test.ts` and verify it fails before documentation is updated.

- [x] **Step 3: Update maintained documentation**

Document all three 4 MiB budgets, the logical accounting formula, lazy compact iteration, shared gather accounting, exact stable error keys, duplicate charging, no truncation, and unchanged public types. Replace the stale statement that gather compact results do not consume its response budget. Record the exact code/test SHA in the maintained contract and this design.

- [x] **Step 4: Run the complete release matrix**

Run lint, all TypeScript projects, the full suite, baseline and CI-budget benchmarks, build, package, publish-contract, and frozen install. Audit declarations, Bun/package/config diffs, `git diff --check`, branch/base/upstream, and tracked status.

Evidence: package contract 7/7; lint checked 105 files; all four TypeScript projects passed; the full suite passed 506/508 with two established filesystem-capability skips; both benchmark profiles, build, package, publish-contract, and frozen install passed. Public declarations and package/config files remained unchanged, both base-range diff checks were clean, and the tracked Task 3 scope contained only the six documented files.

- [x] **Step 5: Commit documentation**

Commit the maintained documentation and provenance with `[MAR-2554] Document bounded read responses`.

- [ ] **Step 6: Review the branch against its base**

Provide one shared evidence packet to the six required parallel reviewers: security, correctness, race/data consistency, tests, maintainability, and UX/API. Fix every concrete high- or medium-confidence issue with focused RED/GREEN evidence, rerun proportionate gates, and repeat review at most three broad waves.

- [ ] **Step 7: Publish without merging**

Push explicitly to `origin mar-2554-api-bound-compact-search-and-gather-response-bytes:mar-2554-api-bound-compact-search-and-gather-response-bytes`, open the ticket PR against the reviewed MAR-2550 stack branch, request the bot review, and leave the PR unmerged until every remaining ticket PR is complete and reviewed.
