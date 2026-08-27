# Changelog

All notable changes to Encephalon are documented here.

## [0.3.0] - 2026-08-27

### Added

- Added a published 0.2.0 compatibility harness covering API, CLI, declaration, independent-budget, and durable-state behaviour, including cache schema 1 to schema 2 to schema 1 upgrade and downgrade recovery.
- Added exact candidate tarball validation, digest reporting, retained CI artifacts, Node 24.15.0 and Node 26 candidate lanes, and a tarball-only publish dry run.

### Changed

- Raised and aligned full, compact, and gather result limits at a 1,000-result limit while preserving every input accepted by published 0.2.0.
- Made canonical reads, validation, and baseline generation consume one stable canonical or repository snapshot with bounded retries under concurrent change.
- Strengthened disposable-cache validation with exact schema and FTS projection checks, canonical-corpus fingerprints, single-pass reads, validated mutation snapshots, and deterministic bounded recovery.
- Added snapshot-local gather deduplication and Unicode-preserving literal search while retaining per-occurrence charging and stable public results.
- Isolated performance samples in fresh processes and replaced source-regex guards with schema-versioned behavioural, latency, phase, and memory evidence.

### Fixed

- Normalised negative-zero confidence and enforced payload budgets before avoidable descriptor and output allocation.
- Made partial initialisation progress actionable and bounded managed-instruction finalisation, operation-lock candidate discovery, recovery-marker reclamation, and mutable SQLite identity checks.
- Assigned record creation timestamps under the repository operation lock so new records and baseline batches remain strictly ordered after canonical history.

### Documentation

- Expanded the maintained contract and README with cache-recovery, stable-snapshot, initialisation-progress, compatibility-oracle, and exact-artifact release guidance.

## [0.2.0] - 2026-08-09

### Added

- Added bounded baseline scanning with deterministic directory ordering and symlink-safe traversal.
- Added package-manager evidence to baseline records instead of inferring npm from incomplete repository metadata.
- Added explicit request, response, corpus, cache, and performance budgets.
- Added package and publish-contract checks to CI, including inspection of the packed package.
- Added a replacement CLI parser and aligned generated TypeScript declarations with the supported Node.js runtime.

### Changed

- Made canonical record staging, publication, instruction-file writes, and post-commit recovery safer across filesystem failures.
- Made cache hydration and gather reads transactional, snapshot-consistent, and resilient to malformed disposable state.
- Made compact search avoid materialising full record JSON and removed persistent-style copying from hot scans.
- Centralised the package version and separated cache schema compatibility from diagnostic package metadata.
- Improved validation of record graphs, kind directories, artifact paths, Windows filename portability, and locale-independent ordering.

### Fixed

- Classified expected filesystem and SQLite environment failures separately from internal defects.
- Made committed add failures report the affected post-commit recovery phase explicitly.
- Made generated baseline refreshes converge on one canonical snapshot.
- Deflaked instruction replacement identity checks across supported platforms.

### Documentation

- Corrected README privacy and packaged-asset claims.
- Resolved implementation-plan drift and removed obsolete documentation surface.
- Added performance baselines and CI budgets for prepare, hydrate, search, and cache-size behaviour.

## [0.1.0]

- Initial release of the repository-local durable knowledge package.
