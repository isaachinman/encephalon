import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmCommand } from '../scripts/npm-command.ts'

test('resolves Windows npm through the provisioned Node installation', () => {
  const nodeExecutable = String.raw`C:\hostedtoolcache\windows\node\24.15.0\x64\node.exe`
  assert.deepEqual(npmCommand(['pack'], { nodeExecutable, platform: 'win32' }), [
    nodeExecutable,
    String.raw`C:\hostedtoolcache\windows\node\24.15.0\x64\node_modules\npm\bin\npm-cli.js`,
    'pack',
  ])
  assert.deepEqual(npmCommand(['pack'], { nodeExecutable: '/opt/node/bin/node', platform: 'linux' }), ['npm', 'pack'])
})
