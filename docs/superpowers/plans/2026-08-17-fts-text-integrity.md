# FTS Text Integrity Implementation Plan

**Ticket:** MAR-2550  
**Design:** `docs/superpowers/specs/2026-08-17-fts-text-integrity-design.md`

## Task 1: Witness semantic FTS mismatches

- Add one representative public-read recovery test for bounded wrong FTS text.
- Extend the existing FTS relationship table with exact text and per-ID binding cases.
- Add one invalid-UTF-8 lookalike case that requires raw-byte equality.
- Run the focused command and record the exact RED.

## Task 2: Validate bounded FTS bytes

- Derive expected search-document bytes from the validated cached records.
- Preserve the numeric-first FTS probe and bounded row iteration.
- Compare raw ID/text bytes exactly and remove the redundant relationship-count query.
- Keep mismatch messages fixed and data-free.
- Run focused, cache, lint, and four-project typechecking gates.

## Task 3: Verify recovery and compatibility

- Prove public-read and forced-writer recovery use one exact quarantine/rebuild.
- Update the exact-boundary control to distinguish preflight acceptance from semantic acceptance.
- Run the full test suite, both benchmarks, build, package, publish-contract, frozen-install, declaration, Bun/config, and diff-hygiene gates.

## Task 4: Document and review

- Update README, changelog, maintained contract, and exact implementation provenance.
- Open the stacked PR against the MAR-2553 branch.
- Run Pullfrog and six parallel role reviews against main.
- Fix accepted high/medium-confidence findings, rerun proportionate gates, and leave the PR unmerged.

