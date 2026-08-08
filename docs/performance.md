# Performance Benchmarks

Encephalon keeps canonical records in JSON and rebuilds a disposable SQLite/FTS cache when those canonical inputs change. The benchmark suite characterises that current full-rebuild design before any cache architecture changes are made.

## Commands

Run the full benchmark profile:

```bash
bun run benchmark -- --output docs/performance-baseline.json
```

Run the CI smoke budget profile:

```bash
bun run benchmark:check
```

The full profile generates deterministic synthetic repositories with 0, 100, 1,000, and 10,000 records. Each non-empty corpus includes small records, large payload records, an artifact-heavy slice, and a deep supersession chain. The benchmark measures cold hydrate, unchanged prepare, stale prepare, list, show, compact search, full search, gather, peak process RSS where Node exposes it, and final SQLite/WAL size.

Results are written as JSON so later commits can compare the same fields without parsing human-readable output. The committed baseline is [performance-baseline.json](./performance-baseline.json), and the CI ceilings are [performance-budgets.json](./performance-budgets.json).

## Baseline

The committed baseline was measured on Node.js v24.15.0 on macOS arm64. Use it as a shape-of-work reference, not as a universal stopwatch. Filesystem metadata, SQLite, CPU, and runner contention vary materially between macOS, Linux, and Windows.

| Records | Cold hydrate | Unchanged prepare | Stale prepare | Compact search | Full search | Gather | Cache amplification |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 6 ms | 1 ms | 1 ms | 1 ms | 1 ms | 1 ms | n/a |
| 100 | 16 ms | 1 ms | 12 ms | 2 ms | 2 ms | 337 ms | 2.75x |
| 1,000 | 90 ms | 6 ms | 104 ms | 14 ms | 15 ms | 3.3 s | 2.60x |
| 10,000 | 874 ms | 44 ms | 972 ms | 124 ms | 126 ms | 33.2 s | 2.34x |

Initial manual budgets for the current implementation on a stable local or dedicated runner are:

- 10,000-record cold hydrate and stale prepare should remain below 2 seconds.
- 10,000-record unchanged prepare, list, and show should remain below 100 ms.
- 10,000-record compact and full search should remain below 250 ms for the benchmark query.
- 10,000-record gather with two broad searches should remain below 45 seconds.
- Cache amplification should remain below 4x canonical JSON bytes for the benchmark corpus.

The CI smoke profile intentionally runs only 0 and 100 records with generous ceilings. It is meant to catch runaway regressions in cache rebuilds, automatic prepare, search, gather, and cache size without making every push depend on precise cross-platform timing.

## Scale Guidance

The v0.1 full-rebuild cache is suitable for small and medium repository knowledge bases. Up to roughly 1,000 records, cold hydration and stale prepare stayed near 100 ms on the baseline machine, and individual list/show/search reads remained interactive.

At 10,000 records, hydration remains under a second on the baseline machine, but broad `gather` requests become expensive because each gathered search executes over the FTS corpus and broad terms produce many candidate matches. For large corpora, prefer specific search terms, compact search, and targeted `show` calls. Treat repeated broad multi-search `gather` calls over 10,000-record corpora as batch work rather than an interactive path.

If future baseline runs exceed the manual budgets, open follow-up performance tickets with the new JSON result attached before changing the cache architecture.
