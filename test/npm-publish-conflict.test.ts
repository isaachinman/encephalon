import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { isPublishedVersionConflictOutput } from '../scripts/npm-publish-conflict.ts'

const root = resolve(import.meta.dirname, '..')

const createPublishCheckFixture = () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'encephalon-publish-check-'))
  const scriptsDirectory = resolve(temporaryRoot, 'scripts')
  mkdirSync(scriptsDirectory)
  cpSync(resolve(root, 'scripts', 'check-publish.ts'), resolve(scriptsDirectory, 'check-publish.ts'))
  cpSync(resolve(root, 'scripts', 'npm-publish-conflict.ts'), resolve(scriptsDirectory, 'npm-publish-conflict.ts'))
  writeFileSync(resolve(temporaryRoot, 'package.json'), '{"type":"module"}\n')
  writeFileSync(
    resolve(scriptsDirectory, 'npm-command.ts'),
    `export const spawnNpmCommand = (arguments_, options) => {
  if (JSON.stringify(arguments_) !== '["publish","--dry-run","--ignore-scripts","--access","public","--json"]') {
    throw new Error('Unexpected npm arguments.')
  }
  if (typeof options.cwd !== 'string') throw new Error('Missing npm working directory.')
  return JSON.parse(process.env.ENCEPHALON_TEST_NPM_RESULT ?? '{}')
}
`,
  )
  return temporaryRoot
}

const runPublishCheckFixture = (temporaryRoot: string, result: object) =>
  spawnSync(process.execPath, ['./scripts/check-publish.ts'], {
    cwd: temporaryRoot,
    encoding: 'utf8',
    env: { ...process.env, ENCEPHALON_TEST_NPM_RESULT: JSON.stringify(result) },
  })

test('accepts only npm diagnostics for an already-published package version', () => {
  const conflictJson =
    '{"error":{"code":"EPUBLISHCONFLICT","summary":"You cannot publish over the previously published versions: 0.2.0."}}'
  const prettyConflictJson = `{
  "error": {
    "summary": "You cannot publish over the previously published versions: 0.2.0."
  }
}`
  const accepted = [
    [conflictJson, ''],
    ['', '{"error":{"code":"E403","summary":"You cannot publish over the previously published versions: 0.2.0."}}'],
    ['{"error":{"summary":"You cannot publish over the previously published versions: 0.2.0."}}', ''],
    [`${prettyConflictJson.replaceAll('\n', '\r\n')}\r\nnpm warn using --force\r\nplain warning text\r\n`, ''],
    ['You cannot publish over the previously published versions: 0.2.0.\n', 'npm error code EPUBLISHCONFLICT\n'],
    ['You cannot publish over the previously published versions: 0.2.0.\r\n', 'npm error code E403\r\n'],
  ] as const
  assert.deepEqual(
    accepted.map(([stdout, stderr]) => isPublishedVersionConflictOutput(stdout, stderr)),
    [true, true, true, true, true, true],
  )

  const rejected = [
    ['{"error":{"code":"E401","summary":"You cannot publish over the previously published versions: 0.2.0."}}', ''],
    ['{"error":{"code":"E403","summary":"Authentication failed."}}', ''],
    ['{"id":"encephalon@0.2.0"}', ''],
    ['You cannot publish over the previously published versions: 0.2.0.\n', 'npm error code E401\n'],
    ['not json', 'npm error code EPUBLISHCONFLICT\n'],
    [conflictJson, 'npm error code E401\nAuthentication failed.\n'],
    [
      'You cannot publish over the previously published versions: 0.2.0.\n',
      'npm error code EPUBLISHCONFLICT\nnpm error code E401\n',
    ],
    [conflictJson, '{"error":{"code":"E401","summary":"Authentication failed."}}'],
    [
      '{"error":{"code":"E401","summary":"Authentication failed."}}\nnpm warn retrying\n',
      'npm error code EPUBLISHCONFLICT\nYou cannot publish over the previously published versions: 0.2.0.\n',
    ],
    [conflictJson, 'npm error Authentication failed\n'],
    [conflictJson, 'npm ERR! network timeout\n'],
    [conflictJson, 'fatal: authentication failed\n'],
    [
      '{"id":"encephalon@0.2.0"}\n',
      'npm error code EPUBLISHCONFLICT\nYou cannot publish over the previously published versions: 0.2.0.\n',
    ],
    [
      `${conflictJson}\n{"error":{"code":"E401","summary":"Authentication failed."}}\n`,
      'npm error code EPUBLISHCONFLICT\nYou cannot publish over the previously published versions: 0.2.0.\n',
    ],
  ] as const
  assert.deepEqual(
    rejected.map(([stdout, stderr]) => isPublishedVersionConflictOutput(stdout, stderr)),
    [false, false, false, false, false, false, false, false, false, false, false, false, false, false],
  )
})

test('publish checker forwards npm output and rejects unrelated publish failures', () => {
  const temporaryRoot = createPublishCheckFixture()
  try {
    const success = runPublishCheckFixture(temporaryRoot, { status: 0, stderr: '', stdout: 'publish succeeded\n' })
    assert.equal(success.status, 0, success.stderr)
    assert.equal(success.stdout, 'publish succeeded\n')
    assert.equal(success.stderr, '')

    const conflictOutput =
      '{"error":{"code":"EPUBLISHCONFLICT","summary":"You cannot publish over the previously published versions: 0.2.0."}}\n'
    const conflictOutputWithWarning = `${conflictOutput}npm warn using --force\n`
    const conflict = runPublishCheckFixture(temporaryRoot, {
      status: 1,
      stderr: '',
      stdout: conflictOutputWithWarning,
    })
    assert.equal(conflict.status, 0, conflict.stderr)
    assert.equal(conflict.stdout, conflictOutputWithWarning)
    assert.equal(conflict.stderr, '')

    const failure = runPublishCheckFixture(temporaryRoot, {
      status: 1,
      stderr: 'fatal: authentication failed\n',
      stdout: conflictOutput,
    })
    assert.notEqual(failure.status, 0)
    assert.equal(failure.stdout, conflictOutput)
    assert.match(failure.stderr, /^fatal: authentication failed\n/u)
    assert.match(failure.stderr, /npm publish dry-run failed with exit code 1\./u)
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})
