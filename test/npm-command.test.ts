import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmCommand } from '../scripts/npm-command.ts'

test('resolves Windows npm through the provisioned Node installation', () => {
  const nodeExecutable = String.raw`C:\hostedtoolcache\windows\node\24.15.0\x64\node.exe`
  const npmCli = String.raw`C:\hostedtoolcache\windows\node\24.15.0\x64\node_modules\npm\bin\npm-cli.js`
  assert.deepEqual(
    npmCommand(['pack'], {
      nodeExecutable,
      pathExists: path => path === npmCli,
      platform: 'win32',
    }),
    [nodeExecutable, npmCli, 'pack'],
  )
  assert.deepEqual(npmCommand(['pack'], { nodeExecutable: '/opt/node/bin/node', platform: 'linux' }), ['npm', 'pack'])
})

test('resolves only runtime-bound Windows npm fallbacks', () => {
  const nodeExecutable = String.raw`C:\tools\node-shim\node.exe`
  const npmExecPath = String.raw`D:\node\node_modules\npm\bin\npm-cli.js`
  assert.deepEqual(
    npmCommand(['publish'], {
      nodeExecutable,
      npmExecPath,
      pathExists: path => path === npmExecPath,
      platform: 'win32',
    }),
    [nodeExecutable, npmExecPath, 'publish'],
  )

  const npmExecutable = String.raw`C:\tools\node-shim\npm.exe`
  assert.deepEqual(
    npmCommand(['pack'], {
      nodeExecutable,
      pathExists: path => path === npmExecutable,
      platform: 'win32',
    }),
    [npmExecutable, 'pack'],
  )

  assert.throws(
    () =>
      npmCommand(['pack'], {
        nodeExecutable,
        npmExecPath: String.raw`.\node_modules\npm\bin\npm-cli.js`,
        pathExists: () => false,
        platform: 'win32',
      }),
    /Unable to resolve npm for the active Windows Node runtime\. Install npm beside node\.exe or run this check through npm\./,
  )
  const nonCanonicalNpmExecPath = String.raw`C:\repository\malicious.js`
  assert.throws(
    () =>
      npmCommand(['pack'], {
        nodeExecutable,
        npmExecPath: nonCanonicalNpmExecPath,
        pathExists: path => path === nonCanonicalNpmExecPath,
        platform: 'win32',
      }),
    /Unable to resolve npm for the active Windows Node runtime\./,
  )
})
