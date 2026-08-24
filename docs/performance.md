# Performance Benchmarks

Encephalon keeps canonical records in JSON and rebuilds a disposable SQLite/FTS cache when those canonical inputs change. The benchmark suite characterises that full-rebuild design with fresh-process latency and memory samples before any cache architecture change is made.

## Commands

Generate the committed stable baseline:

```bash
bun run benchmark -- --profile full --output docs/performance-baseline.json
```

Run the fast CI budget profile:

```bash
bun run benchmark:check
```

The profiles are fixed:

- `ci`: 0 and 100 records, no warmup, one measured sample;
- `baseline` (the default): 0 and 100 records, one warmup and three measured samples;
- `full`: 0, 100, and 1,000 records, two warmups and five measured samples.

Repeated `--records` values create a `custom` profile. `--warmups`, `--repetitions`, and `--timeout-ms` override the selected defaults; `--budget` reads a schema-version 2 budget; and `--output` atomically replaces a JSON report only after every sample and budget check succeeds. Run `bun run benchmark -- --help` for the complete option list.

Each non-empty deterministic corpus contains small records, large payloads, referenced artifacts, and a supersession chain. The benchmark measures cold hydrate, unchanged prepare, stale prepare, list, show, compact search, full search, and gather. Gather emits the public maxima of 64 shows drawn from two repeated exact IDs and 16 searches drawn from two repeated exact queries, so its measured work includes duplicate projection and response charging without repeating the SQLite reads. A zero-record corpus has no meaningful stale mutation, so `stalePrepare` is `null` for that case.

Every warmup and measured operation runs in a fresh Node child after the parent restores the exact unprepared or prepared repository state. Because copying changes canonical filesystem metadata, the parent re-prepares every restored non-cold sample before measurement and applies the different-length stale mutation only afterward. Warmups are discarded. Measured samples retain execution order and report count, maximum, median, and nearest-rank p95. Read operations split their total into preparation/integrity, query/projection, and bounded return overhead; those unrounded per-sample phases add to the total. Summary values are rounded to three decimal places.

`peakRssBytes` is the isolated child's lifetime `process.resourceUsage().maxRSS`, converted from KiB to bytes. It includes Node and module startup but cannot inherit a previous benchmark operation's peak. `rssDeltaBytes` is the signed change in current RSS within that child and is diagnostic rather than budgeted.

Results are committed in [performance-baseline.json](./performance-baseline.json). CI ceilings live in [performance-budgets.json](./performance-budgets.json), select explicit p95 total-time or maximum cache statistics, and reject incompatible or incomplete budget schemas before creating a benchmark repository.

Correctness tests enforce deterministic output and bounded work counts for canonical scans, supersession graphs, and baseline accumulation. They use per-invocation internal observers and never inspect production source spelling. Wall-clock latency, memory, and cache-size regressions remain the exclusive responsibility of `benchmark:check` and the stable full-profile evidence.

## Stable baseline

The committed schema-version 2 baseline was measured on Node.js v26.5.0 on darwin arm64. Each timing is median / p95 across five measured fresh processes after two discarded warmups.

| Records | Cold hydrate | Unchanged prepare | Stale prepare | Compact search | Full search | Gather | Cache amplification |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 11.2 / 11.5 ms | 4.5 / 4.8 ms | n/a | 5.0 / 5.1 ms | 5.0 / 5.1 ms | 5.5 / 5.6 ms | n/a |
| 100 | 35.4 / 35.5 ms | 15.7 / 16.2 ms | 56.1 / 56.5 ms | 17.4 / 17.8 ms | 16.7 / 16.9 ms | 308.0 / 310.8 ms | 2.46x |
| 1,000 | 208.7 / 210.5 ms | 85.0 / 85.9 ms | 377.3 / 380.5 ms | 94.7 / 94.9 ms | 88.5 / 102.0 ms | 3.08 / 3.20 s | 2.32x |

The CI profile intentionally runs only 0 and 100 records with one measured process and generous ceilings. It catches runaway cache rebuild, automatic preparation, search, gather, and cache-size regressions without treating noisy cross-platform timings as precise performance claims. Stable comparisons should use the full profile and its distributions.

## Single-pass read comparison

MAR-2552 removes the second successful integrity pass that previously followed automatic preparation. On the same Node.js v26.5.0 darwin arm64 machine, the 100-record custom profile used one discarded warmup and three measured fresh processes before and after the change. The table reports median preparation/integrity and total milliseconds; it is diagnostic evidence, not a new CI threshold.

| Operation | Previous integrity | Single-pass integrity | Previous total | Single-pass total |
| --- | ---: | ---: | ---: | ---: |
| List | 25.7 | 17.3 | 26.1 | 17.9 |
| Show | 25.9 | 17.1 | 26.3 | 17.5 |
| Compact search | 26.3 | 16.8 | 27.7 | 18.5 |
| Full search | 25.9 | 15.8 | 26.7 | 16.8 |
| Gather | 26.2 | 16.2 | 319.0 | 314.4 |

