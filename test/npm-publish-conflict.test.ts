import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPublishedVersionConflictOutput } from '../scripts/npm-publish-conflict.ts'

test('accepts only npm diagnostics for an already-published package version', () => {
  const accepted = [
    [
      '{"error":{"code":"EPUBLISHCONFLICT","summary":"You cannot publish over the previously published versions: 0.2.0."}}',
      '',
    ],
    ['', '{"error":{"code":"E403","summary":"You cannot publish over the previously published versions: 0.2.0."}}'],
    ['{"error":{"summary":"You cannot publish over the previously published versions: 0.2.0."}}', ''],
    ['You cannot publish over the previously published versions: 0.2.0.\n', 'npm error code EPUBLISHCONFLICT\n'],
  ] as const
  assert.deepEqual(
    accepted.map(([stdout, stderr]) => isPublishedVersionConflictOutput(stdout, stderr)),
    [true, true, true, true],
  )

  const rejected = [
    ['{"error":{"code":"E401","summary":"You cannot publish over the previously published versions: 0.2.0."}}', ''],
    ['{"error":{"code":"E403","summary":"Authentication failed."}}', ''],
    ['{"id":"encephalon@0.2.0"}', ''],
    ['You cannot publish over the previously published versions: 0.2.0.\n', 'npm error code E401\n'],
    ['not json', 'npm error code EPUBLISHCONFLICT\n'],
  ] as const
  assert.deepEqual(
    rejected.map(([stdout, stderr]) => isPublishedVersionConflictOutput(stdout, stderr)),
    [false, false, false, false, false],
  )
})
