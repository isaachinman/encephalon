# FTS Text Integrity Implementation Plan

**Ticket:** MAR-2550
**Design:** `docs/superpowers/specs/2026-08-17-fts-text-integrity-design.md`

## Task 1: Witness semantic FTS mismatches

- [x] Add one representative public-read recovery test for bounded wrong FTS text.
- [x] Extend the existing FTS relationship table with exact text and per-ID binding cases.
- [x] Add one invalid-UTF-8 lookalike case that requires raw-byte equality.
- [x] Run the focused command and record the exact RED.

## Task 2: Validate bounded FTS bytes

- [x] Derive expected search-document bytes from the validated cached records.
- [x] Preserve the numeric-first FTS probe and bounded row iteration.
- [x] Compare raw ID/text bytes exactly and remove the redundant relationship-count query.
- [x] Keep mismatch messages fixed and data-free.
- [x] Run focused, cache, lint, and four-project typechecking gates.

## Task 3: Verify recovery and compatibility

- [x] Prove public-read and forced-writer recovery use one exact quarantine/rebuild.
- [x] Update the exact-boundary control to distinguish preflight acceptance from semantic acceptance.
- [x] Run the full test suite, both benchmarks, build, package, publish-contract, frozen-install, declaration, Bun/config, and diff-hygiene gates.

## Task 4: Document and review

- [x] Update README, changelog, maintained contract, and exact implementation provenance.
- [x] Open the initial stacked PR against the MAR-2553 branch before rebasing onto main.
- [x] Run Pullfrog and six parallel role reviews against main.
- [x] Fix accepted high/medium-confidence findings and rerun proportionate gates.

## Implementation evidence

- RED: the focused public-read and forced-writer cases failed 0/2 because bounded non-canonical and invalidly encoded FTS text was accepted without recovery.
- GREEN: the focused semantic cases pass 3/3 and the cache suite passes 144/144.
- Review remediation added one shared existing-generation validation transaction before writer PRAGMAs, reuses the same authority after `BEGIN IMMEDIATE`, requires bounded emptiness probes for exact newly claimed primaries across repository-change retries, and adds complementary metadata-less, retry-injection, post-initialisation mutation, textual-ID boundary, and two-record ID-binding coverage.
- The compact full suite, lint, all four TypeScript projects, build, package and publish-contract checks, frozen install, baseline benchmark, and CI budget benchmark pass at code/test commit `2a68ce4dc839481a91b9afd6fb44a13ace13cb26`.
