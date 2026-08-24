# Stable Canonical Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate, read, mutate, initialise, and rebuild cache state from one exact bounded canonical generation.

**Architecture:** Extend the existing records-owned planning/publication authority with exact directory-entry and raw-record generation evidence. Use one operation-scoped retry ledger for all consumers, accept only explicit publication deltas, and pass the sealed snapshot into the existing cache writer.

**Tech Stack:** TypeScript 7, Node.js 24.15+ filesystem and crypto built-ins, Bun 1.3.1 scripts, Node test runner, existing SQLite/cache-location and operation-lock authorities.

**Spec:** `docs/superpowers/specs/2026-08-24-stable-canonical-generation-design.md`

## Global Constraints

- Backwards compatibility is a release invariant: preserve every documented valid input, successful public result shape, existing public error code and field, persisted record/artifact format, cache schema version `1`, manifest representation, and successful output semantics. Committed canonical races add only the bounded recovery fields specified below.
- Existing repositories, records, instruction files, caches, and clients require no migration and suffer no data loss.
- Preserve the synchronous public API, CLI framing, package exports, and runtime dependency set.
- Use one records-owned canonical snapshot authority; do not add a parallel scanner, watcher, daemon, rollback mechanism, or external-editor lock.
- Retry only a private path-free canonical-generation sentinel. Preserve validation, cache-location, observer, filesystem, SQLite, and operation-lock error authority.
- Never retry or replan a canonical generation after a canonical record commit. Disposable-cache recovery may retry the same sealed snapshot without reacquiring records. Committed races use `REPOSITORY_CHANGED` and additive bounded details without exposing absolute paths, identities, hashes, payloads, arbitrary names, or private causes.
- Use the local clone and exact Linear branch; do not create a worktree and do not push `main`.
- Every production change follows RED, witnessed expected failure, minimal GREEN, focused regression run, then commit.

---

### Task 1: Exact bounded directory generations and retry budget

**Files:**
- Modify: `src/canonical-layout.ts`
- Modify: `src/operation-budgets.ts`
- Modify: `test/canonical-layout.test.ts`

**Interfaces:**
- Produces: `sameCanonicalDirectoryGeneration(first, second): boolean` and `recaptureCanonicalDirectoryGeneration(snapshot): CanonicalDirectorySnapshot`.
- Produces: `OPERATION_BUDGETS.canonicalSnapshotAttempts.maximum === 3` and `OPERATION_BUDGETS.canonicalSnapshotRetryMilliseconds.maximum === 60_000`.
- Consumes: existing `CanonicalDirectorySnapshot`, `captureCanonicalDirectory`, lossless filesystem identity helpers, and ordinal entry order.

- [x] **Step 1: Write exact-generation RED tests**

Add table-driven tests that capture a directory, then independently add, remove, rename, and type-change one entry. Assert an unchanged recapture compares equal and every changed recapture compares unequal. Cover a replaced directory inode with identical names, root absence followed by creation through the records-facing test in Task 2, exact-boundary enumeration, and overflow without materialising beyond the existing maximum plus one probe.

- [x] **Step 2: Run the focused test and witness RED**

Run:

```bash
node --test --test-name-pattern='canonical directory generation' test/canonical-layout.test.ts
```

Expected: failures show the exact-generation exports are missing; existing bounded enumeration tests remain green.

- [x] **Step 3: Implement the minimal pure comparison and bounded recapture**

Compare directory path/canonical identities with `sameEntryIdentity`, then compare overflow and the complete sorted entries by name plus a stable type projection:

```ts
type CanonicalEntryType = 'directory' | 'file' | 'other' | 'symlink'

export const sameCanonicalDirectoryGeneration = (
  first: CanonicalDirectorySnapshot,
  second: CanonicalDirectorySnapshot,
) => boolean

export const recaptureCanonicalDirectoryGeneration = (
  snapshot: CanonicalDirectorySnapshot,
) => captureCanonicalDirectory(snapshot.witness.path, snapshot.maximum)
```

Store `maximum` in each snapshot so callers cannot revalidate with a different bound. Keep `revalidateCanonicalDirectory()` metadata-only.

- [x] **Step 4: Add the two immutable operation budgets**

Extend `OPERATION_BUDGETS` with `canonicalSnapshotAttempts: { maximum: 3 }` and `canonicalSnapshotRetryMilliseconds: { maximum: 60_000 }`. Do not duplicate either literal in consumer code.

- [x] **Step 5: Run focused and affected tests**

Run:

