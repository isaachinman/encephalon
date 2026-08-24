# Stable Canonical Generation Design

**Ticket:** MAR-2575
**Date:** 2026-08-24
**Status:** Implemented
**Implementation snapshot:** `9127ad98cb3d1e00edd54e8d81a0788c7fd56e83`

## Goal

Make every canonical read, validation, add, initialisation, and cache rebuild consume one proven-stable canonical generation. A successful result must include every accepted canonical entry from that generation, while a mutation must prove the planned generation is still current immediately before publication and that the committed result is exactly the planned delta.

## Compatibility boundary

This change is backwards compatible. It preserves the synchronous public API, successful result shapes, canonical JSON and artifact layouts, cache schema version `1`, cache manifest representation, package exports, existing valid repositories, and existing error codes. New error details are additive and appear only after a canonical record has already committed during a detected repository race.

Stable invalid repositories with no intervening change keep their existing validation results. Cache/read and no-add init also return the settled successor's ordinary validation after a one-off edit. Record-producing add/init retain the established path-free `REPOSITORY_CHANGED` mutation classification when an already-observed pre-link race settles on an invalid successor, so validation output does not depend on race timing. A one-off retryable edit is otherwise retried from scratch and returns only the settled generation. Repeated churn ends with `REPOSITORY_CHANGED`; no partial records, private paths, identities, hashes, payloads, arbitrary names, or sentinel causes escape.

## Architecture

### Exact directory generations

`src/canonical-layout.ts` remains the single bounded directory-enumeration authority. A new exact-generation comparison checks the existing lossless directory identity, overflow state, complete ordinal entry sequence, and every entry name and type. A bounded recapture helper proves that a prior root or kind snapshot still identifies the same entry set. The existing metadata-only witness revalidation remains available for boundaries that intentionally mutate a directory.

Root absence is itself a generation. Creating the root, adding or removing a kind, adding or removing a sibling record, renaming an entry, or changing an entry type invalidates it.

### Records-owned canonical snapshot

`src/records.ts` evolves the existing `RecordPlanningSnapshot`; it does not add a second scanner. A snapshot attempt retains:

- parsed records and corpus byte/count accounting;
- the exact root and kind directory snapshots;
- lossless metadata and raw-byte digests for every accepted canonical JSON file;
- the stable validation result and frozen artifact observations;
- the exact cache-manifest projection for that generation;
- one publication authority that revalidates the generation and accepts only the existing preparation/publication deltas.

Snapshot acceptance brackets graph and artifact validation with exact directory, file-digest, and artifact revalidation. Each attempt closes its descriptors before graph work. Failed attempts expose no records.

### One retry ledger

`src/operation-budgets.ts` owns three total canonical snapshot attempts and a 60-second non-resetting retry deadline. The deadline is checked only before starting another attempt, so a slow stable first attempt can still succeed. A private path-free generation-change sentinel is the only retryable outcome. Validation failures, cache-location failures, observer exceptions, operational I/O, and other `REPOSITORY_CHANGED` errors retain their authority.

Until a canonical record commits, the same ledger covers acquisition, graph/artifact validation, precommit replanning, cache rebuild, missing-primary handling, and corruption-recovery fallback. No consumer nests its own three-attempt loop or resets the deadline. After a link, canonical-generation retry and replanning are forbidden: any required fallback acquisition is exactly one expected-generation-bound attempt and a mismatch uses the committed race contract. Disposable-cache recovery may still retry the same sealed snapshot without acquiring another canonical generation.

### Publication and committed races

Add and init perform graph planning inside the stable-snapshot attempt. If the generation changes before the first canonical hard link, the entire attempt is discarded and replanned, including `createdAt`. The final exact assertion remains adjacent to the hard-link boundary.

After a record commits, canonical-generation retry and replanning are forbidden. The exact linked file identity is accepted while it is still descriptor-bound and before cleanup can fail; later fallback cannot adopt a byte-identical successor. Exact expected-delta acceptance proves the resulting entry set, file identity, digest, graph, and artifacts. A concurrent change becomes `REPOSITORY_CHANGED` with additive bounded details:

- `canonicalCommitted: true`;
- `repositoryChanged: true`;
- legacy `recordId`, relative `path`, and phase fields where already present;
- `committedRecordIds`, bounded by the maximum canonical batch;
- a fixed recovery action to validate and reconcile before retrying.

Init preserves the failing subsystem's original code, message, and cause and adds the existing `initProgress` envelope. A mid-batch race reports the exact committed prefix, publishes no later record, and performs no cache or instruction work.

### Cache consumption

The validated canonical snapshot supplies the exact manifest and current-generation assertion to cache freshness and rebuild. `src/cache.ts` retains SQLite schema, transaction, cache-recovery, and manifest policy, but stops owning a parallel full-corpus before/after scanner. Cache writes reassert the same snapshot before DML and immediately before commit. Safe precommit, read, and no-add canonical churn retries through the shared ledger and never quarantines a valid database; post-commit cache work cannot retry canonical acquisition or adopt another generation.

One cache writer/recovery session remains bound to its exact claimed primary throughout the records ledger, including no-add to record-producing and direct-snapshot-ineligible init transitions. A successor database is preserved without writer initialisation, quarantine, or overwrite. When post-commit cleanup or snapshot eligibility requires reacquisition, one records-owned scan is bracketed by the accepted publication authority and cannot adopt a predecessor or successor.

The logical canonical fingerprint needed by MAR-2571 remains a pure projection over the snapshot's retained raw-byte evidence; MAR-2571 will compare it with independently validated cache rows without another canonical scan.

## Component boundaries

- `src/canonical-layout.ts`: bounded directory capture and exact generation equality.
- `src/operation-budgets.ts`: attempt and retry-deadline authorities.
- `src/records.ts`: canonical acquisition, validation, generation authority, publication deltas, and committed canonical-race classification.
- `src/init.ts`: baseline-specific planning and committed-prefix orchestration.
- `src/cache.ts`: cache manifest policy, SQLite freshness/write transactions, and recovery using the supplied canonical snapshot.

No new runtime dependency, public export, cache migration, background watcher, rollback of append-only records, or lock over external editors is introduced.

## Acceptance evidence

- One-shot sibling add/remove/rename/type changes and same-size timestamp-restored replacements discard the first attempt and return only a stable successor generation.
- Continuous churn performs at most three snapshot attempts and ends with path-free `REPOSITORY_CHANGED`.
- Stable 0-, 100-, and 1,000-record operations visit exactly 0, 100, and 1,000 canonical entries with one scan and one graph pass. A post-graph one-shot retry visits 0, 200, and 2,000 entries with two scans and two graph passes; continuous post-graph churn stops at three scans and three graph passes, while continuous scan-time churn stops at three scans and zero graph passes.
- Rebuilding a missing or stale cache for prepare, hydrate, public reads, post-add hydration, and byte-eligible record-producing init uses one records-owned scan and graph pass without a second cache-owned pass. Fresh-cache paths may scan zero times; byte-ineligible post-commit init deliberately uses its one expected-generation-bound reacquisition.
- Add replans from a changed precommit generation and never publishes a stale candidate.
- Add/init changes after a commit report exact bounded committed IDs and deterministic recovery without claiming clean success.
- Cache manifest bytes, SQLite rows, schema version, and successful public results remain identical on a stable repository.
- Canonical churn does not quarantine or replace valid cache state.
