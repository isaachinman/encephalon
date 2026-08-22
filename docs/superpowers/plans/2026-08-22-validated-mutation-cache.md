# Validated Mutation Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild cache state from the final validated add/init mutation snapshot while retaining exact disk-rebuild safety and public error semantics.

**Architecture:** `records.ts` owns one raw planning scan and one strict final graph validation, then seals actual published rows behind canonical and artifact provenance. `cache.ts` owns one shared transactional writer and an invocation-scoped rebuilder that either revalidates the mutation snapshot or permanently falls back to the existing bounded disk rebuild.

**Tech Stack:** TypeScript ESM, synchronous Node.js filesystem APIs, `node:sqlite`, Node test runner, Bun build tooling.

**Spec:** `docs/superpowers/specs/2026-08-22-validated-mutation-cache-design.md`

## Global Constraints

- Backwards compatibility is a release invariant: preserve every documented valid input, public result/error shape and code, persisted record format, cache/schema compatibility, and successful output semantics. Existing repositories, records, instruction files, caches, and clients must require no migration and suffer no data loss.
- The validated-snapshot performance path is the only permitted observable change. If implementation reveals any compatibility conflict, stop and amend/review the plan before release.
- Preserve the public synchronous API, CLI framing, cache schema version `1`, canonical JSON, and manifest format.
- Stable add/init must perform one canonical scan and one strict graph validation.
- Never combine supplied records with newly adopted artifact observations or a fallback manifest.
- Preserve exact cache-primary ownership, transaction rollback, close-error precedence, and bounded disk recovery.
- Preserve add post-commit priority and init progress/error details.
- Add no runtime dependency or public declaration.

---

### Task 1: Prove stable reuse and changed-generation fallback

**Files:**
- Modify: `test/records.test.ts`
- Modify: `test/init.test.ts`
- Modify: `test/cache.test.ts`

**Interfaces:**
- Consumes: existing `recordWriteTestHooks`, `cacheReadTestHooks`, add/init APIs, and cache inspection helpers.
- Produces: mutation-sensitive RED coverage for stable scan counts, logical projection equivalence, record/artifact mismatch fallback, corrupt recovery, and committed writer failure.

- [ ] **Step 1: Write the stable add and init assertions**

```ts
assert.deepEqual(counts, {
  canonicalScans: 1,
  graphValidations: 1,
  diskCacheValidations: 0,
  hydrations: 1,
})
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern='validated mutation snapshot|canonical snapshot' test/records.test.ts test/init.test.ts test/cache.test.ts`

Expected: stable mutations report a disk cache validation or the current extra graph pass.

- [ ] **Step 3: Add fallback and logical-equivalence cases**

Replace a valid canonical record and a referenced artifact at the existing `during-hydration` boundary. Assert one disk fallback validation, current canonical output, a fresh next prepare, and logical metadata/records/FTS equality before and after forced hydrate.

- [ ] **Step 4: Commit RED tests**

```bash
git add test/records.test.ts test/init.test.ts test/cache.test.ts
git commit -m "[MAR-2565] Prove validated mutation cache reuse"
```

### Task 2: Seal one strictly validated mutation snapshot

**Files:**
- Modify: `src/records.ts`
- Modify: `src/init.ts`

**Interfaces:**
- Produces: `readRecordPlanningSnapshotResolved(...)`, whose final validator returns `readonly ArtifactObservation[]`; internal add `readHooks`; actual timestamped `ValidatedMutationCacheSnapshot` inputs.
- Consumes: existing canonical scan observations, `canonicalPublicationAuthority`, planned records, and captured `CacheLocation.repository`.

- [ ] **Step 1: Separate planning acquisition from final validation**

```ts
type RecordPlanningSnapshot = Readonly<{
  authority: CanonicalPublicationAuthority
  records: readonly BrainRecord[]
  validateFinal: (
    records: readonly BrainRecord[],
    message: string,
    bytes?: number,
    allowed?: readonly AllowedMultiHead[],
  ) => readonly ArtifactObservation[]
}>
```

- [ ] **Step 2: Route add and init through one strict final validation**

