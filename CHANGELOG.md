# Changelog

All notable changes to Encephalon are documented here.

## [0.4.0] - 2026-09-15

### Changed

- Reduce repeated canonical reads, validation passes and retained data during prepare, search and gather while preserving strict cache equivalence and bounded public operations.
- Generate compact search snippets from bounded record metadata. Payload-only terms still match; their snippets use a deterministic metadata fallback instead of reproducing payload text. Compact ranking values may change.
- Replace recursive source and language inventories with a shallow generated baseline covering package, package-manager, workspace, script, top-level and workflow facts. Existing baseline records remain valid; explicit refresh supersedes them append-only.
- Reduce the disposable search cache and rebuild older caches automatically on first use. No canonical record or artifact migration is required. Sequential downgrade to 0.3.0 rebuilds the disposable cache; concurrent mixed-version writers are unsupported.
- Share the API and CLI runtime and publish only public declarations. The synchronous API, Node.js 24.15.0 minimum and zero runtime dependencies remain unchanged; CLI help and version avoid loading repository runtime modules.
- Reuse one verified package candidate across CI consumers and keep historical compatibility checks on release and public-contract paths. Regression budgets and cross-platform correctness checks remain enforced.

### Fixed

- Recheck recovery-directory identity after native realpath failures so concurrent cleanup on Windows invalidates a changed observation while preserving stable errors and ownership checks.

### Verification and documentation

- Verify upgrade and downgrade against the pinned, actual published 0.3.0 package, including public API/CLI/declarations, result limits, durable records, artifacts, managed instructions, old-cache recovery and legacy baseline refresh.
- Keep the README focused on everyday usage and the contract on stable public boundaries; preserve historical designs and documentation as immutable Encephalon artifacts.
- Retain exact reviewed package bytes through successful merged-main CI and trusted artifact promotion. npm publication remains a manual, tarball-only maintainer step.

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
