# FTS Text Integrity Design

**Ticket:** MAR-2550
**Date:** 2026-08-17
**Status:** Implemented

## Goal

Treat each cached FTS row as a derived projection of its validated cached record. A cache generation is compatible only when every `record_search` row has the exact UTF-8 bytes emitted by the canonical search-document projection for the record with the same ID.

## Existing guarantees

- Cache schema, metadata, records, FTS rows, freshness, and the requested public read share one verified SQLite read transaction.
- Numeric-only FTS probes run before text transfer and observe at most 1,001 rows.
- Accepted FTS rows are bounded to 255 ID bytes, 2,105,344 text bytes per row, 1,000 rows, and 24,969,216 aggregate text bytes.
- A semantic cache mismatch quarantines the exact database generation, rebuilds once from canonical records, and retries once.

## Design

`searchDocumentForRecord` remains the single writer and validator authority.

After cached `record_json` values have been bounded, parsed, and cross-checked against their materialised `records` columns:

1. Build a bounded map from the UTF-8 bytes of each validated record ID to the UTF-8 bytes of `searchDocumentForRecord(record)`.
2. Retain the existing numeric FTS probe before any FTS ID or text bytes are transferred.
3. Iterate at most 1,001 rows as `CAST(id AS BLOB)` and `CAST(text AS BLOB)`.
4. Require each row ID to identify one unmatched validated record and require exact byte equality with that record's expected search document.
5. Delete each matched ID from the map and require the map to be empty after iteration.

The bounded byte loop subsumes the existing count, distinct-ID, missing-row, and orphan-row query. Byte comparison is required because malformed SQLite text may decode to the same JavaScript replacement character as valid UTF-8.

## Failure and recovery

Any missing, orphaned, duplicated, invalidly encoded, or text-mismatched FTS row raises the existing fixed-content `CacheSchemaMismatch`. IDs, FTS text, record payloads, and absolute paths never enter the public error or cause chain. Existing exact-generation quarantine, one rebuild, one retry, `CACHE_SCOPE_MISMATCH`, and operational SQLite error policies remain unchanged.

## Boundaries and non-goals

- The authority is the validated cached `records.record_json` projection. Equality between cached JSON and canonical files remains MAR-2571.
- No Unicode, whitespace, JSON, or token normalisation is applied.
- FTS posting/shadow-index checksum validation is not implied by row-text equality and remains out of scope.
- Cache schema, public APIs, canonical record formats, configurable budgets, and migration remain unchanged.

## Acceptance coverage

- Same-ID wrong text is recovered during a representative public read and forced hydration.
- Swapped valid texts remain bound to their exact IDs.
- Invalid UTF-8 bytes that decode like a valid replacement character are rejected by byte comparison.
- Existing missing, duplicate, orphan, type, per-row, aggregate, snapshot, retry, and privacy tests remain complementary coverage.

## Reviewed implementation provenance

The exact reviewed code and behavioural-test snapshot implementing this design is `ce00a6095270fe421361b2595d06622c194e7e4b`. Documentation changes do not alter the runtime API, package exports, cache schema, or generated declarations.
