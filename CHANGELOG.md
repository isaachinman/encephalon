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

- Made canonical record staging, publication, instruction-file writes, and post-commit recovery safer across filesystem failures.
- Made cache hydration and gather reads transactional, snapshot-consistent, and resilient to malformed disposable state.
- Made compact search avoid materialising full record JSON and removed persistent-style copying from hot scans.
- Centralised the package version and separated cache schema compatibility from diagnostic package metadata.
- Improved validation of record graphs, kind directories, artifact paths, Windows filename portability, and locale-independent ordering.

### Fixed

- Classified expected filesystem and SQLite environment failures separately from internal defects.
- Made committed add failures report the affected post-commit recovery phase explicitly.
- Finalised managed instruction replacements at the canonical hard-link commit point with repository-generation and descriptor-bound exclusive alias moves, durability-ordered cleanup, private recovery copies, zero operation-owned aliases on success, and a bounded safe list of every post-commit recovery phase that failed or was deferred.
- Made generated baseline refreshes converge on one canonical snapshot.
- Deflaked instruction replacement identity checks across supported platforms.

### Documentation

- Corrected README privacy and packaged-asset claims.
- Resolved implementation-plan drift and removed obsolete documentation surface.
- Added performance baselines and CI budgets for prepare, hydrate, search, and cache-size behaviour.

## [0.1.0]

- Initial release of the repository-local durable knowledge package.
