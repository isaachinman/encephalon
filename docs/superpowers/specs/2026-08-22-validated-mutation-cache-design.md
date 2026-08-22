# Validated Mutation Cache Design

**Ticket:** MAR-2565
**Date:** 2026-08-22
**Status:** Approved

## Goal

Rebuild disposable cache state from the canonical record snapshot already parsed and validated by `addRecord` or `init`, without weakening record, graph, artifact, repository, cache-location, transaction, recovery, or post-commit guarantees. A stable mutation performs one canonical scan and one strict graph validation. Any uncertainty discards the optimisation and uses the existing bounded disk rebuild.

## One final mutation snapshot

`records.ts` separates raw canonical acquisition from strict final validation. The raw planning snapshot retains parsed records, byte accounting, record observations, canonical directory witnesses, and a publication authority, but it is not cacheable. Add and init build their complete candidate records and run one strict validation over that final graph. Validation returns the frozen artifact observations that are currently computed and discarded.

The cacheable internal snapshot contains only:

- the actual timestamped records that were published;
- artifact observations derived from the strictly validated candidate graph;
- the captured repository realpath from the locked cache location;
- a canonical-authority callback that binds the rows to record digests, record identities, directory generations, and the same cache location.

The fixed-width placeholder timestamps used for pre-ceiling error ordering are never written to SQLite. Their substitution is confined to mutation orchestration: IDs, paths, payloads, artifact paths, graph edges, and formatted byte length are identical, while publication authority binds the actual formatted record bytes.

## Snapshot acceptance

The mutation rebuilder accepts the snapshot only after all record publications and staging cleanup have completed. It then:

1. revalidates canonical publication authority;
2. reinspects every artifact with the existing no-follow descriptor verifier and compares its full stable identity with the retained observation;
3. computes the expected post-publication manifest from the accepted record generation and artifact observations;
4. repeats canonical and artifact identity checks around that enumeration;
5. passes the bound rows, observations, manifest, and captured repository realpath to the shared writer.

The snapshot is invocation-local. A canonical identity, artifact identity, repository realpath, or manifest mismatch marks it permanently discarded. All subsequent work in that invocation uses ordinary disk validation; supplied rows and fallback observations are never mixed. Operational filesystem or SQLite failures retain their existing classification rather than becoming false repository-change fallbacks.

## Shared transactional writer

`cache.ts` extracts the current writer portion of `rebuildCache` without changing its policy. Both disk and mutation paths call the same private writer for:

- cache-primary identity and existing schema/content checks;
- active-head projection, record JSON, summaries, and FTS text;
- metadata using the captured repository realpath;
- `BEGIN IMMEDIATE`, replacement, rollback, commit, and close-error precedence;
- a fresh full record/artifact manifest comparison inside the transaction.

The writer returns either a committed rebuild or a repository-change result carrying the next exact writer-primary identity. The mutation rebuilder passes that identity into the ordinary bounded rebuild so a created or expected-owned cache generation is never lost across fallback.

## Recovery and callers

Disposable-cache recovery and preparation receive one invocation-scoped rebuilder instead of hard-coding disk `rebuildCache`. Stable corrupt or missing cache recovery therefore quarantines or claims the exact cache and revalidates the mutation snapshot before writing it. Once discarded, the same closure uses only disk rebuilds.

Mutating add and init use forced snapshot hydration. Idempotent non-refresh init supplies its strictly validated snapshot to prepare, allowing a missing, stale, or corrupt cache to rebuild without another canonical parse while preserving the fresh-cache fast path. Refresh cases with no additions retain the existing allowed-generated-multihead preparation path rather than treating a relaxed planning graph as cacheable.

## Error and compatibility boundaries

No public API, CLI result, cache schema, canonical JSON, manifest format, operation budget, ranking, active-head, or package export changes.

Backwards compatibility is a release invariant: existing valid repositories, records, instruction files, caches, and clients must continue to work without migration or data loss. This ticket may change only the explicitly specified cache-construction performance path; it must not remove or rename public fields or codes, narrow documented valid inputs, or change successful output semantics. Any conflict discovered during implementation blocks release until the plan is amended and reviewed.

- Add still skips cache work only after `publicationFlush` failure and preserves `publicationVerification > publicationFlush > cacheHydration > stagingCleanup`.
- Every snapshot, writer, fallback, or recovery failure after add publication remains inside `capturePostCommitError('cacheHydration', error)` with the same committed record ID, path, code, cause, and recovery action.
- Init sets `phase: cachePreparation` and `cacheState: disposable` before snapshot cache work, retains committed IDs in publication order, and preserves the failing subsystem's code and details.
- The existing bounded disk rebuild remains the sole fallback authority for changed or invalid current canonical state.

## Acceptance evidence

- Runtime hooks prove stable add, initial init, idempotent init, and changed refresh use one canonical scan/strict graph pass and no disk cache validation.
- Logical SQLite metadata, record rows, and FTS rows from snapshot hydration match a forced disk hydrate.
- Record and byte-identical artifact replacements at the post-publication boundary discard the snapshot and rebuild from current disk state exactly once.
- Corrupt-cache recovery revalidates and reuses a stable snapshot after quarantine.
- A real shared-writer failure preserves committed add details and later `prepare` recovery.
