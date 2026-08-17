# Unicode Literal Search Implementation Plan

**Ticket:** MAR-2559
**Design:** `docs/superpowers/specs/2026-08-18-unicode-literal-search-design.md`

## Task 1: Characterise literal Unicode terms

- [ ] Add a pure parser table for scripts, canonical equivalence, combining marks, underscore compatibility, duplicates, and hostile FTS syntax.
- [ ] Add one public zero-term no-I/O case.
- [ ] Run the focused command and record the exact RED.

## Task 2: Implement one literal-query authority

- [ ] Move literal query validation/construction into one internal module.
- [ ] Preserve original UTF-8 byte and normalized term budgets.
- [ ] Normalize to NFC and extract Unicode letter/number terms with attached marks.
- [ ] Preserve safe underscore-joined ASCII behaviour and literal quote-plus-`AND` construction.
- [ ] Route full search, compact search, and gather through the authority.
- [ ] Run focused tests, cache tests, lint, and four-project typechecking.

## Task 3: Verify public and packaged behaviour

- [ ] Add one complementary full/compact/gather Unicode integration fixture.
- [ ] Add one packed CLI Unicode search assertion.
- [ ] Preserve ASCII rank, order, snippet, budget, recovery, and response-accounting regressions.
- [ ] Run the full suite, both benchmarks, build, package, publish-contract, frozen-install, declaration, Bun/config, and diff-hygiene gates.

## Task 4: Document and review

- [ ] Update README, changelog, maintained contract, and exact implementation provenance.
- [ ] Open the stacked PR against the MAR-2554 branch.
- [ ] Run Pullfrog and six parallel role reviews against main.
- [ ] Fix accepted high/medium-confidence findings, rerun proportionate gates, and leave the PR unmerged.

## Implementation evidence

- Pending focused RED/GREEN evidence and exact implementation SHA.
