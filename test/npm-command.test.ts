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

test('resolves Windows npm from explicit PATH entries when Node has no bundled npm', () => {
  const nodeExecutable = String.raw`C:\tools\node-shim\node.exe`
  const npmCli = String.raw`D:\node\node_modules\npm\bin\npm-cli.js`
  assert.deepEqual(
    npmCommand(['publish'], {
      nodeExecutable,
      pathEnvironment: String.raw`C:\untrusted-current-directory;"D:\node"`,
      pathExists: path => path === npmCli,
      platform: 'win32',
    }),
    [nodeExecutable, npmCli, 'publish'],
  )

  const npmExecutable = String.raw`C:\Program Files\Volta\npm.exe`
  assert.deepEqual(
    npmCommand(['pack'], {
      nodeExecutable,
      pathEnvironment: String.raw`"C:\Program Files\Volta"`,
      pathExists: path => path === npmExecutable,
      platform: 'win32',
    }),
    [npmExecutable, 'pack'],
  )

  assert.throws(
    () =>
      npmCommand(['pack'], {
        nodeExecutable,
        pathEnvironment: '',
        pathExists: () => false,
        platform: 'win32',
      }),
    /Unable to resolve npm for the active Windows Node runtime\./,
  )
})
