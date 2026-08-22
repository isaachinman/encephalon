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

Each non-empty deterministic corpus contains small records, large payloads, referenced artifacts, and a supersession chain. The benchmark measures cold hydrate, unchanged prepare, stale prepare, list, show, compact search, full search, and gather. A zero-record corpus has no meaningful stale mutation, so `stalePrepare` is `null` for that case.

Every warmup and measured operation runs in a fresh Node child after the parent restores the exact unprepared or prepared repository state. Because copying changes canonical filesystem metadata, the parent re-prepares every restored non-cold sample before measurement and applies the different-length stale mutation only afterward. Warmups are discarded. Measured samples retain execution order and report count, maximum, median, and nearest-rank p95. Read operations split their total into preparation/integrity, query/projection, and bounded return overhead; those unrounded per-sample phases add to the total. Summary values are rounded to three decimal places.

`peakRssBytes` is the isolated child's lifetime `process.resourceUsage().maxRSS`, converted from KiB to bytes. It includes Node and module startup but cannot inherit a previous benchmark operation's peak. `rssDeltaBytes` is the signed change in current RSS within that child and is diagnostic rather than budgeted.

Results are committed in [performance-baseline.json](./performance-baseline.json). CI ceilings live in [performance-budgets.json](./performance-budgets.json), select explicit p95 total-time or maximum cache statistics, and reject incompatible or incomplete budget schemas before creating a benchmark repository.

Correctness tests enforce deterministic output and bounded work counts for canonical scans, supersession graphs, and baseline accumulation. They use per-invocation internal observers and never inspect production source spelling. Wall-clock latency, memory, and cache-size regressions remain the exclusive responsibility of `benchmark:check` and the stable full-profile evidence.

## Stable baseline

The committed schema-version 2 baseline was measured on Node.js v26.5.0 on darwin arm64. Each timing is median / p95 across five measured fresh processes after two discarded warmups.

| Records | Cold hydrate | Unchanged prepare | Stale prepare | Compact search | Full search | Gather | Cache amplification |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 11.5 / 12.1 ms | 4.6 / 4.7 ms | n/a | 7.0 / 7.3 ms | 7.1 / 7.3 ms | 7.3 / 7.9 ms | n/a |
| 100 | 35.8 / 38.3 ms | 16.0 / 16.4 ms | 57.4 / 57.5 ms | 28.3 / 29.7 ms | 28.2 / 31.6 ms | 330.2 / 334.6 ms | 2.46x |
| 1,000 | 214.3 / 265.5 ms | 87.6 / 89.1 ms | 406.1 / 413.4 ms | 180.1 / 200.5 ms | 173.0 / 176.0 ms | 3.26 / 3.31 s | 2.32x |

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

The committed schema-version 2 baseline remains the pre-optimisation reference. Benchmark workers now also reject any public-read sample that does not report exactly one successful cache-generation validation before result materialisation.

## Scale guidance

The current full-rebuild cache is suitable for repository knowledge bases up to the product limit of 1,000 canonical records. On the baseline machine, cold hydration remained near a quarter second at that limit; unchanged prepare, list, show, and search remained near or below two tenths of a second, stale rebuilding remained below half a second, and the deliberately broad two-search gather remained the expensive path.

Prefer specific terms, compact search, and targeted `show` calls when exploring larger corpora. Explicit record counts above the product limit remain exploratory and still fail if canonical record or byte budgets are exceeded.

If a stable full-profile run regresses materially, attach the schema-version 2 JSON report to a follow-up performance ticket before changing the cache architecture.
