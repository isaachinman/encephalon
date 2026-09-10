# Performance Benchmarks

Encephalon keeps canonical records in JSON and rebuilds a disposable SQLite/FTS cache when those canonical inputs change. The benchmark suite characterises that full-rebuild design with fresh-process latency and memory samples before any cache architecture change is made.

## Commands

For a local comparison, use two exact commits with the base contained in the candidate:

```bash
node scripts/benchmark-compare.ts BASE_SHA CANDIDATE_SHA /tmp/encephalon-comparison
```

The output directory must be new. The default command runs the complete comparison sequentially for local investigation. One Node executable measures both revisions, with two discarded warmups and twenty measured samples per operation. Each adjacent base/candidate pair alternates AB/BA; samples never overlap. Twenty samples give nearest-rank p95 its own position below the maximum. Do not run tests or builds concurrently on that machine. A fourth argument selects a fixed repetition count of at least three for diagnostics.

CI measures all fifteen representative operations at 1,000 records in six independent `ubuntu-24.04-arm` jobs: `large-gather`, `large-payload`, `large-maximum`, `large-preparation`, `large-reads` and `large-validation`. The three expensive query workloads each own one job; preparation, reads and validation partition the remaining twelve operations. The reads job alone owns package/startup measurements. Every operation retains twenty samples per revision and two discarded warmups. Empty, one-record and 100-record behaviour remains in correctness and smoke coverage; CI no longer repeats a dense timing matrix at each size. No samples are pooled across machines. Reproduce a shard with:

```bash
node scripts/benchmark-compare.ts BASE_SHA CANDIDATE_SHA /tmp/large-gather 20 large-gather
node scripts/benchmark-compare.ts BASE_SHA CANDIDATE_SHA /tmp/large-reads 20 large-reads
```

Each revision prepares its own immutable fixture snapshots once. Short-lived revision-bound controllers restore a separate working fixture for each operation. An explicit allowlist of prepared read/validation operations reuses that fixture across fresh measurement workers; cold hydrate, unchanged prepare and stale prepare restore their required state before every sample. After a reusable worker exits, its empty WAL and transient shared-memory index are removed; a nonempty WAL fails the comparison. Canonical and database bytes remain stable. This measures warm filesystem/prepared state, not cold operating-system caches. The `large-reads` shard alone builds and packs pristine revisions before applying the common harness, and owns package sizes and packed startup checks; source-only shards avoid unnecessary package builds. All shards retain raw samples and their `base.json`, `candidate.json`, and `comparison.json`. The aggregate requires all six declared shards, exact revisions, common harness and fixture identities, the declared per-shard sample counts, and matching runtime settings; each shard retains its own runner and CPU identity. Every comparison must pass, including cache-byte comparisons repeated where a corpus spans shards.

On Linux, fixture setup finishes with GNU `sync --file-system` before the measured worker starts. This drains setup writes once for reused fixtures and before each restored sample. The operation's own SQLite writes and filesystem synchronisation remain inside its wall-clock measurement.

Download all `performance-ATTEMPT-*` artifacts from the same workflow run into separate directories. Aggregation selects the newest available complete pair per declared shard, up to the current attempt, and records each source attempt. It never combines the base from one attempt with the candidate from another or falls back from incomplete newer evidence. CI requires all prerequisite jobs to succeed and every performance upload to exist before aggregation, so a newer failed job cannot reuse an earlier pass. Reproduce aggregation with:

```bash
node scripts/benchmark-aggregate.ts performance-reports BASE_SHA CANDIDATE_SHA ATTEMPT
```

The complete CI workflow must finish under ten minutes; actual duration must be measured. Runtime, API, filesystem and process-lifecycle tests run on Linux, macOS and Windows at the minimum supported Node version, plus current Node on Linux. Benchmark and package-checker regression fixtures run once on Linux, alongside lint and typechecking. The exact package candidate is built and checked on Linux, then the same retained bytes are checked on macOS, Windows and current Node. Published-oracle compatibility and publish dry-run checks remain on Linux. Required check names and read-only permissions are unchanged. macOS and Windows have no required wall-clock performance thresholds.

Build explicitly with `bun run build`, then use `bun run test` for runtime correctness and `bun run test:tooling` for benchmark and release-tool regressions. Tests do not rebuild implicitly. Windows runs the cache file separately from the remaining runtime tests; their disjoint union covers the complete runtime suite. The native Node test runner retains process isolation; filesystem state, SQLite and subprocess behaviour execute under the supported runtime.

