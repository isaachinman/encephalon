# Durable Recovery Marker Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace process-local abandoned-marker authority with a crash-safe, cross-process recovery phase while preserving all public behaviour and active-owner safety.

**Architecture:** Keep recovery coordination in `src/lock.ts`; add one bounded immutable recovered-witness primitive to `src/cache-location.ts`; publish `owner.recovered.json` only while the exact explicit recovering owner and usable SQLite gate are held; and make the exact owner-plus-witness pair sufficient for token-safe reclaim in every process. Design: `docs/superpowers/specs/2026-08-24-durable-recovery-marker-phase-design.md`.

**Tech Stack:** TypeScript, Node.js synchronous filesystem and SQLite APIs, Bun package scripts, Node test runner.

## Global Constraints

- Work only on `mar-2637-locking-make-abandoned-recovery-markers-reclaimable-across`, based on the exact MAR-2635 head; do not use worktrees.
- Preserve public API signatures, result shapes, error codes, error precedence, cache schema, and operation-lock authority.
- Treat phase-less legacy owners as `recovering`; never age-break a valid live recovering owner.
- Never publish or reclaim across token, phase, owner-field, or directory-identity replacement.
- Never expose PID, token, owner bytes, filesystem identity, or absolute paths.
- Keep tests few and complementary; use RED-GREEN TDD for every production change.

---

### Task 1: Specify the durable owner lifecycle with failing tests

**Files:**
- Modify: `test/cache.test.ts`
- Create: `test/fixtures/abandon-recovered-marker.ts`
- Create: `test/fixtures/pause-owner-phase-publication.ts`

**Interfaces:**
- Consumes: `withOperationLock`, `cacheLocationTestHooks`, existing child-process barriers.
- Produces: behavioural evidence only; no public API changes.

- [x] Extend the cleanup-failure regression to assert immutable `owner.json` remains complete explicit `recovering`, `owner.recovered.json` is complete exact `recovered`, and a retry succeeds without process-local state.
- [x] Add a two-process regression where process A injects recovery-marker cleanup failure, reports the failure, remains alive, and process B reclaims and enters before A exits.
- [x] Add complementary cases proving live `recovering` and phase-less owners are not reclaimed by age.
- [x] Add token, phase, owner-file identity, witness-file identity, and directory-identity replacement cases at publication and reclaim boundaries.
- [x] Add a crash-publication fixture that pauses during direct witness publication; kill it and prove a later process never accepts partial witness bytes and can reclaim after PID death, while a complete exact witness remains reclaimable regardless of PID.
- [x] Run the focused tests and record failures caused by the missing phase, cross-process timeout, or missing fault seam:

```bash
node --test --test-name-pattern='recovery marker|owner phase|phase publication' test/cache.test.ts
```

### Task 2: Add bounded durable recovered-witness publication

**Files:**
- Modify: `src/cache-location.ts`
- Modify: `test/cache.test.ts`

**Interfaces:**
- Add internal immutable-owner evidence and recovered-witness publication primitives.
- Add narrow test hooks at the write, flush, and final evidence-validation boundaries.

- [x] Keep explicit recovering `owner.json` immutable and exclusively create fixed `owner.recovered.json` with strict canonical matching owner fields and recovered phase.
- [x] Accept a witness only for a phased recovering owner and only when exact raw bytes, stable single-link regular-file identities, and captured directory identity all remain current; never let a legacy phase-less owner adopt a stray witness.
- [x] Flush the completed witness, capability-aware flush the exact held directory, then revalidate the directory and both files before success. Skip only documented Windows directory-sync unsupported cases.
- [x] Treat `EEXIST` as idempotent only for an exact stable witness matching the current exact owner. Partial, hard-linked, malformed, or replaced witnesses are not recovered.
- [x] Teach exact owned-directory quarantine to remove the bounded partial or complete witness after moving the exact directory, so a publication crash cannot strand a dead marker.
- [x] Carry whether exact recovered evidence became visible across post-visibility flush/verification errors. Keep that error primary, attempt exact cleanup, never enter the operation, and keep any cleanup error secondary.
- [x] Revalidate expected owner and witness identities plus raw bytes inside the moved exact quarantine before unlinking either; retain the intact quarantine and report identity change on mismatch.
- [x] Run focused cache-location and recovery-marker tests until green.

### Task 3: Publish and consume durable recovery phases

**Files:**
- Modify: `src/lock.ts`
- Modify: `test/cache.test.ts`

**Interfaces:**
- Extend the private recovery-owner model with `recovering | recovered`.
- Keep operation-lock owner metadata and every public interface compatible.

- [x] Replace permissive owner parsing with exact allowed-key validation, bounded token/PID validation, canonical timestamp validation, and phase-enum validation; normalise the exact legacy shape to `recovering`.
- [x] Create new recovery markers with `phase: 'recovering'` and retain their complete expected owner as transition authority.
- [x] After verified gate `BEGIN` and post-open ownership validation, durably publish the exact matching recovered witness before cleanup.
- [x] Remove `abandonedRecoveryMarkers` and every process-local ownership decision.
- [x] Treat exact observed `recovered` metadata as reclaimable regardless of PID while requiring the complete observation to remain current at quarantine.
- [x] Preserve current primary-error/cleanup-error precedence and fail the current operation when marker cleanup reports failure.
- [x] Run all recovery, corrupt-gate, contention, timeout, and cache tests.

### Task 4: Maintain the contract and release evidence

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/contract.md`
- Update: `docs/superpowers/specs/2026-08-24-durable-recovery-marker-phase-design.md`
- Update: `docs/superpowers/plans/2026-08-24-durable-recovery-marker-phase.md`

- [x] Document the recovering/recovered lifecycle, legacy phase-less behaviour, atomic publication, exact reclaim authority, and unchanged public surface.
- [x] Run formatting and focused tests.
- [x] Run every release gate:

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

- [x] Request independent security, correctness, data-consistency/race, test-coverage, maintainability, and UX/API-regression reviews against the exact MAR-2635 base; fix every high- or medium-confidence issue and repeat affected verification.
- [ ] Commit as `[MAR-2637] Make recovery markers cross-process reclaimable`, push with explicit `origin <ticket-branch>:<ticket-branch>`, open a draft stacked PR, link it to Linear, and request exact-head bot review. Do not merge until the full ticket sequence is complete.
