# Managed Instruction Finalisation Design

## Scope

MAR-2547 completes successful replacements of root `AGENTS.md` and `CLAUDE.md` files. A normal replacement must leave the new canonical file and no alias created by that operation. After publication, Encephalon must never restore predecessor bytes over the canonical path and must preserve a detected concurrent successor while reporting that publication committed. Before publication, failures must preserve the exact original bytes or an exact recovery copy.

Public method signatures, the managed block format, deletion results, and cleanup of historical aliases remain unchanged. Writes and removals share the fixed repository-root authority. The implementation must not discover or remove unrelated files merely because their names resemble Encephalon aliases.

## State machine

Each write has four states:

1. **Prepared** — one fixed no-follow repository-root pathname identity and, where supported, matching directory-descriptor identity remain current for writes and removals. Every mutation is bracketed by that authority and exact affected-entry validation; unrelated root entries do not invalidate it. On POSIX, an exclusive generated temporary path is created and verified at mode `0600`, written and flushed, compared with the exact planned bytes while private, changed to the intended mode, then flushed and verified again. Windows applies the restrictive mode where supported without treating POSIX permission bits as an ACL guarantee. Its descriptor remains the authority for the staged file.
2. **Recovery held** — for an existing target, a no-follow descriptor is acquired before any pathname is removed and must match the preflight bytes and original filesystem incarnation, apart from an allowed mode change. The operation hard-links the predecessor to an exclusive backup path, verifies that destination against the descriptor, flushes the directory where supported, revalidates the source, and unlinks the canonical predecessor. Before publication, this backup is the recovery authority.
3. **Committed** — after the temporary path is revalidated against its staged descriptor, `linkSync(tempPath, targetPath)` succeeds. This is the publication commit point. The canonical and temporary aliases are verified and the directory is flushed before recovery state is removed. From this point forward the implementation never restores the predecessor over the canonical target.
4. **Finalised** — the canonical path still identifies the staged file; the exact backup is hard-linked to a fresh exclusive cleanup alias, the new alias is verified, and the source is revalidated immediately before source unlink. The cleanup alias is then verified and unlinked, the exact temporary alias is removed, and the containing directory is flushed again where supported.

Every alias move uses no-replace hard-link-and-unlink steps rather than rename. Each newly linked destination is verified against the held descriptor, and the source and fixed root authority are revalidated immediately before source unlink. A successor placed at the canonical or original backup pathname is therefore preserved. A restored canonical predecessor is flushed before its last durable source alias is removed. If exact pre-commit restoration cannot be proved, an exact recovery alias is retained and its containing directory is flushed before it becomes the last reported predecessor pathname; a descriptor recovery copy uses the platform-specific restrictive mode policy, frozen predecessor bytes, private verification, preserved final mode, and final verification. If temporary cleanup loses the last staged pathname, the still-open staged descriptor is likewise copied to one restrictively held and verified recovery alias before close. Node exposes neither portable descriptor-relative `linkat` nor conditional `unlinkat`, so fixed-root and entry checks immediately bracket each pathname syscall, detected replacements are reported and preserved, and the remaining same-user in-syscall root-replacement window is documented as an unsupported security boundary. Windows retains the same exact-byte, identity, successor, and zero-alias success contract while permission-mode privacy and directory fsync remain capability-aware.

## Error contract

Pre-commit failures retain the existing non-committed classifications and recovery behaviour. Post-commit failures throw an `EncephalonError` whose safe details are:

```ts
{
  instructionCommitted: true,
  filename: 'AGENTS.md' | 'CLAUDE.md',
  postCommitPhase:
    | 'publicationVerification'
    | 'publicationFlush'
    | 'backupCleanup'
    | 'temporaryCleanup'
    | 'resourceCleanup',
  recoveryAction: string,
  postCommitFailures: Array<{
    postCommitPhase:
      | 'publicationVerification'
      | 'publicationFlush'
      | 'backupCleanup'
      | 'temporaryCleanup'
      | 'resourceCleanup',
    recoveryAction: string,
  }>,
  recoveryPaths: string[],
}
```

Publication, fixed-root, or pathname-identity uncertainty is `REPOSITORY_CHANGED`; race-indicative `EISDIR`, `ELOOP`, `ENOENT`, and `ENOTDIR` at witnessed alias boundaries have that classification rather than `IO_ERROR`. Any failure detected after the canonical link syscall is captured as committed, and any identity-uncertain captured failure makes the aggregate code `REPOSITORY_CHANGED`, independently of which higher-priority phase supplies the primary message. Recognised operational filesystem failures are otherwise `IO_ERROR`; unexpected faults remain `INTERNAL_ERROR`. The primary phase and bounded distinct failure list use priority order publication verification, publication flush, backup cleanup, temporary cleanup, then resource cleanup; a held root-descriptor close failure is structured resource cleanup. Deferred cleanup is included so every retained operation-owned alias has a safe recovery action. A later successful cumulative directory flush removes an earlier transient publication-flush failure. Repeating the same `init` operation with the same options when its instruction plans are unchanged revalidates the canonical plans and executes the verified containing-directory flush without broad-cleaning aliases. The implementation continues independent safe cleanup after a failure where doing so cannot destroy recovery state.

Error details never include instruction contents or absolute paths. `recoveryPaths` is the sole generated-name exception: it is an ordinal-sorted, bounded list of exact repository-relative current-operation aliases still proved against held descriptor state. It excludes historical aliases, collisions, and concurrent successors.

## Component boundaries

- `src/instructions.ts` owns the publication state machine, operation-owned identities, cleanup sequencing, and post-commit error construction.
- `src/errors.ts` remains the central authority for mapping causes to `IO_ERROR` or `INTERNAL_ERROR`; it accepts safe details when wrapping a cause.
- `src/init.ts` continues to orchestrate initialisation without understanding instruction publication internals.
- `test/init.test.ts` exercises public outcomes and narrow fault seams. No new public API is introduced.

## Verification

The focused tests cover:

- exact successful bytes and mode with no operation-owned temp, backup, or delete aliases;
- preservation of historical aliases;
- structured committed backup-cleanup, directory-flush, and temporary-cleanup failures;
- exact destination collisions, repository-root replacement, source and destination swaps, temporary-path replacement, byte-identical predecessor replacement, and race-indicative disappearance;
- backup-path replacement and old-descriptor mutation containment;
- exact pre-publication restoration;
- backup-before-unlink and publication-before-cleanup flush ordering, including transient flush recovery;
- restrictive recovery-copy creation followed by preserved final mode;
- exact planned and predecessor byte checks while staged or recovered state remains private;
- descriptor ownership across post-open authority failure and read-only predecessor holds;
- restored-canonical durability, last-staged-alias recovery, and fixed-root redirection protection without unrelated-name false positives;
- complete ordered safe failure details, aggregate identity classification, exact retained-alias cardinality, and repository-relative recovery paths;
- deterministic retry with one managed block and an executable all-unchanged durability flush;
- platform-capability handling for restrictive modes and directory fsync, deterministic ordinal recovery paths, and the precisely bracketed pathname-link/unlink boundary.

The branch must also pass lint, all TypeScript projects, the full unit suite, both benchmark gates, build, package checks, publish-contract checks, and frozen Bun installation without changing `bunfig.toml` or plaintext `bun.lock`.
