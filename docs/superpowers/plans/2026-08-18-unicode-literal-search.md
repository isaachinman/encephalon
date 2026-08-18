# Unicode Literal Search Implementation Plan

**Ticket:** MAR-2559
**Design:** `docs/superpowers/specs/2026-08-18-unicode-literal-search-design.md`

## Task 1: Characterise literal Unicode terms

- [x] Add a pure parser table for scripts, canonical equivalence, combining marks, underscore compatibility, duplicates, and hostile FTS syntax.
- [x] Add one public zero-term no-I/O case.
- [x] Run the focused command and record the exact RED.

## Task 2: Implement one literal-query authority

- [x] Move literal query validation/construction into one internal module.
- [x] Preserve original UTF-8 byte and normalized term budgets.
- [x] Normalize to NFC and extract Unicode letter/number terms with attached marks.
- [x] Preserve safe underscore-joined ASCII behaviour and literal quote-plus-`AND` construction.
- [x] Route full search, compact search, and gather through the authority.
- [x] Run focused tests, cache tests, lint, and four-project typechecking.

## Task 3: Verify public and packaged behaviour

- [x] Add one complementary full/compact/gather Unicode integration fixture.
- [x] Add one packed CLI Unicode search assertion.
- [x] Preserve ASCII rank, order, snippet, budget, recovery, and response-accounting regressions.
- [x] Run the full suite, both benchmarks, build, package, publish-contract, frozen-install, declaration, Bun/config, and diff-hygiene gates.

## Task 4: Document and review

- [x] Update README, changelog, maintained contract, and exact implementation provenance.
- [ ] Open the stacked PR against the MAR-2554 branch.
- [ ] Run Pullfrog and six parallel role reviews against main.
- [ ] Fix accepted high/medium-confidence findings, rerun proportionate gates, and leave the PR unmerged.

## Implementation evidence

- RED: the pure parser command failed because `src/literal-query.ts` did not exist; the focused cache command failed 0/2 because composed Unicode input was discarded and punctuation-only search entered repository resolution.
- GREEN: the parser passes 2/2, focused Unicode/no-I/O integration passes 2/2, and the affected cache/parser suites pass 156/156.
- Removing query NFC makes the parser case fail; removing derived-document NFC makes the integration case fail. Restored production passes both.
- Review remediation reproduced and fixed three independent failures: maximum NFC expansion exceeded the old derived FTS bounds, an exclusively created cache primary disappearing before inspection bypassed the existing creation-conflict retry, and primary disappearance during the SQLite constructor was wrapped before revalidation. All focused regressions and their deliberate mutations pass/fail as expected.
- Lint, all four TypeScript projects, the full suite (515 pass, 0 fail, 2 established capability skips), both benchmarks, build, packed-package Unicode CLI validation, publish contract, frozen install, declarations, Bun/config, and diff-hygiene gates pass after review remediation at `894226cd90dce39d01860550247d887157a686e7`.
