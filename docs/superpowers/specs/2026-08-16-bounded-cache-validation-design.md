# Bounded Cache Validation Design

## Goal

Treat every SQLite cache value as untrusted without allowing a corrupt disposable cache to force unbounded JavaScript row or text materialisation. Cache validation must prove bounded structure, types, and byte sizes before transferring text, operate within one SQLite snapshot, quarantine the exact corrupt database generation, rebuild once from canonical JSON, and retry the original operation once.

Successful recovery remains transparent. Public API signatures and successful results do not change.

## Chosen approach

Add one dependency-free canonical budget authority and keep cache-integrity orchestration in `src/cache.ts`. Validation uses two phases in one SQLite read transaction:

1. numeric-only SQL probes over nested queries bounded with `LIMIT maximum + 1`;
2. bounded `.iterate()` text reads only after every probe succeeds.

This is preferred over extracting a cache-integrity module because cache validation depends on cache schema, record parsing, canonical paths, summaries, SQLite opening, and recovery policy. Moving those dependencies would deepen the existing cache/records cycle without creating an independently useful component. It is also preferred over patching only the current metadata and record `.all()` calls, which would leave schema, FTS, snapshot, and exact-generation recovery gaps.

The implementation does not truncate corrupt data, stream partial cache results, migrate cache schema, or make SQLite canonical.

## Canonical budget authority

Create `src/canonical-budgets.ts` as an import-free internal authority:

```ts
export const CANONICAL_BUDGETS = Object.freeze({
  recordBytes: 1024 * 1024,
  recordJsonBytes: 8 * 1024 * 1024,
  records: 1000,
} as const)
```

`src/schema.ts` and `src/records.ts` derive and continue to expose their existing internal aliases from this authority. `src/cache.ts` imports the authority directly, avoiding the existing `cache.ts`/`records.ts` dependency cycle. The authority is not exported through `src/index.ts` and does not change the package API.

Cached record JSON contains the runtime `path` field that canonical files omit. Cache validation therefore permits the existing fixed 4 KiB derived overhead per record:

```ts
const MAX_CACHE_RECORD_OVERHEAD_BYTES = 4096
const MAX_CACHE_RECORD_BYTES = CANONICAL_BUDGETS.recordBytes + MAX_CACHE_RECORD_OVERHEAD_BYTES
const MAX_CACHE_RECORD_JSON_BYTES =
  CANONICAL_BUDGETS.recordJsonBytes + CANONICAL_BUDGETS.records * MAX_CACHE_RECORD_OVERHEAD_BYTES
```

The maximum is 12,484,608 bytes (8 MiB + 1,000 × 4 KiB) for 1,000 cached records. It preserves every valid canonical corpus while remaining fixed and memory-bounded. It is not a new canonical allowance.

## Numeric probe contract

Every probe reads at most one result row containing only bounded counts and exact `0 | 1` flags. It must not return stored SQLite integers, byte lengths, text, blobs, or aggregate values that a hostile database can make unsafe for Node's SQLite conversion.

Each table probe follows this shape:

```sql
SELECT
  COUNT(*) AS row_count,
  CASE WHEN TOTAL(invalid_type) > 0 THEN 1 ELSE 0 END AS has_invalid_type,
  CASE WHEN TOTAL(oversized) > 0 THEN 1 ELSE 0 END AS has_oversized_value,
  CASE WHEN TOTAL(bounded_bytes) > ? THEN 1 ELSE 0 END AS exceeds_aggregate_bytes
FROM (
  SELECT
    CASE WHEN ... THEN 0 ELSE 1 END AS invalid_type,
    CASE WHEN ... THEN 0 ELSE 1 END AS oversized,
    CASE WHEN ... THEN length(CAST(value AS BLOB)) ELSE 0 END AS bounded_bytes
  FROM untrusted_table
  LIMIT ?
)
```

The inner `LIMIT` is mandatory. `COUNT(*) ... LIMIT ?` without the nested bounded selection is invalid because SQLite applies the limit after aggregation and still scans the complete hostile table.

All byte measurements use `length(CAST(value AS BLOB))`. SQLite text length stops at embedded NUL, while BLOB length measures the complete stored byte sequence. Probe results must be safe non-negative integers within the query's fixed result range, and flags must be exactly `0` or `1`; anything else is cache corruption.

Narrow internal test hooks may observe only the probe name, bounded row count, and fixed flags. A separate hook immediately before bounded text iteration proves that overflow generations are rejected without transferring text. Hooks are internal, reset between tests, and excluded from public declarations.

## Schema probes

Schema validation remains semantically unchanged in this ticket. MAR-2553 still owns primary-key, nullability, index, and FTS option semantics.

Before reading column names, query the table-valued `pragma_table_info(?)` through a numeric-only probe limited to the expected column count plus one. Column names must be text and no longer than the longest valid expected name for that table. Only a successful probe may iterate at most the expected count plus one bounded names and apply the existing exact ordered-name comparison.

Before reading `sqlite_master.sql` for `record_search`, probe its type and BLOB byte length with `LIMIT 2` and a fixed 4 KiB maximum. Only then read the one bounded SQL value and retain the existing FTS5 check. This bounds untrusted schema text without expanding schema validation scope.