Every operation independently permits at most 15% median latency regression, 25% nearest-rank p95 latency regression, and 20% peak RSS regression. Cache bytes, emitted JavaScript bytes, declaration bytes, and packed archive bytes permit at most 10% regression. Equality passes. Zero-to-positive increases fail. Comparisons use unrounded samples, reject incomplete or incompatible evidence, and never adjust thresholds automatically. Reports identify both commits, the common harness hash, fixture hashes, runtime, architecture, CPU, sample configuration, raw samples, ranges, population variances, and each metric's values and differences. Peak RSS is the maximum worker-lifetime high-water mark across samples.

The regression comparison requires every named workload at 1,000 records; smaller corpora remain behavioural fixtures. Named operations expose `largePayloadSearch`, `maximumPayloadSearch`, `payloadOnlySearch`, `missingSearch`, `listMaximum`, `validateArtifacts`, and `strictCacheValidation` alongside the existing operations. The 1,000-record mixed corpus references 100 distinct artifacts beneath their record-owned directories and shared ancestors. The maximum-payload search fixture replaces the final small record with an exactly 1 MiB canonical record including 256 KiB of search text; the deep payload token appears only in payload data. Other operations retain the original mixed corpus so maximum-limit list remains within the independent response budget. The isolated strict-cache operation performs a one-result read and retains separate integrity/query timing and peak RSS.

CLI startup runs `--help` and `--version` from each extracted package's declared executable, validates output, and measures complete process lifetime without npm/npx overhead. Package sizes come from those exact archives. All subprocesses retain independent hard timeouts; the existing absolute ceilings below remain generous runaway guards and do not constitute relative performance approval. “Cold hydrate” means an absent disposable application cache, not an artificially cold operating-system filesystem cache.

Generate the committed stable baseline:

```bash
bun run benchmark -- --profile full --output docs/performance-baseline.json
```

Run the fast CI budget profile:

```bash
bun run benchmark:check
```

The profiles are fixed:

- `ci`: 0, 100, and 1,000 records, no warmup, one measured sample;
- `baseline` (the default): 0 and 100 records, one warmup and three measured samples;
- `full`: 0, 100, and 1,000 records, two warmups and five measured samples.

Repeated `--records` values create a `custom` profile. `--warmups`, `--repetitions`, and `--timeout-ms` override the selected defaults; `--budget` reads a schema-version 2 budget; and `--output` atomically replaces a JSON report only after every sample and budget check succeeds. Run `bun run benchmark -- --help` for the complete option list.

Each non-empty deterministic corpus contains small records, large payloads, referenced artifacts, and a supersession chain. The benchmark measures cold hydrate, unchanged prepare, stale prepare, list, show, compact search, full search, and gather. Gather emits the public maxima of 64 shows drawn from two repeated exact IDs and 16 searches drawn from two repeated exact queries, so its measured work includes duplicate projection and response charging without repeating the SQLite reads. A zero-record corpus has no meaningful stale mutation, so `stalePrepare` is `null` for that case.

Every warmup and measured operation runs in a fresh Node child. The standalone baseline controller restores the exact unprepared or prepared repository state before each child; the paired comparison reuses an operation's prepared working fixture. Because copying changes canonical filesystem metadata, controllers re-prepare restored non-cold fixtures before measurement and apply the different-length stale mutation only afterward. Both modes restore cold and stale samples independently. Warmups are discarded. Measured samples retain execution order and report count, maximum, median, and nearest-rank p95. Read operations split their total into preparation/integrity, query/projection, and bounded return overhead; those unrounded per-sample phases add to the total. Summary values are rounded to three decimal places.

`peakRssBytes` is the isolated child's lifetime `process.resourceUsage().maxRSS`, converted from KiB to bytes. It includes Node and module startup but cannot inherit a previous benchmark operation's peak. `rssDeltaBytes` is the signed change in current RSS within that child and is diagnostic rather than budgeted.

Results are committed in [performance-baseline.json](./performance-baseline.json). CI ceilings live in [performance-budgets.json](./performance-budgets.json), select explicit p95 total-time or maximum cache statistics, and reject incompatible or incomplete budget schemas before creating a benchmark repository.

Correctness tests enforce deterministic output and bounded work counts for canonical scans, supersession graphs, and baseline accumulation. They use per-invocation internal observers and never inspect production source spelling. One isolated test also compares retained heap allocation against descriptor-map controls for payload validation; `benchmark:check` and the stable full-profile evidence own configured product wall-clock and cache-size ceilings, while isolated RSS remains diagnostic unless a budget explicitly selects it.

## Stable baseline

The committed schema-version 2 baseline was measured on Node.js v26.5.0 on darwin arm64. Each timing is median / p95 across five measured fresh processes after two discarded warmups.

