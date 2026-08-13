# Managed Instruction Finalisation Implementation Plan

**Status:** Completed historical implementation record. `docs/contract.md` is the maintained normative contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalise successful managed instruction replacements without leaking operation-owned backup or temporary aliases, and report post-commit failures unambiguously.

**Architecture:** Keep the instruction publication state machine in `src/instructions.ts`. Bind all managed instruction mutations to one fixed no-follow repository-root identity plus staged and predecessor files to held descriptors; move aliases with verified no-replace hard-link-and-unlink steps; define the successful canonical hard link as the commit point; flush recovery and publication boundaries before destructive cleanup where supported; and aggregate safe structured post-commit errors and exact repository-relative recovery paths through the existing `EncephalonError` model.

**Tech Stack:** TypeScript, Node.js synchronous filesystem APIs, Bun package scripts, Node test runner.

## Global Constraints

- Public API signatures and the managed instruction block format remain unchanged.
- Normal success leaves no alias created by the operation.
- Never delete historical or concurrent files merely because their names resemble generated aliases.
- Never restore predecessor bytes over the canonical target after publication commits.
- Error details contain no absolute path or instruction content. The only generated-name exception is a bounded exact repository-relative `recoveryPaths` list for aliases still proved to be owned by the current operation.
- Keep `telemetry = false`, `[install].exact = true`, `[install].saveTextLockfile = true`, and plaintext `bun.lock` unchanged.

---

### Task 1: Finalise managed instruction replacements

**Files:**
- Modify: `src/errors.ts`
- Modify: `src/instructions.ts`
- Modify: `test/init.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/contract.md`
- Modify: `docs/superpowers/specs/2026-08-13-managed-instruction-finalisation-design.md`
- Modify: `docs/superpowers/plans/2026-08-13-managed-instruction-finalisation.md`

**Interfaces:**
- Consumes: existing `FilePlan`, `FileIdentity`, `AtomicWriteHooks`, `EncephalonError`, `wrapIo`, `planInstructionChanges(root, remove)`, and `applyInstructionChanges(root, plans, hooks)`.
- Produces: internal post-commit phases, recovery actions, identity-bound cleanup, safe central I/O details, user-visible zero-alias success, and exact maintained documentation provenance. No public signature changes.

- [x] **Step 1: Strengthen successful replacement coverage**

In `test/init.test.ts`, assert the canonical target equals the planned bytes, preserves the intended mode, and leaves no current-operation `.tmp`, `.backup`, or `.delete` alias. Seed historical aliases in a complementary case and assert their identities and bytes remain unchanged.

- [x] **Step 2: Add focused committed-failure coverage**

Add the narrow fault points `during-backup-cleanup` and `during-publication-flush`; use `before-final-backup-validation` and `during-temp-cleanup`. Assert literal primary details plus the bounded safe list of every distinct failed or deferred recovery phase:

```ts
{
  instructionCommitted: true,
  filename: 'AGENTS.md',
  postCommitPhase:
    | 'publicationVerification'
    | 'publicationFlush'
    | 'backupCleanup'
    | 'temporaryCleanup'
    | 'resourceCleanup',
  recoveryAction: '<phase-specific safe action>',
  postCommitFailures: Array<{
    postCommitPhase:
      | 'publicationVerification'
      | 'publicationFlush'
      | 'backupCleanup'
      | 'temporaryCleanup'
      | 'resourceCleanup',
    recoveryAction: '<phase-specific safe action>',
  }>,
  recoveryPaths: string[],
}
```

Cover backup cleanup failure, directory flush failure, temp cleanup failure, backup-path replacement, old-descriptor mutation, exact pre-publication restoration, and deterministic retry with one managed block.

- [x] **Step 3: Run the focused RED tests**

Run:

```bash
node --test --test-name-pattern='instruction replacements|instruction backup|instruction publication|instruction temporary cleanup' test/init.test.ts
```

Expected: failures show leaked backups, absent fault seams, or generic post-commit errors while the canonical new bytes are already visible. Record the exact failures before changing production.

- [x] **Step 4: Extend central cause wrapping without changing classification**

