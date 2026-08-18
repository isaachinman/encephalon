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
- [x] Audit declarations, package/Bun/config drift, diff hygiene, branch/upstream, and tracked status.
- [ ] Open the stacked PR, run Pullfrog, run all six review roles, fix accepted high/medium-confidence findings, and leave the PR unmerged.

## Implementation evidence

- RED: `node --test test/benchmark.test.ts` failed before production with `ERR_MODULE_NOT_FOUND` for the absent benchmark model authority.
- Initial GREEN at code/test commit `3fac5940be66d7e4cc644e216c743fefba24fea5`: focused benchmark 12/12; cache 157/157; full suite 527 pass, 0 fail, 2 established capability skips; lint 112 files; all four TypeScript projects.
- Review RED proved copied prepared templates were stale, vacuous budgets passed, setup allocation could leak, equals-form CLI options regressed, repeated output flags selected inconsistently, and atomic replacement changed report permissions.
- Review GREEN at code/test commit `f6f5ea32934227f6e2370e31fd5191c7ec90d404`: focused benchmark 14/14; cache 157/157; full suite 529 pass, 0 fail, 2 established capability skips; lint 112 files; all four TypeScript projects; corrected schema-version 2 CI budget and full 0/100/1,000 baseline passed.
- Final review remediation GREEN at code/test commit `c5d97b7141a3f52c1a16320e73db7d1e9ddf4f9b`: focused benchmark 15/15; cache 157/157; full suite 530 pass, 0 fail, 2 established capability skips; lint 113 files; all four TypeScript projects. It keeps report temporaries private through rename, applies the final mode through the retained descriptor, makes operation dispatch exhaustive, separates live benchmark instrumentation from test hooks, rejects unavailable zero-record amplification budgets, distinguishes p95 from maximum, exercises stdout rejection and preparation-only phases, and capability-scopes the POSIX signal regression.
- Race-review remediation GREEN at code/test commit `de1d9ea2925c329a4385f37d2cccc91d058925a2`: focused benchmark 16/16; full suite 531 pass, 0 fail, 2 established capability skips; lint 113 files; all four TypeScript projects. Report permissions are finalised on the owned descriptor inside private staging before atomic publication, and cleanup attempts every owned benchmark root while preserving the primary or first cleanup failure.
- Final cleanup-priority remediation GREEN at code/test commit `6c408c48152eb7ecaa122a0772134d0d52d7a364`: focused benchmark 17/17; full suite 532 pass, 0 fail, 2 established capability skips; lint 113 files; all four TypeScript projects. Repository setup, snapshot setup, per-sample worker execution, and final case cleanup now share the same primary-or-first-cleanup-failure authority.
- Final release gates: build, isolated-cache package validation, expected already-published publish refusal, frozen install with no changes, package/declaration/Bun/config audits, and diff hygiene all passed.
