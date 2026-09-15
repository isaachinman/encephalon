# Performance and contributor checks

Canonical JSON and referenced artifacts are authoritative. SQLite is a disposable search/order projection. This guide owns measurement and release-tool commands; the [public contract](./contract.md) owns supported behaviour and limits.

## Contributor checks

Use the repository's pinned Bun for development and Node.js 24.15.0 or later for runtime checks. Build explicitly; tests never rebuild implicitly.

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run test:tooling
bun run build
bun run check:generated
bun run test:all
bun run check:package -- --retain-tarball package-artifacts
```

`test` runs source correctness without a distribution. `test:tooling` covers benchmark/release tools; `test:history` contains migration and published-version history; `test:package` covers package boundaries. `test:all` runs every group after an explicit build. Run focused groups while editing and the complete applicable suite before committing; do not repeat overlapping groups merely to accumulate passes.

Package checking packs once when no tarball is supplied and retains that exact candidate plus verified metadata. Subsequent checks consume the selected file without repacking:

```bash
bun run check:package -- --tarball package-artifacts/encephalon-0.3.0.tgz
bun run check:compatibility -- package-artifacts/encephalon-0.3.0.tgz
bun run check:publish -- package-artifacts/encephalon-0.3.0.tgz
```

These filenames match the current development manifest; use the selected versioned filename after a version bump. Compatibility uses the actual pinned published 0.3.0 oracle, independently of the candidate version. `check:publish` is an exact-tarball **dry run**. Real npm publication is a manual maintainer action using the independently verified trusted-main tarball, with `--ignore-scripts`; never publish from a source directory or rebuild after selection.

CI builds one candidate on Linux and checks the same bytes on Linux, macOS and Windows at minimum Node, plus current Node on Linux. Source, tooling, package and historical groups are disjoint. Windows separates cache tests from the remaining platform suite. Published-oracle compatibility runs for release/public-contract changes, on main and on scheduled checks. Historical tool tests run for changes to their dependencies, release-labelled PRs and scheduled/manual checks. The six benchmark jobs run on Linux ARM. Read-only check permissions remain in force.

Candidate metadata binds bytes, SHA-1/SHA-256/SHA-512, npm integrity, version and source commit. Reruns reuse the successful producer artifact; consumers neither rebuild nor repack it. A code-free workflow promotes a verified successful main-run artifact to trusted storage. Every workflow and job must finish in **under ten minutes**, measured from actual run timestamps; timeout settings alone do not demonstrate this.

## Relative regression comparison

Use exact commits with the base contained in the candidate and a new output directory:

```bash
node scripts/benchmark-compare.ts BASE_SHA CANDIDATE_SHA /tmp/encephalon-comparison
node scripts/benchmark-compare.ts BASE_SHA CANDIDATE_SHA /tmp/large-gather 20 large-gather
node scripts/benchmark-aggregate.ts performance-reports BASE_SHA CANDIDATE_SHA ATTEMPT
```

The default local comparison runs all operations sequentially. CI partitions fifteen representative 1,000-record operations into `large-gather`, `large-payload`, `large-maximum`, `large-preparation`, `large-reads` and `large-validation`. Each operation uses **two discarded warmups and twenty measured samples per revision**: 600 raw samples overall. Adjacent base/candidate pairs alternate AB/BA on one runner and Node executable; no measured workers overlap. Do not run tests or builds concurrently. A fourth positional argument can select at least three repetitions for diagnostics, never for release approval.

The candidate's common harness and deterministic fixtures measure both revisions. Each fresh child measures the public operation after the required fixture state is established. Prepared reads reuse stable working fixtures; cold hydrate and stale/unchanged preparation restore their necessary state. Linux drains fixture-setup writes before measurement; operation-owned writes/fsync remain timed. Prepared filesystem state is warm: “cold hydrate” means absent application cache, not a cold operating-system cache.

The mixed corpus contains payloads, supersession and 100 distinct referenced artifacts. Dedicated workloads exercise payload-only and missing matches, maximum list/gather envelopes, an exactly 1 MiB canonical record with 256 KiB search text, artifact validation and strict cache equivalence. Gather retains 16 searches and 64 shows with repeated queries/IDs, including duplicate projection and response charging. Smaller and empty corpora remain correctness/smoke coverage.

The `large-reads` shard alone builds/packs pristine revisions for package size and `--help`/`--version` startup measurements. Startup uses the extracted package executable without npm/npx overhead. Source-only shards avoid package builds. Every shard retains raw `base.json`, `candidate.json` and `comparison.json` evidence.

For aggregation, download each `performance-ATTEMPT-*` artifact into its own directory. Require all six shards, exact revisions, common harness/fixture identities, complete counts and compatible runtime settings. Each shard keeps its runner/CPU provenance; samples are never pooled across machines. Reruns use the newest complete base/candidate pair for each shard up to the current attempt. Incomplete newer evidence fails; it cannot fall back to an older pass.

| Metric | Maximum regression per operation |
| --- | ---: |
| Median total latency | 15% |
| Nearest-rank p95 total latency | 25% |
| Maximum worker peak RSS | 20% |
| Cache, emitted JavaScript, declarations and tarball bytes | 10% |

Equality passes; zero-to-positive increases fail. Comparisons use unrounded samples and never adjust thresholds automatically. Local complete comparisons check 53 metrics; six-shard CI checks 58 because cache sizes repeat across shards. All must pass. Absolute ceilings in [performance-budgets.json](./performance-budgets.json) are runaway guards, not relative approval.

Reports identify revisions, harness/fixture hashes, runtime/CPU, sample configuration, raw values, range, population variance and differences. Read timing separates preparation/integrity, query/projection and bounded return overhead; per-sample phases sum to total. `peakRssBytes` is the fresh child's lifetime high-water mark, converted from KiB to bytes, including Node/module startup. `rssDeltaBytes` is diagnostic. Cache amplification divides complete cache bytes by canonical JSON bytes; it is undefined for an empty corpus. Summary values are rounded to three decimals.

## Current representative baseline

```bash
bun run benchmark -- --profile full --output docs/performance-baseline.json
bun run benchmark:check
```

[The committed schema-version 2 report](./performance-baseline.json) was generated on 2026-09-10 at `a60fbf4028f999189820d948da5904e55ec16b5b`, with documentation-only working changes, on Node.js v24.15.0, macOS arm64, Apple M5 Pro. No tests/builds ran concurrently. Five measured fresh processes followed two discarded warmups. Values below are median / p95 milliseconds; this diagnostic snapshot does not replace the twenty-sample paired gate or promise latency on other machines.

| Records | Cold hydrate | Unchanged prepare | Stale prepare | Compact search | Full search | Gather | Cache amplification |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 30.3 / 32.3 | 5.2 / 7.1 | n/a | 5.5 / 6.1 | 5.4 / 5.9 | 6.2 / 6.6 | n/a |
| 100 | 52.3 / 55.4 | 25.0 / 26.4 | 67.5 / 68.8 | 24.0 / 25.6 | 23.4 / 23.8 | 24.5 / 24.6 | 1.447x |
| 1,000 | 198.8 / 210.6 | 129.4 / 131.7 | 270.2 / 281.7 | 130.5 / 131.5 | 131.1 / 140.4 | 134.6 / 144.0 | 1.310x |

At 1,000 records the cache is 4,689,920 bytes. Strict cache validation is 130.1 / 141.4 ms with 133,005,312 bytes peak RSS. Maximum-envelope gather peaks at 132,988,928 bytes. These values describe the current lean runtime; historical comparisons and the prior baseline are preserved byte-for-byte under context record `3ae9fa5c-490d-4a55-b988-22609b49ba00`.

Standalone profiles are `ci` (0/100/1,000 records, no warmup, one sample), `baseline` (0/100, one warmup, three samples) and `full` (0/100/1,000, two warmups, five samples). Repeated `--records` selects a custom profile; `--warmups`, `--repetitions`, `--timeout-ms`, `--budget` and `--output` control diagnostics. See `bun run benchmark -- --help`. Reports replace their output only after all samples and budget checks succeed.

The supported corpus stops at 1,000 records. Prefer compact search and targeted shows as knowledge grows. Investigate a regression using its raw paired evidence before changing the architecture; preserve canonical validation, response bounds and filesystem safety throughout.
