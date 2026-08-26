import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { spawnNpmCommand } from './npm-command.ts'
import { packageTarballDigests } from './package-tarball.ts'
import {
  assertDurableSnapshotsEqual,
  CompatibilityCommandError,
  captureDurableSnapshot,
  MAX_COMPATIBILITY_DIAGNOSTIC_BYTES,
  ORACLE,
  runCompatibilityCommand,
  runReleaseCompatibility,
  verifyOracleTarball,
} from './release-compatibility.ts'

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

const standInIndex = (version: string, schemaVersion: string) => {
  const fullMaximum = version === '0.2.0' ? 50 : 1000
  const compactMaximum = version === '0.2.0' ? 100 : 1000
  return `
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const packageWitness = ${JSON.stringify(version)}

export class EncephalonError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'EncephalonError'
    this.code = code
    this.details = details
  }
}

const repositoryRoot = input => resolve(input?.root ?? process.cwd())
const recordsDirectory = root => resolve(root, 'encephalon', 'decision')
const cachePath = root => resolve(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
const recordPath = (root, id) => resolve(recordsDirectory(root), id + '.json')
const readRecords = root => {
  const directory = recordsDirectory(root)
  return existsSync(directory)
    ? readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(readFileSync(resolve(directory, name), 'utf8')))
    : []
}
const assertLimit = (limit, budget) => {
  const maximum = budget === 'fullResultLimit' ? ${fullMaximum} : ${compactMaximum}
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > maximum)) {
    throw new EncephalonError('INVALID_ARGUMENT', 'The result limit is outside the published range.', {
      budget,
      field: 'limit',
      maximum,
    })
  }
  return limit ?? 20
}
const writeCache = root => {
  const path = cachePath(root)
  mkdirSync(resolve(path, '..'), { recursive: true })
  rmSync(path, { force: true })
  const database = new DatabaseSync(path)
  try {
    database.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('schemaVersion', ${JSON.stringify(schemaVersion)})
    database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('packageVersion', ${JSON.stringify(version)})
  } finally {
    database.close()
  }
  return { hydrated: true, recordsIndexed: readRecords(root).length }
}

export const initEncephalon = (input = {}) => {
  const root = repositoryRoot(input)
  mkdirSync(recordsDirectory(root), { recursive: true })
  const managedBlock = '\\n<!-- encephalon:managed-instructions:start fixture -->\\nUse the installed Encephalon skill.\\n<!-- encephalon:managed-instructions:end -->\\n'
  ;['AGENTS.md', 'CLAUDE.md'].forEach(name => {
    const path = resolve(root, name)
    const predecessor = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (!predecessor.includes('encephalon:managed-instructions:start')) {
      writeFileSync(path, predecessor + managedBlock)
    }
  })
  return { instructionFiles: [], nextAction: 'ready', recordsCreated: [], skippedConflicts: [] }
}

export const addRecord = input => {
  const root = repositoryRoot(input)
  const path = recordPath(root, input.id)
  if (existsSync(path)) {
    throw new EncephalonError('RECORD_EXISTS', 'The record already exists.', { id: input.id })
  }
  const record = {
    artifacts: input.artifacts,
    createdAt: '2026-08-26T00:00:00.000Z',
    id: input.id,
    kind: input.kind,
    path: 'encephalon/decision/' + input.id + '.json',
    payload: input.payload,
    searchText: input.searchText,
    source: input.source,
    subject: input.subject,
    supersedes: input.supersedes,
  }
  mkdirSync(recordsDirectory(root), { recursive: true })
  writeFileSync(path, JSON.stringify(record) + '\\n')
  return record
}

export const prepare = input => writeCache(repositoryRoot(input))
export const hydrate = input => ({ recordsIndexed: writeCache(repositoryRoot(input)).recordsIndexed })
export const validateRecords = input => ({ errors: [], recordsChecked: readRecords(repositoryRoot(input)).length, truncated: false, valid: true })
export const listRecords = (input = {}) => readRecords(repositoryRoot(input)).slice(0, assertLimit(input.limit, 'fullResultLimit'))
export const showRecord = input => readRecords(repositoryRoot(input)).find(record => record.id === input.id) ?? null
export const searchRecords = input => readRecords(repositoryRoot(input))
  .filter(record => JSON.stringify(record).includes(input.query))
  .slice(0, assertLimit(input.limit, 'fullResultLimit'))
export const searchCompactRecords = input => readRecords(repositoryRoot(input))
  .filter(record => JSON.stringify(record).includes(input.query))
  .slice(0, assertLimit(input.limit, 'compactResultLimit'))
  .map(record => ({ id: record.id, kind: record.kind, path: record.path, rank: -1, snippet: record.searchText ?? '', subject: record.subject, summary: null }))
export const gatherRecords = (input = {}) => ({
  hydrated: input.hydrate ? hydrate(input) : null,
  records: (input.shows ?? []).map(id => ({ id, record: showRecord({ ...input, id }) })),
  searches: (input.searches ?? []).map(query => ({ kind: input.kind ?? null, query, results: searchCompactRecords({ ...input, query, limit: assertLimit(input.limit, 'compactResultLimit') }) })),
})
`
}

