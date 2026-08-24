# Changelog

All notable changes to Encephalon are documented here.

## [0.2.0] - 2026-08-09

### Added

- Added bounded baseline scanning with deterministic directory ordering and symlink-safe traversal.
- Added package-manager evidence to baseline records instead of inferring npm from incomplete repository metadata.
- Added explicit request, response, corpus, cache, and performance budgets.
- Added package and publish-contract checks to CI, including inspection of the packed package.
- Added a replacement CLI parser and aligned generated TypeScript declarations with the supported Node.js runtime.

### Changed

- Isolated every benchmark operation sample in a fresh child process and replaced single timings with schema-versioned latency, phase, and memory distributions.
- Assigned record creation timestamps under the repository operation lock so new records and generated baseline batches remain strictly ordered after canonical history.
- Validated canonical reads, mutation planning, initialisation, and cache rebuilding against one exact generation, with one records-owned three-attempt/60-second retry ledger and settled-generation-only results.
- Rebuilt disposable cache state from the same sealed canonical snapshot used for graph and artifact validation, preserving cache schema version `1`, exact manifest bytes, logical rows, FTS projection, and cache recovery identity.
- Made canonical record staging, publication, instruction-file writes, and post-commit recovery safer across filesystem failures.
- Made cache hydration and gather reads transactional, snapshot-consistent, and resilient to malformed disposable state.
- Validated disposable SQLite table, constraint, index, and FTS5 semantics before reads or writer mutation, with exact one-generation recovery for incompatible caches.
- Verified each bounded cached FTS row against the exact UTF-8 search projection derived from its cached record before serving reads or mutating an existing cache.
- Validated each successful public cache read once and materialised its result from the same verified SQLite transaction, removing the duplicate preparation pass.
- Rebuilt the disposable cache from the strictly validated add/init mutation snapshot, with identity-bound acceptance, deterministic bounded disk fallback, and unchanged public and post-commit error semantics.
- Deduplicated exact repeated gather shows and searches within each verified cache snapshot while preserving duplicate output order, independent result values, retry isolation, and per-occurrence response charging.
- Preserved Unicode letter and number terms in literal FTS queries with shared NFC normalization for queries and derived cache search documents.
- Made compact search avoid materialising full record JSON and removed persistent-style copying from hot scans.
- Replaced source-regex hot-scan guards with behavioural work bounds while keeping latency and memory enforcement in the benchmark budget.
- Centralised the package version and separated cache schema compatibility from diagnostic package metadata.
- Improved validation of record graphs, kind directories, artifact paths, Windows filename portability, and locale-independent ordering.

### Fixed

- Bounded operation-lock candidate discovery to 64 raw entries, 16 candidate inspections, and 4 reclamation attempts per operation, with at most 8 process-local cursors and exact under-gate reclamation that leaves unrelated or ambiguous entries inert without changing the public contract.
- Classified expected filesystem and SQLite environment failures separately from internal defects.
- Made committed add failures report the affected post-commit recovery phase explicitly.
- Normalised negative-zero confidence to canonical numeric zero before publication and public return.
- Applied payload node budgets before avoidable descriptor and output allocation while preserving guarded iterative validation and canonical results.
- Made multi-resource initialisation report bounded monotonic commit progress while preserving subsystem errors, with inspect-or-rerun guidance and same-options convergence after partial baseline, cache, instruction, refresh, and removal failures.
- Finalised managed instruction writes and removals with fixed-root authority, descriptor-bound private staging and durable recovery, canonical hard-link commit aggregation, concurrent-successor preservation, zero operation-owned aliases on success, and bounded safe post-commit phases and repository-relative recovery paths.
- Made generated baseline refreshes converge on one canonical snapshot.
- Replanned add and initialisation only before their first canonical link, then reported post-link canonical races with the exact bounded committed prefix and deterministic validation-and-reconciliation recovery instead of retrying after commit.
- Rejected multiply linked mutable SQLite primaries, operation gates, and sidecars before use or identity-specific cleanup.
- Made completed operation-gate recovery durably reclaimable across processes while preserving live recovering and phase-less legacy owners.
- Deflaked instruction replacement identity checks across supported platforms.

### Documentation

- Corrected README privacy and packaged-asset claims.
- Resolved implementation-plan drift and removed obsolete documentation surface.
- Added performance baselines and CI budgets for prepare, hydrate, search, and cache-size behaviour.

## [0.1.0]

- Initial release of the repository-local durable knowledge package.