| Records | Cold hydrate | Unchanged prepare | Stale prepare | Compact search | Full search | Gather | Cache amplification |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 30.5 / 32.1 ms | 5.3 / 5.4 ms | n/a | 5.9 / 6.0 ms | 5.9 / 5.9 ms | 6.4 / 6.5 ms | n/a |
| 100 | 103.0 / 104.0 ms | 50.5 / 57.0 ms | 126.2 / 128.4 ms | 54.6 / 55.5 ms | 51.1 / 52.8 ms | 344.1 / 345.4 ms | 2.46x |
| 1,000 | 666.0 / 673.3 ms | 382.0 / 392.3 ms | 885.4 / 890.1 ms | 417.7 / 519.2 ms | 399.4 / 409.6 ms | 3.37 / 3.38 s | 2.32x |

The CI profile runs 0, 100, and 1,000 records with one measured process and generous ceilings. The product-limit case explicitly budgets the preparation/integrity phase that proves canonical/cache record equivalence, as well as total operation latency and cache size. It catches runaway cache rebuild, automatic preparation, search, gather, equivalence validation, and cache-size regressions without treating noisy cross-platform timings as precise performance claims. Stable comparisons should use the full profile and its distributions.

At 1,000 records, canonical/cache equality validation is included in the measured preparation/integrity phase: median / p95 is 382.0 / 392.3 ms for unchanged preparation and 257.0 / 267.7 ms for list. Across list, show, compact search, full search, and gather, that phase remains below 300 ms p95 in this full profile; unchanged preparation is reported separately above. The committed product-limit budget permits at most 10 seconds for each read preparation/integrity phase, leaving cross-platform headroom while still detecting unbounded or duplicated validation work.

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

## Stable canonical read snapshots

Stable validation and canonical reads perform one bounded canonical scan, one graph-validation pass, one initial artifact-validation pass, and one closing artifact-record-artifact evidence sandwich. Behavioural work-count tests cover empty, 100-record, and 1,000-record corpora. A detected generation change discards that attempt and adds exactly one complete pipeline; no per-directory or per-record retry resets the shared maximum of three attempts or its non-resetting 60-second deadline.

This change introduces no new latency, memory, cache-size, or amplification threshold. The existing schema-version 2 benchmark remains the release authority for configured public-operation budgets, while deterministic work observers enforce the stable and retry pipeline counts.

## Validated mutation snapshot comparison

MAR-2565 removes the second canonical JSON parse and graph validation from stable record additions and record-producing initialisation. Three measured fresh Node processes used the same lightweight valid corpus with no warmup at the MAR-2560 base (`15e3b037e5d710fa4743168798d5e3d8f752ee4c`) and the implementation snapshot (`906d6d7710fe511982a81ad0deb9ecff7e36f7d0`). Timings are diagnostic median / nearest-rank p95 milliseconds, not new CI thresholds.

| Records after add | MAR-2560 base | Validated snapshot | Disk cache validations | Canonical scan / graph validation | Next prepare |
| ---: | ---: | ---: | ---: | ---: | --- |
| 100 | 50.6 / 69.2 ms | 41.6 / 43.0 ms | 1 → 0 | 1 / 1 | Fresh, 100 indexed |
| 1,000 | 142.4 / 152.7 ms | 140.3 / 142.3 ms | 1 → 0 | 1 / 1 | Fresh, 1,000 indexed |

The deterministic work counts are the regression authority: every measured snapshot run visited each pre-existing canonical entry once, performed one strict graph validation, performed no disk cache validation, and left the next `prepare` fresh. Behavioural tests separately prove logical metadata, record-row, and FTS equivalence with a forced disk hydrate. The permanent schema-version 2 benchmark remains unchanged because it measures public hydrate, prepare, and read operations rather than mutation orchestration.

## Scale guidance

The current full-rebuild cache is suitable for repository knowledge bases up to the product limit of 1,000 canonical records. On the baseline machine, cold hydration remained below 0.7 seconds at that limit; unchanged prepare, list, show, and full search remained near 0.4 seconds, stale rebuilding remained below 0.9 seconds, and the maximum-envelope duplicate-heavy gather remained the expensive path because it still constructs and charges every requested output occurrence.

Prefer specific terms, compact search, and targeted `show` calls when exploring larger corpora. Explicit record counts above the product limit remain exploratory and still fail if canonical record or byte budgets are exceeded.

If a stable full-profile run regresses materially, attach the schema-version 2 JSON report to a follow-up performance ticket before changing the cache architecture.
