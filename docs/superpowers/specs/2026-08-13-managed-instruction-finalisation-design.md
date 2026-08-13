# Managed Instruction Finalisation Design

## Scope

MAR-2547 completes successful replacements of root `AGENTS.md` and `CLAUDE.md` files. A normal replacement must leave the new canonical file and no alias created by that operation. Failures after publication must preserve the new target and report that publication committed, while failures before publication must preserve the exact original bytes or an exact recovery copy.

Public method signatures, the managed block format, deletion behaviour, and cleanup of historical aliases remain unchanged. The implementation must not discover or remove unrelated files merely because their names resemble Encephalon aliases.

## State machine

Each write has four states:

1. **Prepared** — an exclusive generated temporary path contains the fully written and flushed new bytes. Its descriptor remains the authority for the staged file.
2. **Recovery held** — for an existing target, the original path is renamed to an operation-owned backup. A no-follow descriptor and stable pathname observation bind that exact predecessor to the operation. Before publication, this backup is the recovery authority.
3. **Committed** — `linkSync(tempPath, targetPath)` succeeds. This is the publication commit point. From this point forward the implementation never restores the predecessor over the canonical target.
4. **Finalised** — the canonical path still identifies the staged file; the exact backup is renamed to a fresh operation-owned cleanup alias, revalidated against its held descriptor, and unlinked; the temporary alias is removed; and the containing directory is flushed where supported.

Backup finalisation uses an identity-bound quarantine instead of a pathname-only check followed by unlink. A successor placed at the original backup pathname after quarantine is therefore preserved. Node does not expose descriptor-relative conditional unlink or a cross-platform no-replace rename, so no test hook or other fallible work is inserted between the final cleanup-alias identity check and its unlink. The remaining same-user final-syscall window is documented rather than hidden behind a broader cleanup mechanism.

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
    | 'temporaryCleanup',
  recoveryAction: string,
}
```

Publication or pathname-identity uncertainty is `REPOSITORY_CHANGED`. Recognised operational filesystem failures are `IO_ERROR`; unexpected faults remain `INTERNAL_ERROR`. When more than one post-commit phase fails, the reported priority is publication verification, publication flush, backup cleanup, then temporary cleanup. The implementation continues independent safe cleanup after a failure where doing so cannot destroy recovery state.

Error details never include instruction contents, absolute paths, or generated alias tokens.

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
- backup-path replacement and old-descriptor mutation containment;
- exact pre-publication restoration;
- deterministic retry with one managed block;
- platform-specific descriptor races only where the filesystem capability supports them.

The branch must also pass lint, all TypeScript projects, the full unit suite, both benchmark gates, build, package checks, publish-contract checks, and frozen Bun installation without changing `bunfig.toml` or plaintext `bun.lock`.