This comparison remains the historical two-search/two-show read reference. The committed schema-version 2 baseline now records the MAR-2560 duplicate-heavy gather workload. Benchmark workers also reject any public-read sample that does not report exactly one successful cache-generation validation before result materialisation.

## Gather deduplication comparison

MAR-2560 compares the same 100-record duplicate-heavy workload with and without snapshot-local memoisation: 64 show envelopes from two exact IDs and 16 search envelopes from two exact queries. One discarded warmup and three measured fresh processes were used on the baseline machine. The table reports median / p95 milliseconds and is diagnostic evidence rather than a new CI threshold.

| Phase | Repeated SQLite work | Snapshot-local memoisation |
| --- | ---: | ---: |
| Query/projection | 2,428.0 / 2,428.5 ms | 298.7 / 298.9 ms |
| Total | 2,445.1 / 2,446.5 ms | 315.5 / 315.6 ms |

Deterministic behavioural hooks, not wall-clock thresholds, enforce one show read and one search execution per exact distinct key. The identical benchmark workload demonstrates the resulting reduction while retaining all 80 output envelopes and per-occurrence response accounting.

## Validated mutation snapshot comparison

MAR-2565 removes the second canonical JSON parse and graph validation from stable record additions and record-producing initialisation. Three measured fresh Node processes used the same lightweight valid corpus with no warmup at the MAR-2560 base (`15e3b037e5d710fa4743168798d5e3d8f752ee4c`) and the implementation snapshot (`906d6d7710fe511982a81ad0deb9ecff7e36f7d0`). Timings are diagnostic median / nearest-rank p95 milliseconds, not new CI thresholds.

| Records after add | MAR-2560 base | Validated snapshot | Disk cache validations | Canonical scan / graph validation | Next prepare |
| ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 50.6 / 69.2 ms | 41.6 / 43.0 ms | 1 → 0 | 1 / 1 | Fresh, 100 indexed |
| 1,000 | 142.4 / 152.7 ms | 140.3 / 142.3 ms | 1 → 0 | 1 / 1 | Fresh, 1,000 indexed |

The deterministic work counts are the regression authority: every measured snapshot run visited each pre-existing canonical entry once, performed one strict graph validation, performed no disk cache validation, and left the next `prepare` fresh. Behavioural tests separately prove logical metadata, record-row, and FTS equivalence with a forced disk hydrate. The permanent schema-version 2 benchmark remains unchanged because it measures public hydrate, prepare, and read operations rather than mutation orchestration.

## Stable canonical generation work

MAR-2575 extends the deterministic work-count authority from mutation snapshots to every canonical consumer. Stable validation and a generation change detected after graph validation have these exact test-measured counts:

| Canonical records | Stable entry visits | Stable scans / graph validations | One-retry entry visits | One-retry scans / graph validations |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 1 / 1 | 0 | 2 / 2 |
| 100 | 100 | 1 / 1 | 200 | 2 / 2 |
| 1,000 | 1,000 | 1 / 1 | 2,000 | 2 / 2 |

The retry is operation-scoped rather than repeated per directory. A change rejected during scanning contributes no graph validation for that attempt: continuous scan-time churn stops at three scans and zero graph validations, while continuous post-validation churn stops at three scans and three graph validations. Failed attempts expose no records.

Rebuilding a missing or stale cache for `prepare`, forced `hydrate`, list, show, search, gather, post-add hydration, and byte-eligible record-producing init uses only records-owned canonical scans and graph validations with no second cache-owned canonical pass. Publication-capable operations use one scan and graph validation only when the canonical root, every planned kind, and `_staging` already exist; they use two when only planned child directories must be created and three when the canonical root is absent. Cache-only operations that publish no record retain their single records-owned pass. A fresh-cache fast path may perform zero canonical scans. Byte-ineligible post-commit init deliberately performs its one expected-generation-bound reacquisition instead. Persistent pre-commit, read, or no-add churn during cache writing consumes the same three total scans and graph validations, rolls back every attempted transaction, leaves an existing valid cache unchanged, and performs no valid-cache quarantine; post-commit work never retries canonical acquisition or replanning.

These are behavioural phase counts, not timing claims. MAR-2575 adds no latency, memory, cache-size, benchmark-schema, or CI-budget threshold; `benchmark:check` and the committed schema-version 2 distributions remain the wall-clock and resource authorities.

## Scale guidance

The current full-rebuild cache is suitable for repository knowledge bases up to the product limit of 1,000 canonical records. On the baseline machine, cold hydration remained near a quarter second at that limit; unchanged prepare, list, show, and search remained near or below two tenths of a second, stale rebuilding remained below half a second, and the maximum-envelope duplicate-heavy gather remained the expensive path because it still constructs and charges every requested output occurrence.

Prefer specific terms, compact search, and targeted `show` calls when exploring larger corpora. Explicit record counts above the product limit remain exploratory and still fail if canonical record or byte budgets are exceeded.

If a stable full-profile run regresses materially, attach the schema-version 2 JSON report to a follow-up performance ticket before changing the cache architecture.