const standInCli = (version: string) => `#!/usr/bin/env node
import {
  addRecord,
  gatherRecords,
  hydrate,
  initEncephalon,
  listRecords,
  prepare,
  searchCompactRecords,
  searchRecords,
  showRecord,
  validateRecords,
} from './index.mjs'

const raw = process.argv.slice(2)
if (raw.length === 1 && (raw[0] === '--help' || raw[0] === '-h')) {
  process.stdout.write('Usage: encephalon <command>\\nCommands: init add prepare hydrate validate list show search gather\\n')
} else if (raw.length === 1 && (raw[0] === '--version' || raw[0] === '-v')) {
  process.stdout.write(${JSON.stringify(`${version}\n`)})
} else {
  const rootIndex = raw.findIndex(argument => argument === '--root')
  const root = rootIndex === -1 ? process.cwd() : raw[rootIndex + 1]
  const args = rootIndex === -1 ? [...raw] : raw.filter((_argument, index) => index !== rootIndex && index !== rootIndex + 1)
  const [command, ...options] = args
  const one = name => {
    const exact = options.findIndex(argument => argument === '--' + name)
    const assigned = options.find(argument => argument.startsWith('--' + name + '='))
    return exact === -1 ? assigned?.slice(name.length + 3) : options[exact + 1]
  }
  const many = name => options.reduce((values, argument, index) => argument === '--' + name ? [...values, options[index + 1]] : values, []).filter(Boolean)
  const limitValue = one('limit')
  const limit = limitValue === undefined ? undefined : Number(limitValue)
  const input = { root, ...(limit === undefined ? {} : { limit }) }
  try {
    const value = command === 'init'
      ? initEncephalon(input)
      : command === 'add'
        ? addRecord({ ...input, artifacts: many('artifact'), id: one('id'), kind: one('kind'), payload: JSON.parse(one('data')), searchText: one('text'), source: one('source'), subject: one('subject'), supersedes: many('supersedes') })
        : command === 'prepare'
          ? prepare(input)
          : command === 'hydrate'
            ? hydrate(input)
            : command === 'validate'
              ? validateRecords(input)
              : command === 'list'
                ? listRecords(input)
                : command === 'show'
                  ? showRecord({ ...input, id: one('id') })
                  : command === 'search'
                    ? (options.includes('--compact') ? searchCompactRecords : searchRecords)({ ...input, query: options.at(-1) })
                    : command === 'gather'
                      ? gatherRecords({ ...input, searches: many('search'), shows: many('show') })
                      : (() => { throw new Error('unknown command') })()
    process.stdout.write(JSON.stringify(value) + '\\n')
  } catch (error) {
    if (typeof error?.code === 'string') {
      process.stderr.write(JSON.stringify({ error: { code: error.code, details: error.details, message: error.message } }) + '\\n')
      process.exitCode = 2
    } else {
      process.stderr.write(JSON.stringify({ error: { code: 'INTERNAL_ERROR', details: {}, message: 'An unexpected internal error occurred.' } }) + '\\n')
      process.exitCode = 1
    }
  }
}
`

