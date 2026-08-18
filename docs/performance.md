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

Every warmup and measured operation runs in a fresh Node child after the parent restores the exact unprepared or prepared repository state. Warmups are discarded. Measured samples retain execution order and report count, maximum, median, and nearest-rank p95. Read operations split their total into preparation/integrity, query/projection, and bounded return overhead; those unrounded per-sample phases add to the total. Summary values are rounded to three decimal places.

`peakRssBytes` is the isolated child's lifetime `process.resourceUsage().maxRSS`, converted from KiB to bytes. It includes Node and module startup but cannot inherit a previous benchmark operation's peak. `rssDeltaBytes` is the signed change in current RSS within that child and is diagnostic rather than budgeted.

Results are committed in [performance-baseline.json](./performance-baseline.json). CI ceilings live in [performance-budgets.json](./performance-budgets.json), select explicit p95 total-time or maximum cache statistics, and reject incompatible or incomplete budget schemas before creating a benchmark repository.

## Stable baseline

The committed schema-version 2 baseline was measured on Node.js v26.5.0 on darwin arm64. Each timing is median / p95 across five measured fresh processes after two discarded warmups.

| Records | Cold hydrate | Unchanged prepare | Stale prepare | Compact search | Full search | Gather | Cache amplification |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 11.9 / 12.4 ms | 15.1 / 17.6 ms | n/a | 17.2 / 18.2 ms | 17.2 / 18.7 ms | 20.2 / 24.5 ms | n/a |
| 100 | 38.5 / 39.8 ms | 59.2 / 66.0 ms | 59.2 / 59.5 ms | 73.5 / 88.6 ms | 70.4 / 80.5 ms | 375.8 / 384.5 ms | 2.46x |
| 1,000 | 229.2 / 231.9 ms | 449.9 / 522.5 ms | 400.5 / 478.6 ms | 514.3 / 533.6 ms | 499.5 / 535.1 ms | 3.56 / 3.69 s | 2.32x |

The CI profile intentionally runs only 0 and 100 records with one measured process and generous ceilings. It catches runaway cache rebuild, automatic preparation, search, gather, and cache-size regressions without treating noisy cross-platform timings as precise performance claims. Stable comparisons should use the full profile and its distributions.

## Scale guidance

The current full-rebuild cache is suitable for repository knowledge bases up to the product limit of 1,000 canonical records. On the baseline machine, cold hydration remained below a quarter second at that limit; prepare, list, show, and search remained near half a second, while the deliberately broad two-search gather remained the expensive path.

Prefer specific terms, compact search, and targeted `show` calls when exploring larger corpora. Explicit record counts above the product limit remain exploratory and still fail if canonical record or byte budgets are exceeded.

If a stable full-profile run regresses materially, attach the schema-version 2 JSON report to a follow-up performance ticket before changing the cache architecture.
