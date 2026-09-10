import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectCiChecks } from './ci-selection.ts'

test('requires history for public, persisted, package and verification changes, including removed paths', () => {
  for (const path of [
    'src/records.ts',
    'src/cli.ts',
    'src/index.ts',
    'package.json',
    'bun.lock',
    'skills/encephalon/SKILL.md',
    'scripts/build.ts',
    'scripts/release-compatibility.ts',
    '.github/workflows/ci.yml',
    'docs/contract.md',
    'unknown/new-runtime-file.ts',
  ]) {
    assert.equal(selectCiChecks({ event: 'pull_request', paths: [path] }).compatibility, true, path)
  }
  assert.equal(
    selectCiChecks({ event: 'pull_request', paths: ['test/records.test.ts', 'src/deleted.ts'] }).compatibility,
    true,
  )
  assert.equal(selectCiChecks({ event: 'push', paths: ['src/cache.ts'] }).historyTools, false)
  assert.equal(
    selectCiChecks({ event: 'pull_request', paths: ['scripts/release-compatibility.test.ts'] }).historyTools,
    true,
  )
})

test('skips history only for known ordinary changes and forces complete manual, scheduled and release coverage', () => {
  const paths = ['README.md', 'docs/performance.md', 'encephalon/architecture/decision.json', 'test/records.test.ts']
  assert.deepEqual(selectCiChecks({ event: 'pull_request', paths }), { compatibility: false, historyTools: false })
  // A previous relevant main run may have been cancelled; every main candidate receives its own history proof.
  assert.deepEqual(selectCiChecks({ event: 'push', paths }), { compatibility: true, historyTools: false })
  for (const event of ['workflow_dispatch', 'schedule']) {
    assert.deepEqual(selectCiChecks({ event, paths }), { compatibility: true, historyTools: true })
  }
  assert.deepEqual(selectCiChecks({ event: 'pull_request', labels: ['release'], paths }), {
    compatibility: true,
    historyTools: true,
  })
  assert.throws(() => selectCiChecks({ event: 'unknown', paths }), /event/)
  assert.deepEqual(selectCiChecks({ event: 'pull_request', paths: [] }), { compatibility: true, historyTools: true })
})
