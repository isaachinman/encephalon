# Isolated Performance Benchmarks Implementation Plan

**Ticket:** MAR-2566
**Design:** `docs/superpowers/specs/2026-08-18-isolated-performance-benchmarks-design.md`

## Task 1: Define the versioned benchmark model

- [x] Add pure distribution, report, child-result, profile, and budget authorities.
- [x] Add focused tests for warmup exclusion, median/p95, explicit budget statistics, and schema-version rejection.
- [x] Run the focused command and record exact RED evidence.

## Task 2: Isolate every operation sample

- [x] Create deterministic unprepared/prepared case templates and clone one repository per sample.
- [x] Add the Node IPC worker with nonce/result validation, one-message ownership, hard timeout, close acknowledgement, and bounded failure text.
- [x] Run warmups and measured samples in distinct children and remove every sample/template repository in final boundaries.
- [x] Add complementary crash, timeout, process-identity, and cleanup tests and witness RED before production.

## Task 3: Report additive phases and distributions

- [x] Add the two stripped internal cache read-boundary hooks.
- [x] Measure total, preparation/integrity, query/projection, overhead, isolated peak RSS, and current-RSS delta.
- [x] Emit schema-version 2 JSON with raw measured samples and deterministic summaries.
- [x] Preserve operation inputs, corpus generation, cache metrics, and public API output.

## Task 4: Update profiles, budgets, and evidence

- [x] Keep CI at 0/100 records and add the separate 1,000-record `full` profile.
- [x] Add strict `--warmups` and `--repetitions` options and document all benchmark options.
- [x] Regenerate the committed full baseline and version-2 CI budget file.
- [x] Update README, performance guidance, changelog, maintained contract, and exact implementation provenance.

## Task 5: Verify and review

- [x] Run focused tests, lint, all four TypeScript projects, and the complete suite.
- [x] Run baseline, full/manual, CI-budget, build, package, publish-contract, and frozen-install gates.
- [ ] Audit declarations, package/Bun/config drift, diff hygiene, branch/upstream, and tracked status.
- [ ] Open the stacked PR, run Pullfrog, run all six review roles, fix accepted high/medium-confidence findings, and leave the PR unmerged.

## Implementation evidence

- RED: `node --test test/benchmark.test.ts` failed before production with `ERR_MODULE_NOT_FOUND` for the absent benchmark model authority.
- GREEN at code/test commit `3fac5940be66d7e4cc644e216c743fefba24fea5`: focused benchmark 12/12; cache 157/157; full suite 527 pass, 0 fail, 2 established capability skips; lint 112 files; all four TypeScript projects.
- Release gates: schema-version 2 CI budget, full 0/100/1,000 baseline with two warmups and five measured samples, build, isolated-cache package check, expected already-published publish refusal, frozen install, and diff check all passed.