```bash
node --test test/canonical-layout.test.ts
bun run lint
bun run typecheck
```

- [x] **Step 6: Commit Task 1**

```bash
git add src/canonical-layout.ts src/operation-budgets.ts test/canonical-layout.test.ts
git commit -m "[MAR-2575] Compare exact canonical directory generations"
```

### Task 2: Stable read and validation snapshots

**Files:**
- Modify: `src/records.ts`
- Modify: `test/records.test.ts`
- Modify: `test/performance.test.ts`

**Interfaces:**
- Consumes: Task 1 exact directory generation and retry budgets.
- Produces: private `CanonicalGenerationChanged` sentinel; operation-scoped `CanonicalSnapshotRetryLedger`; `readStableCanonicalSnapshot(...)`; evolved `RecordPlanningSnapshot` with exact record/artifact evidence and one generation authority.
- Preserves: `validateRecordsResolved`, `readRecordsResolved`, `readValidatedRecordSnapshotResolved`, and `readRecordSnapshotResolved` signatures and stable outputs.

- [x] **Step 1: Write stable-read RED tests**

Add deterministic hooks and tests for:

- a sibling record added after kind enumeration;
- a record removed or renamed after its bytes are read;
- a same-size replacement whose mtime is restored after graph validation;
- a new kind added after root enumeration;
- continuous churn on every attempt;
- a stable malformed record.

One-shot changes must discard all first-attempt records and return the settled successor generation. Continuous churn must attempt exactly three complete scans and throw path-free `REPOSITORY_CHANGED`. The stable malformed corpus must retain its ordinary validation result.

- [x] **Step 2: Run the records RED tests**

Run:

```bash
node --test --test-name-pattern='stable canonical snapshot|canonical snapshot churn' test/records.test.ts
```

Expected: one-shot entry-set/content races return stale or invalid first-attempt results and continuous churn is not centrally bounded.

- [x] **Step 3: Implement one snapshot attempt and exact current-generation assertion**

Retain a `RecordObservation` for every opened canonical JSON file, including parse failures, and implement a bounded digest reinspection that opens with `O_NOFOLLOW`, compares lossless metadata before/after, reads at most the captured size plus one byte, and compares the retained SHA-256 digest. Exact root/kind recapture brackets record and artifact reinspection.

Use a private sentinel carrying no path or filesystem data:

```ts
class CanonicalGenerationChanged extends Error {}

type CanonicalSnapshotRetryLedger = {
  readonly deadline: number
  readonly maximumAttempts: number
  attempt: number
  repositoryChanged: boolean
}
```

Check the deadline only before starting attempts after the first. Convert exhaustion to `fail('REPOSITORY_CHANGED', 'The canonical repository changed repeatedly during the operation.')`.

- [x] **Step 4: Route all read/validation entry points through the stable snapshot**

`validateRecordsResolved` returns stable validation output. Read entry points validate the stable graph/artifacts once and return only frozen accepted records. Observer failures and stable validation errors are never translated into churn.

- [x] **Step 5: Prove stable-path and retry work counts**

Extend performance hooks for 0, 100, and 1,000 records. Assert one stable canonical scan and one graph validation. A change detected after graph validation adds one complete scan and graph attempt; continuous post-graph churn stops at three scans and three graph validations. A scan-time change completes no graph work for its rejected attempt, so continuous scan-time churn stops at three scans and zero graph validations. No retry multiplies per directory.

- [x] **Step 6: Run focused regressions and commit Task 2**

Run:

```bash
node --test test/records.test.ts test/performance.test.ts
bun run lint
bun run typecheck
```

Then:

```bash
git add src/records.ts test/records.test.ts test/performance.test.ts
git commit -m "[MAR-2575] Read one stable canonical generation"
```

### Task 3: Replan add and init before commit; classify committed races

**Files:**
- Modify: `src/records.ts`
- Modify: `src/init.ts`
- Modify: `test/records.test.ts`
- Modify: `test/init.test.ts`

**Interfaces:**
- Consumes: Task 2 retry ledger, stable planning snapshot, exact authority, and existing `publishPlannedRecordOutcome` state machine.
- Produces: pre-first-commit replanning; exact post-publication planned-delta sealing; additive committed-race details.
- Preserves: publication error priority `publicationVerification > publicationFlush > cacheHydration > stagingCleanup` and init's failing subsystem code/message/cause.

- [x] **Step 1: Write add RED tests**