const standInDeclarations = `
export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type RootInput = { root?: string }
export type BrainRecordFile = { id: string; kind: string; subject: string; source: string; createdAt: string; confidence?: number; supersedes?: string[]; artifacts?: string[]; payload: JsonValue; searchText?: string }
export type BrainRecord = BrainRecordFile & { path: string }
export type CompactBrainRecord = { id: string; kind: string; subject: string; path: string; summary: string | null; rank: number; snippet: string }
export type AddRecordInput = RootInput & { id?: string; kind: string; subject: string; source: string; confidence?: number; supersedes?: string[]; artifacts?: string[]; payload: JsonValue; searchText?: string }
export type InitEncephalonInput = RootInput & { refreshBaseline?: boolean; remove?: boolean }
export type InitEncephalonResult = { recordsCreated: BrainRecord[]; skippedConflicts: Array<{ kind: string; subject: string; activeRecordIds: string[] }>; instructionFiles: Array<{ file: 'AGENTS.md' | 'CLAUDE.md'; action: 'removed' | 'updated' }>; nextAction: string }
export type ValidateResult = { valid: boolean; recordsChecked: number; errors: ValidationIssue[]; truncated: boolean }
export type ValidationIssue = { code: string; message: string; path?: string; recordId?: string }
export type ListRecordsInput = RootInput & { kind?: string; subject?: string; includeSuperseded?: boolean; limit?: number }
export type ShowRecordInput = RootInput & { id: string; activeOnly?: boolean }
export type SearchRecordsInput = RootInput & { query: string; kind?: string; includeSuperseded?: boolean; limit?: number }
export type GatherInput = RootInput & { searches?: string[]; shows?: string[]; kind?: string; includeSuperseded?: boolean; limit?: number; hydrate?: boolean }
export type PrepareResult = { hydrated: boolean; recordsIndexed: number }
export type HydrateResult = { recordsIndexed: number }
export type GatherResult = { hydrated: HydrateResult | null; searches: Array<{ query: string; kind: string | null; results: CompactBrainRecord[] }>; records: Array<{ id: string; record: BrainRecord | null }> }
export type EncephalonErrorCode = 'INVALID_ARGUMENT' | 'RECORD_EXISTS'
export declare class EncephalonError extends Error { readonly code: EncephalonErrorCode; readonly details: Record<string, JsonValue> }
export declare const initEncephalon: (input?: InitEncephalonInput) => InitEncephalonResult
export declare const addRecord: (input: AddRecordInput) => BrainRecord
export declare const prepare: (input?: RootInput) => PrepareResult
export declare const hydrate: (input?: RootInput) => HydrateResult
export declare const validateRecords: (input?: RootInput) => ValidateResult
export declare const listRecords: (input?: ListRecordsInput) => BrainRecord[]
export declare const showRecord: (input: ShowRecordInput) => BrainRecord | null
export declare const searchRecords: (input: SearchRecordsInput) => BrainRecord[]
export declare const searchCompactRecords: (input: SearchRecordsInput) => CompactBrainRecord[]
export declare const gatherRecords: (input?: GatherInput) => GatherResult
export declare const packageWitness: string
`

const buildStandInTarball = (root: string, version: string, schemaVersion: string) => {
  const packageRoot = resolve(root, `package-${version}`)
  const tarballDirectory = resolve(root, 'tarballs')
  mkdirSync(resolve(packageRoot, 'dist'), { recursive: true })
  mkdirSync(tarballDirectory, { recursive: true })
  writeFileSync(
    resolve(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        bin: { encephalon: 'dist/cli.mjs' },
        exports: { '.': { import: './dist/index.mjs', types: './dist/index.d.ts' } },
        files: ['dist'],
        name: 'encephalon',
        type: 'module',
        types: './dist/index.d.ts',
        version,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(resolve(packageRoot, 'dist', 'index.mjs'), standInIndex(version, schemaVersion))
  writeFileSync(resolve(packageRoot, 'dist', 'cli.mjs'), standInCli(version), { mode: 0o755 })
  writeFileSync(resolve(packageRoot, 'dist', 'index.d.ts'), standInDeclarations)
  const packed = spawnNpmCommand(
    ['pack', '--dry-run=false', '--ignore-scripts', '--json', '--pack-destination', tarballDirectory],
    { cwd: packageRoot },
  )
  assert.equal(packed.status, 0, `${packed.stdout}${packed.stderr}`)
  const [result] = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>
  assert.equal(typeof result?.filename, 'string')
  return { packageRoot, tarball: resolve(tarballDirectory, String(result?.filename)) }
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
        integrity: 'sha512-dgGi7fL43v9KQJ7Rb42fRAT+Z+h6WIOKhbPz9JzNBtnpqSyf4HyN6zBmIy6ftkTazZO6SyGU4MUi1FTVJyBvEw==',
        shasum: '1db80715ac2028cb8f12ae029577aed3428d52ef',
        specifier: 'encephalon@0.2.0',
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

  test('ignores changes only beneath the disposable Encephalon cache', () => {
    const fixture = createDurableFixture()
    try {
      const expected = captureDurableSnapshot(fixture.root)
      writeFileSync(fixture.cache, 'disposable-cache-two')
      writeFileSync(resolve(fixture.cache, '..', 'brain.sqlite-wal'), 'disposable sidecar')

      assert.doesNotThrow(() => assertDurableSnapshotsEqual(expected, captureDurableSnapshot(fixture.root)))
    } finally {
      rmSync(fixture.root, { force: true, recursive: true })
    }
  })

  test('runs commands in fresh Node processes and bounds redacted failure diagnostics', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'encephalon-release-process-'))
    const pidScript = resolve(directory, 'pid.mjs')
    const failureScript = resolve(directory, 'failure.mjs')
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
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})

