# Partial Initialisation Progress Design

## Goal

Make every failed `initEncephalon` call state exactly which durable init commit points were reached, while preserving the failing subsystem's existing `EncephalonError` code and restart behaviour.

## Chosen approach

`init` remains a synchronous monotonic orchestration, not a cross-filesystem transaction. It records progress reported at the existing record and instruction commit points, decorates the final error once, and never compensates by deleting append-only records or reverting committed instruction changes.

This is preferred over:

- a new `PARTIAL_INITIALIZATION` error code, which would hide the original `IO_ERROR`, `REPOSITORY_CHANGED`, validation, or internal classification and expand the public error-code union;
- inferring commit state from error details or filesystem state after failure, which would duplicate subsystem knowledge and race with concurrent changes.

## Operation and commit points

The operation proceeds in this order:

1. Resolve and preflight the repository and both instruction files. A failure here commits nothing.
2. Scan and plan the baseline against one canonical snapshot.
3. Publish baseline records sequentially. Each successful canonical hard link is an irreversible record commit point.
4. Hydrate or prepare the disposable cache. Cache failure never changes canonical truth.
5. Apply the preflighted instruction plans in fixed `AGENTS.md`, `CLAUDE.md` order. Each instruction state machine reports its own write or removal commit point.
6. Complete operation-lock cleanup.

The first failure stops later authoritative mutations. Existing identity-bound cleanup may still run inside the failing subsystem.

## Component boundaries

- `src/records.ts` owns record publication and reports the exact record when its canonical hard-link commit point is reached. Its public add-record behaviour and post-commit error priority remain unchanged.
- `src/instructions.ts` owns instruction publication/removal, recovery aliases, post-commit error priority, and reports each exact file/action commit point. It does not expose plans, descriptors, aliases, or fault phases to init.
- `src/init.ts` owns the bounded cross-phase journal, phase transitions, cache-state description, recovery mode, and final error decoration.
- `src/errors.ts`, `src/types.ts`, and the public export surface do not gain a new error code or public result type.

The progress journal is held outside the operation-lock callback so a lock cleanup failure cannot erase already-reported commit points.

## Error contract

Every init failure preserves the underlying error code, message, cause, and existing safe detail fields. It adds exactly one `initProgress` object:

```ts
{
  phase:
    | 'preflight'
    | 'recordPublication'
    | 'cachePreparation'
    | 'instructionApplication'
    | 'operationCleanup',
  canonicalCommitted: boolean,
  committedRecordIds: string[],
  committedInstructionFiles: Array<{
    file: 'AGENTS.md' | 'CLAUDE.md',
    action: 'updated' | 'removed'
  }>,
  cacheState: 'notAttempted' | 'disposable' | 'prepared',
  recoveryMode: 'rerun' | 'inspectAndRerun',
  recoveryAction: string
}
```

Rules:

- `canonicalCommitted` is true exactly when `committedRecordIds` is non-empty.
- Record IDs appear once, in deterministic publication order, including the current record when its link succeeded but a later record phase failed.
- Instruction actions appear once, in fixed file order, including the current file when its commit point succeeded but finalisation failed.
- `cacheState` becomes `disposable` when cache work starts or when a record commit makes an older cache stale. It becomes `prepared` only after hydrate/prepare returns successfully.
- Existing subsystem fields such as `postCommitPhase`, `postCommitFailures`, `recordId`, `filename`, and `recoveryPaths` remain intact and therefore retain secondary failure metadata.
- `inspectAndRerun` is used for identity uncertainty, internal failure, committed publication verification/durability/cleanup uncertainty, or retained instruction recovery paths. A deterministic cache rebuild or a later pre-commit failure uses `rerun`.
- Recovery text is selected from fixed phase/mode constants. Cache failure directs the caller to run `prepare`, then `validate`, then repeat the same init operation. Other failures direct the caller to resolve or inspect the reported state as required, then repeat the same init operation with the same options.

Preflight errors also receive this object with empty commit lists and `cacheState: 'notAttempted'`, making the absence of durable effects explicit.

## Safety and bounds

The journal contains only validated record IDs and the two fixed repository-relative instruction filenames/actions. It never contains subjects, payloads, instruction bytes, absolute paths, cache paths, raw causes, ownership tokens, stacks, or arbitrary filesystem names. Existing init baseline cardinality and the fixed two-file instruction set bound both arrays; CLI projection applies its existing object, array, and string limits.

Commit-point reporting describes events that were reached. After `REPOSITORY_CHANGED`, it does not assert that the same pathname incarnation is still current; that is why the recovery mode requires inspection.

## Restart semantics

Rerunning the same command always rescans and replans:

- already committed generated baseline subjects are recognised and not duplicated;
- a partial refresh resolver is not recreated, while unresolved subjects receive only their missing resolver;
- disposable cache state is rebuilt from canonical records;
- unchanged managed blocks are revalidated and durability-flushed;
- incomplete instruction application resumes from current file contents and creates no duplicate managed block.

No rollback or compensating deletion is introduced.

## Verification

The smallest complementary behavioural matrix covers:

- preflight failure with explicit empty progress and no mutation;
- failure before the second or third record commit, followed by a convergent rerun;
- a current record's post-link flush/verification failure, reported exactly once;
- cache failure after all record commits, with disposable-cache recovery and no instruction mutation;
- first instruction commit followed by a second-file pre-commit or post-commit failure;
- instruction plans made stale after record/cache work;
- partial parallel-head refresh repair followed by a convergent rerun;
- operation cleanup failure retaining all earlier progress;
- exact CLI JSON, exit-code preservation, deterministic order, and absence of private data.

Normal init, idempotent init, refresh, remove, package, and declaration tests remain regression gates.
