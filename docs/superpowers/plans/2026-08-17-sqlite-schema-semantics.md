# SQLite Schema Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task.

**Goal:** Reject disposable SQLite caches whose familiar table and column names hide incompatible primary keys, nullability, checks, indexes, or FTS5 options, then recover through one exact quarantine and rebuild.

**Architecture:** `src/cache.ts` retains one canonical cache-schema authority and validates it with numeric-first bounded PRAGMA probes plus narrowly normalised owned SQL checks. `src/cache-location.ts` reports whether a verified primary was exclusively created so writers create only new schemas and validate existing databases before mutation. Existing reader transactions and central exact-generation recovery remain authoritative.

**Tech stack:** TypeScript 7, Node.js 24.15+ built-in `node:sqlite`, Bun 1.3.1 scripts, Node test runner.

## Global constraints

- Preserve public API signatures, CLI behaviour, package exports, canonical JSON, and recovery error codes.
- Every schema-text or PRAGMA text read must have a successful bounded numeric-only probe first.
- Explicitly order PRAGMA rows; never depend on SQLite enumeration or autoindex-name order.
- Existing databases are validated before writer mutation. Only a confirmed-new exclusive primary receives DDL.
- Reader schema, metadata, content, freshness, and result reads remain in one transaction.
- Schema mismatch is disposable cache corruption: exact quarantine, one rebuild, one retry, no migration.
- Public errors contain fixed messages only and never include schema SQL, metadata, record JSON, FTS text, or cache paths.
- Tests use real SQLite DDL mutations without sleeps, chmod assumptions, or platform-generated index names.
- Keep `bunfig.toml` exact and `bun.lock` plaintext.

### Task 1: Reject incompatible table and metadata semantics

**Files**

- Modify: `src/cache.ts`
- Test: `test/cache.test.ts`

- [x] Add table-driven RED cases for same-name `metadata` and `records` tables with missing primary keys, changed nullability/types/defaults, and missing or widened `active` checks.
- [x] Add the six-row duplicate-metadata RED and prove it is rejected before accepted metadata iteration.
- [x] Replace name-only column validation with bounded `pragma_table_list` and `pragma_table_xinfo` probes plus exact immutable descriptor comparison.
- [x] Add bounded owned-SQL checks for the exact `metadata` and `records` definitions, including the active constraint and table-level semantics not exposed by the column PRAGMAs.
- [x] Reject duplicate keys before assigning to the metadata map.
- [x] Run the focused schema/metadata tests, lint, and all four TypeScript projects.

### Task 2: Validate required index and FTS5 semantics

**Files**

- Modify: `src/cache.ts`
- Test: `test/cache.test.ts`

- [x] Add RED index cases for missing/renamed/extra indexes, wrong key order, wrong direction, and wrong collation, plus a different-creation-order positive control.
- [x] Add RED FTS cases for an ordinary table, indexed ID, unindexed text, reversed columns, and changed tokenizer/options, plus a harmless-formatting positive control.
- [x] Add bounded `pragma_index_list` and `pragma_index_xinfo` probes and exact required-index comparisons.
- [x] Replace the broad FTS marker with the bounded strict semantic declaration matcher.
- [x] Run focused index/FTS tests, the complete cache suite, lint, and all four TypeScript projects.

### Task 3: Prevent writer repair and prove bounded recovery

**Files**

- Modify: `src/cache-location.ts`
- Modify: `src/cache.ts`
- Test: `test/cache.test.ts`
- Test: `test/cache-location.test.ts` if a pure verified-open seam is required

- [x] Add RED coverage proving forced preparation currently repairs an existing malformed schema instead of quarantining it.
- [x] Add a representative public-read RED proving exact corrupt-primary quarantine, one rebuild, canonical output, and a later fresh prepare.
- [x] Add a second-mismatch/private-schema RED proving no second rebuild and no schema text in the public cause chain.
- [x] Carry a `primaryCreated` fact from exclusive bootstrap through the verified-open callback.
- [x] Create canonical DDL only for a confirmed-new primary; validate existing/expected-owned primaries before PRAGMAs or DDL.
- [x] Revalidate after `BEGIN IMMEDIATE` before rebuild DML.
- [x] Run focused recovery tests, affected cache/location/error tests, lint, and all four TypeScript projects.

### Task 4: Snapshot, valid-schema, documentation, and release gates

**Files**

- Modify: `README.md`
- Modify: `docs/contract.md`
- Modify: `docs/implementation-plan.md`
- Modify: `docs/superpowers/specs/2026-08-17-sqlite-schema-semantics-design.md`
- Modify: `docs/superpowers/plans/2026-08-17-sqlite-schema-semantics.md`
- Modify: `test/cache.test.ts`
- Modify: `test/package.test.ts`

- [x] Add a mutation-sensitive reader test proving schema probes and subsequent reads use one snapshot.
- [x] Add a valid-schema control covering prepare and the public read families without altering the database identity or bytes.
- [x] Update maintained cache compatibility documentation with exact semantic checks, recovery behaviour, scope boundaries, and the reviewed code/test SHA.
- [x] Run package provenance RED then GREEN.
- [x] Run lint, all four typechecks, full tests, both benchmarks, build, package, publish-contract, and frozen-install gates.
- [x] Audit public declarations, package contents, Bun files, diff hygiene, dead hooks, stale assumptions, SoC boundaries, and documentation accuracy.

Implementation and behavioural coverage are captured by `fb17790ac01031aa37d903ec9a3feb3a271e9d05`. The review-remediated release matrix passed with 491 tests, two established filesystem-capability skips, clean lint and four-project typechecking, both benchmark profiles, build, packed-package and publish-contract checks, frozen dependency installation, unchanged Bun/package configuration, no new public declarations, and clean diff hygiene.

### Task 5: Pull request and branch review

- [ ] Push the exact Linear branch with explicit `origin branch:branch` and verify upstream.
- [ ] Open a PR based on the reviewed MAR-2549 branch so the ticket diff remains focused; include British-English title/body and leave it unmerged.
- [ ] Review the complete branch against `origin/main` with Security, Correctness, Data consistency/races, Test coverage, Maintainability, and UX/API reviewers in parallel.
- [ ] Fix every accepted High/Medium-confidence issue with focused RED/GREEN evidence and rerun proportionate gates.
- [ ] Repeat broad review at most three waves, then run the main-thread SoC/tidy/stale-assumption/dead-code/docs audit.
- [ ] Run final cross-platform CI and bot review, fix actionable findings, update Linear, and leave the reviewed PR open for the ordered merge.
