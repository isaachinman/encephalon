# Isolated Performance Benchmarks Design

**Ticket:** MAR-2566
**Date:** 2026-08-18
**Status:** Implemented and reviewed

## Goal

Replace single-process, single-sample performance evidence with isolated child-process samples, repeatable latency and memory distributions, explicit cache-read phases, and schema-versioned budgets. Runtime API values and canonical/cache data formats remain unchanged.

## Profiles

- `ci` remains the fast cross-platform smoke profile: 0 and 100 records, no warmup, one measured sample.
- `baseline` is the normal local profile: 0 and 100 records, one warmup and three measured samples.
- `full` is the stable/manual regression profile: 0, 100, and 1,000 records, two warmups and five measured samples.
- Repeated `--records` arguments still override the profile corpus sizes. `--warmups` and `--repetitions` override the profile defaults after strict non-negative/positive integer validation.

The committed baseline is generated with `--profile full`. CI continues to use `benchmark:check`, so product-limit evidence does not make every platform push depend on long or precise timing.

## Isolation and repository state

The parent process creates one deterministic unprepared template and one prepared template for each corpus size. Before every warmup and measured sample it copies the appropriate template into a fresh temporary repository and establishes any stale-cache precondition outside the measured process.

Every sample then runs in a fresh Node child. No child measures more than one operation, so `process.resourceUsage().maxRSS` cannot inherit a previous benchmark operation. The parent discards warmup results, aggregates measured results only, and removes each sample repository after the child has fully closed. Case templates are removed in a final boundary even when setup, child execution, parsing, or budget validation fails.

The parent uses `child_process.fork` with Node IPC, no shell, an empty `execArgv`, and one random request nonce. It accepts exactly one matching result and only after `close` reports code zero and no signal. A fixed hard timeout sends `SIGKILL` and still waits for `close`. Crashes, timeouts, duplicate messages, malformed values, wrong nonces, and unexpected exits produce bounded errors naming only the operation and record count.

## Phase timing

Public read operations already perform repository resolution, cache preparation, schema/content integrity validation, freshness validation, and result reading within one call. Measuring a separate `prepare()` and subtracting it would double-run work and would not be additive.

The existing internal `cacheReadTestHooks` therefore gains two stripped, test-only read-boundary callbacks. `readFreshCache` invokes them immediately before and after the private result reader. A benchmark child records four nested, non-negative phases:

- `totalMs`: the complete public API call;
- `preparationIntegrityMs`: call start through the verified/fresh cache boundary;
- `queryProjectionMs`: the private SQLite query and result projection;
- `overheadMs`: the bounded remainder between result completion and public return.

For `hydrate` and `prepare`, `preparationIntegrityMs` equals the total and the other two phases are zero. The callbacks do not change public output, error routing, cache authority, or package exports.

## Report schema version 2

Each operation reports the measured raw samples plus deterministic summaries for total duration, both substantive phases, overhead, absolute child peak RSS, and current-RSS delta. A distribution contains:

```ts
{
  count: number
  maximum: number
  median: number
  p95: number
  samples: number[]
}
```

Samples retain execution order. Summaries sort a copy: median is the middle value (or the mean of the two middle values), and p95 is the nearest-rank value at `ceil(0.95 * count)`. Values are finite and rounded to three decimal places; byte metrics remain whole numbers. Warmups never enter the array or count.

The report also records profile, configured warmups/repetitions/timeout, corpus facts, cache sizes, and environment metadata. Memory metadata states that `peakRssBytes` derives from each isolated child's `process.resourceUsage().maxRSS`, converted from KiB to bytes, while `rssDeltaBytes` is a noisy current-RSS delta and may be negative.

## Budget schema version 2

Budgets select a named statistic explicitly. Operation limits use the shape `operations.<operation>.<metric>.<median|p95|maximum>`. Cache limits use `cache.<metric>.maximum`. Old or malformed schema versions fail before any benchmark case runs.

A failed check names the corpus size, operation or cache, metric, statistic, actual value, and configured maximum. CI uses generous p95 total-time ceilings and maximum cache-size/amplification ceilings; it does not turn benchmark noise into correctness failure.

## Compatibility and exclusions

- `bun run benchmark` and `bun run benchmark:check` remain the entry points.
- The synthetic corpus, operation inputs, public result shapes, package exports, runtime dependencies, canonical record format, SQLite schema, and product budgets do not change.
- Raw child stdout is not a protocol and environment values are not copied into reports.
- Timing does not assert correctness beyond validating the bounded worker result contract.
- External benchmark services, 10,000-record product support, runtime optimisation, and platform-specific memory profilers remain out of scope.

## Reviewed implementation provenance

The exact implementation and behavioural-test snapshot is `3fac5940be66d7e4cc644e216c743fefba24fea5`. Documentation, the generated baseline, and the CI budget do not change the public runtime API, package exports, canonical record format, or SQLite schema.

## Acceptance coverage

- Pure tests cover median, nearest-rank p95, raw order/count, and warmup exclusion.
- Budget tests cover explicit statistic selection, fixed failure context, and schema-version rejection.
- Process tests cover one valid IPC result, wrong/malformed result, child crash, hard timeout, and waiting for close.
- An actual worker test proves two samples use different process identities, reports additive read phases, and keeps prepare-only query/projection phases at zero.
- Repository cleanup is tested on both success and child failure.
- Normal benchmark, CI budget, full test, build, package, publish-contract, and frozen-install gates remain required.