Allow `wrapIo(message, cause, details?)` in `src/errors.ts` to attach optional safe `Record<string, JsonValue>` details while continuing to choose only `IO_ERROR` or `INTERNAL_ERROR` from the cause.

- [x] **Step 5: Bind the staged and predecessor files to descriptors**

Keep the flushed staged descriptor open until publication verification and cleanup finish. Create the staged path at mode `0600`; flush and compare it with the planned bytes while private, then apply the intended mode, flush, and verify exact bytes, mode, descriptor, and path again. Before moving an existing target, open it read-only and no-follow, compare the descriptor and pathname identities with the preflight original incarnation and frozen bytes, and retain that descriptor through finalisation. Descriptor recovery copies follow the same private-byte then final-mode verification sequence. Allow the existing deliberate post-plan mode-change behaviour.

- [x] **Step 6: Record the publication commit point**

Set committed state immediately after `linkSync(tempPath, targetPath)` returns. Verify that the canonical path identifies the staged descriptor before treating later work as cleanup. Never invoke predecessor restoration after this state.

- [x] **Step 7: Finalise the exact backup**

Create the fresh cleanup name with an exclusive hard link from the generated backup, verify the destination against the held backup descriptor, revalidate the source and fixed root authority immediately before source unlink, and then verify the cleanup alias immediately before its unlink. Flush a restored canonical predecessor before removing its last durable recovery source. Preserve any canonical, source, or destination successor and retain an exact private recovery alias when identity cannot be proved, including when post-unlink temporary verification would otherwise leave the staged descriptor without a pathname.

- [x] **Step 8: Aggregate post-commit failures**

Capture the highest-priority phase—publication verification, publication flush, backup cleanup, temporary cleanup, then resource cleanup—while continuing independent safe cleanup. Include every distinct failed or deferred phase in the bounded safe list and every exact retained current-operation alias in bounded ordinal-sorted `recoveryPaths`; remove a transient publication-flush failure after a later cumulative directory flush succeeds. Throw one structured committed error after descriptors and safe cleanup complete. Use `REPOSITORY_CHANGED` when any captured failure is identity-uncertain and central cause classification for otherwise operational failures. An all-unchanged retry revalidates its canonical plans and performs the verified containing-directory sync without broad cleanup.

- [x] **Step 9: Run focused and affected GREEN checks**

Run:

```bash
node --test --test-name-pattern='instruction replacements|instruction backup|instruction publication|instruction temporary cleanup' test/init.test.ts
node --test test/init.test.ts test/errors.test.ts test/cli.test.ts
bun run lint
bun run typecheck
```

Expected: all selected tests and all four TypeScript projects pass with no warnings.

- [x] **Step 10: Commit code and tests**

```bash
git add src/errors.ts src/instructions.ts test/init.test.ts
git commit -m "[MAR-2547] Finalise managed instruction replacements"
```

- [x] **Step 11: Update maintained documentation**

In `README.md`, `CHANGELOG.md`, `docs/contract.md`, and the design record, describe the exclusive hard-link-and-unlink moves, fixed root and descriptor authorities for writes and removals, capability-aware private exact-byte verification, durability ordering, concurrent-successor guarantee, hard-link commit point and post-link failure aggregation, zero-alias success, exact safe recovery paths, complete structured post-commit errors, same-operation retry behaviour, and the narrow Node pathname-link/unlink syscall limitation. Add the exact code/test SHA to maintained contract provenance and keep this plan marked as a completed historical record.

- [x] **Step 12: Run all release gates**

Run:

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

Expected: every command exits zero; the publish contract may report the expected refusal to overwrite the existing package version; Bun files remain unchanged.

- [x] **Step 13: Commit documentation**

```bash
git add README.md CHANGELOG.md docs/contract.md
git commit -m "[MAR-2547] Document instruction replacement finalisation"
```

- [x] **Step 14: Perform the final tidy audit**

Verify separation of concerns, understandable state transitions, no dead fault seam or leftover experiment, no stale filesystem assumption, no public declaration drift, exact documentation provenance, clean status, and exact branch/base.
