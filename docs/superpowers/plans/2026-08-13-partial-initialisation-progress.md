# Partial Initialisation Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each failed init subsystem's existing error classification while reporting exact bounded commit progress and guaranteeing same-options rerun convergence.

**Architecture:** Record and instruction modules expose internal outcome-returning variants at their existing commit points; their public throwing behaviour remains unchanged. `src/init.ts` owns one bounded progress journal outside the operation-lock callback and decorates the final `EncephalonError` with deterministic phase, cache state, commit lists, recovery mode, and recovery action.

**Tech Stack:** Node.js 24+, TypeScript ESM, Bun scripts, `node:test`, synchronous filesystem and SQLite authorities already present in the repository.

## Global Constraints

- Preserve the failing subsystem's existing `EncephalonError.code`, message, cause, and safe detail fields; do not add an error code.
- Do not roll back or delete committed append-only records or committed instruction changes.
- Cache state is disposable and never canonical.
- Stop later authoritative mutations after the first failure; only existing identity-bound cleanup may continue.
- `initProgress` contains only bounded validated record IDs, fixed repository-relative instruction filenames/actions, fixed enum values, and fixed recovery text.
- Never expose subjects, payloads, instruction bytes, absolute paths, cache paths, raw causes, ownership tokens, stacks, or arbitrary filesystem names.
- Preserve deterministic record publication order and fixed `AGENTS.md`, `CLAUDE.md` instruction order without duplicates.
- Preflight failure reports empty commit lists and `cacheState: 'notAttempted'`.
- Rerunning the same operation with the same options rescans/replans and converges without duplicate active generated heads or duplicate managed blocks.
- No public API, package export, declaration, Bun configuration, or plaintext lockfile change.
- Use strict TDD: each behavioural change must have a witnessed failing test before production edits.

---

### Task 1: Expose authoritative subsystem commit outcomes

**Files:**
- Modify: `src/records.ts`
- Modify: `src/instructions.ts`
- Modify: `test/records.test.ts`
- Modify: `test/init.test.ts`

**Interfaces:**
- Consumes: existing `PublishResult`, `publishPlannedRecordInternal`, `FilePlan`, `CommittedInstructionFailureContext`, and subsystem post-commit priority/recovery logic.
- Produces:

```ts
/** @internal */
export const publishPlannedRecordOutcome = (
  root: string,
  plan: PlannedRecord,
  options: { authority: CanonicalPublicationAuthority; hooks?: RecordWriteHooks },
): { record: BrainRecord; committedError?: EncephalonError }

export type InstructionAction = {
  file: 'AGENTS.md' | 'CLAUDE.md'
  action: 'removed' | 'updated'
}

/** @internal */
export const applyInstructionChangesOutcome = (
  root: string,
  plans: FilePlan[],
  hooks?: AtomicWriteHooks,
): { instructionFiles: InstructionAction[]; error?: EncephalonError }
```

`publishPlannedRecord` and `applyInstructionChanges` remain throwing wrappers with unchanged public behaviour.

- [ ] **Step 1: Read the good-test rules before editing tests**

Read `superpowers:test-driven-development`'s `writing-good-tests.md`. Name the production mutation each new test detects before writing it.

- [ ] **Step 2: Add focused failing record-outcome tests**

Add complementary tests proving:

```ts
const outcome = publishPlannedRecordOutcome(root, plan, options)
assert.equal(outcome.record.id, plan.record.id)
assert.equal(outcome.committedError?.details.canonicalCommitted, true)
```

Inject a post-link publication verification or flush failure. Also assert a pre-link failure still throws and cannot produce a committed outcome. Do not duplicate existing low-level identity or cleanup tests.

- [ ] **Step 3: Run the record RED test**

Run:

```bash
node --test --test-name-pattern='record publication outcome' test/records.test.ts
```

Expected: fail because `publishPlannedRecordOutcome` is absent or the post-link error still escapes without an outcome.

- [ ] **Step 4: Implement the minimal record outcome**

Make `publishPlannedRecordInternal` convert every failure after successful canonical linking into its existing highest-priority `committedError` and return `PublishResult`. Keep pre-link failures throwing. Export `publishPlannedRecordOutcome` as the direct internal outcome. Keep `publishPlannedRecord` as:

```ts
const published = publishPlannedRecordOutcome(root, plan, options)
if (published.committedError !== undefined) {
  throw published.committedError
}
return published.record
```

- [ ] **Step 5: Run record GREEN and affected record tests**

Run:

```bash
node --test --test-name-pattern='record publication outcome|post-link|post-commit|publication flush' test/records.test.ts
```

Expected: all selected tests pass with existing codes/details unchanged.

