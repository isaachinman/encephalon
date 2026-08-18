# Single-Pass Cache Read Design

## Goal

Each successful list, show, full-search, compact-search, or gather operation that reads cached data must fully validate one cache generation once and materialise its bounded result from the same verified SQLite transaction. Zero-term operations that deliberately return before cache preparation remain the explicit exception. This removes redundant work without weakening exact-generation recovery, repository freshness, or snapshot consistency.

## Boundaries

- Canonical JSON remains authoritative; SQLite remains disposable.
- The cache schema, public API, CLI output, error codes, response budgets, result ordering, and search semantics do not change.
- Validation is never memoised by pathname, device, or inode. WAL commits may change logical content without replacing the primary file identity.
- Statements, iterators, database handles, and unbounded partial results never escape the verified read transaction.

## Prepared-read state machine

One private preparation resolver accepts either a prepare completion or a result-reader completion.

1. It inspects the expected cache primary.
2. If a generation exists, one verified read transaction checks schema, metadata, repository scope, manifest freshness, bounded records, and exact FTS projections.
3. A fresh prepare returns the existing `PrepareResult`. A fresh public read runs its bounded query and materialises the result before rollback in the same transaction.
4. A stale result runs the established operation-lock recheck. If still stale, the cache is rebuilt transactionally. A public read then opens that exact rebuilt database identity, validates it once, and materialises its result.
5. Missing or recoverably corrupt generations retain the existing one-quarantine, one-rebuild, one-retry policy. The rejected predecessor may be validated once and the successful replacement once; the successful generation is not validated twice. A successor or newly stale generation observed after rebuilding is preserved and reported as `REPOSITORY_CHANGED`, never rebuilt again by the same read.

The outer disposable-cache recovery wrapper remains the sole retry owner. One invocation-scoped state carries only the successful rebuild's verified database identity into the final read, so ordinary reads and forced gather hydration share the same one-rebuild ceiling. Valid foreign-scope caches, repository changes, busy or locked contention, operational I/O, response-budget errors, and unknown failures retain their existing terminal classifications.

## Snapshot and lifecycle guarantees

The verified database identity is captured around SQLite open. `BEGIN` precedes validation; the public result reader completes before `ROLLBACK`; and final database-path identity checks still decide whether the result is accepted. After a rebuild, both the open and final identity checks require the exact rebuilt primary. Rollback and close retain their established primary-failure precedence.

Literal search expressions remain computed exactly once before repository resolution. Empty full or compact searches and eligible empty-only gathers continue to return without repository or cache access.

## Performance evidence

The stripped benchmark instrumentation reports a complete validation boundary in addition to the existing result-read boundaries. A non-prepare benchmark child rejects any sample that observes other than one successful validation. Timing distributions remain descriptive: the 100-record comparison in `docs/performance.md` shows the removed pass directly, while CI continues to own only its established p95 total-time and cache-size ceilings.

## Behavioural evidence

- A table exercises list, show, full search, compact search, and mixed gather and observes one FTS integrity pass each.
- The 1,000-record exact-boundary fixture observes one successful integrity pass for its public list read.
- A WAL mutation at the first integrity pass proves validation and result materialisation use one snapshot.
- A semantic cache corruption produces one exact quarantine, one rebuild, two reader initialisations total, and the canonical result.
- Canonical mutation before the post-rebuild read reports `REPOSITORY_CHANGED` after exactly one writer initialisation.
- Replacing a recovered primary with a valid stale successor preserves that successor byte-for-byte and reports `REPOSITORY_CHANGED` after one recovery rebuild.
- Punctuation-only searches observe no repository, cache-location, or integrity work.
- Reintroducing prepare-then-read orchestration makes all three focused single-pass tests fail.

## Reviewed implementation provenance

The exact code and behavioural-test snapshot implementing this design is `5f0b8e53381d8308a5d1e46a0b0f4626d11aa47c`. Documentation changes do not alter runtime behaviour, package exports, cache schema, or generated declarations.
