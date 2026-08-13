# Managed Instruction Finalisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalise successful managed instruction replacements without leaking operation-owned backup or temporary aliases, and report post-commit failures unambiguously.

**Architecture:** Keep the instruction publication state machine in `src/instructions.ts`. Bind the staged file and renamed predecessor to held no-follow descriptors, define the successful canonical hard link as the commit point, quarantine and remove only the exact owned predecessor, and aggregate safe structured post-commit errors through the existing `EncephalonError` model.

**Tech Stack:** TypeScript, Node.js synchronous filesystem APIs, Bun package scripts, Node test runner.

## Global Constraints

- Public API signatures and the managed instruction block format remain unchanged.
- Normal success leaves no alias created by the operation.
- Never delete historical or concurrent files merely because their names resemble generated aliases.
- Never restore predecessor bytes over the canonical target after publication commits.
- Error details contain no absolute path, generated token, or instruction content.
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

**Interfaces:**
- Consumes: existing `FilePlan`, `FileIdentity`, `AtomicWriteHooks`, `EncephalonError`, `wrapIo`, `planInstructionChanges(root, remove)`, and `applyInstructionChanges(root, plans, hooks)`.
- Produces: internal post-commit phases, recovery actions, identity-bound cleanup, safe central I/O details, user-visible zero-alias success, and exact maintained documentation provenance. No public signature changes.

- [ ] **Step 1: Strengthen successful replacement coverage**

In `test/init.test.ts`, assert the canonical target equals the planned bytes, preserves the intended mode, and leaves no current-operation `.tmp`, `.backup`, or `.delete` alias. Seed historical aliases in a complementary case and assert their identities and bytes remain unchanged.

- [ ] **Step 2: Add focused committed-failure coverage**

Add the narrow fault points `during-backup-cleanup` and `during-publication-flush`; reuse `after-final-backup-validation` and `during-temp-cleanup`. Assert literal details:

```ts
{
  instructionCommitted: true,
  filename: 'AGENTS.md',
  postCommitPhase:
    | 'publicationVerification'
    | 'publicationFlush'
    | 'backupCleanup'
    | 'temporaryCleanup',
  recoveryAction: '<phase-specific safe action>',
}
```

Cover backup cleanup failure, directory flush failure, temp cleanup failure, backup-path replacement, old-descriptor mutation, exact pre-publication restoration, and deterministic retry with one managed block.

- [ ] **Step 3: Run the focused RED tests**

Run:

```bash
node --test --test-name-pattern='instruction replacements|instruction backup|instruction publication|instruction temporary cleanup' test/init.test.ts
```

Expected: failures show leaked backups, absent fault seams, or generic post-commit errors while the canonical new bytes are already visible. Record the exact failures before changing production.

- [ ] **Step 4: Extend central cause wrapping without changing classification**

Allow `wrapIo(message, cause, details?)` in `src/errors.ts` to attach optional safe `Record<string, JsonValue>` details while continuing to choose only `IO_ERROR` or `INTERNAL_ERROR` from the cause.

- [ ] **Step 5: Bind the staged and predecessor files to descriptors**

Keep the flushed staged descriptor open until publication verification and cleanup finish. After renaming an existing target, open its backup no-follow, compare descriptor and pathname identities and original bytes, and retain that descriptor through finalisation.

- [ ] **Step 6: Record the publication commit point**

Set committed state immediately after `linkSync(tempPath, targetPath)` returns. Verify that the canonical path identifies the staged descriptor before treating later work as cleanup. Never invoke predecessor restoration after this state.

- [ ] **Step 7: Finalise the exact backup**

Rename the generated backup to a fresh generated cleanup name, revalidate the moved pathname against the held backup descriptor, and unlink it without a hook or other fallible work between final verification and unlink. Preserve any replacement at the original backup pathname.

- [ ] **Step 8: Aggregate post-commit failures**

Capture the highest-priority phase—publication verification, publication flush, backup cleanup, then temporary cleanup—while continuing independent safe cleanup. Throw one structured committed error after descriptors and safe cleanup complete. Use `REPOSITORY_CHANGED` for identity uncertainty and central cause classification for operational failures.

- [ ] **Step 9: Run focused and affected GREEN checks**

Run:

```bash
node --test --test-name-pattern='instruction replacements|instruction backup|instruction publication|instruction temporary cleanup' test/init.test.ts
node --test test/init.test.ts test/errors.test.ts test/cli.test.ts
bun run lint
bun run typecheck
```

Expected: all selected tests and all four TypeScript projects pass with no warnings.

- [ ] **Step 10: Commit code and tests**

```bash
git add src/errors.ts src/instructions.ts test/init.test.ts
git commit -m "[MAR-2547] Finalise managed instruction replacements"
```

- [ ] **Step 11: Update maintained documentation**

In `README.md`, `CHANGELOG.md`, and `docs/contract.md`, describe the hard-link commit point, zero-alias success, safe structured post-commit errors, retry behaviour, and the narrow Node final-syscall limitation. Add the exact code/test SHA to maintained contract provenance; do not edit the historical implementation plan.

- [ ] **Step 12: Run all release gates**

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

- [ ] **Step 13: Commit documentation**

```bash
git add README.md CHANGELOG.md docs/contract.md
git commit -m "[MAR-2547] Document instruction replacement finalisation"
```

- [ ] **Step 14: Perform the final tidy audit**

Verify separation of concerns, understandable state transitions, no dead fault seam or leftover experiment, no stale filesystem assumption, no public declaration drift, exact documentation provenance, clean status, and exact branch/base.