Inject an unrelated sibling and a same-subject active head after candidate graph validation. Assert the unrelated change causes a fresh plan and one eventual commit; the same-subject change causes no stale publication. Inject a sibling change immediately after the hard-link and assert `REPOSITORY_CHANGED` with `canonicalCommitted: true`, `repositoryChanged: true`, legacy `recordId`/relative `path`, `committedRecordIds: [id]`, `postCommitPhase: 'publicationVerification'`, and the fixed validation/reconciliation recovery action. Repeat the committed case with hydration disabled.

- [x] **Step 2: Write init RED tests**

Inject a canonical change before the first baseline publication and assert baseline actions and timestamps are recomputed. Inject a change after the first record in a multi-record batch and assert only that prefix exists, cache and instruction hooks are untouched, the original `REPOSITORY_CHANGED` cause is retained, and `initProgress.committedRecordIds` exactly matches the top-level bounded committed IDs.

- [x] **Step 3: Run the focused RED tests**

Run:

```bash
node --test --test-name-pattern='replans changed canonical generation|committed canonical generation race|mid-batch canonical generation' test/records.test.ts test/init.test.ts
```

- [x] **Step 4: Put planning and publication under one non-nested retry ledger**

Recompute candidate validation, `createdAt`, layout additions, and publication authority on every safe attempt. The publication state machine must translate the private sentinel after a successful link into the committed `REPOSITORY_CHANGED` error. Init catches a sentinel before later links after a non-empty committed prefix and constructs one committed-prefix error instead of retrying.

Use frozen bounded IDs:

```ts
const committedRecordIds = committedRecords
  .slice(0, MAX_CANONICAL_RECORDS)
  .map(record => record.id)
Object.freeze(committedRecordIds)
```

Do not retry `RECORD_EXISTS`, `VALIDATION_FAILED`, cache-location errors, timestamp exhaustion, observer exceptions, or operational I/O.

- [x] **Step 5: Run mutation, staging, init, and error regressions**

Run:

```bash
node --test test/records.test.ts test/init.test.ts test/staging.test.ts test/errors.test.ts
bun run lint
bun run typecheck
```

- [x] **Step 6: Commit Task 3**

```bash
git add src/records.ts src/init.ts test/records.test.ts test/init.test.ts
git commit -m "[MAR-2575] Bind mutations to stable canonical generations"
```

### Task 4: Make cache consume the validated canonical snapshot

**Files:**
- Modify: `src/cache.ts`
- Modify: `src/records.ts`
- Modify: `src/init.ts`
- Modify: `test/cache.test.ts`
- Modify: `test/records.test.ts`

**Interfaces:**
- Consumes: Task 2/3 sealed snapshot records, artifacts, canonical manifest entries/digest, repository identity, and `assertCurrent`.
- Produces: one validated canonical snapshot type consumed by add, init, prepare, hydrate, cache reads, cache rebuild, and corruption recovery.
- Preserves: exact cache manifest JSON/hash representation, schema version `1`, SQLite logical rows, cache recovery identity, and one-generation read semantics.

- [x] **Step 1: Write cache RED tests**

Prove that a stable canonical snapshot produces byte-identical manifest metadata and logically identical metadata/records/FTS rows to the current disk rebuild. Count canonical scans and graph passes when rebuilding a missing or stale cache for prepare, hydrate, list, show, search, gather, post-add hydration, and byte-eligible record-producing init; retain zero-scan fresh-cache paths and the one-shot byte-ineligible post-commit init boundary. Inject retry-eligible churn during cache writing and assert the shared three-attempt budget, no valid-cache quarantine, and no mixed snapshot rows.

- [x] **Step 2: Run the cache RED tests**

Run:

```bash
node --test --test-name-pattern='canonical snapshot cache manifest|shared canonical retry budget|canonical churn preserves cache' test/cache.test.ts test/records.test.ts
```

- [x] **Step 3: Project the existing manifest from snapshot evidence**

Move only the pure manifest-entry/hash projection needed by both layers; retain cache policy in `src/cache.ts`. The projection must emit the existing exact keys `ctimeNanoseconds`, `mtimeNanoseconds`, `path`, `size`, and `type`, preserve record-before-artifact ordering, and hash the identical JSON bytes. Do not include device/inode values in persisted metadata.

- [x] **Step 4: Remove cache-owned canonical full-scan retries**

Replace `ValidatedMutationCacheSnapshot` and `recordManifestEntries`/`boundedRepositoryManifestFromObservations` rebuild orchestration with the sealed canonical snapshot. Keep a bounded optimistic manifest probe only where an existing cache freshness check must decide whether to acquire the operation lock; once work enters validation/rebuild, consume the shared snapshot and ledger. Reassert the snapshot before cache DML and immediately before `COMMIT`.