## Metadata validation

The metadata probe reads at most `METADATA_KEYS.length + 1`, currently seven, rows. It proves before transfer that:

- keys and values are SQLite text;
- each key fits the longest expected metadata key;
- each value is at most the existing 1 MiB maximum;
- the aggregate value bytes are at most six times that fixed maximum.

Seven rows are corruption and stop validation before text iteration. A successful probe permits bounded iteration of at most seven rows. The existing exact six-key set remains required; unknown, missing, or duplicate keys are corruption.

`recordsIndexed` must use canonical unsigned decimal syntax `^(?:0|[1-9]\d*)$`, then parse to a safe integer from zero through 1,000. Signs, fractions, exponent notation, whitespace, leading zeroes, blobs, and unsafe integers are corruption. `artifactPaths` remains JSON text, contains at most 1,000 entries, and every path retains the existing validation.

`repositoryRealpath` is read only after the metadata probe. A valid bounded value belonging to a different repository continues to throw `CACHE_SCOPE_MISMATCH`; it is not disposable corruption and must never trigger quarantine or rebuild.

## Record validation

The record probe reads at most 1,001 rows and proves before text transfer that:

- `id`, `kind`, `subject`, `source`, `created_at`, `path`, and `record_json` are text;
- `active` is the SQLite integer `0` or `1` without returning the stored integer to JavaScript;
- `summary` is either null or text;
- every materialised text column is individually bounded;
- every `record_json` is at most `MAX_CACHE_RECORD_BYTES`;
- aggregate `record_json` bytes do not exceed `MAX_CACHE_RECORD_JSON_BYTES`;
- aggregate bytes across all denormalised record text do not exceed twice `MAX_CACHE_RECORD_JSON_BYTES`.

The twice-JSON bound is derived cache overhead: denormalised columns duplicate values already represented in `record_json`. It bounds malicious duplicated text without adding a separate public field budget.

Any 1,001-row probe, count mismatch with metadata, invalid type, per-value overflow, or aggregate overflow is corruption before text iteration. A successful probe permits `.iterate()` over at most 1,001 rows in deterministic row order. The existing record JSON parser, runtime-path check, column equality checks, supersession activity calculation, and summary equality checks remain authoritative.

## FTS validation

The FTS probe reads at most 1,001 `record_search` rows and proves before existing relationship queries that:

- `id` and `text` are SQLite text;
- each ID is bounded by the existing 255-byte portable path-component maximum;
- aggregate ID bytes do not exceed `CANONICAL_BUDGETS.records * 255`;
- each FTS text value is at most twice `MAX_CACHE_RECORD_BYTES`;
- aggregate FTS text bytes do not exceed twice `MAX_CACHE_RECORD_JSON_BYTES`;
- the row count does not exceed 1,000 and matches metadata.

The doubled bounds are conservative derived-cache overhead: `searchDocumentForRecord` intentionally duplicates searchable fields already represented in the record JSON, including the payload summary. They admit every valid search document without increasing the canonical record or corpus budgets. Only after that probe succeeds may the existing distinct-ID, missing-row, and orphan-row queries execute over the now-bounded table. MAR-2550 owns semantic equality between FTS text and canonical cached records; this ticket bounds type, count, and bytes only.

## Snapshot and database identity

Schema probing, metadata validation, record validation, FTS validation, freshness decisions, and the eventual public cache read must share one SQLite transaction. Reader paths begin the transaction before validation and roll it back after producing the complete in-memory result. Preparation paths also validate freshness within an explicit read transaction.

Validation executes through `openVerifiedCacheDatabase`'s verified-open boundary so a schema or content failure retains the exact final-verified `CacheDatabase` primary and observed sidecar identities. Forced writer paths retain that identity for every recoverable SQLite failure during metadata reads, transactions, and writes; terminal Encephalon errors and repository-change handling remain unchanged. No detached pre-open or pathname-only inspection substitutes for the captured database generation, and a primary error remains authoritative if database close also fails.

The transaction prevents a concurrent writer from changing rows between numeric probes and bounded text iteration. Existing filesystem-location and sidecar verification remains in force around database opening and operation-lock boundaries.

## Recovery policy

One internal recovery coordinator owns disposable-cache recovery for prepare, forced hydration, every read API, and the post-commit add/init paths that already hold the operation lock.

On the first recoverable cache failure it:

1. acquires the existing operation lock or uses the caller's already-held lock, then revalidates the held cache location;
2. quarantines the exact captured `brain.sqlite` identity and its observed sidecars when the failure carries that identity;
3. represents disappearance after an existence observation at any pre-verification boundary distinctly, rechecks under the lock, and exclusively claims an absent primary; the claim is owned immediately, so replacement or disappearance before its first SQLite open becomes a creation conflict, while a successor that wins the initial creation race is preserved and retried without quarantine or writer initialisation;
4. rebuilds at most once from a newly validated canonical record snapshot, retaining the successfully claimed primary's exact device and inode across internal repository-change retries and preserving any replacement as a creation conflict;
5. returns a completed recovery rebuild directly for prepare and forced hydration, while reads or preserved-successor paths retry once.