- [ ] **Step 6: Add focused failing instruction-outcome tests**

Add tests for:

```ts
const outcome = applyInstructionChangesOutcome(root, plans, hooks)
assert.deepEqual(outcome.instructionFiles, [
  { file: 'AGENTS.md', action: 'updated' },
])
assert.equal(outcome.error?.code, expectedCode)
```

Cover one successful first file followed by a second-file pre-commit failure, and a current-file post-commit failure that includes the current action exactly once. Add the equivalent committed removal/root-close characterisation only if existing removal coverage does not already prove it.

- [ ] **Step 7: Run the instruction RED test**

Run:

```bash
node --test --test-name-pattern='instruction apply outcome' test/init.test.ts
```

Expected: fail because `applyInstructionChangesOutcome` is absent and previous/current commit actions cannot be recovered from the throwing batch API.

- [ ] **Step 8: Implement the minimal instruction outcome**

Refactor the existing apply function into an internal outcome producer. Append an action only after the subsystem commit point is authoritative. When an `EncephalonError` has a `CommittedInstructionFailureContext`, include that current plan once before returning the error. Preserve root-close aggregation and set the committed plan for successful deletion as well as write. Implement the existing `applyInstructionChanges` as a wrapper:

```ts
const outcome = applyInstructionChangesOutcome(root, plans, hooks)
if (outcome.error !== undefined) {
  throw outcome.error
}
return outcome.instructionFiles
```

- [ ] **Step 9: Run subsystem GREEN and static checks**

Run:

```bash
node --test test/records.test.ts test/init.test.ts
bun run lint
bun run typecheck
```

Expected: all affected tests and all four TypeScript projects pass; public declarations remain unchanged.

- [ ] **Step 10: Commit subsystem outcomes**

```bash
git add src/records.ts src/instructions.ts test/records.test.ts test/init.test.ts
git commit -m "[MAR-2548] Report init subsystem commit outcomes"
```

---

### Task 2: Aggregate init progress and prove convergence

**Files:**
- Modify: `src/init.ts`
- Modify: `test/init.test.ts`
- Modify: `test/cli.test.ts`

**Interfaces:**
- Consumes: `publishPlannedRecordOutcome`, `applyInstructionChangesOutcome`, existing `EncephalonError`, cache hydrate/prepare results, operation lock, and subsystem detail fields.
- Produces private init types and one decorator with this exact safe shape:

```ts
type InitProgressDetails = {
  phase:
    | 'preflight'
    | 'recordPublication'
    | 'cachePreparation'
    | 'instructionApplication'
    | 'operationCleanup'
  canonicalCommitted: boolean
  committedRecordIds: string[]
  committedInstructionFiles: InstructionAction[]
  cacheState: 'notAttempted' | 'disposable' | 'prepared'
  recoveryMode: 'rerun' | 'inspectAndRerun'
  recoveryAction: string
}
```

The error detail key is exactly `initProgress`.

- [ ] **Step 1: Add exact RED cases for phase and progress aggregation**

Add a compact table plus targeted convergence tests covering:

1. malformed second instruction during preflight: empty arrays, `notAttempted`, no repository mutation;
2. failure before record publication attempts two and three: exact committed prefix, later records/cache/instructions absent;
3. second record post-link flush/verification failure: current record included once and subsystem details preserved;
4. cache failure after all records: all record IDs, `disposable`, no instruction commits;
5. first instruction success then second pre-commit failure: all records, prepared cache, exact first file/action;
6. current instruction post-commit failure: current action included once and existing `postCommitFailures`/`recoveryPaths` preserved;
7. operation-lock cleanup failure after successful phases: full progress retained with phase `operationCleanup`.

Each error assertion must prove original code/message, deterministic order, and absence of injected secrets/absolute paths/payload or instruction bytes.

- [ ] **Step 2: Run the init-progress RED tests**

Run:

```bash
node --test --test-name-pattern='partial init progress|init preflight progress|init cache progress|init instruction progress' test/init.test.ts
```

Expected: failures show absent `initProgress`, lost prior commits, or wrong current-phase accounting.

- [ ] **Step 3: Implement the bounded progress journal**

Create one contained mutable journal outside `withOperationLock`; use immutable array replacement when recording outcomes. Transition phase immediately before each phase starts and cache state at its documented boundaries. Replace `plans.map(...)` with deterministic sequential publication through `publishPlannedRecordOutcome`; append the returned record before throwing `committedError`. Apply instructions through `applyInstructionChangesOutcome`; append its actions before throwing its error.

Decorate every final error once:

```ts
new EncephalonError(error.code, error.message, {
  ...error.details,
  initProgress: progressDetails(progress, error),
}, { cause: error.cause })
```

