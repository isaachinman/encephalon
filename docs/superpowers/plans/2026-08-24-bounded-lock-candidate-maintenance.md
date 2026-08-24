# Bounded Lock Candidate Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unbounded pre-gate candidate discovery and add bounded, exact, process-locally forward-progressing reclamation of abandoned operation-lock candidates.

**Architecture:** Put the reusable read loop in dependency-free `src/bounded-directory.ts`, keep an identity-bound LRU cursor and candidate filesystem evidence in `src/lock-candidates.ts`, extend existing cache-location primitives only for tolerant observation and exact owner/child validation, and let `src/lock.ts` coordinate the current candidate and under-gate maintenance. The process-local cursor avoids stable-prefix starvation without adding persistent state.

**Tech Stack:** TypeScript, Node.js synchronous filesystem and SQLite APIs, Bun package scripts, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-24-bounded-lock-candidate-maintenance-design.md`

## Global Constraints

- Work only on `mar-2636-locking-bound-lock-candidate-discovery-and-reclaim-abandoned`, based on exact MAR-2637 head `79bc637164dfa78d4e88fb7b2a7bdc5fee96a118`; do not use worktrees.
- Preserve every public API signature, result shape, `CACHE_BUSY` detail, single 60-second deadline, cache schema, error code, and error precedence.
- Keep fixed lock/recovery, current-candidate, cache-location, and gate invariants fail-closed; suppress only unrelated candidate-local maintenance failures.
- Visit at most 64 raw entries, inspect at most 16 candidates, attempt at most 4 reclamations, and retain at most 8 identity-bound cursors.
- Reclaim only exact stable evidence for a positively dead canonical owner or unchanged missing/malformed/oversized owner aged strictly more than 5,000 ms.
- Never recursively delete, follow links, adopt a pathname successor, age-break a live owner, or expose candidate-private data.
- Keep tests few and complementary; use RED-GREEN TDD before each production change.
- Do not merge until the full ticket sequence is complete.

---

### Task 1: Specify bounded discovery and lifecycle safety

**Files:**
- Modify: `test/cache.test.ts`
- Create: `test/lock-candidates.test.ts`
- Create: `test/fixtures/abandon-lock-candidate.ts`

**Interfaces:**
- Consumes: `withOperationLock`, existing child-process helpers and cache filesystem hooks.
- Produces: failing behavioural evidence for the private maintenance statistics and crash barriers; no public API change.

- [x] **Step 1: Write a lazy-reader bound test.** Create a reader that can yield 100,000 candidate-shaped entries without allocating an array, throws on the 65th read in one maintenance call, and records open/read/close counts. Assert the operation returns its callback value and reports `directoryEntriesVisited <= 64`, `candidatesInspected <= 16`, `reclamationAttempts <= 4`, and no private string fields.
- [x] **Step 2: Write under-gate and cursor-progress tests.** Record gate acquisition before the first reader call. Feed more than 64 inert prefix entries followed by reclaimable candidates, reuse the same injected reader across operations, and assert later operations reach the suffix while every call remains within all three budgets.
- [x] **Step 3: Write the crash fixture.** In `abandon-lock-candidate.ts`, support `before-owner` and `after-owner` modes; report the candidate basename through a barrier immediately after directory creation or owner publication and then block so the parent can terminate the process.
- [x] **Step 4: Add crash, live, malformed, unsupported, extra-child, and replacement integration cases.** Prove a fresh ownerless candidate is preserved, an aged ownerless candidate and a dead canonical owner converge, live/PID-reused owners remain byte-identical, malformed/oversized owners require grace, candidate files/symlinks and extra-child directories remain untouched, and owner-token/directory replacements immediately before quarantine survive.
- [x] **Step 5: Replace the old unrelated-candidate symlink rejection assertion.** Assert the current operation succeeds while the external sentinel and symlink identity remain unchanged; retain strict fixed lock/recovery symlink tests.
- [x] **Step 6: Run the focused tests and record RED.**

```bash
node --test --test-name-pattern='lock candidate|candidate discovery|candidate maintenance' test/cache.test.ts test/lock-candidates.test.ts
```

Expected: failures demonstrate the unbounded pre-gate scan, missing maintenance hook/cursor, and missing abandoned-candidate reclamation.

### Task 2: Add the bounded reader and identity-bound cursor

**Files:**
- Create: `src/bounded-directory.ts`
- Create: `test/bounded-directory.test.ts`
- Modify: `src/canonical-layout.ts`
- Modify: `test/canonical-layout.test.ts`
- Create: `src/lock-candidates.ts`
- Modify: `test/lock-candidates.test.ts`

**Interfaces:**
- Produces `DirectoryReader<Entry>` and `readBoundedDirectoryEntries(reader, maximum, onEntry?) => { entries, exhausted }` without opening, sorting, or closing the reader.
- Produces private candidate maintenance with limits 64/16/4 and a path-plus-BigInt-identity LRU cursor cap of 8.
- Preserves `collectBoundedDirectoryEntries()` behaviour: maximum-plus-one overflow detection, bounded-result sorting, and primary read-error precedence over close failure.

- [x] **Step 1: Add failing primitive tests.** Cover zero reads, exact limit, early EOF, lazy 100,000-entry input, read failure, and caller-owned close semantics.
- [x] **Step 2: Implement the minimal dependency-free read loop.** Read until `entries.length === maximum` or `readSync()` returns null; invoke `onEntry` exactly once per returned entry; return `exhausted: true` only after observing null.
- [x] **Step 3: Refactor canonical collection through the primitive.** Open one reader, request `maximum + 1`, hide entries when overflow is observed, sort only bounded success, and retain existing close/error semantics.
- [x] **Step 4: Add failing cursor tests.** Cover continuation across calls, EOF close/reopen, exact cache-directory identity replacement, reader failure, injected-reader change, and LRU eviction after the ninth repository.
- [x] **Step 5: Implement the capped cursor layer.** Key by canonical directory path plus exact `dev`/`ino`, close stale same-path cursors, touch LRU order on reuse, close on EOF/error/eviction, and never retain more than eight readers.
- [x] **Step 6: Run bounded-reader, canonical-layout, and cursor tests until GREEN.**

```bash
node --test test/bounded-directory.test.ts test/canonical-layout.test.ts test/lock-candidates.test.ts
```

### Task 3: Implement exact abandoned-candidate maintenance

**Files:**
- Modify: `src/cache-location.ts`
- Modify: `src/lock-candidates.ts`
- Modify: `src/lock.ts`
- Modify: `test/cache.test.ts`
- Modify: `test/lock-candidates.test.ts`
- Modify: `test/fixtures/abandon-lock-candidate.ts`

**Interfaces:**
- Add tolerant maintenance observation returning `stable | missing | changed | unsupported` without weakening strict current/fixed-name observation.
- Add exact comparison for `CacheOwnedFileObservation`, exact child-set validation, and promotion/quarantine options binding owner and missing recovery witness before and after rename.
- Add private `LockTestHooks` seams after current-candidate creation, after owner publication, for directory-reader injection, and after numeric maintenance statistics.

- [x] **Step 1: Make unrelated candidate observation non-authoritative.** Remove `assertCacheLockCandidates`; match only canonical lowercase UUID-v4 candidate names; treat unsupported candidate types and candidate-local observation errors as preserved outcomes while bracketing work with authoritative cache-location checks.
- [x] **Step 2: Parse exact candidate owners.** Accept only exact canonical three-key bytes with bounded canonical timestamp/PID/token and token equal to the name UUID. Positive `ESRCH` plus unchanged exact evidence permits immediate reclamation; every live or uncertain PID is preserved.
- [x] **Step 3: Apply the grace policy.** Missing owner uses directory mtime; malformed or oversized stable single-link owner uses the newer directory/file mtime; require age strictly greater than 5,000 ms. Preserve recovery witnesses, hard links, unsupported types, unreadable evidence, and extra children.
- [x] **Step 4: Bind quarantine to exact evidence.** Reobserve directory, owner, witness, child set, token, liveness/grace, and cache location inside the ownership callback. Count every attempted quarantine against the limit, count reclaim on exact rename, validate the exact child set before unlinking, and suppress candidate-local failures only after proving cache location current.
- [x] **Step 5: Bind the current candidate end to end.** Capture missing-owner evidence at creation and exact owner evidence after publication; verify exact owner/witness/child evidence before and after promotion; release by complete captured evidence; and remove the final pathname-reinspection fallback so a successor is never adopted.
- [x] **Step 6: Invoke maintenance under the held gate.** Promote the exact current candidate, run maintenance before the protected callback, report frozen numeric stats once, and preserve current operation/gate cleanup error precedence and the original deadline.
- [x] **Step 7: Run focused tests until GREEN.**

```bash
node --test --test-name-pattern='operation lock|lock candidate|candidate discovery|candidate maintenance' test/cache.test.ts test/lock-candidates.test.ts
```

### Task 4: Align documentation and complete release evidence

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/contract.md`
- Modify: `docs/implementation-plan.md`
- Update: `docs/superpowers/specs/2026-08-24-bounded-lock-candidate-maintenance-design.md`
- Update: `docs/superpowers/plans/2026-08-24-bounded-lock-candidate-maintenance.md`

