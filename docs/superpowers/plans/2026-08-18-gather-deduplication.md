# Gather Deduplication Implementation Plan

**Ticket:** MAR-2560
**Design:** `docs/superpowers/specs/2026-08-18-gather-deduplication-design.md`

## Task 1: Prove the current repeated work

- [x] Extend the existing gather duplicate-order test with exact database/evaluation counts, missing and zero-term duplicates, textually distinct equivalent queries, and independent-reference mutation checks.
- [x] Add one recoverable-failure test proving partially populated memos do not survive a rejected SQLite snapshot.
- [x] Run the focused command and record exact RED evidence before production changes.

## Task 2: Add snapshot-local exact-key memoisation

- [x] Create show and compact-search maps inside `readGatherFromDatabase` only.
- [x] Memoise complete validated results by exact original key, including `null` and empty arrays.
- [x] Keep emitted duplicate occurrences independently mutable and preserve per-occurrence response-budget charging and work order.
- [x] Run focused tests and mutation witnesses for normalised-key merging, shared aliases, undercharging, and retry leakage.

## Task 3: Exercise duplicate-heavy benchmark work

- [x] Change the existing gather benchmark to 64 show envelopes from two exact IDs and 16 search envelopes from two exact queries.
- [x] Preserve the benchmark operation/report schema and update only the gather cardinality validator.
- [x] Run the focused benchmark suite and the normal benchmark gates.

## Task 4: Document and verify

- [x] Update README, changelog, maintained contract, performance guidance, package assertions, design provenance, and this implementation evidence.
- [x] Run lint, all four TypeScript projects, the full test suite, benchmarks, build, package, publish-contract, frozen-install, declaration, Bun/config, diff, and worktree audits.
- [x] Commit code/tests first and documentation/provenance second using the exact code/test SHA.

## Task 5: Review and release the branch

- [x] Run the six parallel review roles against the stacked base and remediate every accepted high/medium-confidence issue.
- [x] Run the final tidy/separation-of-concerns/stale-assumption/documentation audit.
- [ ] Push the exact Linear branch, open its stacked PR, wait for Pullfrog, address findings, and move MAR-2560 to In Review without merging.

## Implementation evidence

- RED: the focused gather command ran two tests with zero passes. Duplicate present and missing show IDs executed twice instead of once, and the recovery case executed duplicate shows four times instead of once per attempt.
- GREEN at code/test commit `66ee14a565e26a240615f57d4fc28d7ed7bbd56a`: focused gather/budget tests 3/3; cache 161/161; benchmark 17/17; full suite 537 pass, 0 fail, 2 established capability skips; lint 113 files; all four TypeScript projects.
- Review remediation GREEN at code/test commit `5421abe15ac21189675e2ad88e944803915f272e`: focused snapshot/deduplication tests 3/3; cache 161/161; benchmark 18/18; full suite 538 pass, 0 fail, 2 established capability skips; lint 114 files; all four TypeScript projects. The benchmark workload is derived from the central operation-budget authority, its two exact keys and multiplicities are asserted, zero-term memo misses are observed directly, distinct-key snapshot tests remain transaction-sensitive, and internal cache test hooks are absent from packaged declarations.
- Mutation evidence: keying searches by the normalised match merged textually distinct queries; returning memo objects directly aliased duplicate outputs; and skipping charges on search memo hits allowed the one-byte-over response to pass. Each mutation failed its focused authority and restored production passed.
- The 100-record duplicate-heavy diagnostic reduced gather query/projection median from 2,428.0 ms to 298.7 ms and total median from 2,445.1 ms to 315.5 ms across three measured fresh processes after one discarded warmup.
- The full 0/100/1,000-record baseline, CI budget, build, package, expected publish refusal, frozen install, declaration, Bun/config, and diff gates passed before documentation provenance was finalised.
