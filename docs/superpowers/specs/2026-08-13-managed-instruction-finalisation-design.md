# Managed Instruction Finalisation Design

## Scope

MAR-2547 completes successful replacements of root `AGENTS.md` and `CLAUDE.md` files. A normal replacement must leave the new canonical file and no alias created by that operation. Failures after publication must preserve the new target and report that publication committed, while failures before publication must preserve the exact original bytes or an exact recovery copy.

Public method signatures, the managed block format, deletion behaviour, and cleanup of historical aliases remain unchanged. The implementation must not discover or remove unrelated files merely because their names resemble Encephalon aliases.

## State machine

Each write has four states:

1. **Prepared** — a no-follow repository-root authority is current, and an exclusive generated temporary path contains the fully written and flushed new bytes. Its descriptor remains the authority for the staged file. Every controlled pathname mutation hands the authority to the next exact directory generation.
2. **Recovery held** — for an existing target, a no-follow descriptor is acquired before any pathname is removed and must match the preflight bytes and original filesystem incarnation, apart from an allowed mode change. The operation hard-links the predecessor to an exclusive backup path, verifies that destination against the descriptor, flushes the directory where supported, revalidates the source, and unlinks the canonical predecessor. Before publication, this backup is the recovery authority.
3. **Committed** — after the temporary path is revalidated against its staged descriptor, `linkSync(tempPath, targetPath)` succeeds. This is the publication commit point. The canonical and temporary aliases are verified and the directory is flushed before recovery state is removed. From this point forward the implementation never restores the predecessor over the canonical target.
4. **Finalised** — the canonical path still identifies the staged file; the exact backup is hard-linked to a fresh exclusive cleanup alias, the new alias is verified, and the source is revalidated immediately before source unlink. The cleanup alias is then verified and unlinked, the exact temporary alias is removed, and the containing directory is flushed again where supported.

Every alias move uses no-replace hard-link-and-unlink steps rather than rename. Each newly linked destination is verified against the held descriptor, and the source and root generation are revalidated before source unlink. A successor placed at the original backup pathname is therefore preserved. If exact pre-commit restoration cannot be proved, an exact recovery alias is retained; a descriptor recovery copy is created privately at mode `0600`, populated, given the predecessor's preserved final mode, flushed, and verified before it becomes recovery authority. Node does not expose descriptor-relative conditional unlink, so the remaining same-user final-pathname-syscall window is documented rather than hidden behind a broader cleanup mechanism. Windows retains the same identity and zero-alias success contract while directory fsync remains best effort where unsupported.

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
  postCommitFailures: Array<{
    postCommitPhase:
      | 'publicationVerification'
      | 'publicationFlush'
      | 'backupCleanup'
      | 'temporaryCleanup',
    recoveryAction: string,
  }>,
}
```

Publication, root-generation, or pathname-identity uncertainty is `REPOSITORY_CHANGED`; race-indicative `ENOENT` and `ENOTDIR` at witnessed alias boundaries have that classification rather than `IO_ERROR`. Recognised operational filesystem failures are `IO_ERROR`; unexpected faults remain `INTERNAL_ERROR`. The primary phase and the bounded, distinct failure list use priority order publication verification, publication flush, backup cleanup, then temporary cleanup. Deferred cleanup is included so every retained operation-owned alias has a safe recovery action. A later successful cumulative directory flush removes an earlier transient publication-flush failure. The implementation continues independent safe cleanup after a failure where doing so cannot destroy recovery state.

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
- exact destination collisions, repository-root replacement, source and destination swaps, temporary-path replacement, byte-identical predecessor replacement, and race-indicative disappearance;
- backup-path replacement and old-descriptor mutation containment;
- exact pre-publication restoration;
- backup-before-unlink and publication-before-cleanup flush ordering, including transient flush recovery;
- restrictive recovery-copy creation followed by preserved final mode;
- complete ordered safe failure details and exact retained-alias cardinality;
- deterministic retry with one managed block;
- platform-specific descriptor races only where the filesystem capability supports them.

The branch must also pass lint, all TypeScript projects, the full unit suite, both benchmark gates, build, package checks, publish-contract checks, and frozen Bun installation without changing `bunfig.toml` or plaintext `bun.lock`.
