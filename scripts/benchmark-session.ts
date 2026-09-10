import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type CaseTemplates,
  createBenchmarkSession,
  prepareBenchmarkSessionOperation,
  runBenchmark,
} from './benchmark.ts'
import { benchmarkOperations } from './benchmark-model.ts'

// Executed in the selected revision, never imported by the neutral coordinator.
// The coordinator owns this temporary manifest and removes its entire parent on exit.
const [command, manifest, argument, output] = process.argv.slice(2)
if (manifest && command === 'prepare' && argument && /^(0|1|100|1000)$/.test(argument)) {
  writeFileSync(manifest, JSON.stringify(createBenchmarkSession(Number(argument), dirname(manifest))))
} else if (manifest && (command === 'operation' || (command === 'sample' && output))) {
  const operation = benchmarkOperations.find(value => value === argument)
  if (operation) {
    const templates = JSON.parse(readFileSync(manifest, 'utf8')) as CaseTemplates
    if (command === 'operation') {
      writeFileSync(manifest, JSON.stringify(prepareBenchmarkSessionOperation(templates, operation)))
    } else if (output) {
      const report = await runBenchmark(
        ['--records', String(templates.corpus.records), '--warmups', '0', '--repetitions', '1'],
        { operations: [operation], templates },
      )
      writeFileSync(output, JSON.stringify(report))
    }
  } else {
    throw new Error('Unknown benchmark operation.')
  }
} else {
  throw new Error('Invalid benchmark session command.')
}
