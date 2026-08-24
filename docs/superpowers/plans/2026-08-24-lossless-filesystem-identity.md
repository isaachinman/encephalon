# Lossless Filesystem Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `src/filesystem-entry.ts` the single pure authority for lossless BigInt filesystem identity projections and comparisons, then remove the remaining numeric and duplicated guarded-path identities without changing public behaviour or stored formats.

**Architecture:** Extend the existing dependency-free filesystem-entry leaf with immutable BigInt projections for entry instance, complete stable metadata, post-rename metadata, and manifest metadata. Keep filesystem I/O, error classification, link-count policy, lock ownership, and subsystem-specific sequencing in their current modules. Migrate cache and instruction projections mechanically, then migrate canonical record reads and publication observations from `Stats`/millisecond fields to `BigIntStats`/nanosecond fields.

**Tech Stack:** TypeScript 7, Node.js synchronous filesystem APIs with `{ bigint: true }`, Bun package scripts, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-23-release-backlog-hardening-design.md`

## Global Constraints

- Preserve all documented valid public inputs, TypeScript signatures, synchronous behaviour, result shapes, ordering, and CLI framing.
- Preserve existing subsystem error codes, messages, causes, and safe detail fields.
- Preserve canonical record JSON, cache schema and manifests, instruction-file formats, and repository layout.
- `src/filesystem-entry.ts` remains dependency-free except for Node type imports and must not import cache, records, instructions, lock orchestration, or error policy.
- All identity fields remain `bigint` internally; JSON-facing metadata remains canonical decimal strings.
- Link-count policy remains outside the identity module because canonical and instruction publication intentionally use temporary hard links.
- Parent-directory instance checks remain identity-only after independently proving directory type; ordinary child creation must not invalidate a valid parent.
- Post-rename comparison omits only `ctimeNs`, whose change is legitimate after link/rename operations.
- Work test-first: every new behaviour is observed failing before production implementation.

---

### Task 1: Define the Pure Lossless Identity Authority

**Files:**
- Create: `test/filesystem-entry.test.ts`
- Modify: `src/filesystem-entry.ts`

**Interfaces:**
- Consumes: Node `BigIntStats` only at the projection boundary.
- Produces: `EntryIdentity`, `EntryMetadata`, `ManifestEntryMetadata`, `entryIdentityFrom()`, `entryMetadataFrom()`, `manifestEntryMetadataFrom()`, `sameEntryIdentity()`, `sameStableEntryMetadata()`, and `sameStableEntryMetadataExceptCtime()`.

- [ ] **Step 1: Write the failing synthetic identity tests**

  Add a table-driven Node test that constructs structural BigInt metadata with literal values and proves:
  - two `dev`/`ino` values that collapse to the same JavaScript `Number` remain unequal;
  - a `1n` `mtimeNs` or `ctimeNs` change fails complete stable comparison;
  - post-rename comparison accepts a `ctimeNs`-only change but rejects changes to `dev`, `ino`, `birthtimeNs`, `mode`, `mtimeNs`, or `size`;
  - manifest projection emits exact decimal strings and the independently derived entry type.

  The break each test catches is a rounded numeric identity, a millisecond timestamp comparison, or a comparator that omits more than its documented rename exception.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `node --test test/filesystem-entry.test.ts`

  Expected: assertion failure because the new projection/post-rename API is absent.

- [ ] **Step 3: Implement the minimal pure model**

  In `src/filesystem-entry.ts`:
  - define readonly structural types whose identity fields are `bigint`;
  - derive entry type from `BigIntStats` predicates without persisting methods;
  - project exact identity and complete stable metadata once;
  - compare BigInt fields directly, never through `Number` or millisecond timestamps;
  - preserve the existing exported comparator names so current callers remain source-compatible;
  - add the explicitly named post-rename comparator that omits only `ctimeNs`;
  - return canonical decimal strings from the manifest projection.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run: `node --test test/filesystem-entry.test.ts`

  Expected: all filesystem-entry tests pass.

### Task 2: Remove Duplicate Cache and Instruction Projections

**Files:**
- Modify: `src/cache-location.ts`
- Modify: `src/instructions.ts`
- Test: `test/cache.test.ts`
- Test: `test/init.test.ts`

**Interfaces:**
- Consumes: Task 1 identity/projection types and comparators.
- Produces: unchanged cache-location and instruction APIs, error behaviour, and on-disk formats.

- [ ] **Step 1: Establish the regression baseline**

  Run the existing focused cache identity and managed-instruction replacement/finalisation tests through the Node runner. These are real-behaviour guards for exact cache path ownership, byte-identical replacement, rename, and recovery.

- [ ] **Step 2: Migrate cache-location mechanically**

  Alias `CacheEntryIdentity` to the shared `EntryIdentity`, replace local `identityFrom` and incarnation field comparisons with shared projections/comparators, and retain `sameCacheEntryIdentity` as a compatibility export delegating to the shared authority. Keep cache path validation, quarantine, hard-link policy, and SQLite ownership local.

- [ ] **Step 3: Migrate instruction identities without changing policy**

  Replace the private string-valued `FileIdentity` family with shared BigInt projections. Use complete comparison where the existing code compares the complete descriptor/path observation, and the shared except-ctime comparison only at the existing post-rename/link boundaries. Keep masked permission-mode checks local and preserve every instruction error message and recovery detail.

- [ ] **Step 4: Verify the focused regression suites**

  Run: `bun run build && node --test test/cache.test.ts test/init.test.ts`

  Expected: all tests pass with only existing platform skips.

### Task 3: Migrate Canonical Record Reads and Observations

**Files:**
- Modify: `src/records.ts`
- Modify: `test/records.test.ts`

**Interfaces:**
- Consumes: Task 1 shared identity projections/comparators.
- Produces: canonical record reads and publication observations based exclusively on `BigIntStats`, with unchanged `BrainRecord`, `ValidateResult`, and `EncephalonError` contracts.

- [ ] **Step 1: Add the canonical-read regression case**

  Add one focused test beside the existing record replacement tests that preserves file size/content framing while changing a record between descriptor observations and asserts the existing bounded invalid-record result. Reuse the real `validateRecordsResolved()` fault boundary; do not add a production-only test hook or assert on a mock.

  The break it catches is accepting a same-size canonical mutation after an identity or timestamp comparison is weakened.

- [ ] **Step 2: Run the focused test and verify RED where the old precision permits the mutation**

  Run the named test with Node's test-name filter. If the local filesystem exposes the timestamp change at millisecond precision and the test passes on old code, retain it only as complementary integration coverage; the synthetic Task 1 tests remain the deterministic RED proof for sub-millisecond identity loss.

- [ ] **Step 3: Replace numeric record identities**

  In `src/records.ts`:
  - remove `Stats`, numeric `FileIdentity`, `identityFor`, and private millisecond comparators;
  - store `BigIntStats` in `RecordObservation`;
  - use `{ bigint: true }` for every canonical record and parent `lstatSync`/`fstatSync` involved in an identity decision;
  - use shared identity-only comparison for parent directory instances after independently proving directory type;
  - use complete stable comparison across a descriptor read;
  - use the except-ctime comparator only in the existing post-publication observation transition;
  - compare byte budgets as BigInt before the one safe `Number` conversion needed for bounded buffer allocation/accounting;
  - preserve every existing validation and repository-change message/detail.

- [ ] **Step 4: Verify record behaviour**

  Run: `bun run build && node --test test/filesystem-entry.test.ts test/records.test.ts`

  Expected: all focused tests pass with only existing platform skips.

### Task 4: Reuse Manifest Projection and Document the Contract

**Files:**
- Modify: `src/cache.ts`
- Modify: `docs/contract.md`
- Modify: `docs/superpowers/specs/2026-08-23-release-backlog-hardening-design.md`

**Interfaces:**
- Consumes: Task 1 `manifestEntryMetadataFrom()`.
- Produces: byte-for-byte compatible cache manifest JSON fields and maintained documentation naming the single identity authority.

- [ ] **Step 1: Replace duplicate manifest field conversion**

  Use the shared manifest projection for canonical entries and accepted artifact observations while retaining `path` assembly and manifest policy in `src/cache.ts`. Verify exact keys remain `ctimeNanoseconds`, `mtimeNanoseconds`, `size`, and `type` with decimal-string values.

- [ ] **Step 2: Update maintained documentation**

  Document that guarded identity decisions use BigInt device/inode and nanosecond metadata, that context-specific comparators deliberately distinguish exact stable reads, parent instances, and post-rename ctime changes, and that this is an internal/backwards-compatible change with no stored-format migration.

- [ ] **Step 3: Run focused cache-manifest and package tests**

  Run: `bun run build && node --test test/cache.test.ts test/package.test.ts`

  Expected: all tests pass with unchanged public results and manifest compatibility.

### Task 5: Review and Release-Equivalent Verification

**Files:**
- Modify only files required by high/medium-confidence review findings.

**Interfaces:**
- Consumes: completed ticket diff.
- Produces: one clean MAR-2573 branch and draft PR stacked on MAR-2572.

- [ ] **Step 1: Run the six-role parallel review**

  Review the MAR-2573 diff against MAR-2572 for security, correctness, data consistency/races, test coverage, maintainability/separation of concerns, and UX/API regression. Fix every high- or medium-confidence finding and rerun affected tests.

- [ ] **Step 2: Run the full release-equivalent gate**

  Run frozen install, generated/workflow checks, lint, all TypeScript projects, the full Node suite, benchmark budgets, build, packed-package validation, publish-contract validation, repository validation, and `git diff --check`.

- [ ] **Step 3: Record the exact reviewed snapshot**

  Commit implementation first, then update maintained provenance to the exact implementation SHA in a separate documentation commit. Validate again after the provenance-only commit.

- [ ] **Step 4: Push and open the stacked draft PR**

  Push only `mar-2573-filesystem-use-one-lossless-bigint-identity-model-for` with an explicit `origin <branch>:<branch>` refspec, set/verify upstream, and open the draft PR against `mar-2572-api-reject-sparse-arrays-and-accessor-bearing-input`. Require exact-head bot review and leave every ticket unmerged until the full batch is ready.

## Self-Review

- Spec coverage: the plan covers one shared pure authority, BigInt/nanosecond precision, exact/parent/post-rename/manifest projections, records, instructions, cache, preserved errors, and cross-platform regression gates.
- Placeholder scan: no deferred implementation or unspecified test work remains.
- Type consistency: all later tasks consume the Task 1 `EntryIdentity`, `EntryMetadata`, and manifest projection names; cache keeps its compatibility export while records and instructions use shared internal types.

## Implementation Evidence

- The exact reviewed code and behavioural-test snapshot is `849542580e4caa4746bbeed5523a0af65a9df63e`. Earlier task commits remain implementation milestones rather than final provenance.
- Synthetic tests prove lossless device/inode comparison, nanosecond metadata changes, exact post-rename omissions, instruction-specific mode omissions, and byte-compatible manifest projection. Integration tests prove same-inode mutation rejection between record pathname and descriptor observations and the permitted ctime-only instruction quarantine transition.
- Six pinned branch reviewers covered security, correctness, races, tests, maintainability, and UX/API compatibility. The security, coverage, and maintainability findings were fixed; four focused fix-round reviewers returned PASS with no remaining findings.
- Frozen install, generated/workflow checks, lint, all four TypeScript projects, the full Node suite with only the established capability skips, CI benchmark budgets, build, packed-package validation, publish-contract validation, repository validation, and diff hygiene all passed. The publish check recognised the expected refusal to overwrite published version `0.2.0`; no publication occurred.
- The initial packed-package gate exposed a private `BigIntStats` declaration path through `cache-location.d.ts`. Marking the runtime-only projections and instruction-only comparators `@internal` removed that private dependency from the consumer declaration graph while retaining the structural identity declarations needed by emitted internal types.
- The implementation is backwards-compatible: the root export surface, public TypeScript signatures, synchronous behaviour, errors, CLI framing, canonical JSON, cache schema and bytes, manifest and instruction formats, and repository layout are unchanged.
