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
  cpSync(resolve(root, 'scripts', 'package-tarball.ts'), resolve(scriptsDirectory, 'package-tarball.ts'))
  writeFileSync(
    resolve(scriptsDirectory, 'package-preflight.ts'),
    `import { snapshotPackageTarball, verifyPackageArtifactMetadata } from './package-tarball.ts'
export const preflightExactPackageArtifact = ({ snapshotDirectory, tarballPath }) => {
  const metadata = verifyPackageArtifactMetadata(tarballPath)
  const snapshot = snapshotPackageTarball(tarballPath, snapshotDirectory)
  return { metadata, snapshot }
}
`,
  )
  writeFileSync(resolve(temporaryRoot, 'package.json'), '{"type":"module"}\n')
  writeFileSync(resolve(temporaryRoot, 'candidate.tgz'), 'candidate tarball')
  writeFileSync(
    resolve(temporaryRoot, 'candidate.tgz.metadata.json'),
    `${JSON.stringify(
      {
        bytes: 17,
        integrity: 'sha512-pTxmTw4D11aGOhLuuuLi7XMdkIwxMD/CLeWekvX9m00fIf2X+zxgZ/yhlV2/ZgbNj9U6a6zJFfMCchSrkKTj8A==',
        packageVersion: '0.3.0',
        sha1: '4d85c35b6eaaf3bb12766dd30b7f6d763bd34be8',
        sha256: '840e0eaa94a08f97f361ebdc32d46cb60b9e94a5f10773d0647b363847605b67',
        sha512:
          'a53c664f0e03d756863a12eebae2e2ed731d908c31303fc22de59e92f5fd9b4d1f21fd97fb3c6067fca1955dbf6606cd8fd53a6bacc915f3027214ab90a4e3f0',
        sourceCommit: 'a'.repeat(40),
        tarball: 'candidate.tgz',
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    resolve(scriptsDirectory, 'npm-command.ts'),
    `import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
export const spawnNpmCommand = (arguments_, options) => {
  const expectedTail = ['--dry-run', '--ignore-scripts', '--access', 'public', '--json']
  const source = resolve(options.cwd, 'candidate.tgz')
  if (arguments_[0] !== 'publish' || arguments_[1] === source || JSON.stringify(arguments_.slice(2)) !== JSON.stringify(expectedTail)) {
    throw new Error('Unexpected npm arguments.')
  }
  if (readFileSync(arguments_[1], 'utf8') !== 'candidate tarball') throw new Error('Unexpected publish bytes.')
  if (typeof options.cwd !== 'string') throw new Error('Missing npm working directory.')
  return JSON.parse(process.env.ENCEPHALON_TEST_NPM_RESULT ?? '{}')
}
`,
  )
  return temporaryRoot
}

const runPublishCheckFixture = (temporaryRoot: string, result: object) =>
  spawnSync(process.execPath, ['./scripts/check-publish.ts', 'candidate.tgz'], {
    cwd: temporaryRoot,
    encoding: 'utf8',
    env: { ...process.env, ENCEPHALON_TEST_NPM_RESULT: JSON.stringify(result) },
  })

test('accepts only npm diagnostics for an already-published package version', () => {
  const conflictJson =
    '{"error":{"code":"EPUBLISHCONFLICT","summary":"You cannot publish over the previously published versions: 0.2.0."}}'
  const authenticationJson = '{"error":{"code":"E401","summary":"Authentication failed."}}'
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
    [`npm notice preparing package\n${conflictJson}\nnpm warn using --force\n`, ''],
    ['You cannot publish over the previously published versions: 0.2.0.\n', 'npm error code EPUBLISHCONFLICT\n'],
    ['You cannot publish over the previously published versions: 0.2.0.\r\n', 'npm error code E403\r\n'],
  ] as const
  assert.deepEqual(
    accepted.map(([stdout, stderr]) => isPublishedVersionConflictOutput(stdout, stderr)),
    accepted.map(() => true),
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
    [conflictJson, authenticationJson],
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
      `${conflictJson} ${authenticationJson}\n`,
      'npm error code EPUBLISHCONFLICT\nYou cannot publish over the previously published versions: 0.2.0.\n',
    ],
    [`npm warn arbitrary prefix ${conflictJson}\n`, ''],
    ['npm error code E403\nunrelated warning: You cannot publish over the previously published versions: 0.2.0.\n', ''],
  ] as const
  assert.deepEqual(
    rejected.map(([stdout, stderr]) => isPublishedVersionConflictOutput(stdout, stderr)),
    rejected.map(() => false),
  )
})

test('publish checker forwards npm output and rejects unrelated publish failures', () => {
  const temporaryRoot = createPublishCheckFixture()
  try {
    const success = runPublishCheckFixture(temporaryRoot, {
      signal: null,
      status: 0,
      stderr: '',
      stdout: 'publish succeeded\n',
    })
    assert.equal(success.status, 0, success.stderr)
    assert.equal(success.stdout, 'publish succeeded\n')
    assert.equal(success.stderr, '')

    const conflictOutput =
      '{"error":{"code":"EPUBLISHCONFLICT","summary":"You cannot publish over the previously published versions: 0.2.0."}}\n'
    const conflictOutputWithWarning = `${conflictOutput}npm warn using --force\n`
    const conflict = runPublishCheckFixture(temporaryRoot, {
      signal: null,
      status: 1,
      stderr: '',
      stdout: conflictOutputWithWarning,
    })
    assert.equal(conflict.status, 0, conflict.stderr)
    assert.equal(conflict.stdout, conflictOutputWithWarning)
    assert.equal(conflict.stderr, '')

    const failure = runPublishCheckFixture(temporaryRoot, {
      signal: null,
      status: 1,
      stderr: 'fatal: authentication failed\n',
      stdout: conflictOutput,
    })
    assert.notEqual(failure.status, 0)
    assert.equal(failure.stdout, conflictOutput)
    assert.match(failure.stderr, /^fatal: authentication failed\n/u)
    assert.match(failure.stderr, /npm publish dry-run failed with exit code 1\./u)

    const unexpectedExit = runPublishCheckFixture(temporaryRoot, {
      signal: null,
      status: 2,
      stderr: '',
      stdout: conflictOutput,
    })
    assert.notEqual(unexpectedExit.status, 0)
    assert.equal(unexpectedExit.stdout, conflictOutput)
    assert.match(unexpectedExit.stderr, /npm publish dry-run failed with exit code 2\./u)

    const signalled = runPublishCheckFixture(temporaryRoot, {
      signal: 'SIGTERM',
      status: null,
      stderr: '',
      stdout: conflictOutput,
    })
    assert.notEqual(signalled.status, 0)
    assert.equal(signalled.stdout, conflictOutput)
    assert.match(signalled.stderr, /npm publish dry-run terminated with signal SIGTERM\./u)
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
})