- [x] **Step 5: Run cache and package-facing regressions**

Run:

```bash
node --test test/cache.test.ts test/records.test.ts test/init.test.ts test/cli.test.ts
bun run lint
bun run typecheck
bun run build
bun run check:package
```

- [x] **Step 6: Commit Task 4**

```bash
git add src/cache.ts src/records.ts src/init.ts test/cache.test.ts test/records.test.ts
git commit -m "[MAR-2575] Rebuild cache from the canonical snapshot"
```

### Task 5: Maintained contract, release matrix, and branch review

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/contract.md`
- Modify: `docs/implementation-plan.md`
- Modify: `docs/performance.md`
- Modify: `docs/superpowers/specs/2026-08-24-stable-canonical-generation-design.md`
- Modify: `docs/superpowers/plans/2026-08-24-stable-canonical-generation.md`
- Modify: `test/package.test.ts`

**Interfaces:**
- Consumes: exact implemented behaviour and measured stable/retry phase counts from Tasks 1-4.
- Produces: maintained compatibility, recovery, cache, and performance documentation plus exact release evidence.

- [x] **Step 1: Update maintained documentation**

Document exact stable-generation acceptance, three-attempt/60-second retry policy, precommit replanning, committed-race details, shared cache snapshot, and unchanged public/cache/persisted formats. Record measured phase counts without inventing new latency thresholds.

- [x] **Step 2: Run the complete local release matrix**

Run:

```bash
bun install --frozen-lockfile
bun run check:generated
bun run check:workflows
bun run lint
bun run typecheck
bun run test
bun run benchmark:check
bun run build
bun run check:package
bun run check:publish
node dist/cli.mjs validate
git diff --check
```

Observed on 2026-08-24: `check:publish` exited `0` after npm refused `You cannot publish over the previously published versions: 0.2.0.` The gate recognises the expected `EPUBLISHCONFLICT`/`E403` family and this npm version's equivalent JSON summary with the code omitted. No publication occurred.

- [x] **Step 3: Commit documentation and exact evidence**

```bash
git add README.md CHANGELOG.md docs/contract.md docs/implementation-plan.md docs/performance.md docs/superpowers/specs/2026-08-24-stable-canonical-generation-design.md docs/superpowers/plans/2026-08-24-stable-canonical-generation.md test/package.test.ts
git commit -m "[MAR-2575] Document stable canonical generations"
```

- [ ] **Step 4: Run the required six-role review against the stacked base**

Dispatch security, correctness/bug, data consistency/race, test coverage, maintainability, and UX/API reviewers in parallel against `0b04350ab298c22135db0f04c74706f3dbcef5a3..HEAD`. Fix every concrete high- or medium-confidence finding through focused RED/GREEN evidence, run one scoped re-review, and rerun proportionate release gates.

- [ ] **Step 5: Create external review state without merging**

Push only `origin mar-2575-canonical-records-validate-and-mutate-against-a-stable:mar-2575-canonical-records-validate-and-mutate-against-a-stable`, open a stacked draft PR against MAR-2636, move MAR-2575 to In Review with the PR link and exact verification evidence, then obtain a Pullfrog review tied to the exact final head. Leave every ticket PR unmerged until the complete Linear sequence is ready.

## Implementation Evidence Before External Review

- Task 1: `4fea49c6a3922e25278981c3d3a869af56f7b966`.
- Task 2: `b18e526a76120298976bc54bbac088fc8e9f3a00` through `1e2a774d47442ea055275cd0082ebf22fd1641c1`.
- Task 3: `16b2c0f5d142ea83ccbf21bffda3bfa9847e86e5` through `ad5243da69775369aaba592b2015763b3c1cf99b`.
- Task 4: `8fa7aa75138f26e5db7dfffe2baec2cbc2d63648` through the exact implementation and behavioural-test snapshot `9127ad98cb3d1e00edd54e8d81a0788c7fd56e83`.
- The local Task 5 matrix passed with 63 workflow-policy tests plus one platform skip; 718 full-suite passes plus two established capability/platform skips out of 720 tests; the schema-version 2 CI benchmark budget; build and packed-package checks; the expected non-publishing `0.2.0` refusal; 38 valid canonical records and zero validation errors; and clean diff hygiene.
- Steps 4 and 5 remain intentionally open for the controller after review of this local documentation commit.
