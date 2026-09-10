import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { captureIsolatedRoot, disposeIsolatedRoot } from './isolated-root.ts'
import { spawnNpmCommand } from './npm-command.ts'
import * as releaseCompatibilityAuthority from './release-compatibility.ts'
import {
  assertDurableSnapshotsEqual,
  assertStablePublicSurface,
  CompatibilityCommandError,
  captureDurableSnapshot,
  MAX_COMPATIBILITY_DIAGNOSTIC_BYTES,
  ORACLE,
  runCompatibilityCommand,
  sanitizedCompatibilityEnvironment,
  verifyOracleTarball,
} from './release-compatibility.ts'

test('keeps installed package bytes authoritative when Windows cannot preserve archive modes', () => {
  const authority = releaseCompatibilityAuthority as typeof releaseCompatibilityAuthority & {
    installedPackageEntryMatches?: (
      expected: Readonly<{ content: Buffer; mode: number; path: string }>,
      actual: Readonly<{ bytes?: Buffer; canonicalPath: string; mode: number }> | undefined,
      installedPackage: string,
      platform: NodeJS.Platform,
    ) => boolean
  }
  const installedPackage = resolve('fixture', 'node_modules', 'encephalon')
  const expected = { content: Buffer.from('reviewed bytes'), mode: 0o755, path: 'dist/cli.mjs' }
  const actual = {
    bytes: Buffer.from('reviewed bytes'),
    canonicalPath: resolve(installedPackage, 'dist/cli.mjs'),
    mode: 0o666,
  }

  assert.equal(typeof authority.installedPackageEntryMatches, 'function')
  assert.equal(authority.installedPackageEntryMatches?.(expected, actual, installedPackage, 'win32'), true)
  assert.equal(authority.installedPackageEntryMatches?.(expected, actual, installedPackage, 'linux'), false)
  assert.equal(
    authority.installedPackageEntryMatches?.(
      expected,
      { ...actual, bytes: Buffer.from('changed bytes') },
      installedPackage,
      'win32',
    ),
    false,
  )
})

const createDurableFixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'encephalon-release-durable-'))
  const record = resolve(root, 'encephalon', 'decision', 'compatibility.json')
  const artifact = resolve(root, 'encephalon', '_artifacts', 'decision', 'compatibility', 'evidence.txt')
  const cache = resolve(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
  mkdirSync(resolve(record, '..'), { recursive: true })
  mkdirSync(resolve(artifact, '..'), { recursive: true })
  mkdirSync(resolve(cache, '..'), { recursive: true })
  writeFileSync(record, '{"private":"canonical-record-sentinel"}\n')
  writeFileSync(artifact, 'private-artifact-sentinel\n')
  writeFileSync(resolve(root, 'AGENTS.md'), 'private-agents-sentinel\n')
  writeFileSync(resolve(root, 'CLAUDE.md'), 'private-claude-sentinel\n')
  writeFileSync(cache, 'disposable-cache-one')
  return { artifact, cache, record, root }
}