A second validation or recovery failure never causes another rebuild. It follows the existing SQLite category and I/O wrapping policies, returning bounded `IO_ERROR` or `INTERNAL_ERROR` without cache keys, values, record JSON, FTS text, paths from corrupt rows, or private sentinels. Malformed cache JSON and metadata are normalised without retaining V8's parser cause because that cause can contain excerpts of the untrusted source.

`CACHE_SCOPE_MISMATCH`, `REPOSITORY_CHANGED`, busy/locked contention, unknown SQLite failures, and operational I/O errors retain their current fail-closed policies. A valid foreign cache is never quarantined as disposable corruption. No stale or partially validated row is returned before, during, or after recovery.

## Component boundaries

- `src/canonical-budgets.ts` owns dependency-free canonical numeric limits.
- `src/schema.ts` derives the existing per-record limit.
- `src/records.ts` derives existing corpus record and byte limits.
- `src/cache.ts` owns cache-specific overhead, bounded SQL probes, text iteration, snapshot orchestration, cache semantics, and one-rebuild recovery.
- `src/cache-location.ts` continues to own no-follow database/sidecar identity and quarantine operations.
- `src/sqlite-error.ts` and `src/errors.ts` retain SQLite classification and public wrapping policy.

No public type, package export, cache schema, canonical file, or CLI contract changes.

## Verification

The smallest complementary behavioural matrix covers:

- seven metadata rows and 1,001 records/FTS rows generated with recursive SQL, proving `maximum + 1` rejection before text iteration;
- oversized metadata, `record_json`, and FTS text created with `CAST(zeroblob(?) AS TEXT)`, including leading NUL, proving BLOB byte-length probes and avoiding oversized JavaScript fixtures;
- individually bounded record rows whose aggregate cached JSON exceeds 12,484,608 bytes (8 MiB + 1,000 × 4 KiB);
- canonical and noncanonical `recordsIndexed` encodings, including negative, fractional, exponent, leading-zero, whitespace, blob, and over-limit values;
- hostile SQLite integer and blob values in `active` and FTS IDs without leaking `ERR_OUT_OF_RANGE`;
- a concurrent SQLite writer attempt between probe and text iteration, proving one pinned read snapshot;
- one representative public read proving exactly one quarantine/rebuild, one canonical result, and no duplicate serving;
- injected recovery I/O failure proving one attempt, no stale result, bounded public classification, and no private sentinel in message, cause, or details;
- valid `CACHE_SCOPE_MISMATCH` proving zero quarantine attempts;
- public hydrate, forced gather hydration, post-commit add hydration, and init cache preparation recovering real not-a-database writer opens under their correct lock ownership without a second forced rebuild;
- the same forced and lock-held routes quarantining malformed metadata rather than overwriting it in place;
- observed-missing races proving an absent primary rebuilds without quarantine while a current successor is retried and preserved without quarantine;
- repository-change retries retaining an exclusively claimed primary while preserving an exact successor swapped before a later writer open;
- deterministic SQLite read-only classification at the verified database boundary, plus the truthful capability-gated physical read-only case;
- exact-boundary controls for metadata rows, 1,000 self-consistent records and FTS rows, exact per-value bytes, exactly 12,484,608 aggregate cached-record JSON bytes, `recordsIndexed = '1000'`, and one public limited read from the accepted generation.
- a valid large payload summary served through public add, prepare, list, and search at the doubled FTS search-document bounds;
- query-time SQLite corruption during forced writer work proving exact quarantine, one recovery rebuild, and a completed result;
- replacement of an exclusive claim before its first SQLite open and disappearance at pre-verification boundaries, proving typed held-lock recovery and successor preservation;
- forced hydration of a valid foreign-scope cache proving `CACHE_SCOPE_MISMATCH`, zero quarantine or rebuild, and unchanged database identity and bytes.

Existing malformed-record recovery coverage already exercises list, show, full search, compact search, and gather. New corruption mechanics therefore use `prepare` plus one representative read rather than duplicating every API × corruption combination. No CLI tests are needed because the CLI adds no cache-validation boundary.

The complete lint, four-project typecheck, full test, benchmark, build, package, publish-contract, frozen-install, cross-platform CI, declaration, Bun configuration, and plaintext lockfile gates remain required.

## Scope exclusions

- Semantic SQLite schema validation remains MAR-2553.
- FTS text equality remains MAR-2550.
- Cached JSON equality with canonical files remains MAR-2571.
- Per-operation cache-generation memoisation remains MAR-2552.
- Compact and gather response-byte budgets remain MAR-2554.
- Incremental hydration, pagination, streaming, schema migration, configurable budgets, and new canonical storage remain out of scope.

## Reviewed implementation provenance

The exact reviewed code and behavioural-test snapshot implementing this design is `fa5c1688c274b4f0f8fdc94ea102ed6cb1f0a4dd`. Documentation changes do not alter the runtime API, package exports, cache schema, or generated declarations.
