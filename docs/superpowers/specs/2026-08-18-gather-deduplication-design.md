# Gather Deduplication Design

**Ticket:** MAR-2560
**Date:** 2026-08-18
**Status:** Implemented

## Goal

Evaluate each exact distinct gather show ID and original search query once per accepted SQLite snapshot while preserving every public output occurrence, ordering rule, response-budget charge, and recovery boundary. Each distinct non-empty query executes against SQLite at most once; zero-term queries perform no `MATCH` work.

## Snapshot-local memoisation

`readGatherFromDatabase` owns two invocation-local maps inside the verified SQLite read callback:

- `Map<string, BrainRecord | null>` for exact validated show IDs;
- `Map<string, readonly CompactBrainRecord[]>` for exact original query strings.

The maps are created anew for every read callback. A disposable-cache recovery retry therefore cannot reuse values from a rejected database generation. Shows are never keyed by path or record identity, and searches are never keyed by their normalised FTS expression: textually distinct queries remain distinct work even when they compile to the same `MATCH` value.

Only fully parsed and materialised values enter a map. Missing shows and zero-term searches are retained as real memo entries, using `Map.has` to distinguish a cached absence from a miss. Raw SQLite rows, statements, iterators, database handles, and partial search results never escape the verified transaction.

## Independent output and response accounting

The first successfully materialised occurrence may serve as the memo template while the synchronous response is assembled. Later occurrences are cloned from that template, so no two public occurrences share mutable state.

- Every repeated non-null shown record is deep-cloned; `null` is reused as an immutable value.
- Every repeated compact result receives a fresh array and fresh compact-record objects. Compact records contain only scalar or null values, so a shallow record clone is sufficient.
- The first search execution retains the existing bounded validate-then-charge-then-retain order. A memo entry is installed only after the complete search succeeds.
- Every memo hit is cloned and charged through the same gather ledger before it enters the response.

The established deterministic charge order remains: root gather skeleton; every show envelope; every search envelope; every compact result row. Duplicate and missing outputs continue to consume their full logical response size, so exact 4 MiB success and one-byte overflow behaviour do not change.

## Orchestration and compatibility

The existing show and compact-search readers remain the database authorities and continue to own prepared statements, row parsing, bounded iteration, ranking, snippets, and execution hooks. Gather adds only snapshot-local memo lookups around those readers. It does not prefetch unique keys or reorder work: all shows still precede searches, and first occurrences execute in input order.

No public API, CLI shape, cache schema, canonical record, search semantics, operation budget, error code, or recovery policy changes. Empty-only gather remains eligible for the existing pre-repository fast path. Mixed gather skips SQLite work for zero-term searches while preserving their envelopes.

## Performance evidence

The existing gather benchmark becomes duplicate-heavy without changing the report schema: each measured gather emits the public maxima of 64 show envelopes from two repeated exact IDs and 16 search envelopes from two repeated exact queries. Hook-count behavioural tests are the deterministic work bound; benchmark median and p95 distributions remain descriptive and the established CI ceilings remain authoritative.

## Acceptance coverage

- One dense gather case proves exact-key evaluation counts for present, missing, non-empty, textually distinct equivalent, and zero-term duplicates, plus SQLite execution counts for non-empty queries, while preserving order and independent mutable results.
- One recovery case fails after partial memo population and proves the rebuilt retry re-executes each exact distinct key from a fresh map.
- Existing exact response-boundary tests prove duplicate memo hits are charged for every output occurrence.
- Existing WAL snapshot, corruption recovery, statement reuse, zero-I/O, ranking, snippet, and missing-result tests remain complementary.

## Reviewed implementation provenance

The exact implementation and behavioural-test snapshot is `36091c7e886b67b5c5bc355e6bcdb078f9a74f85`. Documentation does not change the public API, package exports, cache schema, canonical records, or operation budgets.