describe('release compatibility authorities', () => {
  test('rejects oracle bytes unless both pinned published identities match', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-oracle-'))
    const tarball = resolve(directory, 'oracle.tgz')
    try {
      writeFileSync(tarball, 'literal wrong oracle bytes')

      assert.throws(
        () => verifyOracleTarball(tarball),
        error =>
          error instanceof Error &&
          error.message ===
            'The published compatibility oracle does not match its pinned SHA-1 and SHA-512 identities.',
      )
      assert.deepEqual(ORACLE, {
        integrity: 'sha512-wRDny+n6df42ZImjuqYNDOoi9PuoA5hRXPwaX7pXV4Nud3FqgSUEtK/CBQLtpLWpvqtrUn/cSlUIl/sX7OxGCA==',
        shasum: '3dffeac3c66b60d398fb00eedd68243296c67b7b',
        specifier: 'encephalon@0.3.0',
      })
      assert.equal(Object.isFrozen(ORACLE), true)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('detects added, removed, mode-changed, and byte-changed durable entries without exposing bytes', () => {
    const cases = [
      {
        change: (fixture: ReturnType<typeof createDurableFixture>) => {
          writeFileSync(resolve(fixture.root, 'encephalon', 'decision', 'added.json'), '{}\n')
        },
        expectedKind: 'added',
      },
      {
        change: (fixture: ReturnType<typeof createDurableFixture>) => {
          rmSync(fixture.artifact)
        },
        expectedKind: 'removed',
      },
      {
        change: (fixture: ReturnType<typeof createDurableFixture>) => {
          chmodSync(fixture.record, 0o400)
        },
        expectedKind: 'mode',
      },
      {
        change: (fixture: ReturnType<typeof createDurableFixture>) => {
          writeFileSync(fixture.record, '{"private":"changed-canonical-record-sentinel"}\n')
        },
        expectedKind: 'bytes',
      },
    ] as const

    const verifiedCases = cases.map(({ change, expectedKind }) => {
      const fixture = createDurableFixture()
      try {
        const expected = captureDurableSnapshot(fixture.root)
        change(fixture)
        const actual = captureDurableSnapshot(fixture.root)
        assert.throws(
          () => assertDurableSnapshotsEqual(expected, actual),
          error => {
            assert.equal(error instanceof Error, true)
            const candidate = error as Error & { changes?: Array<{ kind?: unknown }> }
            assert.equal(
              candidate.changes?.some(entry => entry.kind === expectedKind),
              true,
            )
            assert.equal(candidate.message.includes('canonical-record-sentinel'), false)
            assert.equal(candidate.message.includes('artifact-sentinel'), false)
            assert.equal(candidate.message.includes('agents-sentinel'), false)
            assert.equal(candidate.message.includes('claude-sentinel'), false)
            return true
          },
        )
        return true
      } finally {
        rmSync(fixture.root, { force: true, recursive: true })
      }
    })
    assert.equal(verifiedCases.every(Boolean), true)
  })

  test('preserves and compares special permission bits in durable snapshots', {
    skip: process.platform === 'win32',
  }, testContext => {
    const fixture = createDurableFixture()
    try {
      chmodSync(fixture.record, 0o4755)
      if ((lstatSync(fixture.record).mode & 0o7777) !== 0o4755) {
        testContext.skip('The temporary filesystem does not preserve special permission bits.')
        return
      }
      const expected = captureDurableSnapshot(fixture.root)
      const record = expected.find(entry => entry.path === 'encephalon/decision/compatibility.json')
      assert.equal(record?.mode, 0o4755)

      chmodSync(fixture.record, 0o755)
      assert.throws(
        () => assertDurableSnapshotsEqual(expected, captureDurableSnapshot(fixture.root)),
        error =>
          error instanceof Error &&
          'changes' in error &&
          Array.isArray(error.changes) &&
          error.changes.some(change => change.kind === 'mode' && change.path === record?.path),
      )
    } finally {
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })

  test('ignores changes only beneath the disposable Encephalon cache', () => {
    const fixture = createDurableFixture()
    const unrelatedParentSibling = resolve(fixture.root, '..', `encephalon-unrelated-${randomUUID()}`)
    try {
      const expected = captureDurableSnapshot(fixture.root)
      mkdirSync(unrelatedParentSibling)
      writeFileSync(fixture.cache, 'disposable-cache-two')
      writeFileSync(resolve(fixture.cache, '..', 'brain.sqlite-wal'), 'disposable sidecar')

      assert.doesNotThrow(() => assertDurableSnapshotsEqual(expected, captureDurableSnapshot(fixture.root)))
    } finally {
      rmSync(unrelatedParentSibling, { force: true, recursive: true })
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })

  test('persists same-byte replacement and hard-link identity changes across durable snapshots', () => {
    const replaced = createDurableFixture()
    const moved = `${replaced.record}.moved`
    try {
      const expected = captureDurableSnapshot(replaced.root)
      const bytes = readFileSync(replaced.record)
      const mode = lstatSync(replaced.record).mode & 0o7777
      renameSync(replaced.record, moved)
      writeFileSync(replaced.record, bytes, { mode })
      rmSync(moved)

      assert.throws(
        () => assertDurableSnapshotsEqual(expected, captureDurableSnapshot(replaced.root)),
        error =>
          error instanceof Error &&
          'changes' in error &&
          Array.isArray(error.changes) &&
          error.changes.some(change => change.kind === 'identity' && change.path.endsWith('compatibility.json')),
      )
    } finally {
      rmSync(replaced.root, { force: true, recursive: true })
    }

    const hardLinked = createDurableFixture()
    const hardLink = resolve(hardLinked.record, '..', 'hard-link.json')
    try {
      const singleLink = captureDurableSnapshot(hardLinked.root)
      linkSync(hardLinked.record, hardLink)
      const doubleLink = captureDurableSnapshot(hardLinked.root)
      assert.throws(
        () => assertDurableSnapshotsEqual(singleLink, doubleLink),
        error => error instanceof Error && error.message.includes('links:'),
      )
      rmSync(hardLink)
      assert.throws(
        () => assertDurableSnapshotsEqual(doubleLink, captureDurableSnapshot(hardLinked.root)),
        error => error instanceof Error && error.message.includes('links:'),
      )
    } finally {
      rmSync(hardLinked.root, { force: true, recursive: true })
    }
  })

  test('bounded isolated cleanup never follows outside symlinks or a replaced ancestor generation', () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-cleanup-'))
    const outside = resolve(temporaryRoot, 'outside')
    const outsideSentinel = resolve(outside, 'sentinel')
    try {
      mkdirSync(outside)
      writeFileSync(outsideSentinel, 'outside sentinel')

      const isolated = resolve(temporaryRoot, 'isolated')
      mkdirSync(isolated)
      writeFileSync(resolve(isolated, 'inside'), 'inside')
      symlinkSync(outside, resolve(isolated, 'outside-link'), 'junction')
      disposeIsolatedRoot(captureIsolatedRoot(isolated))
      assert.equal(existsSync(isolated), false)
      assert.equal(readFileSync(outsideSentinel, 'utf8'), 'outside sentinel')

      const generation = resolve(temporaryRoot, 'generation')
      const generationMoved = resolve(temporaryRoot, 'generation-moved')
      const generationRoot = resolve(generation, 'isolated')
      mkdirSync(generationRoot, { recursive: true })
      const witness = captureIsolatedRoot(generationRoot)
      renameSync(generation, generationMoved)
      mkdirSync(generation)
      symlinkSync(outside, generationRoot, 'junction')
      assert.throws(() => disposeIsolatedRoot(witness), /root or parent identity changed|ordinary directory/u)
      assert.equal(readFileSync(outsideSentinel, 'utf8'), 'outside sentinel')
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects oversized, growing, and concurrently replaced durable files', () => {
    const oversized = createDurableFixture()
    try {
      writeFileSync(oversized.artifact, Buffer.alloc(16 * 1024 * 1024 + 1))
      assert.throws(() => captureDurableSnapshot(oversized.root), /byte limit|bounded regular file/u)
    } finally {
      rmSync(oversized.root, { force: true, recursive: true })
    }

    const growing = createDurableFixture()
    try {
      assert.throws(
        () =>
          captureDurableSnapshot(growing.root, {
            afterFileOpen: (path: string) => {
              if (path === growing.record) {
                writeFileSync(path, '{"private":"grown-canonical-record-sentinel"}\n')
              }
            },
          }),
        /changed|stable bounded regular file/u,
      )
    } finally {
      rmSync(growing.root, { force: true, recursive: true })
    }

    const replaced = createDurableFixture()
    const moved = `${replaced.record}.moved`
    try {
      assert.throws(
        () =>
          captureDurableSnapshot(replaced.root, {
            afterFileOpen: (path: string) => {
              if (path === replaced.record) {
                renameSync(path, moved)
                writeFileSync(path, '{"private":"replacement-canonical-record-sentinel"}\n')
              }
            },
          }),
        /changed|stable bounded regular file/u,
      )
    } finally {
      rmSync(replaced.root, { force: true, recursive: true })
    }
  })

  test('runs commands in fresh Node processes and bounds redacted failure diagnostics', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-process-'))
    const pidScript = resolve(directory, 'pid.mjs')
    const failureScript = resolve(directory, 'failure.mjs')
    const multibyteFailureScript = resolve(directory, 'multibyte-failure.mjs')
    const canonicalSecret = 'private-canonical-command-sentinel'
    const instructionSecret = 'private-instruction-command-sentinel'
    try {
      writeFileSync(pidScript, 'process.stdout.write(String(process.pid))\n')
      writeFileSync(
        failureScript,
        `process.stdout.write('${canonicalSecret}' + 'x'.repeat(${MAX_COMPATIBILITY_DIAGNOSTIC_BYTES * 2}))\n` +
          `process.stderr.write('safe diagnostic ${instructionSecret}')\n` +
          'process.exitCode = 7\n',
      )
      writeFileSync(
        multibyteFailureScript,
        `process.stdout.write('x' + '🙂'.repeat(${MAX_COMPATIBILITY_DIAGNOSTIC_BYTES}))\nprocess.exitCode = 8\n`,
      )

      const first = runCompatibilityCommand(process.execPath, [pidScript], {
        cwd: directory,
        label: 'first fresh-process witness',
      })
      const second = runCompatibilityCommand(process.execPath, [pidScript], {
        cwd: directory,
        label: 'second fresh-process witness',
      })
      assert.notEqual(first.stdout, second.stdout)

      assert.throws(
        () =>
          runCompatibilityCommand(process.execPath, [failureScript], {
            cwd: directory,
            label: 'bounded failure witness',
            redactions: [Buffer.from(canonicalSecret), Buffer.from(instructionSecret)],
          }),
        error => {
          assert.equal(error instanceof CompatibilityCommandError, true)
          const candidate = error as CompatibilityCommandError
          assert.equal(candidate.exitCode, 7)
          assert.equal(Buffer.byteLength(candidate.stdout), MAX_COMPATIBILITY_DIAGNOSTIC_BYTES)
          assert.equal(Buffer.byteLength(candidate.stderr) <= MAX_COMPATIBILITY_DIAGNOSTIC_BYTES, true)
          assert.equal(candidate.stdout.includes(canonicalSecret), false)
          assert.equal(candidate.stderr.includes(instructionSecret), false)
          assert.equal(candidate.stdout.includes('[redacted]'), true)
          assert.equal(candidate.stderr.includes('safe diagnostic [redacted]'), true)
          return true
        },
      )

      assert.throws(
        () =>
          runCompatibilityCommand(process.execPath, [multibyteFailureScript], {
            cwd: directory,
            label: 'multibyte bounded failure witness',
          }),
        error => {
          assert.equal(error instanceof CompatibilityCommandError, true)
          const candidate = error as CompatibilityCommandError
          assert.equal(Buffer.byteLength(candidate.stdout) <= MAX_COMPATIBILITY_DIAGNOSTIC_BYTES, true)
          assert.equal(candidate.stdout.includes('\uFFFD'), false)
          return true
        },
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('terminates a hanging compatibility subprocess within its explicit bound', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-timeout-'))
    const hang = resolve(directory, 'hang.mjs')
    const wrapper = resolve(directory, 'wrapper.mjs')
    try {
      writeFileSync(hang, 'setInterval(() => {}, 1000)\n')
      writeFileSync(
        wrapper,
        `import { runCompatibilityCommand } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, 'release-compatibility.ts')).href)}
try {
  runCompatibilityCommand(process.execPath, [${JSON.stringify(hang)}], {
    cwd: ${JSON.stringify(directory)},
    label: 'hanging compatibility witness',
    timeoutMilliseconds: 50,
  })
  process.exitCode = 91
} catch {
  process.stdout.write('bounded timeout\\n')
}
`,
      )

      const result = spawnSync(process.execPath, [wrapper], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 2000,
      })
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}${String(result.error ?? '')}`)
      assert.equal(result.stdout, 'bounded timeout\n')
      assert.equal(result.stderr, '')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('terminates forked descendants before they can mutate after a timeout', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-process-tree-'))
    const descendant = resolve(directory, 'descendant.mjs')
    const parent = resolve(directory, 'parent.mjs')
    const sentinel = resolve(directory, 'late-descendant-mutation')
    try {
      writeFileSync(
        descendant,
        `import { writeFileSync } from 'node:fs'\nsetTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'late mutation'), 250)\n`,
      )
      writeFileSync(
        parent,
        `import { spawn } from 'node:child_process'\nspawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' })\nsetInterval(() => {}, 1000)\n`,
      )

      assert.throws(
        () =>
          runCompatibilityCommand(process.execPath, [parent], {
            cwd: directory,
            label: 'forking timeout witness',
            timeoutMilliseconds: 50,
          }),
        CompatibilityCommandError,
      )
      const waited = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', 'await new Promise(resolve => setTimeout(resolve, 400))'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 1000,
        },
      )
      assert.equal(waited.status, 0, `${waited.stdout}${waited.stderr}`)
      assert.equal(existsSync(sentinel), false)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('drains descendants missed by the first group signal before reporting timeout', {
    skip: process.platform === 'win32' ? 'Exercises POSIX process-group signalling.' : false,
  }, () => {
    for (const stdio of ['ignore', 'inherit']) {
      const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-group-race-'))
      const ready = resolve(directory, 'ready')
      const release = resolve(directory, 'release')
      const expired = resolve(directory, 'expired')
      const sentinel = resolve(directory, 'late-mutation')
      const descendant = resolve(directory, 'descendant.mjs')
      const parent = resolve(directory, 'parent.mjs')
      const wrapper = resolve(directory, 'wrapper.mjs')
      try {
        writeFileSync(
          descendant,
          `import { existsSync, writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(ready)}, String(process.pid))
setInterval(() => {
  if (existsSync(${JSON.stringify(release)})) {
    writeFileSync(${JSON.stringify(sentinel)}, 'post-return mutation')
    process.exit()
  }
}, 10)
setTimeout(() => { writeFileSync(${JSON.stringify(expired)}, 'fixture expired'); process.exit(92) }, 5000)
`,
        )
        writeFileSync(
          parent,
          `import { spawn } from 'node:child_process'
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: ${JSON.stringify(stdio)} })
setInterval(() => {}, 1000)
`,
        )
        writeFileSync(
          wrapper,
          `import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
const kill = process.kill.bind(process)
let missed = false
process.kill = (pid, signal) => {
  if (!missed && pid < 0 && signal === 'SIGKILL') {
    assert.equal(existsSync(${JSON.stringify(ready)}), true, 'descendant must be live before the injected missed signal')
    missed = true
    return kill(-pid, signal)
  }
  return kill(pid, signal)
}
await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, 'bounded-process-supervisor.mjs')).href)})
`,
        )
        const request = Buffer.from(
          JSON.stringify({
            arguments: [parent],
            cwd: directory,
            executable: process.execPath,
            maximumOutputBytes: 4096,
            timeoutMilliseconds: 1000,
          }),
        ).toString('base64url')
        const result = spawnSync(process.execPath, [wrapper, request], {
          encoding: 'utf8',
          timeout: 8000,
        })
        assert.equal(result.status, 0, `${result.stdout}${result.stderr}${String(result.error ?? '')}`)
        assert.equal(JSON.parse(result.stdout).timedOut, true)
        assert.equal(existsSync(ready), true)
        assert.equal(existsSync(expired), false)
        writeFileSync(release, 'wrapper returned')
        const observed = spawnSync(
          process.execPath,
          ['--input-type=module', '--eval', 'await new Promise(resolve => setTimeout(resolve, 400))'],
          { timeout: 2000 },
        )
        assert.equal(observed.status, 0)
        assert.equal(existsSync(sentinel), false, `${stdio}: descendant mutated after timeout returned`)
        const processes = spawnSync('ps', ['-A', '-o', 'pid=,stat='], { encoding: 'utf8', timeout: 2000 })
        assert.equal(processes.status, 0, processes.stderr)
        const descendantPid = readFileSync(ready, 'utf8')
        assert.equal(
          processes.stdout
            .trim()
            .split('\n')
            .some(line => {
              const [pid, state] = line.trim().split(/\s+/)
              return pid === descendantPid && !state?.startsWith('Z')
            }),
          false,
          `${stdio}: descendant must be absent or zombie after return`,
        )
        assert.equal(existsSync(expired), false)
      } finally {
        // Failure cleanup happens only after the assertions; it cannot make the supervisor pass.
        if (existsSync(ready)) {
          try {
            process.kill(Number(readFileSync(ready, 'utf8')), 'SIGKILL')
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
          }
        }
        rmSync(directory, { force: true, recursive: true })
      }
    }
  })

  test('applies explicit environments and output bounds to npm subprocesses', () => {
    const poisoned = spawnNpmCommand(['--version'], {
      cwd: resolve(import.meta.dirname, '..'),
      environment: { ...process.env, NODE_OPTIONS: '--encephalon-invalid-preload-option' },
    })
    assert.notEqual(poisoned.status, 0)

    const bounded = spawnNpmCommand(['--version'], {
      cwd: resolve(import.meta.dirname, '..'),
      environment: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      maxBuffer: 1,
    })
    assert.equal((bounded.error as NodeJS.ErrnoException | undefined)?.code, 'ENOBUFS')
  })

  test('removes preload variables case-insensitively from compatibility subprocess environments', () => {
    assert.deepEqual(
      sanitizedCompatibilityEnvironment({
        NODE_OPTIONS: '--require=/private/preload.cjs',
        Node_Options: '--require=/private/second-preload.cjs',
        node_path: '/private/modules',
        Path: '/usr/bin',
      }),
      { Path: '/usr/bin' },
    )
  })

  test('rejects every stable public surface drift without normalising fields, values, messages, details, or help', () => {
    const oracle = {
      error: {
        code: 'RECORD_EXISTS',
        details: { id: 'compatibility-base' },
        message: 'Record compatibility-base already exists.',
        name: 'EncephalonError',
      },
      help: 'Usage: encephalon <command>\n',
      success: { records: [{ id: 'compatibility-base', value: 'stable' }], valid: true },
    }
    const drifts = [
      { ...oracle, success: { records: [{ id: 'compatibility-base' }], valid: true } },
      { ...oracle, success: { records: [{ id: 'compatibility-base', value: 'changed' }], valid: true } },
      { ...oracle, error: { ...oracle.error, message: 'Changed.' } },
      { ...oracle, error: { ...oracle.error, details: { id: 'different' } } },
      { ...oracle, help: 'Changed help.\n' },
    ]

    for (const drift of drifts) {
      assert.throws(
        () => assertStablePublicSurface(oracle, drift, 'The candidate API'),
        /The candidate API does not exactly preserve the published public surface\./,
      )
    }
    assert.doesNotThrow(() => assertStablePublicSurface(oracle, structuredClone(oracle), 'The candidate API'))
  })

  test('allows bounded search presentation changes while preserving every other public value', () => {
    const row = { id: 'same', rank: -1, snippet: 'historical payload fragment', summary: 'Same summary' }
    const surface = (result: unknown) => ({
      gather: { searches: [{ query: 'same', results: [result] }] },
      help: 'Published 0.3 help must remain identical.\n',
      searchCompact: [result],
      show: { payload: { rank: 1, snippet: 'canonical content' } },
    })
    const oracle = surface(row)
    const candidate = surface({ ...row, rank: -2, snippet: '[Same] summary' })
    assert.doesNotThrow(() => assertStablePublicSurface(oracle, candidate, 'Candidate', true))
    assert.throws(() => assertStablePublicSurface(oracle, candidate, 'Downgrade'))
    assert.throws(() => assertStablePublicSurface(oracle, { ...candidate, help: 'Changed help' }, 'Candidate', true))
    for (const changed of [
      { ...row, id: 'invented' },
      { ...row, summary: 'changed' },
      { ...row, extra: true },
      { ...row, rank: 'wrong type' },
      { ...row, rank: Number.POSITIVE_INFINITY },
      { ...row, snippet: '' },
      { ...row, snippet: 'é'.repeat(551) },
      { id: row.id, snippet: row.snippet, summary: row.summary },
    ]) {
      assert.throws(() => assertStablePublicSurface(oracle, surface(changed), 'Candidate', true))
    }
    assert.throws(() =>
      assertStablePublicSurface(
        oracle,
        { ...candidate, show: { payload: { rank: 2, snippet: 'canonical content' } } },
        'Candidate',
        true,
      ),
    )
  })
})
