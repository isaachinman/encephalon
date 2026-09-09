import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareBenchmarkRuns, parseComparableRun } from './benchmark-comparison.ts'
import { benchmarkShards } from './benchmark-shards.ts'

export const aggregateBenchmarkShards = (
  evidence: Record<string, { base: unknown; candidate: unknown }>,
  baseCommit: string,
  candidateCommit: string,
) => {
  const names = Object.keys(benchmarkShards)
  if (Object.keys(evidence).length !== names.length || names.some(name => !Object.hasOwn(evidence, name))) {
    throw new Error('Benchmark aggregate requires every declared shard exactly once.')
  }
  const shards = names.map(name => {
    const pair = evidence[name]
    const scope = benchmarkShards[name]
    if (!(pair && scope)) {
      throw new Error('Benchmark shard is missing.')
    }
    const base = parseComparableRun(pair.base, scope)
    const candidate = parseComparableRun(pair.candidate, scope)
    if (
      base.commit !== baseCommit ||
      candidate.commit !== candidateCommit ||
      base.benchmark.configuration.repetitions !== 20 ||
      base.benchmark.configuration.warmups !== 2 ||
      base.benchmark.environment.platform !== 'linux'
    ) {
      throw new Error('Benchmark shard does not match the expected revisions or Linux sampling policy.')
    }
    return { base, candidate, comparison: compareBenchmarkRuns(base, candidate, scope), name }
  })
  const [first] = shards
  if (!first) {
    throw new Error('Benchmark aggregate is empty.')
  }
  const fixtures = new Map<number, string>()
  for (const shard of shards) {
    if (
      shard.base.harnessSha256 !== first.base.harnessSha256 ||
      JSON.stringify(shard.base.benchmark.configuration) !== JSON.stringify(first.base.benchmark.configuration) ||
      shard.base.benchmark.environment.node !== first.base.benchmark.environment.node ||
      shard.base.benchmark.environment.arch !== first.base.benchmark.environment.arch
    ) {
      throw new Error('Benchmark shards have incompatible harnesses or runtime settings.')
    }
    for (const { operations: _operations, cache: _cache, ...fixture } of shard.base.benchmark.cases) {
      const identity = JSON.stringify(fixture)
      const previous = fixtures.get(fixture.records)
      if (previous !== undefined && previous !== identity) {
        throw new Error('Benchmark shards have incompatible fixtures.')
      }
      fixtures.set(fixture.records, identity)
    }
  }
  return {
    baseCommit,
    candidateCommit,
    harnessSha256: first.base.harnessSha256,
    passed: shards.every(shard => shard.comparison.passed),
    schemaVersion: 2,
    // Each comparison retains its own runner, CPU, raw samples, and spread.
    // No observations or distributions are pooled across different jobs.
    shards,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, base, candidate, attempt] = process.argv.slice(2)
  if (!(directory && base && candidate && attempt && /^[1-9][0-9]*$/.test(attempt))) {
    throw new Error('Usage: node scripts/benchmark-aggregate.ts DIRECTORY BASE_SHA CANDIDATE_SHA RUN_ATTEMPT')
  }
  const prefix = `performance-${attempt}-`
  const directories = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
  if (directories.some(entry => !entry.name.startsWith(prefix))) {
    throw new Error('Benchmark evidence belongs to a different workflow attempt.')
  }
  const evidence = Object.fromEntries(
    directories.map(entry => [
      entry.name.slice(prefix.length),
      Object.fromEntries(
        ['base', 'candidate'].map(side => [
          side,
          JSON.parse(readFileSync(join(directory, entry.name, `${side}.json`), 'utf8')),
        ]),
      ) as { base: unknown; candidate: unknown },
    ]),
  )
  const result = aggregateBenchmarkShards(evidence, base, candidate)
  writeFileSync(join(directory, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(
    `Performance comparison ${result.passed ? 'passed' : 'failed'} across ${result.shards.length} same-runner shards.\n`,
  )
  process.exitCode = result.passed ? 0 : 1
}
