import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBenchmarkSession, restoreBenchmarkSample } from './benchmark.ts'
import { runCompatibilityCommand } from './release-compatibility.ts'

// Temporary CI investigation: never feeds observations into the performance gate.
const available = spawnSync('strace', ['--version'], { encoding: 'utf8', timeout: 1000 })
if (available.status === 0) {
  const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-cold-io-'))
  const root = resolve(import.meta.dirname, '..')
  const deadline = performance.now() + 45_000
  try {
    const templates = createBenchmarkSession(1, directory)
    const worker = resolve(directory, 'hydrate.mjs')
    writeFileSync(
      worker,
      `import { hydrate } from ${JSON.stringify(pathToFileURL(resolve(root, 'src/index.ts')).href)}
const before = process.resourceUsage()
const start = performance.now()
hydrate({ root: process.argv[2] })
const totalMs = performance.now() - start
const after = process.resourceUsage()
process.stdout.write(JSON.stringify({totalMs,userCpuMs:(after.userCPUTime-before.userCPUTime)/1000,systemCpuMs:(after.systemCPUTime-before.systemCPUTime)/1000,voluntarySwitches:after.voluntaryContextSwitches-before.voluntaryContextSwitches,involuntarySwitches:after.involuntaryContextSwitches-before.involuntaryContextSwitches}))
`,
    )
    for (const trial of Array.from({ length: 20 }, (_, index) => index + 1)) {
      if (performance.now() < deadline) {
        restoreBenchmarkSample(templates.unprepared, templates.sampleRoot, 'coldHydrate')
        execFileSync('sync', ['--file-system', templates.sampleRoot], { timeout: 3000 })
        const trace = resolve(directory, `trace-${trial}`)
        const output = runCompatibilityCommand(
          'strace',
          [
            '-f',
            '-qq',
            '-T',
            '-e',
            'trace=fsync,fdatasync',
            '-o',
            trace,
            process.execPath,
            worker,
            templates.sampleRoot,
          ],
          { cwd: root, label: 'Cold hydration I/O diagnostic', timeoutMilliseconds: 3000 },
        )
        const syncDurations = [...readFileSync(trace, 'utf8').matchAll(/<([\d.]+)>/g)].map(
          match => Number(match[1]) * 1000,
        )
        process.stdout.write(
          `${JSON.stringify({ trial, ...JSON.parse(output.stdout), syncCalls: syncDurations.length, syncMaximumMs: Math.max(0, ...syncDurations), syncTotalMs: syncDurations.reduce((total, value) => total + value, 0) })}\n`,
        )
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
} else {
  process.stdout.write('Cold hydration I/O diagnostic unavailable: strace is not installed.\n')
}