**Interfaces:**
- Documents internal limits 64/16/4, cursor cap 8, grace 5,000 ms, exact reclaim authority, process-local forward-progress scope, and unchanged public behaviour.

- [x] **Step 1: Update the cache contract and README.** State that unrelated candidate-shaped entries are inert, maintenance occurs only under the SQLite gate, every work limit is exact, fixed/current entries remain fail-closed, and cursor state is private and process-local.
- [x] **Step 2: Correct the stale implementation-plan lock section.** Replace the obsolete atomic-lock-only algorithm and owner fields with the SQLite gate, durable fixed recovery marker, exact current candidate, and bounded maintenance lifecycle.
- [x] **Step 3: Add one changelog entry and self-review docs against code.** Ensure no claim exceeds the implemented restart/fairness guarantee and no public surface or migration is implied.
- [x] **Step 4: Run focused formatting and tests, then every release gate.**

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

- [ ] **Step 5: Request independent security, correctness, data-consistency/race, test-coverage, maintainability, and UX/API-regression reviews against exact MAR-2637 head.** Fix every high- or medium-confidence issue and repeat affected verification.
- [ ] **Step 6: Commit the documentation as `[MAR-2636] Document lock candidate maintenance`, push with explicit `origin mar-2636-locking-bound-lock-candidate-discovery-and-reclaim-abandoned:mar-2636-locking-bound-lock-candidate-discovery-and-reclaim-abandoned`, open a draft stacked PR based on MAR-2637, link it to Linear, and request exact-head bot review. Do not merge until the full ticket sequence is complete.