describe('release compatibility process fixture', () => {
  test('rejects an invalid release command invocation before oracle acquisition', () => {
    const result = spawnSync(process.execPath, ['./scripts/check-release-compatibility.ts'], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    })

    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(
      result.stderr.includes('Usage: check-release-compatibility.ts <repository-relative-candidate.tgz>'),
      true,
    )
  })

  test('upgrades and downgrades supplied local package bytes in fresh processes without changing durable state', {
    timeout: 120_000,
  }, () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-integration-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)
      const candidateDigests = packageTarballDigests(candidate.tarball)
      writeFileSync(resolve(oracle.packageRoot, 'dist', 'index.mjs'), 'throw new Error("unpacked oracle executed")\n')
      writeFileSync(
        resolve(candidate.packageRoot, 'dist', 'index.mjs'),
        'throw new Error("unpacked candidate executed")\n',
      )

      const report = runReleaseCompatibility({
        candidateTarball: candidate.tarball,
        fixtureRoot,
        oracle: {
          identity: {
            integrity: oracleDigests.integrity,
            shasum: oracleDigests.sha1,
            specifier: 'local-encephalon@0.2.0',
          },
          tarball: oracle.tarball,
        },
      })

      const expectedCandidateLimits = {
        gather: { accepted: [50, 100, 101, 999, 1000], rejected: [1001] },
        list: { accepted: [50, 100, 101, 999, 1000], rejected: [1001] },
        search: { accepted: [50, 100, 101, 999, 1000], rejected: [1001] },
        searchCompact: { accepted: [50, 100, 101, 999, 1000], rejected: [1001] },
      }
      const expectedOracleLimits = {
        gather: { accepted: [50, 100], rejected: [101, 999, 1000, 1001] },
        list: { accepted: [50], rejected: [100, 101, 999, 1000, 1001] },
        search: { accepted: [50], rejected: [100, 101, 999, 1000, 1001] },
        searchCompact: { accepted: [50, 100], rejected: [101, 999, 1000, 1001] },
      }
      assert.equal(report.status, 'ok')
      assert.deepEqual(report.oracle.digests, oracleDigests)
      assert.deepEqual(report.candidate.digests, candidateDigests)
      assert.equal(report.oracle.version, '0.2.0')
      assert.equal(report.candidate.version, '0.3.0')
      assert.deepEqual(report.upgrade.schemas, { after: '2', before: '1' })
      assert.deepEqual(report.downgrade.schemas, { after: '1', before: '2' })
      assert.equal(report.upgrade.durableState, 'identical')
      assert.equal(report.downgrade.durableState, 'identical')
      assert.deepEqual(report.upgrade.resultLimits.api, expectedCandidateLimits)
      assert.deepEqual(report.upgrade.resultLimits.cli, expectedCandidateLimits)
      assert.deepEqual(report.downgrade.resultLimits.api, expectedOracleLimits)
      assert.deepEqual(report.downgrade.resultLimits.cli, expectedOracleLimits)
      assert.equal(JSON.stringify(report).includes(temporaryRoot), false)
      assert.equal(
        readFileSync(resolve(fixtureRoot, 'AGENTS.md'), 'utf8').startsWith('oracle agents predecessor\n'),
        true,
      )
      assert.equal(
        readFileSync(resolve(fixtureRoot, 'CLAUDE.md'), 'utf8').startsWith('oracle claude predecessor\n'),
        true,
      )
      assert.equal(
        readFileSync(
          resolve(fixtureRoot, 'encephalon', '_artifacts', 'decision', 'compatibility-base', 'evidence.txt'),
          'utf8',
        ),
        'oracle artifact evidence\n',
      )
      const database = new DatabaseSync(resolve(fixtureRoot, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'), {
        readOnly: true,
      })
      try {
        const row = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as
          | { value?: unknown }
          | undefined
        assert.equal(row?.value, '1')
      } finally {
        database.close()
      }
      assert.equal(
        JSON.parse(readFileSync(resolve(fixtureRoot, 'node_modules', 'encephalon', 'package.json'), 'utf8')).version,
        '0.2.0',
      )
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  test('rejects a local oracle identity mismatch before creating or installing the fixture repository', () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'encephalon-release-wrong-oracle-'))
    const fixtureRoot = resolve(temporaryRoot, 'repository')
    try {
      mkdirSync(fixtureRoot)
      const oracle = buildStandInTarball(temporaryRoot, '0.2.0', '1')
      const candidate = buildStandInTarball(temporaryRoot, '0.3.0', '2')
      const oracleDigests = packageTarballDigests(oracle.tarball)

      assert.throws(() =>
        runReleaseCompatibility({
          candidateTarball: candidate.tarball,
          fixtureRoot,
          oracle: {
            identity: {
              integrity: `${oracleDigests.integrity}-wrong`,
              shasum: oracleDigests.sha1,
              specifier: 'local-encephalon@0.2.0',
            },
            tarball: oracle.tarball,
          },
        }),
      )
      assert.equal(existsSync(resolve(fixtureRoot, 'package.json')), false)
      assert.equal(existsSync(resolve(fixtureRoot, 'node_modules', 'encephalon')), false)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })
})
