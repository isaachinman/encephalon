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

The default full and baseline profiles generate deterministic synthetic repositories with 0, 100, and 1,000 records, matching `MAX_CANONICAL_RECORDS`. Each non-empty corpus includes small records, large payload records, an artifact-heavy slice, and a deep supersession chain. The benchmark measures cold hydrate, unchanged prepare, stale prepare, list, show, compact search, full search, gather, peak process RSS where Node exposes it, and final SQLite/WAL size.

To opt in past the product record limit for exploratory runs, pass explicit sizes with repeated `--records` flags, for example `bun run benchmark -- --records 0 --records 100 --records 1000 --records 10000`. Those over-limit corpora still have to satisfy product byte caps or they fail hydrate with corpus budget errors.

Results are written as JSON so later commits can compare the same fields without parsing human-readable output. The committed baseline is [performance-baseline.json](./performance-baseline.json), and the CI ceilings are [performance-budgets.json](./performance-budgets.json).

## Baseline

The committed baseline was measured on Node.js v26.5.0 on darwin arm64.

| Records | Cold hydrate | Unchanged prepare | Stale prepare | Compact search | Full search | Gather | Cache amplification |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 6 ms | 1 ms | 1 ms | 1 ms | 1 ms | 1 ms | n/a |
| 100 | 20 ms | 6 ms | 15 ms | 12 ms | 11 ms | 311 ms | 2.84x |
| 1,000 | 95 ms | 338 ms | 119 ms | 686 ms | 688 ms | 3.6 s | 2.6x |

Initial manual budgets for the current implementation on a stable local or dedicated runner are:

- 1,000-record cold hydrate and stale prepare should remain below 400 ms.
- 1,000-record unchanged prepare, list, and show should remain below 2100 ms.
- 1,000-record compact and full search should remain below 2100 ms for the benchmark query.
- 1,000-record gather with two broad searches should remain below 10.9 seconds.
- Cache amplification should remain below 4x canonical JSON bytes for the benchmark corpus.

The CI smoke profile intentionally runs only 0 and 100 records with generous ceilings. It is meant to catch runaway regressions in cache rebuilds, automatic prepare, search, gather, and cache size without making every push depend on precise cross-platform timing.

## Scale Guidance

The v0.1 full-rebuild cache is suitable for small and medium repository knowledge bases up to the product corpus limit of 1,000 canonical records. On the baseline machine, cold hydration and stale prepare stayed near a tenth of a second at that limit; list, show, and search remain usable, while broad gather stays the expensive path.

Broad `gather` requests become expensive as corpora grow because each gathered search executes over the FTS corpus and broad terms produce many candidate matches. Prefer specific search terms, compact search, and targeted `show` calls when exploring larger synthetic corpora with `--records`.

If future baseline runs exceed the manual budgets, open follow-up performance tickets with the new JSON result attached before changing the cache architecture.