Raw errors still pass through central `wrapIo` first. Select recovery mode/action from fixed constants and existing safe fields; never parse prose. Cache failure uses: `Run prepare, run validate, then repeat the same init operation with the same options.`

- [ ] **Step 4: Run init-progress GREEN**

Run the same focused command from Step 2. Expected: all selected tests pass.

- [ ] **Step 5: Add and witness rerun/refresh RED cases**

Add complementary tests proving:

- record-prefix and full-record/cache failures rerun without changing committed IDs and create only missing records;
- partial repair of two parallel generated subjects reruns to one active head per subject without another resolver for the already-repaired subject;
- stale instruction plan after record/cache phases reports no instruction commit, preserves concurrent bytes, and reruns to one managed block per file;
- remove-mode first-file commit followed by second-file failure reruns without baseline deletion or duplicate state.

Run:

```bash
node --test --test-name-pattern='partial init rerun|partial refresh rerun|partial instruction rerun' test/init.test.ts
```

Expected: fail before production changes or before missing convergence handling is complete.

- [ ] **Step 6: Complete minimal rerun handling**

Only adjust orchestration where the RED tests prove a gap. Always rescan and replan; do not persist progress, reuse plans, compensate, or add a transaction layer.

- [ ] **Step 7: Add one exact CLI projection test**

Exercise a deterministic init failure through the CLI. Assert one stderr JSON value, unchanged exit classification, exact safe `initProgress`, no stdout, and no private sentinel/absolute path. Remove the fault and assert the same command succeeds without duplicate records or managed blocks.

- [ ] **Step 8: Run affected and full verification before commit**

Run:

```bash
node --test test/init.test.ts test/cli.test.ts test/errors.test.ts test/records.test.ts
bun run lint
bun run typecheck
bun run test
bun run benchmark
bun run benchmark:check
bun run build
bun run check:package
bun run check:publish
bun install --frozen-lockfile
```

Expected: all commands exit zero; publish check may report the repository's expected already-published-version refusal while exiting zero; two existing filesystem capability skips remain acceptable.

- [ ] **Step 9: Commit init progress and tests**

```bash
git add src/init.ts test/init.test.ts test/cli.test.ts
git commit -m "[MAR-2548] Report partial initialisation progress"
```

---

### Task 3: Document and audit the maintained contract

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/contract.md`
- Modify: `docs/superpowers/specs/2026-08-13-partial-initialisation-progress-design.md`
- Modify: `docs/superpowers/plans/2026-08-13-partial-initialisation-progress.md`
- Test: `test/package.test.ts`

**Interfaces:**
- Consumes: the exact code/test commit SHA from Tasks 1-2 and the final tested `initProgress` schema.
- Produces: concise user guidance, normative maintained contract, exact provenance, and a completed historical plan. No runtime interface.

- [ ] **Step 1: Update maintained documentation**

Document:

- multi-resource init is monotonic rather than globally transactional;
- exact `initProgress` fields and their event semantics;
- original error-code preservation and subsystem secondary details;
- `rerun` versus `inspectAndRerun` guidance;
- cache disposal and `prepare`/`validate` recovery;
- same-options rerun convergence for baseline, refresh, instructions, and remove;
- bounded privacy exclusions;
- exact code/test commit SHA in maintained provenance.

Mark this plan's checkboxes complete only for commands actually run and record exact RED/GREEN evidence. Do not rewrite the historical MAR-2547 design or superseded broad implementation plan.

- [ ] **Step 2: Add or update the smallest contract assertion**

In `test/package.test.ts`, assert only stable maintained-document requirements not already proven by behavioural tests, such as the named `initProgress` contract and exact provenance relationship. Avoid copying large Markdown blocks.

- [ ] **Step 3: Run final documentation and release gates**

Run:

```bash
node --test test/package.test.ts
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

Expected: all gates pass, Bun files remain unchanged and plaintext, public declarations contain no new internal types, diff check is clean, and status contains only intended documentation changes before commit.

- [ ] **Step 4: Commit documentation and provenance**

```bash
git add README.md CHANGELOG.md docs/contract.md docs/superpowers/specs/2026-08-13-partial-initialisation-progress-design.md docs/superpowers/plans/2026-08-13-partial-initialisation-progress.md test/package.test.ts
git commit -m "[MAR-2548] Document restart-safe initialisation"
```

- [ ] **Step 5: Final tidy audit**

Verify separation of concerns, understandable state transitions, no stale assumptions, dead hooks, experiments, obsolete error text, declaration leaks, documentation drift, Bun drift, or unrelated changes. Report exact commits, RED/GREEN evidence, gates, and any concern.
