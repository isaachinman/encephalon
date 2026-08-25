import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { npmCommand, spawnNpmCommand } from '../scripts/npm-command.ts'

test('resolves Windows npm through the provisioned Node installation', () => {
  const nodeExecutable = String.raw`C:\hostedtoolcache\windows\node\24.15.0\x64\node.exe`
  const npmCli = String.raw`C:\hostedtoolcache\windows\node\24.15.0\x64\node_modules\npm\bin\npm-cli.js`
  assert.deepEqual(
    npmCommand(['pack'], {
      nodeExecutable,
      pathExists: path => path === npmCli,
      platform: 'win32',
    }),
    { arguments: [npmCli, 'pack'], executable: nodeExecutable },
  )
  assert.deepEqual(npmCommand(['pack'], { nodeExecutable: '/opt/node/bin/node', platform: 'linux' }), {
    arguments: ['pack'],
    executable: 'npm',
  })
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
    { arguments: [npmExecPath, 'publish'], executable: nodeExecutable },
  )

  const npmExecutable = String.raw`C:\tools\node-shim\npm.exe`
  assert.deepEqual(
    npmCommand(['pack'], {
      nodeExecutable,
      pathExists: path => path === npmExecutable,
      platform: 'win32',
    }),
    { arguments: ['pack'], executable: npmExecutable },
  )

  const npmBatch = String.raw`C:\tools\node-shim\npm.cmd`
  const commandInterpreter = String.raw`D:\Windows\System32\cmd.exe`
  assert.deepEqual(
    npmCommand(['pack'], {
      commandInterpreter,
      environment: { Path: String.raw`D:\Windows\System32` },
      nodeExecutable,
      pathExists: path => path === npmBatch || path === commandInterpreter,
      platform: 'win32',
    }),
    {
      arguments: ['/d', '/s', '/v:off', '/c', '""%ENCEPHALON_NPM_COMMAND%" "%ENCEPHALON_NPM_ARGUMENT_0%""'],
      environment: {
        ENCEPHALON_NPM_ARGUMENT_0: 'pack',
        ENCEPHALON_NPM_COMMAND: npmBatch,
        Path: String.raw`D:\Windows\System32`,
      },
      executable: commandInterpreter,
      windowsVerbatimArguments: true,
    },
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

test('binds sibling Windows npm batch arguments without shell interpolation', () => {
  const nodeExecutable = String.raw`C:\Program Files (x64)\node-shim\node.exe`
  const npmBatch = String.raw`C:\Program Files (x64)\node-shim\npm.cmd`
  const commandInterpreter = String.raw`C:\Windows\System32\cmd.exe`
  const payload = 'literal & %PATH% !PATH! ^ | < > (safe)'
  const options = {
    commandInterpreter,
    environment: {
      ENCEPHALON_NPM_COMMAND: String.raw`C:\attacker\npm.cmd`,
      encephalon_npm_argument_0: 'attacker-controlled',
      Path: String.raw`C:\Windows\System32`,
    },
    nodeExecutable,
    pathExists: (path: string) => path === npmBatch || path === commandInterpreter,
    platform: 'win32' as const,
  }
  const command = npmCommand(['install', payload], options)
  assert.deepEqual(command, {
    arguments: [
      '/d',
      '/s',
      '/v:off',
      '/c',
      '""%ENCEPHALON_NPM_COMMAND%" "%ENCEPHALON_NPM_ARGUMENT_0%" "%ENCEPHALON_NPM_ARGUMENT_1%""',
    ],
    environment: {
      ENCEPHALON_NPM_ARGUMENT_0: 'install',
      ENCEPHALON_NPM_ARGUMENT_1: payload,
      ENCEPHALON_NPM_COMMAND: npmBatch,
      Path: String.raw`C:\Windows\System32`,
    },
    executable: commandInterpreter,
    windowsVerbatimArguments: true,
  })
  assert.equal(command.arguments[4]?.includes(npmBatch), false)
  assert.equal(command.arguments[4]?.includes(payload), false)
  assert.throws(
    () => npmCommand(['install', 'unsafe"argument'], options),
    /Unsafe Windows npm\.cmd argument: values must not contain quotes or line breaks\./,
  )
  assert.throws(
    () =>
      npmCommand(['install'], {
        ...options,
        commandInterpreter: 'cmd.exe',
        pathExists: path => path === npmBatch || path === 'cmd.exe',
      }),
    /Unable to resolve an absolute Windows cmd\.exe through ComSpec/,
  )
})

test('executes sibling Windows npm batch arguments without command injection', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'encephalon-npm-command-'))
  const npmBatch = join(directory, 'npm.cmd')
  const captureScript = join(directory, 'capture.mjs')
  const capturedArguments = join(directory, 'arguments.json')
  const injectedFile = join(directory, 'injected.txt')
  const payload = 'literal & echo compromised>injected.txt %PATH% !PATH! ^ | < > (safe)'
  try {
    writeFileSync(
      npmBatch,
      `@echo off\r\n"${process.execPath}" "${captureScript}" "${capturedArguments}" %*\r\n`,
      'utf8',
    )
    writeFileSync(
      captureScript,
      "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))\n",
      'utf8',
    )
    const result = spawnNpmCommand([payload], {
      cwd: directory,
      nodeExecutable: join(directory, 'node.exe'),
      npmExecPath: '',
      platform: 'win32',
    })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.deepEqual(JSON.parse(readFileSync(capturedArguments, 'utf8')) as unknown, [payload])
    assert.equal(existsSync(injectedFile), false)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