Add retains its invalid-history-before-timestamp-ceiling ordering, then seals actual published records. Mutating init validates the complete planned graph once; idempotent non-refresh init validates the scanned graph once.

- [ ] **Step 3: Run focused records/init tests and verify GREEN**

Run: `node --test test/records.test.ts test/init.test.ts`

Expected: all focused tests pass with one stable canonical scan and graph validation.

- [ ] **Step 4: Commit planning-snapshot changes**

```bash
git add src/records.ts src/init.ts test/records.test.ts test/init.test.ts
git commit -m "[MAR-2565] Reuse the validated mutation snapshot"
```

### Task 3: Share the writer and preserve bounded fallback/recovery

**Files:**
- Modify: `src/cache.ts`
- Modify: `src/records.ts`
- Modify: `src/init.ts`
- Modify: `test/cache.test.ts`
- Modify: `test/records.test.ts`

**Interfaces:**
- Consumes: provenance-bound `ValidatedMutationCacheSnapshot` values.
- Produces: private `writeCacheSnapshot(...)`, invocation-scoped `CacheRebuilder`, `hydrateResolvedMutationSnapshot(...)`, and `prepareResolvedMutationSnapshot(...)`.

- [ ] **Step 1: Extract the current transactional writer unchanged**

```ts
type CacheSnapshotWrite =
  | { kind: 'committed'; rebuild: CompletedCacheRebuild }
  | { kind: 'repository-changed'; retryPrimary: CacheWriterPrimary }
```

- [ ] **Step 2: Add one-shot mutation verification and fallback**

Revalidate canonical authority, complete artifact identities, repository realpath, and the expected manifest. On mismatch, mark the snapshot discarded and call ordinary `rebuildCache` with the returned primary; propagate operational failures.

- [ ] **Step 3: Inject the rebuilder through preparation and disposable recovery**

Use the supplied rebuilder after missing-cache claims and corrupt-cache quarantine. Revalidate a retained snapshot after quarantine; never return to it once discarded.

- [ ] **Step 4: Run focused tests and mutation witnesses**

Run: `node --test test/cache.test.ts test/records.test.ts test/init.test.ts`

Expected: stable reuse, logical equivalence, record/artifact fallback, corrupt recovery, and post-commit details all pass. Mutations that trust stale rows, skip artifact identity comparison, lose the retry primary, or use disk rebuild after stable quarantine must fail.

- [ ] **Step 5: Commit the shared writer**

```bash
git add src/cache.ts src/records.ts src/init.ts test/cache.test.ts test/records.test.ts test/init.test.ts
git commit -m "[MAR-2565] Share validated cache rebuilds"
```

### Task 4: Document, verify, review, and release

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/contract.md`
- Modify: `docs/performance.md`
- Modify: `docs/performance-baseline.json`
- Modify: `docs/superpowers/specs/2026-08-22-validated-mutation-cache-design.md`
- Modify: `docs/superpowers/plans/2026-08-22-validated-mutation-cache.md`

**Interfaces:**
- Consumes: the final code/test commit SHA and benchmark evidence.
- Produces: maintained contract/performance documentation, exact provenance, six-role review evidence, stacked PR, and Linear handoff.

- [ ] **Step 1: Update maintained documentation and exact provenance**

Document one-pass mutation cache construction, deterministic fallback, unchanged public semantics, and measured 100/1,000-record diagnostics without adding a new benchmark schema.

- [ ] **Step 2: Run the full release matrix**

Run: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run benchmark`, `bun run benchmark:check`, `bun run build`, `bun run check:package`, `bun run check:publish`, and `bun install --frozen-lockfile`.

- [ ] **Step 3: Run the required reviews and root audit**

Dispatch security, correctness, data/race, test, maintainability, and UX/API reviewers against base `15e3b037e5d710fa4743168798d5e3d8f752ee4c`; fix every accepted high/medium-confidence issue and repeat exact-head review.

- [ ] **Step 4: Publish without merging**

Push only `mar-2565-performance-rebuild-cache-from-the-validated-mutation`, open the stacked PR against MAR-2560, wait for Pullfrog/CI, attach it to MAR-2565, and move Linear to In Review. Merge nothing until the complete release sequence is ready.
