import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { afterEach, describe, test } from 'node:test'
import { artifactInspectionTestHooks } from '../src/artifact-inspection.ts'
import { cacheReadTestHooks } from '../src/cache.ts'
import {
  CacheDatabaseCreationConflict,
  CacheDatabaseFailure,
  cacheLocationTestHooks,
  createCacheOwnedDirectory,
  inspectCacheDatabase,
  inspectCacheLocation,
  inspectCacheOwnedDirectory,
  observeCacheOwner,
  observeCacheRecoveryWitness,
  openVerifiedCacheDatabase,
  publishCacheOwnerRecovery,
  quarantineCacheOwnedDirectory,
  sameCacheEntryIdentity,
  writeCacheOwner,
} from '../src/cache-location.ts'
import { PACKAGE_VERSION } from '../src/generated/version.ts'
import * as api from '../src/index.ts'
import { withOperationLock } from '../src/lock.ts'
import { ordinalStringCompare } from '../src/order.ts'
import { recordCorpusFingerprint } from '../src/record-corpus-fingerprint.ts'
import { recordWriteTestHooks } from '../src/records.ts'
import { repositoryTestHooks } from '../src/repository.ts'
import { responseBudgetTestHooks } from '../src/response-budget.ts'
import type { BrainRecord } from '../src/types.ts'
import {
  canRenameParentWithOpenChild,
  createTestRepository,
  ensureParent,
  removeTestRepository,
} from '../test/helpers.ts'

const roots: string[] = []

const renameParentWithOpenChildSupported = canRenameParentWithOpenChild()

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const createOutsideDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'encephalon-cache-outside-'))
  roots.push(directory)
  return directory
}

const createHardLinkIfSupported = (target: string, path: string) => {
  let supported = true
  try {
    linkSync(target, path)
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'EACCES' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EPERM' || code === 'EXDEV') {
      supported = false
    } else {
      throw error
    }
  }
  return supported
}

const detectHardLinkSupport = () => {
  const directory = mkdtempSync(join(tmpdir(), 'encephalon-hard-link-probe-'))
  const target = join(directory, 'target')
  const alias = join(directory, 'alias')
  writeFileSync(target, 'hard-link probe')
  const supported = createHardLinkIfSupported(target, alias)
  rmSync(directory, { force: true, recursive: true })
  return supported
}

const hardLinksSupported = detectHardLinkSupport()
const hardLinkSkip = hardLinksSupported ? false : 'The test filesystem does not support user-created hard links.'

const observeDatabaseCleanupAttempts = (unsafeAliasExists: () => boolean) => {
  const originalExec = DatabaseSync.prototype.exec
  const originalClose = DatabaseSync.prototype.close
  const attempts = { close: 0, rollback: 0 }
  DatabaseSync.prototype.exec = function observedDatabaseExec(this: DatabaseSync, sql: string) {
    if (unsafeAliasExists() && sql === 'ROLLBACK') {
      attempts.rollback += 1
    }
    return originalExec.call(this, sql)
  }
  DatabaseSync.prototype.close = function observedDatabaseClose(this: DatabaseSync) {
    if (unsafeAliasExists()) {
      attempts.close += 1
    }
    return originalClose.call(this)
  }
  return {
    attempts,
    restore: () => {
      DatabaseSync.prototype.exec = originalExec
      DatabaseSync.prototype.close = originalClose
    },
  }
}

afterEach(() => {
  cacheLocationTestHooks.afterCacheOwnerRead = undefined
  artifactInspectionTestHooks.close = undefined
  artifactInspectionTestHooks.fault = undefined
  artifactInspectionTestHooks.open = undefined
  cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
  cacheLocationTestHooks.afterDatabaseOpen = undefined
  cacheLocationTestHooks.afterPrimaryBootstrapClose = undefined
  cacheLocationTestHooks.afterPrimaryBootstrapOpen = undefined
  cacheLocationTestHooks.afterQuarantineRename = undefined
  cacheLocationTestHooks.afterRegularFileOpen = undefined
  cacheLocationTestHooks.afterOwnerRecoveryCreation = undefined
  cacheLocationTestHooks.beforeDatabaseOpen = undefined
  cacheLocationTestHooks.beforeCacheOwnerOpen = undefined
  cacheLocationTestHooks.beforeCacheLocationAssertion = undefined
  cacheLocationTestHooks.beforeLocationInspection = undefined
  cacheLocationTestHooks.beforeOwnedDirectoryPromotionRename = undefined
  cacheLocationTestHooks.beforeOwnedDirectoryFinalIdentity = undefined
  cacheLocationTestHooks.beforeOwnerRecoveryFsync = undefined
  cacheLocationTestHooks.beforeQuarantineRename = undefined
  cacheLocationTestHooks.beforeQuarantinedOwnerRemoval = undefined
  cacheLocationTestHooks.beforeQuarantinedOwnerValidation = undefined
  cacheLocationTestHooks.beforeQuarantinedFileCleanup = undefined
  cacheLocationTestHooks.duringOwnedDirectoryInspection = undefined
  cacheLocationTestHooks.fsyncOwnedDirectory = undefined
  cacheLocationTestHooks.ownedDirectoryRealpath = undefined
  cacheLocationTestHooks.regularFileRealpath = undefined
  cacheReadTestHooks.afterCanonicalCacheEqualityValidation = undefined
  cacheReadTestHooks.afterCanonicalValidation = undefined
  cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = undefined
  cacheReadTestHooks.afterGatherSearchEvaluation = undefined
  cacheReadTestHooks.afterIntegrityProbe = undefined
  cacheReadTestHooks.afterManifestKindEnumeration = undefined
  cacheReadTestHooks.afterManifestEntryLstat = undefined
  cacheReadTestHooks.afterManifestRootEnumeration = undefined
  cacheReadTestHooks.afterMissingPrimaryRecoveryObservation = undefined
  cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
  cacheReadTestHooks.beforeCacheSnapshotCommit = undefined
  cacheReadTestHooks.beforeManifestEntryLstat = undefined
  cacheReadTestHooks.beforeIntegrityTextRead = undefined
  cacheReadTestHooks.duringDatabaseInitialisation = undefined
  cacheReadTestHooks.recordReadHooks = undefined
  responseBudgetTestHooks.afterCharge = undefined
  recordWriteTestHooks.fault = undefined
  repositoryTestHooks.afterGitMarkerDecision = undefined
  cacheLocationTestHooks.releaseCloseSafetyLatchesForTests?.()
  roots.splice(0).forEach(removeTestRepository)
})

const functionFromApi = <T>(name: string) => (api as unknown as Record<string, T>)[name] as T

const completeCauseChain = (value: unknown, seen = new Set<object>()): unknown[] => {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    return [value, ...completeCauseChain((value as { cause?: unknown }).cause, seen)]
  }
  return [value]
}

const causeChainText = (value: unknown) =>
  completeCauseChain(value)
    .map(entry => (entry instanceof Error ? `${entry.name}: ${entry.message}` : String(entry)))
    .join('\n')

const assertBudgetError = (operation: () => unknown, expected: { budget: string; field: string; maximum: number }) => {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'INVALID_ARGUMENT')
    assert.deepEqual((error as { details?: unknown }).details, expected)
    return true
  })
}

const expectedResponseBytes = (value: unknown): number => {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8')
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return 8
  }
  if (Array.isArray(value)) {
    return value.reduce((bytes, item) => bytes + expectedResponseBytes(item), 8)
  }
  if (typeof value === 'object') {
    return Object.entries(value).reduce(
      (bytes, [key, item]) => bytes + Buffer.byteLength(key, 'utf8') + expectedResponseBytes(item),
      8,
    )
  }
  throw new Error('Test response fixture must be JSON-compatible.')
}

const rewriteRecordSummary = (root: string, path: string, summary: string) => {
  const absolutePath = join(root, ...path.split('/'))
  const record = JSON.parse(readFileSync(absolutePath, 'utf8')) as Record<string, unknown>
  const { payload } = record
  assert.ok(payload !== null && !Array.isArray(payload) && typeof payload === 'object')
  writeFileSync(absolutePath, `${JSON.stringify({ ...record, payload: { ...payload, summary } }, null, 2)}\n`, 'utf8')
}

const waitForPath = (path: string, process: ReturnType<typeof spawn>) => {
  const deadline = Date.now() + 5000
  while (!existsSync(path) && process.exitCode === null && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  assert.equal(existsSync(path), true)
}

const waitForChild = async (child: ReturnType<typeof spawn>) => {
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, 'exit')
  }
}

const stopChild = async (child: ReturnType<typeof spawn>) => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill()
  }
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, 'exit')
  }
}

const cacheDirectoryPath = (root: string) => join(root, 'node_modules', '.cache', 'encephalon')

const cacheDatabasePath = (root: string) => join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')

const createRecoveredOperationMarker = (root: string, token: string) => {
  const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
  const owner = {
    acquiredAt: '2026-08-24T10:00:00.000Z',
    phase: 'recovering',
    pid: process.pid,
    token,
  } as const
  mkdirSync(recoveryPath, { recursive: true })
  writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify(owner)}\n`)
  writeFileSync(join(recoveryPath, 'owner.recovered.json'), `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`)
  return { owner, recoveryPath }
}

const logicalCacheProjection = (root: string) => {
  const database = new DatabaseSync(cacheDatabasePath(root), { readOnly: true })
  try {
    return {
      metadata: database.prepare('SELECT key, value FROM metadata ORDER BY key').all(),
      records: database
        .prepare(
          'SELECT id, kind, subject, source, created_at, path, active, summary, record_json FROM records ORDER BY id',
        )
        .all(),
      search: database.prepare('SELECT id, text FROM record_search ORDER BY id').all(),
    }
  } finally {
    database.close()
  }
}

const databaseOpenCases = [
  {
    databaseName: 'brain.sqlite',
    name: 'writer',
    operation: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }),
    prepare: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
  },
  {
    databaseName: 'brain.sqlite',
    name: 'reader',
    operation: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
    prepare: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
  },
  {
    databaseName: 'operation-lock.sqlite',
    name: 'gate',
    operation: (root: string) => withOperationLock(root, () => 'entered'),
    prepare: (root: string) => withOperationLock(root, () => 'prepared'),
  },
] as const

const addCacheRecord = (root: string) =>
  functionFromApi<(input: Record<string, unknown>) => BrainRecord>('addRecord')({
    id: 'cache-record',
    kind: 'context',
    payload: { detail: 'cache corruption marker', summary: 'Cache record' },
    root,
    searchText: 'recoverable cache row',
    source: 'agent',
    subject: 'cache.validation',
  })

test('writes validated mutation snapshots equivalently and falls back after identity changes', () => {
  const cases = [
    { kind: 'stable', name: 'stable snapshot' },
    { kind: 'corrupt', name: 'corrupt cache recovery' },
    { kind: 'record', name: 'canonical record replacement' },
    { kind: 'writer-record', name: 'transaction-time record replacement' },
    { kind: 'artifact', name: 'artifact replacement' },
  ] as const

  for (const entry of cases) {
    const root = createRoot()
    const seedId = `snapshot-seed-${entry.kind}`
    const artifact = `_artifacts/decision/${seedId}/evidence.txt`
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, 'stable evidence')
    const seed = api.addRecord({
      artifacts: [artifact],
      id: seedId,
      kind: 'decision',
      payload: { summary: 'Original snapshot seed' },
      root,
      searchText: 'original searchable snapshot seed',
      source: 'test',
      subject: `cache.snapshot.${entry.kind}`,
    })
    const seedPath = join(root, ...seed.path.split('/'))
    if (entry.kind === 'corrupt') {
      writeFileSync(cacheDatabasePath(root), 'not a sqlite database')
    }
    let diskCacheValidations = 0
    cacheReadTestHooks.afterCanonicalValidation = () => {
      diskCacheValidations += 1
    }
    const replaceSeedRecord = () => {
      const displacedPath = join(root, `${seedId}.displaced`)
      renameSync(seedPath, displacedPath)
      const record = JSON.parse(readFileSync(displacedPath, 'utf8')) as Record<string, unknown>
      writeFileSync(
        seedPath,
        `${JSON.stringify(
          {
            ...record,
            payload: { summary: 'Current replacement snapshot seed' },
          },
          null,
          2,
        )}\n`,
      )
    }
    recordWriteTestHooks.fault = point => {
      if (point === 'during-hydration') {
        recordWriteTestHooks.fault = undefined
        if (entry.kind === 'record') {
          replaceSeedRecord()
        }
        if (entry.kind === 'artifact') {
          renameSync(artifactPath, `${artifactPath}.displaced`)
          writeFileSync(artifactPath, 'stable evidence')
        }
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer' && entry.kind === 'writer-record') {
        cacheReadTestHooks.duringDatabaseInitialisation = undefined
        replaceSeedRecord()
      }
    }

    api.addRecord({
      id: `snapshot-addition-${entry.kind}`,
      kind: 'decision',
      payload: { summary: 'Validated snapshot addition' },
      root,
      searchText: 'new searchable snapshot addition',
      source: 'test',
      subject: `cache.snapshot.${entry.kind}`,
      supersedes: [seedId],
    })

    assert.equal(
      diskCacheValidations,
      entry.kind === 'record' || entry.kind === 'writer-record' || entry.kind === 'artifact' ? 1 : 0,
      entry.name,
    )
    if (entry.kind === 'record' || entry.kind === 'writer-record') {
      const shown = api.showRecord({ activeOnly: false, id: seedId, root })
      assert.ok(shown)
      assert.equal((shown.payload as { summary?: unknown }).summary, 'Current replacement snapshot seed')
    }
    const snapshotProjection = logicalCacheProjection(root)
    cacheReadTestHooks.afterCanonicalValidation = undefined
    assert.deepEqual(api.hydrate({ root }), { recordsIndexed: 2 })
    assert.deepEqual(logicalCacheProjection(root), snapshotProjection, entry.name)
    assert.deepEqual(api.prepare({ root }), { hydrated: false, recordsIndexed: 2 }, entry.name)
  }
})

test('uses verified artifact observations without a detached cache lstat', () => {
  const root = createRoot()
  const id = 'handed-artifact-observation'
  const artifact = `_artifacts/architecture/${id}/diagram.svg`
  const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
  ensureParent(artifactPath)
  writeFileSync(artifactPath, '<svg>stable</svg>')
  api.addRecord({
    artifacts: [artifact],
    id,
    kind: 'architecture',
    payload: { summary: 'Stable observation' },
    root,
    source: 'test',
    subject: 'cache.handed-artifact-observation',
  })

  let detachedArtifactStats = 0
  cacheReadTestHooks.beforeManifestEntryLstat = path => {
    if (path === artifactPath) {
      detachedArtifactStats += 1
      throw Object.assign(new Error('detached artifact stat'), { code: 'EIO' })
    }
  }

  assert.deepEqual(api.hydrate({ root }), { recordsIndexed: 1 })
  assert.equal(detachedArtifactStats, 0)
})

test('preserves artifact manifest field ordering while converting verified observations', () => {
  const root = createRoot()
  const id = 'artifact-manifest-conversion'
  const artifact = `_artifacts/architecture/${id}/diagram.svg`
  const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
  ensureParent(artifactPath)
  writeFileSync(artifactPath, '<svg>stable</svg>')
  api.addRecord({
    artifacts: [artifact],
    id,
    kind: 'architecture',
    payload: { summary: 'Manifest conversion' },
    root,
    source: 'test',
    subject: 'cache.artifact-manifest-conversion',
  })

  const manifestEntry = (path: string, type: 'directory' | 'file') => {
    const metadata = lstatSync(join(root, ...path.split('/')), { bigint: true })
    return {
      ctimeNanoseconds: metadata.ctimeNs.toString(),
      mtimeNanoseconds: metadata.mtimeNs.toString(),
      path,
      size: metadata.size.toString(),
      type,
    }
  }
  const expected = createHash('sha256')
    .update(
      JSON.stringify([
        manifestEntry('encephalon', 'directory'),
        manifestEntry('encephalon/architecture', 'directory'),
        manifestEntry(`encephalon/architecture/${id}.json`, 'file'),
        manifestEntry(`encephalon/${artifact}`, 'file'),
      ]),
    )
    .digest('hex')
  const database = new DatabaseSync(cacheDatabasePath(root), { readOnly: true })
  const actual = database.prepare("SELECT value FROM metadata WHERE key = 'manifest'").get() as {
    value?: unknown
  }
  database.close()

  assert.equal(actual.value, expected)
})

test('retries transient artifact mutation and bounds persistent mutation as repository change', () => {
  for (const persistent of [false, true]) {
    const root = createRoot()
    const id = persistent ? 'persistent-artifact-mutation' : 'transient-artifact-mutation'
    const artifact = `_artifacts/architecture/${id}/diagram.svg`
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, '<svg>initial</svg>')
    api.addRecord({
      artifacts: [artifact],
      id,
      kind: 'architecture',
      payload: { summary: 'Artifact mutation retry' },
      root,
      source: 'test',
      subject: `cache.${id}`,
    })

    let mutations = 0
    artifactInspectionTestHooks.fault = (point, path) => {
      if (point === 'after-artifact-fstat' && path === artifact && (persistent || mutations === 0)) {
        mutations += 1
        writeFileSync(artifactPath, `<svg>mutation-${mutations}</svg>`)
      }
    }

    if (persistent) {
      assert.throws(
        () => api.hydrate({ root }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
      assert.equal(mutations, 3)
    } else {
      assert.deepEqual(api.hydrate({ root }), { recordsIndexed: 1 })
      assert.equal(mutations, 1)
      assert.deepEqual(api.prepare({ root }), { hydrated: false, recordsIndexed: 1 })
    }
    artifactInspectionTestHooks.fault = undefined
  }
})

test('keeps operational artifact I/O errors classified as IO_ERROR', () => {
  const root = createRoot()
  const id = 'artifact-operational-io'
  const artifact = `_artifacts/architecture/${id}/diagram.svg`
  const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
  ensureParent(artifactPath)
  writeFileSync(artifactPath, '<svg>stable</svg>')
  api.addRecord({
    artifacts: [artifact],
    id,
    kind: 'architecture',
    payload: { summary: 'Operational artifact failure' },
    root,
    source: 'test',
    subject: 'cache.artifact-operational-io',
  })
  artifactInspectionTestHooks.fault = (point, path) => {
    if (point === 'after-artifact-fstat' && path === artifact) {
      throw Object.assign(new Error('simulated artifact I/O failure'), { code: 'EIO' })
    }
  }

  assert.throws(
    () => api.hydrate({ root }),
    (error: unknown) => {
      const failure = error as { code?: unknown; details?: unknown; message?: unknown }
      assert.equal(failure.code, 'IO_ERROR')
      assert.equal(typeof failure.message === 'string' && failure.message.includes(root), false)
      assert.equal(JSON.stringify(failure.details ?? null).includes(root), false)
      return true
    },
  )
})

test('does not accept an artifact mutation after canonical cache equality validation', () => {
  const root = createRoot()
  const id = 'artifact-freshness-enumeration'
  const artifact = `_artifacts/architecture/${id}/diagram.svg`
  const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
  ensureParent(artifactPath)
  writeFileSync(artifactPath, '<svg>before</svg>')
  api.addRecord({
    artifacts: [artifact],
    id,
    kind: 'architecture',
    payload: { summary: 'Freshness enumeration' },
    root,
    source: 'test',
    subject: 'cache.artifact-freshness-enumeration',
  })
  let mutated = false
  cacheReadTestHooks.afterCanonicalCacheEqualityValidation = () => {
    if (!mutated) {
      writeFileSync(artifactPath, '<svg>after-enumeration</svg>')
      mutated = true
    }
  }

  assert.throws(
    () => api.prepare({ root }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
      return true
    },
  )
  assert.equal(mutated, true)
  cacheReadTestHooks.afterCanonicalCacheEqualityValidation = undefined
  assert.deepEqual(api.prepare({ root }), { hydrated: true, recordsIndexed: 1 })
  assert.deepEqual(api.prepare({ root }), { hydrated: false, recordsIndexed: 1 })
})

test('retries artifact mutation after canonical validation without committing a stale manifest', () => {
  for (const persistent of [false, true]) {
    const root = createRoot()
    const id = `after-validation-${persistent}`
    const artifact = `_artifacts/architecture/${id}/diagram.svg`
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, '<svg>before</svg>')
    api.addRecord({
      artifacts: [artifact],
      id,
      kind: 'architecture',
      payload: { summary: 'After validation mutation' },
      root,
      source: 'test',
      subject: `cache.after-validation-${persistent}`,
    })
    let mutations = 0
    cacheReadTestHooks.afterCanonicalValidation = () => {
      if (persistent || mutations === 0) {
        mutations += 1
        writeFileSync(artifactPath, `<svg>mutation-${mutations}</svg>`)
      }
    }

    if (persistent) {
      assert.throws(
        () => api.hydrate({ root }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
      assert.equal(mutations, 3)
    } else {
      assert.deepEqual(api.hydrate({ root }), { recordsIndexed: 1 })
      assert.equal(mutations, 1)
      assert.deepEqual(api.prepare({ root }), { hydrated: false, recordsIndexed: 1 })
    }
    cacheReadTestHooks.afterCanonicalValidation = undefined
  }
})

const mutateCache = (root: string, mutation: (database: DatabaseSync) => void) => {
  const database = new DatabaseSync(cacheDatabasePath(root))
  try {
    mutation(database)
  } finally {
    database.close()
  }
}

const overwriteCacheWithInternallyConsistentForgery = (
  root: string,
  canonical: BrainRecord,
  options: { replaceIdentity?: boolean } = {},
) => {
  const forgedId = options.replaceIdentity === true ? 'invented-cache-record' : canonical.id
  const forgedSummary = 'Forged cache record'
  const forged: BrainRecord = {
    ...canonical,
    id: forgedId,
    path: `encephalon/context/${forgedId}.json`,
    payload: { detail: 'invented disposable cache knowledge', summary: forgedSummary },
    searchText: 'forged cache token',
    subject: 'cache.forged',
  }
  const forgedSearchDocument = [
    forged.kind,
    forged.subject,
    forged.source,
    forgedSummary,
    JSON.stringify(forged.payload),
    forged.searchText,
  ].join('\n')
  mutateCache(root, database => {
    database.exec('BEGIN IMMEDIATE')
    database
      .prepare(
        `UPDATE records
         SET subject = ?, summary = ?, record_json = ?
         WHERE id = ?`,
      )
      .run(forged.subject, forgedSummary, JSON.stringify(forged), canonical.id)
    database.prepare('UPDATE records SET id = ?, path = ? WHERE id = ?').run(forged.id, forged.path, canonical.id)
    database.prepare('DELETE FROM record_search WHERE id = ?').run(canonical.id)
    database.prepare('INSERT INTO record_search(id, text) VALUES (?, ?)').run(forged.id, forgedSearchDocument)
    database
      .prepare("UPDATE metadata SET value = ? WHERE key = 'recordFingerprint'")
      .run(recordCorpusFingerprint([forged]))
    database.exec('COMMIT')
  })
}

const installInternallyConsistentForgedCacheRecord = (root: string) => {
  const canonical = addCacheRecord(root)
  overwriteCacheWithInternallyConsistentForgery(root, canonical)
  return canonical
}

const observeCacheIntegrity = () => {
  const observations: Array<{ kind: 'probe'; name: string; rows: number } | { kind: 'text-read'; name: string }> = []
  cacheReadTestHooks.afterIntegrityProbe = ({ name, rows }) => {
    observations.push({ kind: 'probe', name, rows })
  }
  cacheReadTestHooks.beforeIntegrityTextRead = name => {
    observations.push({ kind: 'text-read', name })
  }
  return observations
}

const assertCacheLayoutRejected = (operation: () => unknown) => {
  assert.throws(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
    return true
  })
}

describe('cache filesystem containment', () => {
  test('compares cache entry identities without losing bigint precision', () => {
    const beyondSafeInteger = BigInt(Number.MAX_SAFE_INTEGER) + 1n
    assert.equal(
      sameCacheEntryIdentity(
        { dev: beyondSafeInteger, ino: beyondSafeInteger + 1n },
        { dev: beyondSafeInteger, ino: beyondSafeInteger + 1n },
      ),
      true,
    )
    assert.equal(
      sameCacheEntryIdentity(
        { dev: beyondSafeInteger, ino: beyondSafeInteger + 1n },
        { dev: beyondSafeInteger, ino: beyondSafeInteger + 2n },
      ),
      false,
    )
    assert.equal(
      sameCacheEntryIdentity(
        { dev: beyondSafeInteger, ino: beyondSafeInteger + 1n },
        { dev: beyondSafeInteger + 1n, ino: beyondSafeInteger + 1n },
      ),
      false,
    )
  })

  test('preserves a verified database failure when close also fails', () => {
    const root = createRoot()
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    const location = inspectCacheLocation(root)
    const primaryFailure = new Error('verified read failure')
    const closeFailure = new Error('database close failure')
    let closeAttempts = 0
    class CloseFailingDatabase {
      readonly database: DatabaseSync

      constructor(path: string) {
        this.database = new DatabaseSync(path)
      }

      close() {
        closeAttempts += 1
        this.database.close()
        throw closeFailure
      }
    }

    assert.throws(
      () =>
        openVerifiedCacheDatabase({
          afterVerifiedOpen: () => {
            throw primaryFailure
          },
          DatabaseConstructor: CloseFailingDatabase,
          location,
          name: 'brain.sqlite',
          primary: { kind: 'existing' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof CacheDatabaseFailure)
        assert.equal(error.failure, primaryFailure)
        return true
      },
    )
    assert.equal(closeAttempts, 1)
  })

  test('reclassifies primary disappearance during database construction', () => {
    const root = createRoot()
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    const location = inspectCacheLocation(root)
    const databasePath = cacheDatabasePath(root)
    const displacedPath = join(root, 'constructor-disappeared-primary.sqlite')
    const missingFailure = new Error('verified primary disappeared during construction')
    class DisappearingDatabase {
      constructor(path: string) {
        renameSync(path, displacedPath)
        throw new Error('database constructor could not open the missing primary')
      }

      close() {}
    }

    assert.throws(
      () =>
        openVerifiedCacheDatabase({
          DatabaseConstructor: DisappearingDatabase,
          location,
          missing: () => {
            throw missingFailure
          },
          name: 'brain.sqlite',
          primary: { kind: 'existing' },
        }),
      error => error === missingFailure,
    )
    assert.equal(existsSync(displacedPath), true)
    assert.equal(existsSync(databasePath), false)
  })

  test('rejects cache ancestor redirects without changing the redirect target', () => {
    const cases = [
      {
        arrange: (root: string, outside: string) => {
          const installedPackage = realpathSync(join(root, 'node_modules', 'encephalon'))
          rmSync(join(root, 'node_modules'), { recursive: true })
          symlinkSync(installedPackage, join(outside, 'encephalon'), process.platform === 'win32' ? 'junction' : 'dir')
          symlinkSync(outside, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
        },
        entry: 'node_modules',
        name: 'node_modules',
      },
      {
        arrange: (root: string, outside: string) => {
          symlinkSync(outside, join(root, 'node_modules', '.cache'), process.platform === 'win32' ? 'junction' : 'dir')
        },
        entry: 'node_modules/.cache',
        name: '.cache',
      },
      {
        arrange: (root: string, outside: string) => {
          mkdirSync(join(root, 'node_modules', '.cache'))
          symlinkSync(
            outside,
            join(root, 'node_modules', '.cache', 'encephalon'),
            process.platform === 'win32' ? 'junction' : 'dir',
          )
        },
        entry: 'node_modules/.cache/encephalon',
        name: 'encephalon',
      },
    ] as const

    for (const entry of cases) {
      const root = createRoot()
      const outside = createOutsideDirectory()
      writeFileSync(join(outside, 'sentinel'), entry.name)
      entry.arrange(root, outside)
      const before = readdirSync(outside).sort(ordinalStringCompare)

      assert.throws(
        () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: entry.entry,
            invariant: 'real-directory',
          })
          assert.equal(causeChainText(error).includes(outside), false)
          return true
        },
      )
      assert.deepEqual(readdirSync(outside).sort(ordinalStringCompare), before)
      assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), entry.name)
    }
  })

  test('rejects a primary database symlink without changing its target', () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    const target = join(outside, 'database-target')
    mkdirSync(cacheDirectoryPath(root), { recursive: true })
    writeFileSync(target, 'outside database bytes')
    symlinkSync(target, cacheDatabasePath(root))

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/brain.sqlite',
          invariant: 'regular-non-symlink-file',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.equal(readFileSync(target, 'utf8'), 'outside database bytes')
    assert.equal(readFileSync(cacheDatabasePath(root), 'utf8'), 'outside database bytes')
  })

  test('rejects hard-linked primary databases before SQLite opens them', { skip: hardLinkSkip }, () => {
    const cases = [
      {
        databaseName: 'brain.sqlite',
        name: 'primary cache',
        operation: (root: string, _entered: () => void) =>
          functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        prepareTarget: (path: string) => writeFileSync(path, ''),
      },
      {
        databaseName: 'operation-lock.sqlite',
        name: 'operation gate',
        operation: (root: string, entered: () => void) => withOperationLock(root, entered),
        prepareTarget: (path: string) => {
          const database = new DatabaseSync(path)
          database.close()
        },
      },
    ] as const

    for (const entry of cases) {
      const root = createRoot()
      const outside = createOutsideDirectory()
      const target = join(outside, `${entry.databaseName}-target`)
      const databasePath = join(cacheDirectoryPath(root), entry.databaseName)
      mkdirSync(cacheDirectoryPath(root), { recursive: true })
      entry.prepareTarget(target)
      const before = readFileSync(target)
      linkSync(target, databasePath)
      let databaseOpens = 0
      let operationEntered = false
      cacheLocationTestHooks.beforeDatabaseOpen = database => {
        if (database.name === entry.databaseName) {
          databaseOpens += 1
        }
      }

      assert.throws(
        () =>
          entry.operation(root, () => {
            operationEntered = true
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED', entry.name)
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: `node_modules/.cache/encephalon/${entry.databaseName}`,
            invariant: 'single-link-file',
          })
          assert.equal(causeChainText(error).includes(outside), false)
          return true
        },
      )
      assert.equal(databaseOpens, 0, entry.name)
      assert.equal(operationEntered, false, entry.name)
      assert.deepEqual(readFileSync(target), before, entry.name)
      assert.deepEqual(readFileSync(databasePath), before, entry.name)
      cacheLocationTestHooks.beforeDatabaseOpen = undefined
    }
  })

  test('rejects hard-linked SQLite sidecars without changing either alias', { skip: hardLinkSkip }, () => {
    const databases = [
      {
        databaseName: 'brain.sqlite',
        operation: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }),
        prepare: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      },
      {
        databaseName: 'operation-lock.sqlite',
        operation: (root: string) => withOperationLock(root, () => 'entered'),
        prepare: (root: string) => withOperationLock(root, () => 'prepared'),
      },
    ] as const
    const suffixes = ['-wal', '-shm', '-journal'] as const

    for (const database of databases) {
      for (const suffix of suffixes) {
        const root = createRoot()
        const outside = createOutsideDirectory()
        database.prepare(root)
        const sidecarPath = join(cacheDirectoryPath(root), `${database.databaseName}${suffix}`)
        const target = join(outside, `${database.databaseName}${suffix}-target`)
        rmSync(sidecarPath, { force: true })
        writeFileSync(target, `outside ${database.databaseName}${suffix} bytes`)
        const before = readFileSync(target)
        linkSync(target, sidecarPath)
        let databaseOpens = 0
        cacheLocationTestHooks.beforeDatabaseOpen = candidate => {
          if (candidate.name === database.databaseName) {
            databaseOpens += 1
          }
        }

        assert.throws(
          () => database.operation(root),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
            assert.deepEqual((error as { details?: unknown }).details, {
              entry: `node_modules/.cache/encephalon/${database.databaseName}${suffix}`,
              invariant: 'single-link-file',
            })
            assert.equal(causeChainText(error).includes(outside), false)
            return true
          },
        )
        assert.equal(databaseOpens, 0, `${database.databaseName}${suffix}`)
        assert.deepEqual(readFileSync(target), before)
        assert.deepEqual(readFileSync(sidecarPath), before)
        cacheLocationTestHooks.beforeDatabaseOpen = undefined
      }
    }
  })

  test('rejects hard-linked aliases introduced at database open validation boundaries', { skip: hardLinkSkip }, () => {
    const databases = [
      {
        databaseName: 'brain.sqlite',
        operation: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        prepare: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      },
      {
        databaseName: 'operation-lock.sqlite',
        operation: (root: string) => withOperationLock(root, () => 'entered'),
        prepare: (root: string) => withOperationLock(root, () => 'prepared'),
      },
    ] as const
    const boundaries = ['before-open', 'after-open'] as const

    for (const database of databases) {
      for (const boundary of boundaries) {
        const root = createRoot()
        const outside = createOutsideDirectory()
        database.prepare(root)
        const databasePath = join(cacheDirectoryPath(root), database.databaseName)
        const alias = join(outside, `${database.databaseName}-${boundary}`)
        const before = readFileSync(databasePath)
        let initialisationReached = false
        let postOpenReached = false
        cacheLocationTestHooks.afterDatabaseLockInitialisation = candidate => {
          if (candidate.name === database.databaseName) {
            initialisationReached = true
          }
        }
        cacheReadTestHooks.duringDatabaseInitialisation = () => {
          initialisationReached = true
        }
        if (boundary === 'before-open') {
          cacheLocationTestHooks.beforeDatabaseOpen = candidate => {
            if (candidate.name === database.databaseName) {
              cacheLocationTestHooks.beforeDatabaseOpen = undefined
              linkSync(databasePath, alias)
            }
          }
          cacheLocationTestHooks.afterDatabaseOpen = candidate => {
            if (candidate.name === database.databaseName) {
              postOpenReached = true
            }
          }
        } else {
          cacheLocationTestHooks.afterDatabaseOpen = candidate => {
            if (candidate.name === database.databaseName) {
              cacheLocationTestHooks.afterDatabaseOpen = undefined
              postOpenReached = true
              linkSync(databasePath, alias)
            }
          }
        }

        assert.throws(
          () => database.operation(root),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
            assert.deepEqual((error as { details?: unknown }).details, {
              entry: `node_modules/.cache/encephalon/${database.databaseName}`,
              invariant: 'single-link-file',
            })
            assert.equal(causeChainText(error).includes(outside), false)
            return true
          },
        )
        assert.equal(existsSync(databasePath), true)
        assert.equal(existsSync(alias), true)
        assert.equal(postOpenReached, boundary === 'after-open')
        assert.equal(initialisationReached, false)
        assert.deepEqual(readFileSync(databasePath), before)
        assert.deepEqual(readFileSync(alias), before)
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        cacheLocationTestHooks.beforeDatabaseOpen = undefined
        cacheLocationTestHooks.afterDatabaseOpen = undefined
        cacheReadTestHooks.duringDatabaseInitialisation = undefined
      }
    }
  })

  test('preserves repository-change precedence for hard-linked primary replacements', { skip: hardLinkSkip }, () => {
    const databases = [
      {
        databaseName: 'brain.sqlite',
        operation: (root: string, _entered: () => void) =>
          functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        prepare: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      },
      {
        databaseName: 'operation-lock.sqlite',
        operation: (root: string, entered: () => void) => withOperationLock(root, entered),
        prepare: (root: string) => withOperationLock(root, () => 'prepared'),
      },
    ] as const

    for (const database of databases) {
      const root = createRoot()
      const outside = createOutsideDirectory()
      database.prepare(root)
      const databasePath = join(cacheDirectoryPath(root), database.databaseName)
      const displacedPath = join(root, `displaced-${database.databaseName}`)
      const successorPath = join(root, `successor-${database.databaseName}`)
      const alias = join(outside, `${database.databaseName}-replacement-alias`)
      copyFileSync(databasePath, successorPath)
      linkSync(successorPath, alias)
      const before = readFileSync(successorPath)
      let operationEntered = false
      cacheLocationTestHooks.beforeDatabaseOpen = candidate => {
        if (candidate.name === database.databaseName) {
          cacheLocationTestHooks.beforeDatabaseOpen = undefined
          renameSync(databasePath, displacedPath)
          renameSync(successorPath, databasePath)
        }
      }

      assert.throws(
        () =>
          database.operation(root, () => {
            operationEntered = true
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: `node_modules/.cache/encephalon/${database.databaseName}`,
            invariant: 'stable-identity',
          })
          assert.equal(causeChainText(error).includes(outside), false)
          return true
        },
      )
      assert.equal(operationEntered, false)
      assert.deepEqual(readFileSync(databasePath), before)
      assert.deepEqual(readFileSync(alias), before)
      assert.equal(existsSync(displacedPath), true)
    }
  })

  test('preserves creation-conflict precedence for a hard-linked successor', { skip: hardLinkSkip }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    const databasePath = cacheDatabasePath(root)
    const displacedPath = join(root, 'displaced-created-primary.sqlite')
    const successorPath = join(root, 'hard-linked-bootstrap-successor.sqlite')
    const alias = join(outside, 'bootstrap-successor-alias.sqlite')
    const successor = new DatabaseSync(successorPath)
    successor.exec('CREATE TABLE successor_sentinel(value TEXT);')
    successor.close()
    linkSync(successorPath, alias)
    const before = readFileSync(successorPath)
    cacheLocationTestHooks.afterPrimaryBootstrapClose = path => {
      if (basename(path) === 'brain.sqlite') {
        cacheLocationTestHooks.afterPrimaryBootstrapClose = undefined
        renameSync(path, displacedPath)
        renameSync(successorPath, path)
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/brain.sqlite',
          invariant: 'stable-identity',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.deepEqual(readFileSync(databasePath), before)
    assert.deepEqual(readFileSync(alias), before)
    assert.equal(existsSync(displacedPath), true)
  })

  test('preserves repository-change precedence for hard-linked sidecar replacements', { skip: hardLinkSkip }, () => {
    const databases = [
      {
        databaseName: 'brain.sqlite',
        operation: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        prepare: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      },
      {
        databaseName: 'operation-lock.sqlite',
        operation: (root: string) => withOperationLock(root, () => 'entered'),
        prepare: (root: string) => withOperationLock(root, () => 'prepared'),
      },
    ] as const

    for (const database of databases) {
      const root = createRoot()
      const outside = createOutsideDirectory()
      database.prepare(root)
      const sidecarPath = join(cacheDirectoryPath(root), `${database.databaseName}-journal`)
      const displacedPath = join(root, `displaced-${database.databaseName}-journal`)
      const target = join(outside, `${database.databaseName}-journal-replacement`)
      writeFileSync(sidecarPath, 'captured sidecar bytes')
      writeFileSync(target, 'hard-linked replacement sidecar bytes')
      const before = readFileSync(target)
      cacheLocationTestHooks.beforeDatabaseOpen = candidate => {
        if (candidate.name === database.databaseName) {
          cacheLocationTestHooks.beforeDatabaseOpen = undefined
          renameSync(sidecarPath, displacedPath)
          linkSync(target, sidecarPath)
        }
      }

      assert.throws(
        () => database.operation(root),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: `node_modules/.cache/encephalon/${database.databaseName}-journal`,
            invariant: 'stable-identity',
          })
          assert.equal(causeChainText(error).includes(outside), false)
          return true
        },
      )
      assert.deepEqual(readFileSync(sidecarPath), before)
      assert.deepEqual(readFileSync(target), before)
      assert.equal(existsSync(displacedPath), true)
    }
  })

  test('rejects a hard link introduced after the gate transaction begins', { skip: hardLinkSkip }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const databasePath = join(cacheDirectoryPath(root), 'operation-lock.sqlite')
    const alias = join(outside, 'post-begin-operation-lock.sqlite')
    const before = readFileSync(databasePath)
    let aliasIntroduced = false
    let operationEntered = false
    const cleanup = observeDatabaseCleanupAttempts(() => aliasIntroduced)
    cacheLocationTestHooks.afterDatabaseLockInitialisation = candidate => {
      if (candidate.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        linkSync(databasePath, alias)
        aliasIntroduced = true
      }
    }

    try {
      assert.throws(
        () =>
          withOperationLock(root, () => {
            operationEntered = true
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
            invariant: 'single-link-file',
          })
          assert.equal(causeChainText(error).includes(outside), false)
          return true
        },
      )
      assert.equal(operationEntered, false)
      assert.deepEqual(cleanup.attempts, { close: 0, rollback: 0 })
      assert.deepEqual(readFileSync(databasePath), before)
      assert.deepEqual(readFileSync(alias), before)

      assert.throws(
        () =>
          withOperationLock(root, () => {
            operationEntered = true
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
            invariant: 'stable-identity',
          })
          return true
        },
      )
      assert.equal(operationEntered, false)
      assert.deepEqual(cleanup.attempts, { close: 0, rollback: 0 })
    } finally {
      cleanup.restore()
    }
  })

  test('does not quarantine a primary hard-linked at the final source boundary', { skip: hardLinkSkip }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    const databasePath = cacheDatabasePath(root)
    const alias = join(outside, 'quarantine-brain.sqlite')
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    writeFileSync(databasePath, 'corrupt cache bytes')
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        linkSync(path, alias)
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/brain.sqlite',
          invariant: 'single-link-file',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.equal(readFileSync(databasePath, 'utf8'), 'corrupt cache bytes')
    assert.equal(readFileSync(alias, 'utf8'), 'corrupt cache bytes')
  })

  test('preserves repository-change precedence for a hard-linked quarantine replacement', {
    skip: hardLinkSkip,
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    const databasePath = cacheDatabasePath(root)
    const displacedPath = join(root, 'displaced-corrupt-hard-linked-brain.sqlite')
    const target = join(outside, 'quarantine-replacement-brain.sqlite')
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    writeFileSync(databasePath, 'corrupt cache bytes')
    writeFileSync(target, 'hard-linked quarantine replacement bytes')
    const before = readFileSync(target)
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        renameSync(path, displacedPath)
        linkSync(target, path)
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/brain.sqlite',
          invariant: 'stable-quarantine-source',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.deepEqual(readFileSync(databasePath), before)
    assert.deepEqual(readFileSync(target), before)
    assert.equal(readFileSync(displacedPath, 'utf8'), 'corrupt cache bytes')
  })

  test('does not unlink a quarantine file hard-linked after its rename', { skip: hardLinkSkip }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    const databasePath = cacheDatabasePath(root)
    const alias = join(outside, 'renamed-quarantine-brain.sqlite')
    let quarantinePath: string | undefined
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    writeFileSync(databasePath, 'corrupt cache bytes')
    cacheLocationTestHooks.afterQuarantineRename = path => {
      if (basename(path).startsWith('.brain.sqlite.')) {
        cacheLocationTestHooks.afterQuarantineRename = undefined
        quarantinePath = path
        linkSync(path, alias)
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/brain.sqlite',
          invariant: 'stable-quarantine-identity',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.ok(quarantinePath !== undefined)
    assert.equal(existsSync(databasePath), false)
    assert.equal(readFileSync(quarantinePath, 'utf8'), 'corrupt cache bytes')
    assert.equal(readFileSync(alias, 'utf8'), 'corrupt cache bytes')
  })

  test('rejects an unexpected cache sidecar type', () => {
    const root = createRoot()
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    const walPath = `${cacheDatabasePath(root)}-wal`
    rmSync(walPath, { force: true })
    mkdirSync(walPath)

    assertCacheLayoutRejected(() => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }))
    assert.equal(statSync(walPath).isDirectory(), true)
  })

  test('rejects a cache sidecar symlink without changing its target', () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    const target = join(outside, 'wal-target')
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    writeFileSync(target, 'outside wal bytes')
    symlinkSync(target, `${cacheDatabasePath(root)}-wal`)

    assertCacheLayoutRejected(() => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }))
    assert.equal(readFileSync(target, 'utf8'), 'outside wal bytes')
  })

  test('aborts corrupt cleanup after the cache directory is replaced', {
    skip:
      process.platform === 'win32'
        ? 'Windows does not permit renaming a directory containing the open operation gate.'
        : false,
  }, () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const displacedPath = `${cachePath}-displaced`
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    writeFileSync(cacheDatabasePath(root), 'not a sqlite database')
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        renameSync(cachePath, displacedPath)
        mkdirSync(cachePath)
        writeFileSync(join(cachePath, 'replacement-sentinel'), 'replacement cache')
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(readFileSync(join(cachePath, 'replacement-sentinel'), 'utf8'), 'replacement cache')
  })

  test('never unlinks a replacement at a cache quarantine path', () => {
    const root = createRoot()
    let quarantinePath: string | undefined
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    writeFileSync(cacheDatabasePath(root), 'not a sqlite database')
    cacheLocationTestHooks.afterQuarantineRename = path => {
      if (path.includes('.brain.sqlite.')) {
        quarantinePath = path
        rmSync(path)
        writeFileSync(path, 'replacement quarantine')
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.ok(quarantinePath !== undefined)
    assert.equal(readFileSync(quarantinePath, 'utf8'), 'replacement quarantine')
  })

  test('never quarantines a replacement at the corrupt primary source path', () => {
    const root = createRoot()
    const displacedPath = join(root, 'displaced-corrupt-brain.sqlite')
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    writeFileSync(cacheDatabasePath(root), 'not a sqlite database')
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        renameSync(path, displacedPath)
        writeFileSync(path, 'replacement primary')
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(readFileSync(cacheDatabasePath(root), 'utf8'), 'replacement primary')
  })

  test('rejects valid primary replacements between inspection and SQLite open', () => {
    for (const [index, entry] of databaseOpenCases.entries()) {
      const root = createRoot()
      entry.prepare(root)
      const databasePath = join(cacheDirectoryPath(root), entry.databaseName)
      const replacementPath = join(root, `valid-replacement-${index}.sqlite`)
      const displacedPath = join(root, `displaced-${index}.sqlite`)
      copyFileSync(databasePath, replacementPath)
      const replacement = statSync(replacementPath, { bigint: true })
      cacheLocationTestHooks.beforeDatabaseOpen = database => {
        if (database.name === entry.databaseName) {
          cacheLocationTestHooks.beforeDatabaseOpen = undefined
          renameSync(databasePath, displacedPath)
          renameSync(replacementPath, databasePath)
        }
      }

      assert.throws(
        () => entry.operation(root),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
      const preserved = statSync(databasePath, { bigint: true })
      assert.equal(sameCacheEntryIdentity(replacement, preserved), true)
    }
  })

  test('binds an exclusively created primary before inspecting its pathname', () => {
    const root = createRoot()
    const databasePath = cacheDatabasePath(root)
    const displacedPath = join(root, 'bootstrap-created-primary.sqlite')
    let replacements = 0
    cacheLocationTestHooks.afterPrimaryBootstrapClose = path => {
      if (basename(path) === 'brain.sqlite') {
        cacheLocationTestHooks.afterPrimaryBootstrapClose = undefined
        renameSync(path, displacedPath)
        const successor = new DatabaseSync(path)
        successor.exec('CREATE TABLE successor_sentinel(value TEXT);')
        successor.close()
        replacements += 1
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/brain.sqlite',
          invariant: 'stable-identity',
        })
        return true
      },
    )
    assert.equal(replacements, 1)
    assert.equal(existsSync(displacedPath), true)
    const successor = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(
        successor.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'successor_sentinel'").get()?.count,
        1,
      )
      assert.equal(
        successor.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'metadata'").get()?.count,
        0,
      )
    } finally {
      successor.close()
    }
  })

  test('retries when an exclusive primary disappears immediately after creation', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'post-bootstrap-predecessor.sqlite')
    const disappearedClaimPath = join(root, 'post-bootstrap-disappeared-claim.sqlite')
    let claimsDisappeared = 0
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'prepare-fast-path') {
        renameSync(databasePath, predecessorPath)
      }
      if (phase === 'reader-missing') {
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheLocationTestHooks.afterPrimaryBootstrapClose = path => {
      if (basename(path) === 'brain.sqlite') {
        cacheLocationTestHooks.afterPrimaryBootstrapClose = undefined
        renameSync(path, disappearedClaimPath)
        claimsDisappeared += 1
      }
    }
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 1,
    })
    assert.equal(claimsDisappeared, 1)
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 1)
    assert.equal(existsSync(predecessorPath), true)
    assert.equal(existsSync(disappearedClaimPath), true)
    assert.equal(existsSync(databasePath), true)
  })

  test('reports an exclusive primary unlinked while its creation descriptor is open as a creation conflict', {
    skip: process.platform === 'win32' ? 'Windows does not permit unlinking an open cache primary.' : false,
  }, () => {
    const root = createRoot()
    const location = inspectCacheLocation(root)
    const databasePath = cacheDatabasePath(root)
    let disappearances = 0
    cacheLocationTestHooks.afterPrimaryBootstrapOpen = path => {
      if (basename(path) === 'brain.sqlite') {
        cacheLocationTestHooks.afterPrimaryBootstrapOpen = undefined
        rmSync(path)
        disappearances += 1
      }
    }

    assert.throws(
      () =>
        openVerifiedCacheDatabase({
          DatabaseConstructor: DatabaseSync,
          location,
          name: 'brain.sqlite',
          primary: { kind: 'create-exclusive' },
        }),
      (error: unknown) => error instanceof CacheDatabaseCreationConflict,
    )
    assert.equal(disappearances, 1)
    assert.equal(existsSync(databasePath), false)
  })

  test('rejects a hard link added while a fresh primary creation descriptor is open', { skip: hardLinkSkip }, () => {
    const databaseNames = ['brain.sqlite', 'operation-lock.sqlite'] as const

    for (const databaseName of databaseNames) {
      const root = createRoot()
      const outside = createOutsideDirectory()
      const location = inspectCacheLocation(root)
      const databasePath = join(cacheDirectoryPath(root), databaseName)
      const alias = join(outside, `${databaseName}-bootstrap-alias`)
      let initialisationEntries = 0
      cacheLocationTestHooks.afterPrimaryBootstrapOpen = path => {
        if (basename(path) === databaseName) {
          cacheLocationTestHooks.afterPrimaryBootstrapOpen = undefined
          linkSync(path, alias)
        }
      }

      assert.throws(
        () =>
          openVerifiedCacheDatabase({
            afterVerifiedOpen: () => {
              initialisationEntries += 1
            },
            DatabaseConstructor: DatabaseSync,
            location,
            name: databaseName,
            primary: { kind: 'create-exclusive' },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: `node_modules/.cache/encephalon/${databaseName}`,
            invariant: 'single-link-file',
          })
          return true
        },
      )
      assert.equal(initialisationEntries, 0)
      assert.deepEqual(readFileSync(databasePath), readFileSync(alias))
    }
  })

  test('rejects primary replacements immediately after SQLite opens where open-file rename is supported', {
    skip: process.platform === 'win32',
  }, () => {
    for (const [index, entry] of databaseOpenCases.entries()) {
      const root = createRoot()
      entry.prepare(root)
      const databasePath = join(cacheDirectoryPath(root), entry.databaseName)
      const replacementDatabasePath = join(root, `after-open-database-${index}.sqlite`)
      const displacedDatabasePath = join(root, `after-open-displaced-database-${index}.sqlite`)
      copyFileSync(databasePath, replacementDatabasePath)
      const replacementDatabase = statSync(replacementDatabasePath, { bigint: true })
      cacheLocationTestHooks.afterDatabaseOpen = database => {
        if (database.name === entry.databaseName) {
          cacheLocationTestHooks.afterDatabaseOpen = undefined
          renameSync(databasePath, displacedDatabasePath)
          renameSync(replacementDatabasePath, databasePath)
        }
      }

      assert.throws(
        () => entry.operation(root),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
      assert.equal(sameCacheEntryIdentity(replacementDatabase, statSync(databasePath, { bigint: true })), true)
    }
  })

  test('retries pre-open sidecar replacement once across every database path', () => {
    for (const entry of databaseOpenCases) {
      const root = createRoot()
      entry.prepare(root)
      const databasePath = join(cacheDirectoryPath(root), entry.databaseName)
      const sidecarPath = `${databasePath}-journal`
      const displacedSidecarPath = join(root, `${entry.name}-pre-open-sidecar-predecessor`)
      writeFileSync(sidecarPath, '')
      let attempts = 0
      cacheLocationTestHooks.beforeDatabaseOpen = database => {
        if (database.name === entry.databaseName) {
          attempts += 1
          if (attempts === 1) {
            renameSync(sidecarPath, displacedSidecarPath)
            writeFileSync(sidecarPath, '')
          }
        }
      }

      entry.operation(root)
      assert.equal(attempts, 2, entry.name)
      assert.equal(statSync(displacedSidecarPath).isFile(), true, entry.name)
    }
  })

  test('accepts verified sidecar appearance and disappearance across SQLite open', () => {
    const cases = [
      {
        arrange: (_path: string) => {},
        mutate: (path: string) => writeFileSync(path, 'appeared journal'),
        name: 'appearance',
      },
      {
        arrange: (path: string) => writeFileSync(path, 'disappearing journal'),
        mutate: (path: string) => rmSync(path, { force: true }),
        name: 'disappearance',
      },
    ] as const

    for (const entry of cases) {
      const root = createRoot()
      withOperationLock(root, () => 'prepared')
      const journalPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
      entry.arrange(journalPath)
      cacheLocationTestHooks.afterDatabaseOpen = database => {
        if (database.name === 'operation-lock.sqlite') {
          cacheLocationTestHooks.afterDatabaseOpen = undefined
          entry.mutate(journalPath)
        }
      }

      assert.equal(
        withOperationLock(root, () => entry.name),
        entry.name,
      )
    }
  })

  test('accepts optional sidecar teardown after its verification descriptor opens', {
    skip: process.platform === 'win32' ? 'Windows does not permit unlinking an open SQLite sidecar.' : false,
  }, () => {
    const root = createRoot()
    withOperationLock(root, () => 'prepared')
    const journalPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
    writeFileSync(journalPath, 'disappearing journal')
    let teardowns = 0
    let operationEntered = false
    cacheLocationTestHooks.afterRegularFileOpen = path => {
      if (basename(path) === 'operation-lock.sqlite-journal') {
        cacheLocationTestHooks.afterRegularFileOpen = undefined
        rmSync(path)
        teardowns += 1
      }
    }

    assert.equal(
      withOperationLock(root, () => {
        operationEntered = true
        return 'entered'
      }),
      'entered',
    )
    assert.equal(teardowns, 1)
    assert.equal(operationEntered, true)
  })

  test('retries one post-open sidecar replacement across every database path', () => {
    for (const entry of databaseOpenCases) {
      const root = createRoot()
      entry.prepare(root)
      const sidecarPath = join(cacheDirectoryPath(root), `${entry.databaseName}-journal`)
      const displacedPath = join(root, `${entry.name}-post-open-sidecar-predecessor`)
      writeFileSync(sidecarPath, '')
      let opens = 0
      cacheLocationTestHooks.afterDatabaseOpen = database => {
        if (database.name === entry.databaseName) {
          opens += 1
          if (opens === 1) {
            renameSync(sidecarPath, displacedPath)
            writeFileSync(sidecarPath, '')
          }
        }
      }

      entry.operation(root)
      assert.equal(opens, 2, entry.name)
      assert.equal(statSync(displacedPath).isFile(), true, entry.name)
    }
  })

  test('bounds persistent post-open sidecar replacements across every database path', () => {
    for (const entry of databaseOpenCases) {
      const root = createRoot()
      entry.prepare(root)
      const sidecarPath = join(cacheDirectoryPath(root), `${entry.databaseName}-journal`)
      writeFileSync(sidecarPath, '')
      let opens = 0
      cacheLocationTestHooks.afterDatabaseOpen = database => {
        if (database.name === entry.databaseName) {
          opens += 1
          renameSync(sidecarPath, join(root, `${entry.name}-sidecar-generation-${opens - 1}`))
          writeFileSync(sidecarPath, '')
        }
      }

      assert.throws(
        () => entry.operation(root),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED', entry.name)
          return true
        },
      )
      assert.equal(opens, 3, entry.name)
    }
  })

  test('retries sidecar replacement during complete writer and reader initialisation', () => {
    for (const entry of databaseOpenCases.filter(({ name }) => name !== 'gate')) {
      for (const persistent of [false, true]) {
        const root = createRoot()
        entry.prepare(root)
        const sidecarPath = join(cacheDirectoryPath(root), 'brain.sqlite-journal')
        writeFileSync(sidecarPath, '')
        let initialisations = 0
        let opens = 0
        cacheLocationTestHooks.afterDatabaseOpen = database => {
          if (database.name === 'brain.sqlite') {
            opens += 1
          }
        }
        cacheReadTestHooks.duringDatabaseInitialisation = mode => {
          if (mode === entry.name) {
            initialisations += 1
            if (persistent || initialisations === 1) {
              renameSync(sidecarPath, join(root, `${entry.name}-initialisation-sidecar-generation-${initialisations}`))
              writeFileSync(sidecarPath, '')
            }
          }
        }

        if (persistent) {
          assert.throws(
            () => entry.operation(root),
            (error: unknown) => {
              assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED', entry.name)
              return true
            },
          )
        } else {
          entry.operation(root)
        }
        const expectedAttempts = persistent ? 3 : 2
        assert.equal(initialisations, expectedAttempts, entry.name)
        assert.equal(opens, expectedAttempts, entry.name)
        assert.equal(
          statSync(join(root, `${entry.name}-initialisation-sidecar-generation-1`)).isFile(),
          true,
          entry.name,
        )
        cacheLocationTestHooks.afterDatabaseOpen = undefined
        cacheReadTestHooks.duringDatabaseInitialisation = undefined
      }
    }
  })

  test('retries sidecar replacement immediately after the gate transaction begins', {
    skip: process.platform === 'win32' ? 'Windows does not permit renaming an open SQLite rollback journal.' : false,
  }, () => {
    for (const persistent of [false, true]) {
      const root = createRoot()
      withOperationLock(root, () => 'prepared')
      const sidecarPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
      writeFileSync(sidecarPath, '')
      let attempts = 0
      cacheLocationTestHooks.afterDatabaseOpen = database => {
        if (database.name === 'operation-lock.sqlite' && !existsSync(sidecarPath)) {
          writeFileSync(sidecarPath, '')
        }
      }
      cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
        if (database.name === 'operation-lock.sqlite') {
          attempts += 1
          if (persistent || attempts === 1) {
            renameSync(sidecarPath, join(root, `gate-sidecar-generation-${attempts}`))
            writeFileSync(sidecarPath, '')
          }
        }
      }

      if (persistent) {
        assert.throws(
          () => withOperationLock(root, () => 'entered'),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
            return true
          },
        )
      } else {
        assert.equal(
          withOperationLock(root, () => 'entered'),
          'entered',
        )
      }
      assert.equal(attempts, persistent ? 3 : 2)
      cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
      cacheLocationTestHooks.afterDatabaseOpen = undefined
    }
  })

  test('rejects an unsafe sidecar introduced after the gate transaction begins', {
    skip: process.platform === 'win32' ? 'Windows does not permit renaming an open SQLite rollback journal.' : false,
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const sidecarPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
    const displacedPath = join(root, 'safe-gate-journal')
    const targetPath = join(outside, 'gate-journal-target')
    writeFileSync(sidecarPath, '')
    writeFileSync(targetPath, 'outside gate journal')
    cacheLocationTestHooks.afterDatabaseOpen = database => {
      if (database.name === 'operation-lock.sqlite' && !existsSync(sidecarPath)) {
        writeFileSync(sidecarPath, '')
      }
    }
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        renameSync(sidecarPath, displacedPath)
        symlinkSync(targetPath, sidecarPath)
      }
    }

    assertCacheLayoutRejected(() => withOperationLock(root, () => 'entered'))
    assert.equal(readFileSync(targetPath, 'utf8'), 'outside gate journal')
  })

  test('rejects an uncoordinated gate replacement while acquisition is serialised', {
    skip: process.platform === 'win32' ? 'Windows does not permit renaming an open SQLite database.' : false,
  }, () => {
    const root = createRoot()
    withOperationLock(root, () => 'prepared')
    const gatePath = join(cacheDirectoryPath(root), 'operation-lock.sqlite')
    const displacedPath = join(root, 'displaced-operation-lock.sqlite')
    const replacementPath = join(root, 'replacement-operation-lock.sqlite')
    const replacement = new DatabaseSync(replacementPath)
    replacement.close()
    const replacementIdentity = statSync(replacementPath, { bigint: true })
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        renameSync(gatePath, displacedPath)
        renameSync(replacementPath, gatePath)
      }
    }

    assert.throws(
      () => withOperationLock(root, () => 'entered'),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
          invariant: 'stable-identity',
        })
        return true
      },
    )
    assert.equal(sameCacheEntryIdentity(replacementIdentity, statSync(gatePath, { bigint: true })), true)
    assert.equal(statSync(displacedPath).isFile(), true)
  })

  test('preserves post-BEGIN repository-change precedence for a hard-linked gate replacement', {
    skip: process.platform === 'win32' ? 'Windows does not permit renaming an open SQLite database.' : hardLinkSkip,
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const gatePath = join(cacheDirectoryPath(root), 'operation-lock.sqlite')
    const displacedPath = join(root, 'post-begin-displaced-operation-lock.sqlite')
    const successorPath = join(root, 'post-begin-successor-operation-lock.sqlite')
    const alias = join(outside, 'post-begin-operation-lock-alias.sqlite')
    copyFileSync(gatePath, successorPath)
    linkSync(successorPath, alias)
    const before = readFileSync(successorPath)
    let operationEntered = false
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        renameSync(gatePath, displacedPath)
        renameSync(successorPath, gatePath)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
          invariant: 'stable-identity',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.deepEqual(readFileSync(gatePath), before)
    assert.deepEqual(readFileSync(alias), before)
    assert.equal(existsSync(displacedPath), true)
  })

  test('preserves post-BEGIN repository-change precedence for a hard-linked gate journal successor', {
    skip:
      process.platform === 'win32' ? 'Windows does not permit renaming an open SQLite rollback journal.' : hardLinkSkip,
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const sidecarPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
    const displacedPath = join(root, 'post-begin-displaced-operation-lock.sqlite-journal')
    const successorPath = join(root, 'post-begin-successor-operation-lock.sqlite-journal')
    const alias = join(outside, 'post-begin-operation-lock-journal-alias')
    writeFileSync(sidecarPath, '')
    writeFileSync(successorPath, 'hard-linked gate journal successor')
    linkSync(successorPath, alias)
    const before = readFileSync(successorPath)
    let operationEntered = false
    cacheLocationTestHooks.afterDatabaseOpen = database => {
      if (database.name === 'operation-lock.sqlite' && !existsSync(sidecarPath)) {
        writeFileSync(sidecarPath, '')
      }
    }
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        renameSync(sidecarPath, displacedPath)
        renameSync(successorPath, sidecarPath)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite-journal',
          invariant: 'stable-identity',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.deepEqual(readFileSync(sidecarPath), before)
    assert.deepEqual(readFileSync(alias), before)
    assert.equal(existsSync(displacedPath), true)
  })

  test('preserves a same-generation hard-linked gate journal after the transaction begins', {
    skip:
      process.platform === 'win32' ? 'Windows does not permit linking an open SQLite rollback journal.' : hardLinkSkip,
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const sidecarPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
    const alias = join(outside, 'post-begin-same-generation-journal-alias')
    writeFileSync(sidecarPath, '')
    let aliasedBytes: Buffer | undefined
    let databaseOpens = 0
    let operationEntered = false
    cacheLocationTestHooks.afterDatabaseOpen = database => {
      if (database.name === 'operation-lock.sqlite') {
        databaseOpens += 1
        if (!existsSync(sidecarPath)) {
          writeFileSync(sidecarPath, '')
        }
      }
    }
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        aliasedBytes = readFileSync(sidecarPath)
        linkSync(sidecarPath, alias)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite-journal',
          invariant: 'single-link-file',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.notEqual(aliasedBytes, undefined)
    assert.deepEqual(readFileSync(sidecarPath), aliasedBytes)
    assert.deepEqual(readFileSync(alias), aliasedBytes)

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
          invariant: 'stable-identity',
        })
        return true
      },
    )
    assert.equal(databaseOpens, 1)
    assert.equal(operationEntered, false)
  })

  test('retains a gate journal hard-linked by a successful operation callback', {
    skip:
      process.platform === 'win32' ? 'Windows does not permit linking an open SQLite rollback journal.' : hardLinkSkip,
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const sidecarPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
    const alias = join(outside, 'successful-operation-lock-journal-alias')
    let aliasIntroduced = false
    let callbackEntries = 0
    let journalBytes: Buffer | undefined
    const cleanup = observeDatabaseCleanupAttempts(() => aliasIntroduced)

    try {
      assert.throws(
        () =>
          withOperationLock(root, () => {
            callbackEntries += 1
            if (!existsSync(sidecarPath)) {
              writeFileSync(sidecarPath, '')
            }
            journalBytes = readFileSync(sidecarPath)
            linkSync(sidecarPath, alias)
            aliasIntroduced = true
            return 'entered'
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: 'node_modules/.cache/encephalon/operation-lock.sqlite-journal',
            invariant: 'single-link-file',
          })
          assert.equal(causeChainText(error).includes(outside), false)
          return true
        },
      )
      assert.equal(callbackEntries, 1)
      assert.notEqual(journalBytes, undefined)
      assert.deepEqual(cleanup.attempts, { close: 0, rollback: 0 })
      assert.deepEqual(readFileSync(sidecarPath), journalBytes)
      assert.deepEqual(readFileSync(alias), journalBytes)

      assert.throws(
        () =>
          withOperationLock(root, () => {
            callbackEntries += 1
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
            invariant: 'stable-identity',
          })
          return true
        },
      )
      assert.equal(callbackEntries, 1)
      assert.deepEqual(cleanup.attempts, { close: 0, rollback: 0 })
      assert.deepEqual(readFileSync(sidecarPath), journalBytes)
      assert.deepEqual(readFileSync(alias), journalBytes)
    } finally {
      cleanup.restore()
    }
  })

  test('rechecks the gate primary after observing sidecars for close safety', { skip: hardLinkSkip }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const databasePath = join(cacheDirectoryPath(root), 'operation-lock.sqlite')
    const alias = join(outside, 'close-proof-operation-lock-alias')
    const before = readFileSync(databasePath)
    let aliasIntroduced = false
    const cleanup = observeDatabaseCleanupAttempts(() => aliasIntroduced)

    try {
      assert.throws(
        () =>
          withOperationLock(root, () => {
            cacheLocationTestHooks.regularFileRealpath = (path, actual) => {
              if (!aliasIntroduced && basename(path) === 'operation-lock.sqlite-journal') {
                linkSync(databasePath, alias)
                aliasIntroduced = true
              }
              return actual
            }
            return 'entered'
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
          assert.deepEqual((error as { details?: unknown }).details, {
            entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
            invariant: 'single-link-file',
          })
          assert.equal(causeChainText(error).includes(outside), false)
          return true
        },
      )
      assert.equal(aliasIntroduced, true)
      assert.deepEqual(cleanup.attempts, { close: 0, rollback: 0 })
      assert.deepEqual(readFileSync(databasePath), before)
      assert.deepEqual(readFileSync(alias), before)
    } finally {
      cleanup.restore()
    }
  })

  test('preserves a proof-only gate close inspection failure', () => {
    const root = createRoot()
    withOperationLock(root, () => 'prepared')
    let primaryObservations = 0
    const cleanup = observeDatabaseCleanupAttempts(() => true)

    try {
      assert.throws(
        () =>
          withOperationLock(root, () => {
            cacheLocationTestHooks.regularFileRealpath = (path, actual) => {
              if (basename(path) === 'operation-lock.sqlite') {
                primaryObservations += 1
                if (primaryObservations === 2) {
                  throw Object.assign(new Error('Injected final close-proof inspection failure.'), {
                    code: 'EACCES',
                  })
                }
              }
              return actual
            }
            return 'entered'
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
          assert.equal(causeChainText(error).includes('Injected final close-proof inspection failure.'), true)
          return true
        },
      )
      assert.equal(primaryObservations, 2)
      assert.deepEqual(cleanup.attempts, { close: 0, rollback: 0 })
    } finally {
      cleanup.restore()
    }
  })

  test('preserves a hard-linked gate journal successor when the gate primary is also hard linked', {
    skip:
      process.platform === 'win32' ? 'Windows does not permit renaming an open SQLite rollback journal.' : hardLinkSkip,
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const gatePath = join(cacheDirectoryPath(root), 'operation-lock.sqlite')
    const primaryAlias = join(outside, 'post-begin-combined-gate-alias.sqlite')
    const sidecarPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
    const displacedPath = join(root, 'post-begin-combined-displaced-journal')
    const successorPath = join(root, 'post-begin-combined-successor-journal')
    const sidecarAlias = join(outside, 'post-begin-combined-journal-alias')
    writeFileSync(sidecarPath, '')
    writeFileSync(successorPath, 'hard-linked combined gate journal successor')
    linkSync(successorPath, sidecarAlias)
    const primaryBefore = readFileSync(gatePath)
    const sidecarBefore = readFileSync(successorPath)
    let operationEntered = false
    cacheLocationTestHooks.afterDatabaseOpen = database => {
      if (database.name === 'operation-lock.sqlite' && !existsSync(sidecarPath)) {
        writeFileSync(sidecarPath, '')
      }
    }
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        linkSync(gatePath, primaryAlias)
        renameSync(sidecarPath, displacedPath)
        renameSync(successorPath, sidecarPath)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
          invariant: 'single-link-file',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.deepEqual(readFileSync(gatePath), primaryBefore)
    assert.deepEqual(readFileSync(primaryAlias), primaryBefore)
    assert.deepEqual(readFileSync(sidecarPath), sidecarBefore)
    assert.deepEqual(readFileSync(sidecarAlias), sidecarBefore)
    assert.equal(existsSync(displacedPath), true)
  })

  test('preserves a redirected hard-linked gate journal after the transaction begins', {
    skip:
      process.platform === 'win32'
        ? 'Windows does not permit replacing a cache directory containing an open SQLite database.'
        : hardLinkSkip ||
          (renameParentWithOpenChildSupported ? false : 'The filesystem cannot rename an open cache directory.'),
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const cachePath = cacheDirectoryPath(root)
    const displacedCachePath = join(root, 'post-begin-redirected-cache')
    const sidecarPath = join(outside, 'operation-lock.sqlite-journal')
    const alias = join(outside, 'redirected-operation-lock-journal-alias')
    writeFileSync(sidecarPath, 'redirected hard-linked gate journal')
    linkSync(sidecarPath, alias)
    const before = readFileSync(sidecarPath)
    let databaseOpens = 0
    let operationEntered = false
    cacheLocationTestHooks.afterDatabaseOpen = database => {
      if (database.name === 'operation-lock.sqlite') {
        databaseOpens += 1
      }
    }
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        renameSync(cachePath, displacedCachePath)
        symlinkSync(outside, cachePath, 'dir')
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon',
          invariant: 'real-directory',
        })
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.deepEqual(readFileSync(sidecarPath), before)
    assert.deepEqual(readFileSync(alias), before)

    rmSync(cachePath)
    renameSync(displacedCachePath, cachePath)
    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
          invariant: 'stable-identity',
        })
        return true
      },
    )
    assert.equal(databaseOpens, 1)
    assert.equal(operationEntered, false)
    assert.deepEqual(readFileSync(sidecarPath), before)
    assert.deepEqual(readFileSync(alias), before)
  })

  test('preserves a hard-linked gate journal when close-safety inspection throws', {
    skip:
      process.platform === 'win32' ? 'Windows does not permit linking an open SQLite rollback journal.' : hardLinkSkip,
  }, () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    withOperationLock(root, () => 'prepared')
    const location = inspectCacheLocation(root)
    const snapshot = inspectCacheDatabase(location, 'operation-lock.sqlite')
    assert.ok(snapshot)
    const sidecarPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
    const alias = join(outside, 'inspection-failure-journal-alias')
    writeFileSync(sidecarPath, '')
    let aliasedBytes: Buffer | undefined
    cacheLocationTestHooks.afterDatabaseOpen = database => {
      if (database.name === 'operation-lock.sqlite' && !existsSync(sidecarPath)) {
        writeFileSync(sidecarPath, '')
      }
    }
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        aliasedBytes = readFileSync(sidecarPath)
        linkSync(sidecarPath, alias)
        cacheLocationTestHooks.regularFileRealpath = (path, actual) => {
          if (basename(path) === 'operation-lock.sqlite-journal') {
            throw Object.assign(new Error('Injected close-safety inspection failure.'), {
              code: 'EACCES',
            })
          }
          return actual
        }
      }
    }

    assert.throws(
      () =>
        openVerifiedCacheDatabase({
          afterVerifiedOpen: database => {
            database.exec('BEGIN IMMEDIATE')
          },
          DatabaseConstructor: DatabaseSync,
          location,
          name: 'operation-lock.sqlite',
          openOptions: {},
          preserveDatabaseLocksAfterInitialisation: true,
          primary: { database: snapshot, kind: 'expected-owned' },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'EACCES')
        assert.equal(causeChainText(error).includes('Injected close-safety inspection failure.'), true)
        assert.equal(causeChainText(error).includes(outside), false)
        return true
      },
    )
    assert.notEqual(aliasedBytes, undefined)
    assert.deepEqual(readFileSync(sidecarPath), aliasedBytes)
    assert.deepEqual(readFileSync(alias), aliasedBytes)
  })

  test('bounds retained database opens after repeated post-BEGIN hard-linked journal observations', {
    skip:
      process.platform === 'win32' ? 'Windows does not permit linking an open SQLite rollback journal.' : hardLinkSkip,
  }, () => {
    const entries = Array.from({ length: 5 }, (_, index) => {
      const root = createRoot()
      const outside = createOutsideDirectory()
      withOperationLock(root, () => 'prepared')
      const sidecarPath = join(cacheDirectoryPath(root), 'operation-lock.sqlite-journal')
      writeFileSync(sidecarPath, '')
      return {
        alias: join(outside, `bounded-journal-alias-${index}`),
        root,
        sidecarPath,
      }
    })
    const repeatedAlias = join(createOutsideDirectory(), 'bounded-journal-repeated-alias')
    let databaseOpens = 0
    let linkTriggers = 0
    let operationEntries = 0
    const trigger = (entry: (typeof entries)[number], alias: string) => {
      cacheLocationTestHooks.afterDatabaseOpen = database => {
        if (database.name === 'operation-lock.sqlite') {
          databaseOpens += 1
          if (!existsSync(entry.sidecarPath)) {
            writeFileSync(entry.sidecarPath, '')
          }
        }
      }
      cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
        if (database.name === 'operation-lock.sqlite') {
          linkTriggers += 1
          linkSync(entry.sidecarPath, alias)
        }
      }
      assert.throws(
        () =>
          withOperationLock(entry.root, () => {
            operationEntries += 1
          }),
        (error: unknown) => {
          assert.equal(
            ['REPOSITORY_CHANGED', 'VALIDATION_FAILED'].includes(String((error as { code?: unknown }).code)),
            true,
          )
          return true
        },
      )
    }

    const [firstEntry] = entries
    assert.ok(firstEntry)
    trigger(firstEntry, firstEntry.alias)
    trigger(firstEntry, repeatedAlias)
    for (const entry of entries.slice(1)) {
      trigger(entry, entry.alias)
    }

    assert.equal(databaseOpens, 4)
    assert.equal(linkTriggers, 4)
    assert.equal(operationEntries, 0)
    assert.equal(existsSync(repeatedAlias), false)
    for (const entry of entries.slice(0, 4)) {
      assert.deepEqual(readFileSync(entry.sidecarPath), readFileSync(entry.alias))
    }
  })

  test('rejects an uncoordinated gate successor after exact corrupt quarantine', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const gatePath = join(cachePath, 'operation-lock.sqlite')
    const replacementPath = join(root, 'replacement-operation-lock.sqlite')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(gatePath, 'not a sqlite database')
    const replacement = new DatabaseSync(replacementPath)
    replacement.close()
    const replacementIdentity = statSync(replacementPath, { bigint: true })
    let operationEntered = false
    cacheLocationTestHooks.afterQuarantineRename = path => {
      if (basename(path).startsWith('.operation-lock.sqlite.')) {
        cacheLocationTestHooks.afterQuarantineRename = undefined
        renameSync(replacementPath, gatePath)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
          invariant: 'stable-identity',
        })
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(sameCacheEntryIdentity(replacementIdentity, statSync(gatePath, { bigint: true })), true)
  })

  test('carries the locked cache location through add-record hydration', {
    skip:
      process.platform === 'win32'
        ? 'Windows does not permit renaming a directory containing the open operation gate.'
        : false,
  }, () => {
    const root = createRoot()
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    const cachePath = cacheDirectoryPath(root)
    const displacedPath = `${cachePath}-before-add-hydration`
    recordWriteTestHooks.fault = point => {
      if (point === 'during-hydration') {
        recordWriteTestHooks.fault = undefined
        renameSync(cachePath, displacedPath)
        mkdirSync(cachePath)
        writeFileSync(join(cachePath, 'replacement-sentinel'), 'replacement cache')
      }
    }

    assert.throws(
      () =>
        functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
          id: 'locked-location-hydration',
          kind: 'context',
          payload: null,
          root,
          source: 'agent',
          subject: 'cache.location',
        }),
      (error: unknown) => {
        assert.equal((error as { details?: { postCommitPhase?: unknown } }).details?.postCommitPhase, 'cacheHydration')
        assert.equal(((error as Error).cause as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.deepEqual(readdirSync(cachePath), ['replacement-sentinel'])
  })

  test('rejects a locked cache replacement before canonical record publication', {
    skip: renameParentWithOpenChildSupported ? false : 'The filesystem cannot rename an open cache directory.',
  }, () => {
    const root = createRoot()
    functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
    const cachePath = inspectCacheLocation(root).directory
    const displacedPath = `${cachePath}-before-record-publication`
    recordWriteTestHooks.fault = point => {
      if (point === 'after-scan-validation') {
        renameSync(cachePath, displacedPath)
        mkdirSync(cachePath)
        writeFileSync(join(cachePath, 'replacement-sentinel'), 'replacement cache')
      }
    }

    assert.throws(
      () =>
        functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
          id: 'locked-location-before-publication',
          kind: 'context',
          payload: null,
          root,
          source: 'agent',
          subject: 'cache.location-before-publication',
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(existsSync(join(root, 'encephalon', 'context', 'locked-location-before-publication.json')), false)
  })

  test('rejects an operation gate database symlink without changing its target', () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    const target = join(outside, 'gate-target')
    mkdirSync(cacheDirectoryPath(root), { recursive: true })
    writeFileSync(target, 'outside gate bytes')
    symlinkSync(target, join(cacheDirectoryPath(root), 'operation-lock.sqlite'))

    assertCacheLayoutRejected(() => withOperationLock(root, () => 'entered'))
    assert.equal(readFileSync(target, 'utf8'), 'outside gate bytes')
  })

  test('rejects an operation gate sidecar symlink without changing its target', () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    const target = join(outside, 'gate-wal-target')
    mkdirSync(cacheDirectoryPath(root), { recursive: true })
    writeFileSync(target, 'outside gate wal bytes')
    symlinkSync(target, join(cacheDirectoryPath(root), 'operation-lock.sqlite-wal'))

    assertCacheLayoutRejected(() => withOperationLock(root, () => 'entered'))
    assert.equal(readFileSync(target, 'utf8'), 'outside gate wal bytes')
  })

  test('rejects an operation lock directory symlink without changing its target', () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    mkdirSync(cacheDirectoryPath(root), { recursive: true })
    writeFileSync(join(outside, 'sentinel'), 'outside lock')
    symlinkSync(
      outside,
      join(cacheDirectoryPath(root), 'operation.lock'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    assertCacheLayoutRejected(() => withOperationLock(root, () => 'entered'))
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside lock')
  })

  test('rejects an operation gate recovery symlink without changing its target', () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    mkdirSync(cacheDirectoryPath(root), { recursive: true })
    writeFileSync(join(outside, 'sentinel'), 'outside recovery')
    symlinkSync(
      outside,
      join(cacheDirectoryPath(root), 'operation-lock.recovery'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    assertCacheLayoutRejected(() => withOperationLock(root, () => 'entered'))
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside recovery')
  })

  test('ignores an unrelated operation lock candidate symlink without changing its target', () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    mkdirSync(cacheDirectoryPath(root), { recursive: true })
    writeFileSync(join(outside, 'sentinel'), 'outside candidate')
    symlinkSync(
      outside,
      join(cacheDirectoryPath(root), 'operation.lock.00000000-0000-4000-8000-000000000000'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const linkPath = join(cacheDirectoryPath(root), 'operation.lock.00000000-0000-4000-8000-000000000000')
    const before = lstatSync(linkPath, { bigint: true })

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside candidate')
    const after = lstatSync(linkPath, { bigint: true })
    assert.equal(after.isSymbolicLink(), true)
    assert.equal(after.dev, before.dev)
    assert.equal(after.ino, before.ino)
  })
})

describe('SQLite cache and reads', () => {
  const canonicalCacheEquivalenceCases = [
    {
      assertResult: (root: string, canonical: BrainRecord) => {
        assert.deepEqual(api.prepare({ root }), { hydrated: true, recordsIndexed: 1 })
        const cached = logicalCacheProjection(root).records[0]?.record_json
        assert.equal(typeof cached, 'string')
        assert.deepEqual(JSON.parse(cached as string), canonical)
      },
      name: 'prepare',
    },
    {
      assertResult: (root: string, canonical: BrainRecord) => {
        assert.deepEqual(api.listRecords({ root }), [canonical])
      },
      name: 'list',
    },
    {
      assertResult: (root: string, canonical: BrainRecord) => {
        assert.deepEqual(api.showRecord({ id: canonical.id, root }), canonical)
      },
      name: 'show',
    },
    {
      assertResult: (root: string, canonical: BrainRecord) => {
        assert.deepEqual(api.searchRecords({ query: 'cache corruption marker', root }), [canonical])
      },
      name: 'full search',
    },
    {
      assertResult: (root: string, canonical: BrainRecord) => {
        const records = api.searchCompactRecords({ query: 'cache corruption marker', root })
        assert.deepEqual(
          records.map(record => ({ id: record.id, subject: record.subject })),
          [{ id: canonical.id, subject: canonical.subject }],
        )
      },
      name: 'compact search',
    },
    {
      assertResult: (root: string, canonical: BrainRecord) => {
        const gathered = api.gatherRecords({
          root,
          searches: ['cache corruption marker'],
          shows: [canonical.id],
        })
        assert.deepEqual(gathered.records[0], { id: canonical.id, record: canonical })
        const [search] = gathered.searches
        assert.ok(search)
        assert.deepEqual(
          search.results.map(record => record.id),
          [canonical.id],
        )
      },
      name: 'gather',
    },
  ] as const

  for (const entry of canonicalCacheEquivalenceCases) {
    test(`rebuilds an internally consistent forged cache corpus before ${entry.name}`, () => {
      const root = createRoot()
      const canonical = installInternallyConsistentForgedCacheRecord(root)

      entry.assertResult(root, canonical)

      assert.equal(
        logicalCacheProjection(root).records.some(record => record.id === 'invented-cache-record'),
        false,
      )
    })
  }

  test('rebuilds an equal-count cache corpus that omits canonical knowledge and invents a replacement', () => {
    const root = createRoot()
    const canonical = addCacheRecord(root)
    overwriteCacheWithInternallyConsistentForgery(root, canonical, { replaceIdentity: true })

    assert.deepEqual(api.prepare({ root }), { hydrated: true, recordsIndexed: 1 })
    assert.deepEqual(api.listRecords({ root }), [canonical])
    assert.equal(
      logicalCacheProjection(root).records.some(record => record.id === 'invented-cache-record'),
      false,
    )
  })

  test('does not rebuild a logically identical cache whose physical row order changes', () => {
    const root = createRoot()
    const first = addCacheRecord(root)
    const second = api.addRecord({
      id: 'cache-record-two',
      kind: 'context',
      payload: { detail: 'second cache record', summary: 'Second cache record' },
      root,
      searchText: 'second cache marker',
      source: 'agent',
      subject: 'cache.validation.two',
    })
    const before = logicalCacheProjection(root)
    mutateCache(root, database => {
      const records = database
        .prepare(
          'SELECT id, kind, subject, source, created_at, path, active, summary, record_json FROM records ORDER BY rowid',
        )
        .all() as Array<{
        active: number
        created_at: string
        id: string
        kind: string
        path: string
        record_json: string
        source: string
        subject: string
        summary: string | null
      }>
      const search = database.prepare('SELECT id, text FROM record_search ORDER BY rowid').all() as Array<{
        id: string
        text: string
      }>
      database.exec('BEGIN IMMEDIATE; DELETE FROM record_search; DELETE FROM records;')
      const insertRecord = database.prepare(`
        INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertSearch = database.prepare('INSERT INTO record_search(id, text) VALUES (?, ?)')
      for (const row of records.reverse()) {
        insertRecord.run(
          row.id,
          row.kind,
          row.subject,
          row.source,
          row.created_at,
          row.path,
          row.active,
          row.summary,
          row.record_json,
        )
      }
      for (const row of search.reverse()) {
        insertSearch.run(row.id, row.text)
      }
      database.exec('COMMIT')
    })
    let rebuilds = 0
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      rebuilds += 1
    }

    assert.deepEqual(
      api.listRecords({ root }).map(record => record.id),
      [second.id, first.id],
    )
    assert.equal(rebuilds, 0)
    assert.deepEqual(logicalCacheProjection(root), before)
  })

  test('fails closed when canonical JSON changes after cache equality validation', () => {
    const root = createRoot()
    const canonical = addCacheRecord(root)
    const canonicalPath = join(root, ...canonical.path.split('/'))
    let served = 0
    cacheReadTestHooks.afterCanonicalCacheEqualityValidation = () => {
      cacheReadTestHooks.afterCanonicalCacheEqualityValidation = undefined
      const current = JSON.parse(readFileSync(canonicalPath, 'utf8')) as BrainRecord
      writeFileSync(
        canonicalPath,
        `${JSON.stringify({ ...current, payload: { summary: 'Changed after equality' } }, null, 2)}\n`,
      )
    }

    assert.throws(
      () => {
        served = api.listRecords({ root }).length
      },
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(served, 0)
    const [current] = api.listRecords({ root })
    assert.ok(current)
    assert.deepEqual((current.payload as { summary?: unknown }).summary, 'Changed after equality')
  })

  test('allows only one rebuild when canonical cache equivalence fails repeatedly', () => {
    const root = createRoot()
    const canonical = addCacheRecord(root)
    overwriteCacheWithInternallyConsistentForgery(root, canonical)
    let rebuilds = 0
    let served = 0
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      rebuilds += 1
      overwriteCacheWithInternallyConsistentForgery(root, canonical)
    }

    assert.throws(
      () => {
        served = api.listRecords({ root }).length
      },
      (error: unknown) => {
        assert.ok(
          (error as { code?: unknown }).code === 'IO_ERROR' || (error as { code?: unknown }).code === 'INTERNAL_ERROR',
        )
        assert.equal(causeChainText(error).includes('invented disposable cache knowledge'), false)
        assert.equal(causeChainText(error).includes(root), false)
        return true
      },
    )
    assert.equal(rebuilds, 1)
    assert.equal(served, 0)
  })

  test('preserves stable canonical validation failures after a transient rebuild race', () => {
    const root = createRoot()
    const canonical = addCacheRecord(root)
    const canonicalPath = join(root, ...canonical.path.split('/'))
    overwriteCacheWithInternallyConsistentForgery(root, canonical)
    cacheReadTestHooks.beforeCacheSnapshotCommit = () => {
      cacheReadTestHooks.beforeCacheSnapshotCommit = undefined
      writeFileSync(canonicalPath, '{}\n')
      return 'repository-changed'
    }

    assert.throws(
      () => api.listRecords({ root }),
      (error: unknown) => {
        const typed = error as {
          code?: unknown
          details?: { errors?: Array<{ code?: unknown }> }
        }
        assert.equal(typed.code, 'VALIDATION_FAILED')
        assert.equal(
          typed.details?.errors?.some(validationIssue => validationIssue.code === 'INVALID_RECORD'),
          true,
        )
        return true
      },
    )
  })

  test('reuses the rebuilt canonical snapshot for the final proven read', () => {
    const root = createRoot()
    const canonical = addCacheRecord(root)
    overwriteCacheWithInternallyConsistentForgery(root, canonical)
    let canonicalScans = 0
    cacheReadTestHooks.recordReadHooks = {
      canonicalScan: () => {
        canonicalScans += 1
      },
    }

    assert.deepEqual(api.listRecords({ root }), [canonical])
    assert.equal(canonicalScans, 2)
  })

  test('rejects invalid public API inputs before repository side effects', () => {
    const accessorEnvelope = (root: string, fields: Record<string, unknown> = {}) => {
      const input = { ...fields, root }
      Object.defineProperty(input, 'unknownAccessor', {
        enumerable: true,
        get: () => {
          throw new Error('hostile input secret')
        },
      })
      return input
    }
    const cases: [string, (root: string) => void][] = [
      [
        'prepare accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')(accessorEnvelope(root))
        },
      ],
      [
        'prepare unknown envelope field',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({
            root,
            unknownData: true,
          })
        },
      ],
      [
        'hydrate accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')(accessorEnvelope(root))
        },
      ],
      [
        'validate accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('validateRecords')(accessorEnvelope(root))
        },
      ],
      [
        'list accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')(accessorEnvelope(root))
        },
      ],
      [
        'show accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('showRecord')(
            accessorEnvelope(root, { id: 'record-1' }),
          )
        },
      ],
      [
        'full search accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('searchRecords')(
            accessorEnvelope(root, { query: 'safe' }),
          )
        },
      ],
      [
        'compact search accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('searchCompactRecords')(
            accessorEnvelope(root, { query: 'safe' }),
          )
        },
      ],
      [
        'gather accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')(accessorEnvelope(root))
        },
      ],
      [
        'add accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')(
            accessorEnvelope(root, {
              kind: 'context',
              payload: null,
              source: 'agent',
              subject: 'cache.validation',
            }),
          )
        },
      ],
      [
        'init accessor envelope',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('initEncephalon')(accessorEnvelope(root))
        },
      ],
      [
        'gather sparse searches',
        root => {
          const searches = new Array<string>(2)
          searches[1] = 'ignored'
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            root,
            searches,
          })
        },
      ],
      [
        'gather sparse shows',
        root => {
          const shows = new Array<string>(2)
          shows[1] = 'record-2'
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            root,
            shows,
          })
        },
      ],
      [
        'add sparse supersedes',
        root => {
          const supersedes = new Array<string>(2)
          supersedes[1] = 'record-2'
          functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
            kind: 'context',
            payload: null,
            root,
            source: 'agent',
            subject: 'cache.validation',
            supersedes,
          })
        },
      ],
      [
        'add sparse artifacts',
        root => {
          const artifacts = new Array<string>(2)
          artifacts[1] = '_artifacts/context/record-1/file.txt'
          functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
            artifacts,
            id: 'record-1',
            kind: 'context',
            payload: null,
            root,
            source: 'agent',
            subject: 'cache.validation',
          })
        },
      ],
      [
        'list includeSuperseded',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({
            includeSuperseded: 'yes',
            root,
          })
        },
      ],
      [
        'list limit',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({
            limit: 0,
            root,
          })
        },
      ],
      [
        'show id',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('showRecord')({
            id: '../bad',
            root,
          })
        },
      ],
      [
        'show activeOnly',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('showRecord')({
            activeOnly: 'yes',
            id: 'record-1',
            root,
          })
        },
      ],
      [
        'search query',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('searchRecords')({
            query: 42,
            root,
          })
        },
      ],
      [
        'search kind',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('searchCompactRecords')({
            kind: '../bad',
            query: 'safe',
            root,
          })
        },
      ],
      [
        'gather hydrate searches',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            hydrate: true,
            root,
            searches: 'safe',
          })
        },
      ],
      [
        'gather show id',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            root,
            shows: ['../bad'],
          })
        },
      ],
      [
        'add kind',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
            kind: '../bad',
            payload: null,
            root,
            source: 'agent',
            subject: 'cache.validation',
          })
        },
      ],
      [
        'add root',
        () => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
            kind: 'context',
            payload: null,
            root: 123,
            source: 'agent',
            subject: 'cache.validation',
          })
        },
      ],
      [
        'init booleans',
        root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('initEncephalon')({
            refreshBaseline: 'yes',
            root,
          })
        },
      ],
    ]

    for (const [name, action] of cases) {
      const root = createRoot()
      assert.throws(
        () => action(root),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'INVALID_ARGUMENT', name)
          return true
        },
      )
      assert.equal(existsSync(join(root, 'node_modules', '.cache', 'encephalon')), false, name)
      assert.equal(existsSync(join(root, 'encephalon')), false, name)
      assert.equal(existsSync(join(root, 'AGENTS.md')), false, name)
      assert.equal(existsSync(join(root, 'CLAUDE.md')), false, name)
    }
  })

  test('wraps cache-location filesystem failures from prepared reads and gathers', () => {
    const cases = [
      ['list', (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ root })],
      [
        'gather',
        (root: string) =>
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            root,
            searches: [],
          }),
      ],
    ] as const

    for (const [name, operation] of cases) {
      const root = createRoot()
      cacheLocationTestHooks.beforeLocationInspection = () => {
        throw Object.assign(new Error('Injected cache location inspection failure.'), {
          code: 'EACCES',
        })
      }
      try {
        assert.throws(
          () => operation(root),
          (error: unknown) => {
            assert.equal((error as { code?: unknown }).code, 'IO_ERROR', name)
            assert.equal(JSON.stringify(error).includes(root), false, name)
            return true
          },
        )
      } finally {
        cacheLocationTestHooks.beforeLocationInspection = undefined
      }
    }
  })

  test('prepares an empty repository before a cache directory exists', () => {
    const root = createRoot()
    const prepare =
      functionFromApi<
        (input: Record<string, unknown>) => {
          hydrated: boolean
          recordsIndexed: number
        }
      >('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('does not create a cache when canonical root enumeration overflows', () => {
    const root = createRoot()
    for (const index of Array.from({ length: 1003 }, (_, value) => value)) {
      mkdirSync(join(root, 'encephalon', `kind-${String(index).padStart(4, '0')}`), {
        recursive: true,
      })
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown
          details?: { errors?: Array<{ code?: unknown }> }
        }
        assert.equal(actual.code, 'VALIDATION_FAILED')
        assert.equal(actual.details?.errors?.[0]?.code, 'CORPUS_DIRECTORY_ENTRY_LIMIT')
        return true
      },
    )
    assert.equal(existsSync(cacheDatabasePath(root)), false)
  })

  test('classifies a manifest directory overflow after validation as repository change', () => {
    const root = createRoot()
    const kindDirectory = join(root, 'encephalon', 'decision')
    mkdirSync(kindDirectory, { recursive: true })
    writeFileSync(
      join(kindDirectory, 'stable.json'),
      `${JSON.stringify({
        createdAt: '2026-08-06T10:00:00.000Z',
        id: 'stable',
        kind: 'decision',
        payload: {},
        source: 'test',
        subject: 'cache.manifest-bound',
      })}\n`,
    )
    let mutated = false
    cacheReadTestHooks.afterCanonicalValidation = () => {
      if (!mutated) {
        mutated = true
        for (const index of Array.from({ length: 1000 }, (_, value) => value)) {
          writeFileSync(join(kindDirectory, `extra-${String(index).padStart(4, '0')}`), '')
        }
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(existsSync(cacheDatabasePath(root)), false)
  })

  test('ignores transient staging contents in canonical validation and cache freshness', () => {
    const root = createRoot()
    const stagingDirectory = join(root, 'encephalon', '_staging')
    mkdirSync(stagingDirectory, { recursive: true })
    for (const index of Array.from({ length: 1001 }, (_, value) => value)) {
      writeFileSync(join(stagingDirectory, `temporary-${String(index).padStart(4, '0')}`), '')
    }

    assert.equal(api.validateRecords({ root }).valid, true)
    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 0,
    })
    writeFileSync(join(stagingDirectory, 'after-prepare'), '')
    const fixedTime = new Date('2025-01-02T03:04:05.000Z')
    utimesSync(stagingDirectory, fixedTime, fixedTime)
    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: false,
      recordsIndexed: 0,
    })
  })

  test('retries record disappearance before final canonical witness validation', () => {
    const root = createRoot()
    const recordPath = join(realpathSync.native(root), 'encephalon', 'context', 'manifest-disappearance.json')
    ensureParent(recordPath)
    writeFileSync(
      recordPath,
      `${JSON.stringify({
        createdAt: '2026-08-12T00:00:00.000Z',
        id: 'manifest-disappearance',
        kind: 'context',
        payload: {},
        source: 'test',
        subject: 'cache.manifest-disappearance',
      })}\n`,
    )
    let removed = false
    cacheReadTestHooks.recordReadHooks = {
      beforeFinalWitnessValidation: () => {
        if (!removed) {
          removed = true
          rmSync(recordPath)
        }
      },
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 0,
    })
    assert.equal(removed, true)
  })

  test('does not follow a missing-target link replacement before final canonical validation', () => {
    const root = createRoot()
    const recordPath = join(realpathSync.native(root), 'encephalon', 'context', 'manifest-symlink.json')
    ensureParent(recordPath)
    writeFileSync(
      recordPath,
      `${JSON.stringify({
        createdAt: '2026-08-12T00:00:00.000Z',
        id: 'manifest-symlink',
        kind: 'context',
        payload: {},
        source: 'test',
        subject: 'cache.manifest-symlink',
      })}\n`,
    )
    const missingTarget = join(root, 'missing-manifest-target')
    let replaced = false
    cacheReadTestHooks.recordReadHooks = {
      beforeFinalWitnessValidation: () => {
        if (!replaced) {
          replaced = true
          rmSync(recordPath)
          symlinkSync(missingTarget, recordPath, process.platform === 'win32' ? 'junction' : 'file')
        }
      },
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.equal(JSON.stringify(error).includes(missingTarget), false)
        return true
      },
    )
    assert.equal(replaced, true)
  })

  test('classifies a kind ancestor replacement during canonical witness validation as repository change', () => {
    const root = createRoot()
    const canonicalRoot = realpathSync.native(root)
    const kindDirectory = join(canonicalRoot, 'encephalon', 'decision')
    const preservedKindDirectory = join(canonicalRoot, 'preserved-decision-kind')
    const outside = createOutsideDirectory()
    const sentinel = join(outside, 'outside-sentinel.txt')
    mkdirSync(kindDirectory, { recursive: true })
    writeFileSync(sentinel, 'outside kind sentinel')
    utimesSync(kindDirectory, new Date('2025-01-02T03:04:05.000Z'), new Date('2025-01-02T03:04:05.000Z'))
    utimesSync(outside, new Date('2024-02-03T04:05:06.000Z'), new Date('2024-02-03T04:05:06.000Z'))
    assert.equal(api.validateRecords({ root }).valid, true)

    let replaced = false
    let replacements = 0
    cacheReadTestHooks.recordReadHooks = {
      beforeFinalWitnessValidation: () => {
        if (replaced) {
          rmSync(kindDirectory)
          renameSync(preservedKindDirectory, kindDirectory)
          replaced = false
        } else {
          renameSync(kindDirectory, preservedKindDirectory)
          symlinkSync(outside, kindDirectory, process.platform === 'win32' ? 'junction' : 'dir')
          replaced = true
          replacements += 1
        }
      },
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(replacements > 0, true)
    assert.equal(readFileSync(sentinel, 'utf8'), 'outside kind sentinel')
  })

  test('classifies an artifact ancestor replacement after descriptor verification as repository change', {
    skip: !renameParentWithOpenChildSupported,
  }, () => {
    const root = createRoot()
    const canonicalRoot = realpathSync.native(root)
    const id = 'manifest-artifact-ancestor'
    const artifact = `_artifacts/architecture/${id}/diagram.svg`
    const artifactDirectory = join(canonicalRoot, 'encephalon', '_artifacts', 'architecture', id)
    const artifactPath = join(artifactDirectory, 'diagram.svg')
    const preservedArtifactDirectory = join(canonicalRoot, 'preserved-artifact-directory')
    const outside = createOutsideDirectory()
    const sentinel = join(outside, 'diagram.svg')
    mkdirSync(artifactDirectory, { recursive: true })
    writeFileSync(artifactPath, '<svg>a</svg>')
    writeFileSync(sentinel, '<svg>outside artifact sentinel with deliberately different metadata</svg>')
    utimesSync(artifactPath, new Date('2025-01-02T03:04:05.000Z'), new Date('2025-01-02T03:04:05.000Z'))
    utimesSync(sentinel, new Date('2024-02-03T04:05:06.000Z'), new Date('2024-02-03T04:05:06.000Z'))
    api.addRecord({
      artifacts: [artifact],
      id,
      kind: 'architecture',
      payload: {},
      root,
      source: 'test',
      subject: 'cache.manifest-artifact-ancestor',
    })
    assert.equal(api.validateRecords({ root }).valid, true)

    let replaced = false
    let replacements = 0
    cacheReadTestHooks.recordReadHooks = {
      graphValidation: () => {
        if (replaced) {
          rmSync(artifactDirectory)
          renameSync(preservedArtifactDirectory, artifactDirectory)
          replaced = false
        }
      },
    }
    artifactInspectionTestHooks.fault = (point, path) => {
      if (point === 'before-final-directory-revalidation' && path === artifact && !replaced) {
        renameSync(artifactDirectory, preservedArtifactDirectory)
        symlinkSync(outside, artifactDirectory, process.platform === 'win32' ? 'junction' : 'dir')
        replaced = true
        replacements += 1
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(replacements > 0, true)
    assert.equal(
      readFileSync(sentinel, 'utf8'),
      '<svg>outside artifact sentinel with deliberately different metadata</svg>',
    )
  })

  test('retries a kind disappearance during final canonical witness validation', () => {
    const root = createRoot()
    const kindDirectory = join(root, 'encephalon', 'decision')
    mkdirSync(kindDirectory, { recursive: true })
    writeFileSync(
      join(kindDirectory, 'transient.json'),
      `${JSON.stringify({
        createdAt: '2026-08-06T10:00:00.000Z',
        id: 'transient',
        kind: 'decision',
        payload: {},
        source: 'test',
        subject: 'cache.transient-manifest',
      })}\n`,
    )
    cacheReadTestHooks.recordReadHooks = {
      beforeFinalWitnessValidation: () => {
        cacheReadTestHooks.recordReadHooks = undefined
        rmSync(kindDirectory, { recursive: true })
      },
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 0,
    })
  })

  test('bounds persistent canonical replacement and preserves operational I/O errors', () => {
    const persistentRoot = createRoot()
    const persistentKind = join(persistentRoot, 'encephalon', 'decision')
    mkdirSync(persistentKind, { recursive: true })
    cacheReadTestHooks.afterCanonicalValidation = () => {
      if (existsSync(persistentKind)) {
        rmSync(persistentKind, { recursive: true })
      } else {
        mkdirSync(persistentKind, { recursive: true })
      }
    }
    assert.throws(
      () =>
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({
          root: persistentRoot,
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    cacheReadTestHooks.afterCanonicalValidation = undefined
    const ioRoot = createRoot()
    mkdirSync(join(ioRoot, 'encephalon', 'decision'), { recursive: true })
    cacheReadTestHooks.recordReadHooks = {
      fault: point => {
        if (point === 'before-kind-lstat') {
          throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' })
        }
      },
    }
    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root: ioRoot }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        return true
      },
    )
  })

  test('keeps one stable real cache directory during concurrent first use', async () => {
    const root = createRoot()
    const firstResult = join(root, 'first-prepare-result')
    const secondResult = join(root, 'second-prepare-result')
    const firstReady = join(root, 'first-prepare-ready')
    const secondReady = join(root, 'second-prepare-ready')
    const releasePath = join(root, 'release-first-prepare')
    const fixture = join(import.meta.dirname, 'fixtures', 'prepare-cache.ts')
    const before = statSync(join(root, 'node_modules'), { bigint: true })
    const first = spawn(process.execPath, [fixture, root, firstResult, firstReady, releasePath], {
      stdio: 'inherit',
    })
    const second = spawn(process.execPath, [fixture, root, secondResult, secondReady, releasePath], {
      stdio: 'inherit',
    })
    const exits = [once(first, 'exit'), once(second, 'exit')]

    waitForPath(firstReady, first)
    waitForPath(secondReady, second)
    writeFileSync(releasePath, 'release')
    const exitResults = await Promise.all(exits)
    assert.equal(exitResults[0]?.[0], 0)
    assert.equal(exitResults[1]?.[0], 0)
    const firstOutput = JSON.parse(readFileSync(firstResult, 'utf8')) as {
      cacheIdentity: { dev: string; ino: string }
      result: { recordsIndexed: number }
    }
    const secondOutput = JSON.parse(readFileSync(secondResult, 'utf8')) as typeof firstOutput
    assert.equal(firstOutput.result.recordsIndexed, 0)
    assert.equal(secondOutput.result.recordsIndexed, 0)
    assert.deepEqual(firstOutput.cacheIdentity, secondOutput.cacheIdentity)
    const finalIdentity = statSync(cacheDirectoryPath(root), { bigint: true })
    assert.deepEqual(firstOutput.cacheIdentity, {
      dev: finalIdentity.dev.toString(),
      ino: finalIdentity.ino.toString(),
    })
    assert.equal(
      realpathSync(cacheDirectoryPath(root)),
      join(realpathSync(root), 'node_modules', '.cache', 'encephalon'),
    )
    assert.equal(statSync(join(root, 'node_modules'), { bigint: true }).ino, before.ino)
  })

  test('tolerates an operation lock that changes before gate acquisition', () => {
    const root = createRoot()
    const location = inspectCacheLocation(root)
    const lockPath = join(location.directory, 'operation.lock')
    const displacedPath = join(root, 'displaced-operation-lock')
    mkdirSync(lockPath)
    cacheLocationTestHooks.beforeOwnedDirectoryFinalIdentity = path => {
      if (path === lockPath) {
        cacheLocationTestHooks.beforeOwnedDirectoryFinalIdentity = undefined
        renameSync(path, displacedPath)
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
  })

  test('uses schema version rather than package version for cache compatibility', () => {
    const root = createRoot()
    const canonical = addCacheRecord(root)
    const prepare =
      functionFromApi<
        (input: Record<string, unknown>) => {
          hydrated: boolean
          recordsIndexed: number
        }
      >('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 1 })
    const database = new DatabaseSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'))
    const metadata = database.prepare("SELECT value FROM metadata WHERE key = 'packageVersion'").get()
    assert.equal(metadata?.value, PACKAGE_VERSION)
    database.prepare("UPDATE metadata SET value = '9.9.9' WHERE key = 'packageVersion'").run()
    database.close()

    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 1 })

    const schemaDatabase = new DatabaseSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'))
    schemaDatabase.prepare("UPDATE metadata SET value = '1' WHERE key = 'schemaVersion'").run()
    schemaDatabase.prepare("DELETE FROM metadata WHERE key = 'recordFingerprint'").run()
    schemaDatabase.close()

    let writerInitialisations = 0
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }
    assert.deepEqual(api.listRecords({ root }), [canonical])
    assert.equal(writerInitialisations, 0)
    assert.equal(logicalCacheProjection(root).metadata.find(row => row.key === 'schemaVersion')?.value, '1')

    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 1 })
    assert.equal(writerInitialisations, 1)
    const upgraded = logicalCacheProjection(root).metadata
    assert.equal(upgraded.find(row => row.key === 'schemaVersion')?.value, '2')
    assert.match(String(upgraded.find(row => row.key === 'recordFingerprint')?.value), /^[0-9a-f]{64}$/u)
    assert.deepEqual(api.listRecords({ root }), [canonical])
  })

  test('automatically prepares active list, show, search, compact search, and gather reads', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const first = addRecord({
      id: 'database-v1',
      kind: 'decision',
      payload: { detail: 'database storage', summary: 'Use a remote database' },
      root,
      source: 'agent',
      subject: 'backend.database',
    })
    const second = addRecord({
      id: 'database-v2',
      kind: 'decision',
      payload: { detail: 'local database storage', summary: 'Use SQLite' },
      root,
      searchText: 'portable persistence',
      source: 'agent',
      subject: 'backend.database',
      supersedes: [first.id],
    })
    const databasePath = cacheDatabasePath(root)
    const databaseIdentity = lstatSync(databasePath, { bigint: true })
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    assert.deepEqual(
      listRecords({ root }).map(record => record.id),
      [second.id],
    )
    assert.deepEqual(
      listRecords({ includeSuperseded: true, root }).map(record => record.id),
      [second.id, first.id],
    )

    const showRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown> | null>('showRecord')
    assert.equal(showRecord({ activeOnly: true, id: first.id, root }), null)
    assert.equal(showRecord({ id: first.id, root })?.id, first.id)

    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    assert.deepEqual(
      searchRecords({ query: 'database/storage', root }).map(record => record.id),
      [second.id],
    )
    assert.deepEqual(searchRecords({ query: '   ', root }), [])

    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const compact = searchCompactRecords({
      query: 'portable persistence',
      root,
    })
    assert.deepEqual(Object.keys(compact[0] ?? {}).sort(ordinalStringCompare), [
      'id',
      'kind',
      'path',
      'rank',
      'snippet',
      'subject',
      'summary',
    ])
    assert.equal(compact[0]?.summary, 'Use SQLite')
    assert.match(String(compact[0]?.snippet), /\[(portable|persistence)\]/i)
    assert.equal(compact[0]?.path, 'encephalon/decision/database-v2.json')

    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
    const gathered = gatherRecords({
      root,
      searches: ['SQLite', 'SQLite'],
      shows: [second.id, first.id, 'missing', second.id],
    }) as {
      hydrated: { recordsIndexed: number } | null
      searches: Array<{ query: string; results: Array<{ id: string }> }>
      records: Array<{ id: string; record: { id: string } | null }>
    }
    assert.deepEqual(
      gathered.searches.map(entry => entry.query),
      ['SQLite', 'SQLite'],
    )
    assert.equal((gathered as { hydrated?: unknown }).hydrated, null)
    assert.deepEqual(
      gathered.records.map(entry => [entry.id, entry.record?.id ?? null]),
      [
        [second.id, second.id],
        [first.id, null],
        ['missing', null],
        [second.id, second.id],
      ],
    )
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 0)
    assert.deepEqual(gatherRecords({ hydrate: true, root }), {
      hydrated: { recordsIndexed: 2 },
      records: [],
      searches: [],
    })
    const identityAfterReads = lstatSync(databasePath, { bigint: true })
    assert.deepEqual(
      { dev: identityAfterReads.dev, ino: identityAfterReads.ino },
      { dev: databaseIdentity.dev, ino: databaseIdentity.ino },
    )
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 1)

    functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'without-summary',
      kind: 'context',
      payload: { detail: 'searchable marker' },
      root,
      source: 'agent',
      subject: 'no.summary',
    })
    assert.equal(searchCompactRecords({ query: 'searchable marker', root })[0]?.summary, null)
  })

  test('keeps compact search and repeated gather ordering aligned with full search for large records', () => {
    const root = createRoot()
    const largePayload = 'payload filler '.repeat(10_000)
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const records = [
      addRecord({
        id: 'large-search-alpha',
        kind: 'context',
        payload: { body: largePayload, summary: 'Alpha compact summary' },
        root,
        searchText: 'shared performance needle',
        source: 'agent',
        subject: 'search.large.alpha',
      }),
      addRecord({
        id: 'large-search-beta',
        kind: 'context',
        payload: { body: largePayload, summary: 'Beta compact summary' },
        root,
        searchText: 'shared performance needle',
        source: 'agent',
        subject: 'search.large.beta',
      }),
    ]
    const expectedIds = records.map(record => record.id).reverse()

    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const fullIds = searchRecords({ query: 'shared performance needle', root }).map(record => record.id)
    const compactResults = searchCompactRecords({ query: 'shared performance needle', root })

    assert.deepEqual(fullIds, expectedIds)
    assert.deepEqual(
      compactResults.map(record => record.id),
      fullIds,
    )
    assert.deepEqual(
      compactResults.map(record => Object.keys(record).sort()),
      compactResults.map(() => ['id', 'kind', 'path', 'rank', 'snippet', 'subject', 'summary']),
    )

    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
    const gathered = gatherRecords({
      root,
      searches: ['shared performance needle', 'shared performance needle'],
    }) as { searches: Array<{ results: Array<{ id: string }> }> }
    assert.deepEqual(
      gathered.searches.map(entry => entry.results.map(record => record.id)),
      [fullIds, fullIds],
    )
  })

  test('preserves Unicode literal terms across full, compact, and gathered search', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const record = addRecord({
      id: 'unicode-search',
      kind: 'context',
      payload: { summary: 'Unicode search marker' },
      root,
      searchText: 'Cafe\u0301 Ελληνικά Русский مرحبا שלום 中文 किताब 한글'.normalize('NFD'),
      source: 'agent',
      subject: 'search.unicode',
    })
    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')

    assert.deepEqual(
      ['Café', 'Cafe\u0301'].map(query => searchRecords({ query, root }).map(result => result.id)),
      [[record.id], [record.id]],
    )
    assert.deepEqual(
      searchCompactRecords({ query: 'Ελληνικά', root }).map(result => result.id),
      [record.id],
    )
    const gathered = gatherRecords({
      root,
      searches: ['Ελληνικά', 'Русский', '* ()', 'مرحبا', 'שלום', '中文', 'किताब', '한글'],
    }) as {
      searches: Array<{ results: Array<{ id: string }> }>
    }
    assert.deepEqual(
      gathered.searches.map(search => search.results.map(result => result.id)),
      [[record.id], [record.id], [], [record.id], [record.id], [record.id], [record.id], [record.id]],
    )
  })

  test('accepts worst-case NFC expansion in valid derived search documents', () => {
    const root = createRoot()
    const expandingSummary = '\u{1D160}'.repeat(90_000)
    const added = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'unicode-expansion',
      kind: 'context',
      payload: { summary: expandingSummary },
      root,
      searchText: 'normalization expansion marker',
      source: 'agent',
      subject: 'search.unicode-expansion',
    })
    const prepare = functionFromApi<(input: Record<string, unknown>) => { recordsIndexed: number }>('prepare')
    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')

    assert.equal(prepare({ root }).recordsIndexed, 1)
    assert.deepEqual(
      listRecords({ root }).map(record => record.id),
      [added.id],
    )
    assert.deepEqual(
      searchRecords({ query: 'normalization expansion marker', root }).map(record => record.id),
      [added.id],
    )
  })

  test('validates the repository but skips the cache for punctuation-only searches', () => {
    const root = createRoot()
    const query = '\u0301 _ __ * " - + ^ : () {} []\u0000'
    let cacheInspections = 0
    let integrityProbes = 0
    let repositoryInspections = 0
    cacheLocationTestHooks.beforeLocationInspection = () => {
      cacheInspections += 1
      throw new Error('cache inspection must not run for an empty literal query')
    }
    repositoryTestHooks.afterGitMarkerDecision = () => {
      repositoryInspections += 1
    }
    cacheReadTestHooks.afterIntegrityProbe = () => {
      integrityProbes += 1
      throw new Error('cache integrity validation must not run for an empty literal query')
    }
    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')

    assert.deepEqual(searchRecords({ query, root }), [])
    assert.ok(repositoryInspections > 0)
    repositoryInspections = 0
    assert.deepEqual(searchCompactRecords({ query, root }), [])
    assert.ok(repositoryInspections > 0)
    repositoryInspections = 0
    assert.deepEqual(gatherRecords({ root, searches: [query] }), {
      hydrated: null,
      records: [],
      searches: [{ kind: null, query, results: [] }],
    })
    assert.ok(repositoryInspections > 0)
    assert.equal(cacheInspections, 0)
    assert.equal(integrityProbes, 0)
  })

  test('preserves root-install-required before punctuation-only cache fast paths', () => {
    const root = createRoot()
    const query = '* ()'
    let cacheInspections = 0
    rmSync(join(root, 'node_modules', 'encephalon'), { recursive: true })
    cacheLocationTestHooks.beforeLocationInspection = () => {
      cacheInspections += 1
      throw new Error('cache inspection must not run before root-installation rejection')
    }
    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
    const assertRootInstallRequired = (read: () => unknown) =>
      assert.throws(read, (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'ROOT_INSTALL_REQUIRED')
        return true
      })

    assertRootInstallRequired(() => searchRecords({ query, root }))
    assertRootInstallRequired(() => searchCompactRecords({ query, root }))
    assertRootInstallRequired(() => gatherRecords({ root, searches: [query] }))
    assert.equal(cacheInspections, 0)
  })

  test('serves a valid large-summary record through cache preparation and search', () => {
    const root = createRoot()
    const summary = `large summary marker ${'x'.repeat(600_000)}`
    const added = api.addRecord({
      id: 'large-summary-cache-record',
      kind: 'context',
      payload: { summary },
      root,
      source: 'agent',
      subject: 'cache.large-summary',
    })

    assert.deepEqual(api.prepare({ root }), { hydrated: false, recordsIndexed: 1 })
    assert.equal(api.listRecords({ limit: 1, root })[0]?.id, added.id)
    assert.equal(api.searchRecords({ limit: 1, query: 'large summary marker', root })[0]?.id, added.id)
  })

  test('accepts request budget boundaries and rejects one unit over before cache I/O', () => {
    const validRoot = createRoot()
    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')

    assert.deepEqual(listRecords({ limit: 50, root: validRoot }), [])
    assert.deepEqual(searchRecords({ limit: 50, query: 'x'.repeat(1024), root: validRoot }), [])
    assert.deepEqual(
      searchRecords({
        limit: 50,
        query: Array.from({ length: 32 }, () => 'x').join(' '),
        root: validRoot,
      }),
      [],
    )
    assert.deepEqual(searchCompactRecords({ limit: 100, query: 'x', root: validRoot }), [])
    const gathered = gatherRecords({
      limit: 100,
      root: validRoot,
      searches: Array.from({ length: 16 }, () => 'x'),
      shows: Array.from({ length: 64 }, () => 'missing'),
    }) as {
      records: Array<{ id: string }>
      searches: Array<{ query: string }>
    }
    assert.deepEqual(
      gathered.searches.map(search => search.query),
      Array.from({ length: 16 }, () => 'x'),
    )
    assert.deepEqual(
      gathered.records.map(record => record.id),
      Array.from({ length: 64 }, () => 'missing'),
    )

    const invalidCases: Array<{
      expected: { budget: string; field: string; maximum: number }
      run: (root: string) => void
    }> = [
      {
        expected: { budget: 'fullResultLimit', field: 'limit', maximum: 50 },
        run: root => listRecords({ limit: 51, root }),
      },
      {
        expected: { budget: 'fullResultLimit', field: 'limit', maximum: 50 },
        run: root => searchRecords({ limit: 51, query: 'x', root }),
      },
      {
        expected: { budget: 'compactResultLimit', field: 'limit', maximum: 100 },
        run: root => searchCompactRecords({ limit: 101, query: 'x', root }),
      },
      {
        expected: { budget: 'queryBytes', field: 'query', maximum: 1024 },
        run: root => searchRecords({ query: `${'x'.repeat(1024)}y`, root }),
      },
      {
        expected: { budget: 'queryBytes', field: 'query', maximum: 1024 },
        run: root => searchCompactRecords({ query: `${'x'.repeat(1024)}y`, root }),
      },
      {
        expected: { budget: 'queryTerms', field: 'query', maximum: 32 },
        run: root => searchRecords({ query: Array.from({ length: 33 }, () => 'x').join(' '), root }),
      },
      {
        expected: { budget: 'queryTerms', field: 'query', maximum: 32 },
        run: root => searchCompactRecords({ query: Array.from({ length: 33 }, () => 'x').join(' '), root }),
      },
      {
        expected: { budget: 'gatherSearches', field: 'searches', maximum: 16 },
        run: root => gatherRecords({ root, searches: [42, ...Array.from({ length: 16 }, () => 'x')] }),
      },
      {
        expected: { budget: 'gatherShows', field: 'shows', maximum: 64 },
        run: root =>
          gatherRecords({
            root,
            shows: ['not a valid record id', ...Array.from({ length: 64 }, () => 'missing')],
          }),
      },
      {
        expected: { budget: 'gatherShows', field: 'shows', maximum: 64 },
        run: root =>
          gatherRecords({
            root,
            searches: [42],
            shows: Array.from({ length: 65 }, () => 'missing'),
          }),
      },
      {
        expected: { budget: 'compactResultLimit', field: 'limit', maximum: 100 },
        run: root => gatherRecords({ limit: 101, root, searches: ['x'] }),
      },
      {
        expected: { budget: 'queryTerms', field: 'query', maximum: 32 },
        run: root => gatherRecords({ root, searches: [Array.from({ length: 33 }, () => 'x').join(' ')] }),
      },
    ]

    for (const invalidCase of invalidCases) {
      const root = createRoot()
      let repositoryInspections = 0
      let cacheLocationInspections = 0
      repositoryTestHooks.afterGitMarkerDecision = () => {
        repositoryInspections += 1
        throw new Error('repository inspection must not run for rejected budget input')
      }
      cacheLocationTestHooks.beforeLocationInspection = () => {
        cacheLocationInspections += 1
        throw new Error('cache inspection must not run for rejected budget input')
      }
      assertBudgetError(() => invalidCase.run(root), invalidCase.expected)
      assert.equal(repositoryInspections, 0)
      assert.equal(cacheLocationInspections, 0)
      assert.equal(existsSync(cacheDirectoryPath(root)), false)
    }
  })

  test('stops full-record responses at the aggregate byte budget while compact search remains usable', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    for (const index of Array.from({ length: 5 }, (_, value) => value)) {
      addRecord({
        id: `large-response-${index}`,
        kind: 'context',
        payload: { text: 'x '.repeat(450 * 1024) },
        root,
        searchText: 'response budget marker',
        source: 'agent',
        subject: `response.budget.${index}`,
      })
    }

    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    assertBudgetError(() => searchRecords({ limit: 5, query: 'response budget marker', root }), {
      budget: 'fullResponseBytes',
      field: 'response',
      maximum: 4 * 1024 * 1024,
    })

    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
    assertBudgetError(
      () =>
        gatherRecords({
          root,
          shows: Array.from({ length: 5 }, () => 'large-response-0'),
        }),
      {
        budget: 'gatherResponseBytes',
        field: 'response',
        maximum: 4 * 1024 * 1024,
      },
    )
    const gathered = gatherRecords({ limit: 5, root, searches: ['response budget marker'] }) as {
      searches: Array<{ results: unknown[] }>
    }
    assert.deepEqual(
      gathered.searches.map(search => search.results.length),
      [5],
    )

    const searchCompactRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')
    assert.equal(searchCompactRecords({ limit: 5, query: 'response budget marker', root }).length, 5)
  })

  test('streams compact rows through the exact 4 MiB response boundary', () => {
    const root = createRoot()
    const query = 'compactboundary'
    const initialSummary = `${'é '.repeat(215_999)}é`
    const records = Array.from({ length: 6 }, (_, index) =>
      api.addRecord({
        id: `compact-boundary-${index}`,
        kind: 'context',
        payload: { summary: initialSummary },
        root,
        source: 'agent',
        subject: `${query}.${index}`,
      }),
    )
    const initial = api.searchCompactRecords({ limit: records.length, query, root })
    const remainingBytes = 4 * 1024 * 1024 - expectedResponseBytes(initial)
    assert.ok(remainingBytes > 0)
    const adjustedSummary = `${initialSummary}${'x'.repeat(remainingBytes)}`
    const adjustedRecord = records.at(-1)
    assert.ok(adjustedRecord !== undefined)
    rewriteRecordSummary(root, adjustedRecord.path, adjustedSummary)

    const allDescriptor = Object.getOwnPropertyDescriptor(StatementSync.prototype, 'all')
    assert.ok(allDescriptor !== undefined)
    Object.defineProperty(StatementSync.prototype, 'all', {
      ...allDescriptor,
      value: () => {
        throw new Error('compact search must stream rows with iterate()')
      },
    })
    try {
      const exact = api.searchCompactRecords({ limit: records.length, query, root })
      assert.equal(expectedResponseBytes(exact), 4 * 1024 * 1024)

      rewriteRecordSummary(root, adjustedRecord.path, `${adjustedSummary}x`)
      assertBudgetError(() => api.searchCompactRecords({ limit: records.length, query, root }), {
        budget: 'compactResponseBytes',
        field: 'response',
        maximum: 4 * 1024 * 1024,
      })
    } finally {
      Object.defineProperty(StatementSync.prototype, 'all', allDescriptor)
    }
  })

  test('charges compact response containers in their composing callers', () => {
    const root = createRoot()
    const query = 'structural ownership marker'
    api.addRecord({
      id: 'structural-ownership',
      kind: 'context',
      payload: { summary: 'Structural ownership result' },
      root,
      source: 'agent',
      subject: query,
    })
    const events: Array<{ budgetKey: string; value: unknown } | 'prepare'> = []
    responseBudgetTestHooks.afterCharge = (budgetKey, value) => {
      events.push({ budgetKey, value })
    }
    cacheReadTestHooks.onCompactSearchPrepare = () => {
      events.push('prepare')
    }

    api.searchCompactRecords({ query, root })
    assert.deepEqual(events.slice(0, 2), [{ budgetKey: 'compactResponseBytes', value: [] }, 'prepare'])

    events.length = 0
    api.gatherRecords({ root, searches: [query] })
    const gatherCharges = events.filter(event => event !== 'prepare')
    assert.deepEqual(gatherCharges.at(0), {
      budgetKey: 'gatherResponseBytes',
      value: { hydrated: null, records: [], searches: [] },
    })
    assert.deepEqual(gatherCharges.at(1), {
      budgetKey: 'gatherResponseBytes',
      value: { kind: null, query, results: [] },
    })
  })

  test('shares one 4 MiB gather response budget across complete repeated results', () => {
    const root = createRoot()
    const query = 'gatherboundary'
    const initialSummary = `${'é '.repeat(299_999)}é`
    const repeated = api.addRecord({
      id: 'gather-boundary-repeated',
      kind: 'context',
      payload: { summary: initialSummary },
      root,
      source: 'agent',
      subject: query,
    })
    const shown = api.addRecord({
      id: 'gather-boundary-shown',
      kind: 'context',
      payload: { detail: 'full record', summary: `Secondary ${'z'.repeat(200_000)}` },
      root,
      source: 'agent',
      subject: 'gather.boundary.shown',
    })
    const gather = (absentId: string) =>
      api.gatherRecords({
        hydrate: true,
        limit: 2,
        root,
        searches: [query, query],
        shows: [repeated.id, repeated.id, shown.id, absentId],
      })
    const missingId = 'missing'
    const initial = gather(missingId)
    const remainingBytes = 4 * 1024 * 1024 - expectedResponseBytes(initial)
    assert.ok(remainingBytes > 0)
    const repeatedOccurrences = 4
    const summaryBytesToAdd = Math.floor(remainingBytes / repeatedOccurrences)
    const missingIdBytesToAdd = remainingBytes % repeatedOccurrences
    rewriteRecordSummary(root, repeated.path, `${initialSummary}${'x'.repeat(summaryBytesToAdd)}`)
    const exactMissingId = `${missingId}${'x'.repeat(missingIdBytesToAdd)}`

    const exact = gather(exactMissingId)
    assert.equal(expectedResponseBytes(exact), 4 * 1024 * 1024)
    assert.deepEqual(exact.hydrated, { recordsIndexed: 2 })
    assert.deepEqual(
      exact.records.map(entry => [entry.id, entry.record?.id ?? null]),
      [
        [repeated.id, repeated.id],
        [repeated.id, repeated.id],
        [shown.id, shown.id],
        [exactMissingId, null],
      ],
    )
    assert.deepEqual(
      exact.searches.map(entry => [entry.query, entry.results.map(result => result.id)]),
      [
        [query, [repeated.id]],
        [query, [repeated.id]],
      ],
    )
    assertBudgetError(() => gather(`${exactMissingId}x`), {
      budget: 'gatherResponseBytes',
      field: 'response',
      maximum: 4 * 1024 * 1024,
    })
  })

  test('gather reads every item from one cache snapshot', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const firstId = 'snapshot-v1'
    addRecord({
      id: firstId,
      kind: 'context',
      payload: { summary: 'Snapshot generation one' },
      root,
      source: 'agent',
      subject: 'cache.snapshot.first',
    })
    const secondId = 'snapshot-v2'
    addRecord({
      id: secondId,
      kind: 'context',
      payload: { summary: 'Snapshot generation two' },
      root,
      source: 'agent',
      subject: 'cache.snapshot.second',
    })
    const replacement = {
      createdAt: '2026-08-08T00:00:01.000Z',
      id: 'snapshot-v3',
      kind: 'context',
      path: 'encephalon/context/snapshot-v3.json',
      payload: { summary: 'Snapshot generation three' },
      source: 'agent',
      subject: 'cache.snapshot.second',
      supersedes: [secondId],
    }
    let mutatedBetweenItems = false

    cacheReadTestHooks.afterShowRead = () => {
      if (!mutatedBetweenItems) {
        mutatedBetweenItems = true
        const database = new DatabaseSync(cacheDatabasePath(root))
        try {
          database.exec('BEGIN IMMEDIATE')
          database.prepare('UPDATE records SET active = 0 WHERE id = ?').run(secondId)
          database
            .prepare(`
              INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              replacement.id,
              replacement.kind,
              replacement.subject,
              replacement.source,
              replacement.createdAt,
              replacement.path,
              1,
              'Snapshot generation three',
              JSON.stringify(replacement),
            )
          database
            .prepare('INSERT INTO record_search(id, text) VALUES (?, ?)')
            .run(replacement.id, 'Snapshot generation three')
          database.exec('COMMIT')
        } catch (error) {
          try {
            database.exec('ROLLBACK')
          } catch {}
          throw error
        } finally {
          database.close()
        }
      }
    }

    try {
      const gatherRecords =
        functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
      const gathered = gatherRecords({ root, shows: [firstId, secondId] }) as {
        records: Array<{ id: string; record: { id: string } | null }>
      }
      assert.equal(mutatedBetweenItems, true)
      assert.deepEqual(
        gathered.records.map(entry => [entry.id, entry.record?.id ?? null]),
        [
          [firstId, firstId],
          [secondId, secondId],
        ],
      )
    } finally {
      cacheReadTestHooks.afterShowRead = undefined
    }
  })

  test('gather reads every search from one cache snapshot', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const firstId = 'search-snapshot-v1'
    addRecord({
      id: firstId,
      kind: 'context',
      payload: { summary: 'Search snapshot generation one' },
      root,
      searchText: 'snapshot searchable generation one',
      source: 'agent',
      subject: 'cache.search-snapshot',
    })
    const replacement = {
      createdAt: '2026-08-08T00:00:01.000Z',
      id: 'search-snapshot-v2',
      kind: 'context',
      path: 'encephalon/context/search-snapshot-v2.json',
      payload: { summary: 'Search snapshot generation two' },
      searchText: 'snapshot searchable generation two',
      source: 'agent',
      subject: 'cache.search-snapshot',
      supersedes: [firstId],
    }
    let mutatedBetweenSearches = false

    cacheReadTestHooks.afterCompactSearchRead = () => {
      if (!mutatedBetweenSearches) {
        mutatedBetweenSearches = true
        const database = new DatabaseSync(cacheDatabasePath(root))
        try {
          database.exec('BEGIN IMMEDIATE')
          database.prepare('UPDATE records SET active = 0 WHERE id = ?').run(firstId)
          database
            .prepare(`
              INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              replacement.id,
              replacement.kind,
              replacement.subject,
              replacement.source,
              replacement.createdAt,
              replacement.path,
              1,
              'Search snapshot generation two',
              JSON.stringify(replacement),
            )
          database
            .prepare('INSERT INTO record_search(id, text) VALUES (?, ?)')
            .run(replacement.id, replacement.searchText)
          database.exec('COMMIT')
        } catch (error) {
          try {
            database.exec('ROLLBACK')
          } catch {}
          throw error
        } finally {
          database.close()
        }
      }
    }

    try {
      const gatherRecords =
        functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
      const gathered = gatherRecords({
        root,
        searches: ['snapshot searchable', 'snapshot   searchable'],
      }) as {
        searches: Array<{ results: Array<{ id: string }> }>
      }
      assert.equal(mutatedBetweenSearches, true)
      assert.deepEqual(
        gathered.searches.map(entry => entry.results.map(result => result.id)),
        [[firstId], [firstId]],
      )
    } finally {
      cacheReadTestHooks.afterCompactSearchRead = undefined
    }
  })

  test('gather deduplicates exact database work while preserving order and independent results', () => {
    const root = createRoot()
    const addRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')
    const first = addRecord({
      id: 'reuse-v1',
      kind: 'decision',
      payload: { summary: 'First reusable decision' },
      root,
      source: 'agent',
      subject: 'cache.reuse',
    })
    const second = addRecord({
      id: 'reuse-v2',
      kind: 'decision',
      payload: { detail: { markers: ['second'] }, summary: 'Second reusable decision' },
      root,
      searchText: 'statement reuse marker',
      source: 'agent',
      subject: 'cache.reuse',
      supersedes: [first.id],
    })
    let showPrepareCount = 0
    let searchPrepareCount = 0
    let compactSearchSelectedRecordJson = false
    let showSelectedRecordBytes = false
    const searchEvaluationCounts = new Map<string, number>()
    const searchReadCounts = new Map<string, number>()
    const showReadCounts = new Map<string, number>()
    const count = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)

    cacheReadTestHooks.onShowPrepare = source => {
      showPrepareCount += 1
      showSelectedRecordBytes ||= source.includes('record_bytes')
    }
    cacheReadTestHooks.onCompactSearchPrepare = source => {
      searchPrepareCount += 1
      compactSearchSelectedRecordJson ||= source.includes('records.record_json')
    }
    cacheReadTestHooks.afterGatherSearchEvaluation = query => count(searchEvaluationCounts, query)
    cacheReadTestHooks.afterCompactSearchRead = query => count(searchReadCounts, query)
    cacheReadTestHooks.afterShowRead = id => count(showReadCounts, id)

    try {
      const gatherRecords =
        functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
      const exactQuery = 'statement reuse marker'
      const equivalentQuery = 'statement   reuse marker'
      const missingId = 'reuse-missing'
      const gathered = gatherRecords({
        root,
        searches: [exactQuery, equivalentQuery, exactQuery, '   ', equivalentQuery, '   '],
        shows: [second.id, missingId, second.id, missingId, first.id],
      }) as {
        records: Array<{
          id: string
          record: {
            id: string
            payload: { detail?: { markers?: string[] }; summary?: string }
          } | null
        }>
        searches: Array<{ query: string; results: Array<{ id: string; snippet: string }> }>
      }
      assert.deepEqual(
        gathered.records.map(entry => [entry.id, entry.record?.id ?? null]),
        [
          [second.id, second.id],
          [missingId, null],
          [second.id, second.id],
          [missingId, null],
          [first.id, null],
        ],
      )
      assert.deepEqual(
        gathered.searches.map(entry => [entry.query, entry.results.map(result => result.id)]),
        [
          [exactQuery, [second.id]],
          [equivalentQuery, [second.id]],
          [exactQuery, [second.id]],
          ['   ', []],
          [equivalentQuery, [second.id]],
          ['   ', []],
        ],
      )
      assert.deepEqual(
        showReadCounts,
        new Map([
          [second.id, 1],
          [missingId, 1],
          [first.id, 1],
        ]),
      )
      assert.deepEqual(
        searchReadCounts,
        new Map([
          [exactQuery, 1],
          [equivalentQuery, 1],
        ]),
      )
      assert.deepEqual(
        searchEvaluationCounts,
        new Map([
          [exactQuery, 1],
          [equivalentQuery, 1],
          ['   ', 1],
        ]),
      )

      const [firstShownEntry, , repeatedShownEntry] = gathered.records
      const [firstSearch, , repeatedSearch, firstEmptySearch, , repeatedEmptySearch] = gathered.searches
      const firstShownRecord = firstShownEntry?.record
      const repeatedShownRecord = repeatedShownEntry?.record
      assert.ok(firstShownRecord !== null && firstShownRecord !== undefined)
      assert.ok(repeatedShownRecord !== null && repeatedShownRecord !== undefined)
      assert.ok(firstSearch !== undefined)
      assert.ok(repeatedSearch !== undefined)
      assert.ok(firstEmptySearch !== undefined)
      assert.ok(repeatedEmptySearch !== undefined)
      assert.notStrictEqual(firstShownRecord, repeatedShownRecord)
      assert.notStrictEqual(firstShownRecord.payload, repeatedShownRecord.payload)
      assert.notStrictEqual(firstShownRecord.payload.detail, repeatedShownRecord.payload.detail)
      assert.notStrictEqual(firstSearch.results, repeatedSearch.results)
      assert.notStrictEqual(firstSearch.results[0], repeatedSearch.results[0])
      assert.notStrictEqual(firstEmptySearch.results, repeatedEmptySearch.results)

      firstShownRecord.payload.detail?.markers?.push('mutated')
      assert.deepEqual(repeatedShownRecord.payload.detail?.markers, ['second'])
      const [firstCompactResult] = firstSearch.results
      assert.ok(firstCompactResult !== undefined)
      firstCompactResult.snippet = 'mutated'
      firstSearch.results.splice(0)
      assert.equal(repeatedSearch.results.length, 1)
      assert.notEqual(repeatedSearch.results[0]?.snippet, 'mutated')
    } finally {
      cacheReadTestHooks.onShowPrepare = undefined
      cacheReadTestHooks.onCompactSearchPrepare = undefined
      cacheReadTestHooks.afterGatherSearchEvaluation = undefined
      cacheReadTestHooks.afterCompactSearchRead = undefined
      cacheReadTestHooks.afterShowRead = undefined
    }

    assert.equal(showPrepareCount, 1)
    assert.equal(searchPrepareCount, 1)
    assert.equal(compactSearchSelectedRecordJson, false)
    assert.equal(showSelectedRecordBytes, false)
  })

  test('gather resets partially populated exact-work memos before a recovery retry', () => {
    const root = createRoot()
    const record = api.addRecord({
      id: 'memo-retry',
      kind: 'context',
      payload: { summary: 'Memo generation one' },
      root,
      searchText: 'retry memo alpha beta',
      source: 'agent',
      subject: 'cache.memo-retry',
    })
    const firstQuery = 'retry memo'
    const secondQuery = 'alpha beta'
    const searchReadCounts = new Map<string, number>()
    let recoveryRebuilds = 0
    let showReads = 0
    let writerInitialisations = 0
    let faulted = false

    cacheReadTestHooks.afterShowRead = () => {
      showReads += 1
    }
    cacheReadTestHooks.afterCompactSearchRead = query => {
      searchReadCounts.set(query, (searchReadCounts.get(query) ?? 0) + 1)
      if (query === secondQuery && !faulted) {
        faulted = true
        rewriteRecordSummary(root, record.path, 'Memo generation two')
        throw Object.assign(new Error('private rejected gather generation'), {
          code: 'SQLITE_CORRUPT',
        })
      }
    }
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      recoveryRebuilds += 1
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    try {
      const gathered = api.gatherRecords({
        root,
        searches: [firstQuery, firstQuery, secondQuery, secondQuery],
        shows: [record.id, record.id],
      }) as {
        records: Array<{ record: { payload: { summary: string } } | null }>
        searches: Array<{ results: Array<{ summary: string | null }> }>
      }
      assert.deepEqual(
        gathered.records.map(entry => entry.record?.payload.summary ?? null),
        ['Memo generation two', 'Memo generation two'],
      )
      assert.deepEqual(
        gathered.searches.map(entry => entry.results.map(result => result.summary)),
        [['Memo generation two'], ['Memo generation two'], ['Memo generation two'], ['Memo generation two']],
      )
    } finally {
      cacheReadTestHooks.afterShowRead = undefined
      cacheReadTestHooks.afterCompactSearchRead = undefined
      cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = undefined
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
    }

    assert.equal(faulted, true)
    assert.equal(showReads, 2)
    assert.deepEqual(
      searchReadCounts,
      new Map([
        [firstQuery, 2],
        [secondQuery, 2],
      ]),
    )
    assert.equal(recoveryRebuilds, 1)
    assert.equal(writerInitialisations, 1)
  })

  test('tracks record and referenced-artifact freshness', () => {
    const root = createRoot()
    const id = 'architecture-with-artifact'
    const artifact = `_artifacts/architecture/${id}/diagram.svg`
    const artifactPath = join(root, 'encephalon', ...artifact.split('/'))
    ensureParent(artifactPath)
    writeFileSync(artifactPath, '<svg>one</svg>')

    functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
      artifacts: [artifact],
      id,
      kind: 'architecture',
      payload: { summary: 'System overview' },
      root,
      source: 'agent',
      subject: 'system.overview',
    })
    const prepare =
      functionFromApi<
        (input: Record<string, unknown>) => {
          hydrated: boolean
          recordsIndexed: number
        }
      >('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 1 })

    const recordPath = join(root, 'encephalon', 'architecture', `${id}.json`)
    writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')} `)
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 1 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 1 })

    writeFileSync(artifactPath, '<svg>two</svg>')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 1 })
  })

  test('does not serve a preserved stale cache after canonical validation fails', () => {
    const root = createRoot()
    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'valid-before-corruption',
      kind: 'context',
      payload: { summary: 'Valid' },
      root,
      source: 'agent',
      subject: 'repository.overview',
    })
    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    assert.equal(listRecords({ root }).length, 1)
    writeFileSync(join(root, String(record.path)), '{not-json')

    assert.throws(
      () => listRecords({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
  })

  test('rebuilds a corrupt disposable cache', () => {
    const root = createRoot()
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    prepare({ root })
    writeFileSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'), 'not a sqlite database')

    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('recovers not-a-database writer opens across forced and already-held cache preparation', () => {
    const cases: Array<{
      name: string
      run: (root: string) => unknown
      seed: (root: string) => void
    }> = [
      {
        name: 'public hydrate',
        run: root => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }),
        seed: root => {
          addCacheRecord(root)
        },
      },
      {
        name: 'forced gather hydration',
        run: root =>
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            hydrate: true,
            root,
          }),
        seed: root => {
          addCacheRecord(root)
        },
      },
      {
        name: 'post-commit add hydration',
        run: root =>
          functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
            id: 'recovered-post-commit-hydration',
            kind: 'context',
            payload: { summary: 'Recovered post-commit hydration' },
            root,
            source: 'agent',
            subject: 'cache.recovery',
          }),
        seed: root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
        },
      },
      {
        name: 'init cache preparation under its held lock',
        run: root => functionFromApi<(input: Record<string, unknown>) => unknown>('initEncephalon')({ root }),
        seed: root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('initEncephalon')({ root })
        },
      },
    ]

    for (const { name, run, seed } of cases) {
      const root = createRoot()
      seed(root)
      writeFileSync(cacheDatabasePath(root), 'not a sqlite database')
      let primaryQuarantines = 0
      let writerInitialisations = 0
      cacheLocationTestHooks.beforeQuarantineRename = path => {
        if (basename(path) === 'brain.sqlite') {
          primaryQuarantines += 1
        }
      }
      cacheReadTestHooks.duringDatabaseInitialisation = mode => {
        if (mode === 'writer') {
          writerInitialisations += 1
        }
      }

      const result = run(root) as {
        hydrated?: { recordsIndexed?: unknown } | null
        id?: unknown
        recordsCreated?: unknown[]
        recordsIndexed?: unknown
      }
      if (name === 'public hydrate') {
        assert.deepEqual(result, { recordsIndexed: 1 }, name)
      } else if (name === 'forced gather hydration') {
        assert.deepEqual(result.hydrated, { recordsIndexed: 1 }, name)
      } else if (name === 'post-commit add hydration') {
        assert.equal(result.id, 'recovered-post-commit-hydration', name)
      } else {
        assert.deepEqual(result.recordsCreated, [], name)
      }
      assert.equal(primaryQuarantines, 1, name)
      assert.equal(writerInitialisations, 1, name)
      cacheLocationTestHooks.beforeQuarantineRename = undefined
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
    }
  })

  test('quarantines malformed metadata across forced and already-held cache rebuilds', () => {
    const cases: Array<{
      name: string
      run: (root: string) => unknown
      seed: (root: string) => void
    }> = [
      {
        name: 'public hydrate',
        run: root => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }),
        seed: root => {
          addCacheRecord(root)
        },
      },
      {
        name: 'forced gather hydration',
        run: root =>
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            hydrate: true,
            root,
          }),
        seed: root => {
          addCacheRecord(root)
        },
      },
      {
        name: 'post-commit add hydration',
        run: root =>
          functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
            id: 'metadata-recovered-post-commit',
            kind: 'context',
            payload: { summary: 'Recovered malformed metadata' },
            root,
            source: 'agent',
            subject: 'cache.recovery',
          }),
        seed: root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
        },
      },
      {
        name: 'init cache preparation under its held lock',
        run: root => functionFromApi<(input: Record<string, unknown>) => unknown>('initEncephalon')({ root }),
        seed: root => {
          functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
        },
      },
    ]

    for (const { name, run, seed } of cases) {
      const root = createRoot()
      seed(root)
      mutateCache(root, database => {
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'artifactPaths'").run('["private-forced",')
      })
      let primaryQuarantines = 0
      let writerInitialisations = 0
      cacheLocationTestHooks.beforeQuarantineRename = path => {
        if (basename(path) === 'brain.sqlite') {
          primaryQuarantines += 1
        }
      }
      cacheReadTestHooks.duringDatabaseInitialisation = mode => {
        if (mode === 'writer') {
          writerInitialisations += 1
        }
      }

      const result = run(root) as {
        hydrated?: { recordsIndexed?: unknown } | null
        id?: unknown
        recordsCreated?: unknown[]
        recordsIndexed?: unknown
      }
      if (name === 'public hydrate') {
        assert.deepEqual(result, { recordsIndexed: 1 }, name)
      } else if (name === 'forced gather hydration') {
        assert.deepEqual(result.hydrated, { recordsIndexed: 1 }, name)
      } else if (name === 'post-commit add hydration') {
        assert.equal(result.id, 'metadata-recovered-post-commit', name)
      } else {
        assert.ok(result.recordsCreated !== undefined && result.recordsCreated.length > 0, name)
      }
      assert.equal(primaryQuarantines, 1, name)
      assert.equal(writerInitialisations, 1, name)
      cacheLocationTestHooks.beforeQuarantineRename = undefined
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
    }
  })

  test('recovers an observed-missing cache without displacing a current successor', () => {
    const cases = [
      { expectedHydrated: true, name: 'primary remains absent', successor: false },
      { expectedHydrated: false, name: 'current successor appears', successor: true },
    ] as const

    for (const { expectedHydrated, name, successor } of cases) {
      const root = createRoot()
      addCacheRecord(root)
      const databasePath = cacheDatabasePath(root)
      const predecessorPath = join(root, 'observed-cache-predecessor.sqlite')
      const successorPath = join(root, 'observed-cache-successor.sqlite')
      if (successor) {
        copyFileSync(databasePath, successorPath)
      }
      const successorIdentity = successor ? lstatSync(successorPath, { bigint: true }) : undefined
      const phases: string[] = []
      let primaryQuarantines = 0
      let readerInitialisations = 0
      let writerInitialisations = 0
      cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
        phases.push(phase)
        if (phase === 'prepare-fast-path') {
          renameSync(databasePath, predecessorPath)
        }
        if (phase === 'reader-missing' && successor) {
          renameSync(successorPath, databasePath)
        }
        if (phase === 'reader-missing') {
          cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
        }
      }
      cacheLocationTestHooks.beforeQuarantineRename = path => {
        if (basename(path) === 'brain.sqlite') {
          primaryQuarantines += 1
        }
      }
      cacheReadTestHooks.duringDatabaseInitialisation = mode => {
        if (mode === 'reader') {
          readerInitialisations += 1
        } else {
          writerInitialisations += 1
        }
      }

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: expectedHydrated, recordsIndexed: 1 },
        name,
      )
      assert.deepEqual(phases, ['prepare-fast-path', 'reader-missing'], name)
      assert.equal(primaryQuarantines, 0, name)
      assert.equal(readerInitialisations, successor ? 1 : 0, name)
      assert.equal(writerInitialisations, successor ? 0 : 1, name)
      assert.equal(existsSync(predecessorPath), true, name)
      if (successorIdentity !== undefined) {
        const currentIdentity = lstatSync(databasePath, { bigint: true })
        assert.deepEqual(
          { dev: currentIdentity.dev, ino: currentIdentity.ino },
          { dev: successorIdentity.dev, ino: successorIdentity.ino },
          name,
        )
      }
      cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      cacheLocationTestHooks.beforeQuarantineRename = undefined
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
    }
  })

  test('does not repopulate a successor installed after missing-primary recovery observes absence', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'late-cache-predecessor.sqlite')
    const successorPath = join(root, 'late-cache-successor.sqlite')
    copyFileSync(databasePath, successorPath)
    const successorIdentity = lstatSync(successorPath, { bigint: true })
    let missingRecoveryObservations = 0
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'prepare-fast-path') {
        renameSync(databasePath, predecessorPath)
      }
      if (phase === 'reader-missing') {
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheReadTestHooks.afterMissingPrimaryRecoveryObservation = () => {
      missingRecoveryObservations += 1
      cacheReadTestHooks.afterMissingPrimaryRecoveryObservation = undefined
      renameSync(successorPath, databasePath)
    }
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({
      root,
    })

    assert.equal(missingRecoveryObservations, 1)
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 0)
    assert.deepEqual(result, { hydrated: false, recordsIndexed: 1 })
    assert.equal(existsSync(predecessorPath), true)
    const currentIdentity = lstatSync(databasePath, { bigint: true })
    assert.deepEqual(
      { dev: currentIdentity.dev, ino: currentIdentity.ino },
      { dev: successorIdentity.dev, ino: successorIdentity.ino },
    )
  })

  test('reuses an exclusively claimed primary across repository-change retries', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'retry-cache-predecessor.sqlite')
    let recoveryRebuilds = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'prepare-fast-path') {
        renameSync(databasePath, predecessorPath)
      }
      if (phase === 'reader-missing') {
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      recoveryRebuilds += 1
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
        if (writerInitialisations === 1) {
          const recordPath = join(root, String(record.path))
          writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')} `)
        }
      }
    }

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({
      root,
    })

    assert.equal(recoveryRebuilds, 1)
    assert.equal(writerInitialisations, 2)
    assert.deepEqual(result, { hydrated: true, recordsIndexed: 1 })
    assert.equal(existsSync(predecessorPath), true)
  })

  test('retries an exclusively created primary that disappears before inspection', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'missing-bootstrap-predecessor.sqlite')
    const disappearedClaimPath = join(root, 'missing-bootstrap-claim.sqlite')
    let disappearedClaims = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'prepare-fast-path') {
        renameSync(databasePath, predecessorPath)
      }
      if (phase === 'reader-missing') {
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheLocationTestHooks.afterPrimaryBootstrapClose = path => {
      if (basename(path) === 'brain.sqlite' && disappearedClaims === 0) {
        renameSync(path, disappearedClaimPath)
        disappearedClaims += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(api.prepare({ root }), { hydrated: true, recordsIndexed: 1 })
    assert.equal(disappearedClaims, 1)
    assert.equal(writerInitialisations, 1)
    assert.equal(existsSync(predecessorPath), true)
    assert.equal(existsSync(disappearedClaimPath), true)
  })

  test('rejects a non-empty exclusively claimed primary before a repository-change retry', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'non-empty-retry-cache-predecessor.sqlite')
    let canonicalValidations = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'prepare-fast-path') {
        renameSync(databasePath, predecessorPath)
      }
      if (phase === 'reader-missing') {
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheReadTestHooks.afterCanonicalValidation = () => {
      canonicalValidations += 1
      if (canonicalValidations === 2) {
        mutateCache(root, database => {
          database.prepare("INSERT INTO record_search(id, text) VALUES ('injected-retry-row', 'untrusted')").run()
        })
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
        if (writerInitialisations === 1) {
          const recordPath = join(root, String(record.path))
          writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')} `)
        }
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
        return true
      },
    )
    assert.equal(writerInitialisations, 1)
    const preserved = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(
        preserved.prepare("SELECT COUNT(*) AS count FROM record_search WHERE id = 'injected-retry-row'").get()?.count,
        1,
      )
    } finally {
      preserved.close()
    }
  })

  test('rejects a non-empty exclusively claimed primary after writer initialisation', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'post-initialisation-retry-cache-predecessor.sqlite')
    let writerInitialisations = 0
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'prepare-fast-path') {
        renameSync(databasePath, predecessorPath)
      }
      if (phase === 'reader-missing') {
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
        if (writerInitialisations === 1) {
          const recordPath = join(root, String(record.path))
          writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')} `)
        }
        if (writerInitialisations === 2) {
          mutateCache(root, database => {
            database
              .prepare("INSERT INTO record_search(id, text) VALUES ('post-initialisation-row', 'untrusted')")
              .run()
          })
        }
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
        return true
      },
    )
    assert.equal(writerInitialisations, 2)
    const preserved = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(
        preserved.prepare("SELECT COUNT(*) AS count FROM record_search WHERE id = 'post-initialisation-row'").get()
          ?.count,
        1,
      )
    } finally {
      preserved.close()
    }
  })

  test('preserves a successor swapped between exclusively claimed primary retries', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'swapped-retry-cache-predecessor.sqlite')
    const claimedPath = join(root, 'swapped-retry-cache-claim.sqlite')
    const successorPath = join(root, 'swapped-retry-cache-successor.sqlite')
    const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true })
    sourceDatabase.prepare('VACUUM INTO ?').run(successorPath)
    sourceDatabase.close()
    const successorBytes = readFileSync(successorPath)
    const successorIdentity = lstatSync(successorPath, { bigint: true })
    let canonicalValidations = 0
    let primaryQuarantines = 0
    let repositoryRetryInjected = false
    let successorInstalled = false
    let successorWriterInitialisations = 0
    let writerOpened = false
    let writerInitialisations = 0
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'prepare-fast-path') {
        renameSync(databasePath, predecessorPath)
      }
      if (phase === 'reader-missing') {
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheReadTestHooks.afterCanonicalValidation = () => {
      canonicalValidations += 1
      if (canonicalValidations === 2) {
        for (const suffix of ['-wal', '-shm', '-journal']) {
          const sidecarPath = `${databasePath}${suffix}`
          if (existsSync(sidecarPath)) {
            renameSync(sidecarPath, `${claimedPath}${suffix}`)
          }
        }
        renameSync(databasePath, claimedPath)
        renameSync(successorPath, databasePath)
        successorInstalled = true
      }
    }
    cacheReadTestHooks.beforeCacheSnapshotCommit = () => {
      if (writerOpened && !repositoryRetryInjected) {
        repositoryRetryInjected = true
        return 'repository-changed'
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
        writerOpened = true
        const currentIdentity = lstatSync(databasePath, { bigint: true })
        if (
          successorInstalled &&
          currentIdentity.dev === successorIdentity.dev &&
          currentIdentity.ino === successorIdentity.ino
        ) {
          successorWriterInitialisations += 1
        }
      }
    }
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({
      root,
    })

    assert.equal(canonicalValidations, 2)
    assert.equal(primaryQuarantines, 0)
    assert.equal(repositoryRetryInjected, true)
    assert.ok(writerInitialisations >= 1)
    assert.equal(successorWriterInitialisations, 0)
    assert.deepEqual(result, { hydrated: false, recordsIndexed: 1 })
    assert.equal(existsSync(predecessorPath), true)
    assert.equal(existsSync(claimedPath), true)
    const currentIdentity = lstatSync(databasePath, { bigint: true })
    assert.deepEqual(
      { dev: currentIdentity.dev, ino: currentIdentity.ino },
      { dev: successorIdentity.dev, ino: successorIdentity.ino },
    )
    assert.deepEqual(readFileSync(databasePath), successorBytes)
  })

  test('binds a create-if-missing claim across repository-change retries', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'create-if-missing-predecessor.sqlite')
    const claimedPath = join(root, 'create-if-missing-claim.sqlite')
    const successorPath = join(root, 'create-if-missing-successor.sqlite')
    const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true })
    sourceDatabase.prepare('VACUUM INTO ?').run(successorPath)
    sourceDatabase.close()
    const successorBytes = readFileSync(successorPath)
    const successorIdentity = lstatSync(successorPath, { bigint: true })
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const sourcePath = `${databasePath}${suffix}`
      if (existsSync(sourcePath)) {
        renameSync(sourcePath, `${predecessorPath}${suffix}`)
      }
    }
    let canonicalValidations = 0
    let primaryQuarantines = 0
    let repositoryRetryInjected = false
    let successorInstalled = false
    let successorWriterInitialisations = 0
    let writerOpened = false
    let writerInitialisations = 0
    cacheReadTestHooks.afterCanonicalValidation = () => {
      canonicalValidations += 1
      if (canonicalValidations === 2) {
        for (const suffix of ['-wal', '-shm', '-journal']) {
          const sidecarPath = `${databasePath}${suffix}`
          if (existsSync(sidecarPath)) {
            renameSync(sidecarPath, `${claimedPath}${suffix}`)
          }
        }
        renameSync(databasePath, claimedPath)
        renameSync(successorPath, databasePath)
        successorInstalled = true
      }
    }
    cacheReadTestHooks.beforeCacheSnapshotCommit = () => {
      if (writerOpened && !repositoryRetryInjected) {
        repositoryRetryInjected = true
        return 'repository-changed'
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
        writerOpened = true
        const currentIdentity = lstatSync(databasePath, { bigint: true })
        if (
          successorInstalled &&
          currentIdentity.dev === successorIdentity.dev &&
          currentIdentity.ino === successorIdentity.ino
        ) {
          successorWriterInitialisations += 1
        }
      }
    }
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/brain.sqlite',
          invariant: 'stable-identity',
        })
        return true
      },
    )
    assert.equal(canonicalValidations, 2)
    assert.equal(primaryQuarantines, 0)
    assert.equal(repositoryRetryInjected, true)
    assert.equal(writerInitialisations, 1)
    assert.equal(successorWriterInitialisations, 0)
    assert.equal(existsSync(predecessorPath), true)
    assert.equal(existsSync(claimedPath), true)
    const currentIdentity = lstatSync(databasePath, { bigint: true })
    assert.equal(sameCacheEntryIdentity(successorIdentity, currentIdentity), true)
    assert.deepEqual(readFileSync(databasePath), successorBytes)
  })

  test('owns an exclusively created primary before its first SQLite open', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'exclusive-open-predecessor.sqlite')
    const claimedPath = join(root, 'exclusive-open-claim.sqlite')
    const successorPath = join(root, 'exclusive-open-successor.sqlite')
    const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true })
    sourceDatabase.prepare('VACUUM INTO ?').run(successorPath)
    sourceDatabase.close()
    const successorBytes = readFileSync(successorPath)
    const successorIdentity = lstatSync(successorPath, { bigint: true })
    let primaryQuarantines = 0
    let replacements = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'prepare-fast-path') {
        renameSync(databasePath, predecessorPath)
      }
      if (phase === 'reader-missing') {
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheLocationTestHooks.beforeDatabaseOpen = database => {
      if (database.name === 'brain.sqlite') {
        cacheLocationTestHooks.beforeDatabaseOpen = undefined
        renameSync(databasePath, claimedPath)
        renameSync(successorPath, databasePath)
        replacements += 1
      }
    }
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(api.prepare({ root }), { hydrated: false, recordsIndexed: 1 })
    assert.equal(replacements, 1)
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 0)
    assert.equal(existsSync(predecessorPath), true)
    assert.equal(existsSync(claimedPath), true)
    const currentIdentity = lstatSync(databasePath, { bigint: true })
    assert.deepEqual(
      { dev: currentIdentity.dev, ino: currentIdentity.ino },
      { dev: successorIdentity.dev, ino: successorIdentity.ino },
    )
    assert.deepEqual(readFileSync(databasePath), successorBytes)
  })

  test('recovers a primary that disappears before its first verified open', () => {
    const cases = [
      { expectedHydrated: true, name: 'primary remains absent', successor: false },
      {
        expectedHydrated: false,
        name: 'successor appears after missing observation',
        successor: true,
      },
    ] as const

    for (const { expectedHydrated, name, successor } of cases) {
      const root = createRoot()
      addCacheRecord(root)
      const databasePath = cacheDatabasePath(root)
      const predecessorPath = join(root, `pre-open-missing-${successor ? 'successor' : 'absent'}.sqlite`)
      const successorPath = join(root, `pre-open-successor-${successor ? 'ready' : 'unused'}.sqlite`)
      if (successor) {
        const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true })
        sourceDatabase.prepare('VACUUM INTO ?').run(successorPath)
        sourceDatabase.close()
      }
      const successorBytes = successor ? readFileSync(successorPath) : undefined
      const successorIdentity = successor ? lstatSync(successorPath, { bigint: true }) : undefined
      let missingObservations = 0
      let primaryQuarantines = 0
      let writerInitialisations = 0
      cacheLocationTestHooks.beforeDatabaseOpen = database => {
        if (database.name === 'brain.sqlite') {
          cacheLocationTestHooks.beforeDatabaseOpen = undefined
          renameSync(databasePath, predecessorPath)
        }
      }
      cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
        if (phase === 'reader-missing') {
          missingObservations += 1
          cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
          if (successor) {
            renameSync(successorPath, databasePath)
          }
        }
      }
      cacheLocationTestHooks.beforeQuarantineRename = path => {
        if (basename(path) === 'brain.sqlite') {
          primaryQuarantines += 1
        }
      }
      cacheReadTestHooks.duringDatabaseInitialisation = mode => {
        if (mode === 'writer') {
          writerInitialisations += 1
        }
      }

      assert.deepEqual(api.prepare({ root }), { hydrated: expectedHydrated, recordsIndexed: 1 }, name)
      assert.equal(missingObservations, 1, name)
      assert.equal(primaryQuarantines, 0, name)
      assert.equal(writerInitialisations, successor ? 0 : 1, name)
      assert.equal(existsSync(predecessorPath), true, name)
      if (successorIdentity !== undefined && successorBytes !== undefined) {
        const currentIdentity = lstatSync(databasePath, { bigint: true })
        assert.deepEqual(
          { dev: currentIdentity.dev, ino: currentIdentity.ino },
          { dev: successorIdentity.dev, ino: successorIdentity.ino },
          name,
        )
        assert.deepEqual(readFileSync(databasePath), successorBytes, name)
      }
      cacheLocationTestHooks.beforeDatabaseOpen = undefined
      cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      cacheLocationTestHooks.beforeQuarantineRename = undefined
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
    }
  })

  test('recovers primary disappearance after SQLite construction before verified read', {
    skip: process.platform === 'win32' ? 'Windows cannot rename an open SQLite primary.' : false,
  }, () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const predecessorPath = join(root, 'post-construction-missing-primary.sqlite')
    let missingObservations = 0
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.afterDatabaseOpen = database => {
      if (database.name === 'brain.sqlite') {
        cacheLocationTestHooks.afterDatabaseOpen = undefined
        renameSync(databasePath, predecessorPath)
      }
    }
    cacheReadTestHooks.afterPrimaryDatabaseObservation = phase => {
      if (phase === 'reader-missing') {
        missingObservations += 1
        cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
      }
    }
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(api.prepare({ root }), { hydrated: true, recordsIndexed: 1 })
    assert.equal(missingObservations, 1)
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 1)
    assert.equal(existsSync(predecessorPath), true)
  })

  test('prepare returns its completed recovery rebuild without rebuilding changed canonical inputs again', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    writeFileSync(cacheDatabasePath(root), 'not a sqlite database')
    let recoveryRebuilds = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      recoveryRebuilds += 1
      cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = undefined
      const recordPath = join(root, String(record.path))
      writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')} `)
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({
      root,
    })

    assert.equal(recoveryRebuilds, 1)
    assert.equal(writerInitialisations, 1)
    assert.deepEqual(result, { hydrated: true, recordsIndexed: 1 })
  })

  test('rebuilds a disposable cache with an incompatible table schema', () => {
    const root = createRoot()
    const path = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    mkdirSync(join(root, 'node_modules', '.cache', 'encephalon'), {
      recursive: true,
    })
    const database = new DatabaseSync(path)
    database.exec('CREATE TABLE metadata (wrong_column TEXT)')
    database.close()

    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('rebuilds metadata tables with incompatible semantics', () => {
    const cases = [
      { definition: 'key TEXT, value TEXT NOT NULL', name: 'missing primary key' },
      { definition: 'key TEXT PRIMARY KEY, value TEXT', name: 'nullable value' },
      { definition: 'key BLOB PRIMARY KEY, value TEXT NOT NULL', name: 'declared key type' },
      {
        definition: "key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT 'private-schema-sentinel'",
        name: 'value default',
      },
      {
        definition: 'key TEXT PRIMARY KEY, value TEXT NOT NULL, diagnostic TEXT GENERATED ALWAYS AS (key) VIRTUAL',
        name: 'generated column',
      },
      {
        definition: 'key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (length(value) > 0)',
        name: 'additional table constraint',
      },
      {
        definition: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
        name: 'strict table',
        tableOptions: 'STRICT',
      },
      {
        definition: 'key TEXT PRIMARY KEY, value TEXT NOT NULL',
        name: 'without-rowid table',
        tableOptions: 'WITHOUT ROWID',
      },
    ] as const

    for (const fixture of cases) {
      const root = createRoot()
      addCacheRecord(root)
      mutateCache(root, database => {
        database.exec(`
          CREATE TABLE replacement_metadata(${fixture.definition}) ${'tableOptions' in fixture ? fixture.tableOptions : ''};
          INSERT INTO replacement_metadata(key, value) SELECT key, value FROM metadata;
          DROP TABLE metadata;
          ALTER TABLE replacement_metadata RENAME TO metadata;
        `)
      })

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: 1 },
        fixture.name,
      )
    }
  })

  test('accepts semantically equivalent legacy table definitions without rebuilding', () => {
    const root = createRoot()
    addCacheRecord(root)
    let primaryQuarantines = 0
    let writerInitialisations = 0
    mutateCache(root, database => {
      database.enableDefensive(false)
      database.exec('PRAGMA writable_schema = ON;')
      database
        .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'metadata'")
        .run('CREATE TABLE IF NOT EXISTS "metadata" ("key" text PRIMARY KEY, "value" text NOT NULL)')
      database
        .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'records'")
        .run(`CREATE TABLE IF NOT EXISTS "records" (
            "id" text PRIMARY KEY,
            "kind" text NOT NULL,
            "subject" text NOT NULL,
            "source" text NOT NULL,
            "created_at" text NOT NULL,
            "path" text NOT NULL,
            "active" integer NOT NULL CHECK ("active" IN (0, 1)),
            "summary" text,
            "record_json" text NOT NULL
          )
        `)
      database.exec('PRAGMA writable_schema = OFF;')
    })
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({
      root,
    })
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 0)
    assert.deepEqual(result, { hydrated: false, recordsIndexed: 1 })
  })

  test('rebuilds same-name records tables with incompatible semantics', () => {
    const cases = [
      {
        name: 'records primary key',
        recordsDefinition: `
          id TEXT,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          path TEXT NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          summary TEXT,
          record_json TEXT NOT NULL
        `,
      },
      {
        name: 'records nullability',
        recordsDefinition: `
          id TEXT PRIMARY KEY,
          kind TEXT,
          subject TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          path TEXT NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          summary TEXT,
          record_json TEXT NOT NULL
        `,
      },
      {
        name: 'records declared type',
        recordsDefinition: `
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          path TEXT NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          summary BLOB,
          record_json TEXT NOT NULL
        `,
      },
      {
        name: 'records default',
        recordsDefinition: `
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          path TEXT NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          summary TEXT DEFAULT 'private-schema-sentinel',
          record_json TEXT NOT NULL
        `,
      },
      {
        name: 'records active constraint',
        recordsDefinition: `
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          path TEXT NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1, 2)),
          summary TEXT,
          record_json TEXT NOT NULL
        `,
      },
    ] as const

    for (const fixture of cases) {
      const root = createRoot()
      addCacheRecord(root)
      mutateCache(root, database => {
        database.exec(`
          CREATE TABLE replacement_records (${fixture.recordsDefinition});
          INSERT INTO replacement_records
            SELECT id, kind, subject, source, created_at, path, active, summary, record_json FROM records;
          DROP TABLE records;
          ALTER TABLE replacement_records RENAME TO records;
          CREATE INDEX records_active_order ON records(active, created_at DESC, id DESC);
          CREATE INDEX records_kind_subject ON records(kind, subject);
        `)
      })

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: 1 },
        fixture.name,
      )
    }
  })

  test('rejects PK-less duplicate metadata before metadata text transfer', () => {
    const root = createRoot()
    addCacheRecord(root)
    mutateCache(root, database => {
      database.exec(`
        CREATE TABLE replacement_metadata(key TEXT, value TEXT NOT NULL);
        INSERT INTO replacement_metadata SELECT key, value FROM metadata WHERE key != 'repositoryRealpath';
        INSERT INTO replacement_metadata SELECT key, value FROM metadata WHERE key = 'manifest';
        DROP TABLE metadata;
        ALTER TABLE replacement_metadata RENAME TO metadata;
      `)
    })
    const observations = observeCacheIntegrity()

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 1,
    })
    assert.equal(
      observations.some(observation => observation.kind === 'text-read' && observation.name === 'metadata'),
      false,
    )
  })

  test('rebuilds caches with incompatible required records indexes', () => {
    const cases = [
      {
        mutate: (database: DatabaseSync) => {
          database.exec('DROP INDEX records_active_order;')
        },
        name: 'missing active-order index',
      },
      {
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DROP INDEX records_active_order;
            CREATE INDEX renamed_active_order ON records(active, created_at DESC, id DESC);
          `)
        },
        name: 'renamed active-order index',
      },
      {
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DROP INDEX records_active_order;
            CREATE INDEX records_active_order ON records(created_at DESC, active, id DESC);
          `)
        },
        name: 'reordered active-order columns',
      },
      {
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DROP INDEX records_active_order;
            CREATE INDEX records_active_order ON records(active, created_at, id DESC);
          `)
        },
        name: 'changed active-order direction',
      },
      {
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DROP INDEX records_kind_subject;
            CREATE INDEX records_kind_subject ON records(subject, kind);
          `)
        },
        name: 'reordered kind-subject columns',
      },
      {
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DROP INDEX records_kind_subject;
            CREATE INDEX records_kind_subject ON records(kind COLLATE NOCASE, subject);
          `)
        },
        name: 'changed kind-subject collation',
      },
      {
        mutate: (database: DatabaseSync) => {
          database.exec('CREATE INDEX records_extra ON records(source);')
        },
        name: 'additional application index',
      },
      {
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DROP INDEX records_active_order;
            CREATE UNIQUE INDEX records_active_order ON records(active, created_at DESC, id DESC);
          `)
        },
        name: 'unique active-order index',
      },
      {
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DROP INDEX records_active_order;
            CREATE INDEX records_active_order ON records(active, created_at DESC, id DESC) WHERE active = 1;
          `)
        },
        name: 'partial active-order index',
      },
    ] as const

    for (const fixture of cases) {
      const root = createRoot()
      addCacheRecord(root)
      mutateCache(root, fixture.mutate)

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: 1 },
        fixture.name,
      )
    }

    const validRoot = createRoot()
    addCacheRecord(validRoot)
    mutateCache(validRoot, database => {
      database.exec(`
        DROP INDEX records_active_order;
        DROP INDEX records_kind_subject;
        CREATE INDEX records_kind_subject ON records(kind, subject);
        CREATE INDEX records_active_order ON records(active, created_at DESC, id DESC);
      `)
    })
    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root: validRoot }), {
      hydrated: false,
      recordsIndexed: 1,
    })
  })

  test('rebuilds caches with incompatible FTS5 semantics', () => {
    const cases = [
      {
        definition: 'CREATE TABLE record_search(id TEXT, text TEXT)',
        name: 'ordinary table',
      },
      {
        definition: 'CREATE VIRTUAL TABLE record_search USING fts5(id, text)',
        name: 'indexed id',
      },
      {
        definition: 'CREATE VIRTUAL TABLE record_search USING fts5(id UNINDEXED, text UNINDEXED)',
        name: 'unindexed text',
      },
      {
        definition: 'CREATE VIRTUAL TABLE record_search USING fts5(text, id UNINDEXED)',
        name: 'reversed columns',
      },
      {
        definition: "CREATE VIRTUAL TABLE record_search USING fts5(id UNINDEXED, text, tokenize='porter')",
        name: 'changed tokenizer',
      },
    ] as const

    for (const fixture of cases) {
      const root = createRoot()
      addCacheRecord(root)
      mutateCache(root, database => {
        database.enableDefensive(false)
        database.exec(`
          CREATE TEMP TABLE saved_search AS SELECT id, text FROM record_search;
          DROP TABLE record_search;
          ${fixture.definition};
          INSERT INTO record_search(id, text) SELECT id, text FROM saved_search;
        `)
      })

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: 1 },
        fixture.name,
      )
    }

    const validRoot = createRoot()
    addCacheRecord(validRoot)
    mutateCache(validRoot, database => {
      database.enableDefensive(false)
      database.exec(`
        CREATE TEMP TABLE saved_search AS SELECT id, text FROM record_search;
        DROP TABLE record_search;
        create virtual table "record_search" using FTS5(
          "id" unindexed,
          "text"
        );
        INSERT INTO record_search(id, text) SELECT id, text FROM saved_search;
      `)
    })
    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root: validRoot }), {
      hydrated: false,
      recordsIndexed: 1,
    })
  })

  test('recovers an unavailable private FTS module before introspecting columns', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    const privateSentinel = 'private_customer_module_sentinel'
    let primaryQuarantines = 0
    let writerInitialisations = 0
    mutateCache(root, database => {
      database.enableDefensive(false)
      database.exec('PRAGMA writable_schema = ON;')
      database
        .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'record_search'")
        .run(`CREATE VIRTUAL TABLE record_search USING ${privateSentinel}(id UNINDEXED, text)`)
      database.exec('PRAGMA writable_schema = OFF;')
    })
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    const listed = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
      root,
    })

    assert.deepEqual(
      listed.map(entry => entry.id),
      [record.id],
    )
    assert.equal(primaryQuarantines, 1)
    assert.equal(writerInitialisations, 1)
  })

  test('quarantines an incompatible existing schema instead of repairing it in place', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    mutateCache(root, database => {
      database.exec('DROP INDEX records_active_order;')
    })
    const incompatibleIdentity = lstatSync(databasePath, { bigint: true })
    let primaryQuarantines = 0
    let quarantinedIncompatiblePrimaries = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        const current = lstatSync(path, { bigint: true })
        assert.equal(current.dev, incompatibleIdentity.dev)
        assert.equal(current.ino, incompatibleIdentity.ino)
        primaryQuarantines += 1
      }
    }
    cacheLocationTestHooks.afterQuarantineRename = path => {
      if (path.includes('.brain.sqlite.')) {
        const quarantined = lstatSync(path, { bigint: true })
        assert.equal(sameCacheEntryIdentity(incompatibleIdentity, quarantined), true)
        quarantinedIncompatiblePrimaries += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }), {
      recordsIndexed: 1,
    })
    assert.equal(primaryQuarantines, 1)
    assert.equal(quarantinedIncompatiblePrimaries, 1)
    assert.equal(writerInitialisations, 1)
    const rebuilt = new DatabaseSync(databasePath, { readOnly: true })
    try {
      assert.equal(
        rebuilt
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'records_active_order'")
          .get()?.count,
        1,
      )
    } finally {
      rebuilt.close()
    }
  })

  test('quarantines an existing metadata-less cache before mutating bounded tables', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    mutateCache(root, database => {
      database.exec(`
        DELETE FROM metadata;
        WITH RECURSIVE generated(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM generated WHERE value < 1001
        )
        INSERT INTO record_search(id, text)
        SELECT printf('metadata-less-%04d', value), 'untrusted search text'
        FROM generated;
      `)
    })
    const original = lstatSync(databasePath, { bigint: true })
    let exactQuarantines = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        const current = lstatSync(path, { bigint: true })
        if (current.dev === original.dev && current.ino === original.ino) {
          exactQuarantines += 1
        }
      }
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 1,
    })
    assert.equal(exactQuarantines, 1)
  })

  test('recovers one exact semantically incompatible cache during a public read', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    mutateCache(root, database => {
      database.exec(`
        DROP INDEX records_kind_subject;
        CREATE INDEX records_kind_subject ON records(subject, kind);
      `)
    })
    const incompatibleIdentity = lstatSync(databasePath, { bigint: true })
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        const current = lstatSync(path, { bigint: true })
        assert.equal(current.dev, incompatibleIdentity.dev)
        assert.equal(current.ino, incompatibleIdentity.ino)
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    const listed = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
      root,
    })
    assert.deepEqual(
      listed.map(candidate => candidate.id),
      [record.id],
    )
    assert.equal(primaryQuarantines, 1)
    assert.equal(writerInitialisations, 1)
    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: false,
      recordsIndexed: 1,
    })
  })

  test('pins writer schema probes before rebuild metadata and mutation', () => {
    const root = createRoot()
    addCacheRecord(root)
    let mutations = 0
    let recoveryRebuilds = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      recoveryRebuilds += 1
    }
    cacheReadTestHooks.beforeIntegrityTextRead = name => {
      if (name === 'metadata-columns' && mutations === 0) {
        mutations += 1
        mutateCache(root, database => {
          database.exec('DROP INDEX records_kind_subject;')
        })
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }), {
      recordsIndexed: 1,
    })
    assert.equal(mutations, 1)
    assert.equal(recoveryRebuilds, 1)
    assert.equal(writerInitialisations, 1)
  })

  test('validates each fresh cache generation once per public read', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    const cases = [
      {
        name: 'list',
        read: () =>
          functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({ root }).map(
            item => item.id,
          ),
        result: [record.id],
      },
      {
        name: 'show',
        read: () =>
          functionFromApi<(input: Record<string, unknown>) => Record<string, unknown> | null>('showRecord')({
            id: record.id,
            root,
          })?.id,
        result: record.id,
      },
      {
        name: 'full search',
        read: () =>
          functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')({
            query: 'recoverable cache row',
            root,
          }).map(item => item.id),
        result: [record.id],
      },
      {
        name: 'compact search',
        read: () =>
          functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchCompactRecords')({
            query: 'recoverable cache row',
            root,
          }).map(item => item.id),
        result: [record.id],
      },
      {
        name: 'gather',
        read: () => {
          const result = functionFromApi<
            (input: Record<string, unknown>) => {
              records: Array<{ record: { id?: unknown } | null }>
              searches: Array<{ results: Array<{ id?: unknown }> }>
            }
          >('gatherRecords')({
            root,
            searches: ['recoverable cache row'],
            shows: [record.id],
          })
          return [result.records[0]?.record?.id, result.searches[0]?.results[0]?.id]
        },
        result: [record.id, record.id],
      },
    ] as const

    for (const entry of cases) {
      let validationPasses = 0
      cacheReadTestHooks.afterIntegrityProbe = observation => {
        if (observation.name === 'record-search') {
          validationPasses += 1
        }
      }
      const result = entry.read()
      assert.deepEqual(result, entry.result, entry.name)
      assert.equal(validationPasses, 1, entry.name)
    }
  })

  test('validates a forced gather rebuild once before materialising its result', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    let readerInitialisations = 0
    let writerInitialisations = 0
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'reader') {
        readerInitialisations += 1
      } else {
        writerInitialisations += 1
      }
    }

    const result = functionFromApi<
      (input: Record<string, unknown>) => {
        hydrated: { recordsIndexed?: unknown } | null
        records: Array<{ record: { id?: unknown } | null }>
        searches: Array<{ results: Array<{ id?: unknown }> }>
      }
    >('gatherRecords')({
      hydrate: true,
      root,
      searches: ['recoverable cache row'],
      shows: [record.id],
    })

    assert.equal(result.hydrated?.recordsIndexed, 1)
    assert.equal(result.records[0]?.record?.id, record.id)
    assert.equal(result.searches[0]?.results[0]?.id, record.id)
    assert.equal(readerInitialisations, 1)
    assert.equal(writerInitialisations, 1)
  })

  test('does not rebuild twice when canonical state changes before the post-rebuild read', () => {
    const cases = [
      {
        arrange: (root: string) => {
          renameSync(cacheDatabasePath(root), join(root, 'missing-read-predecessor.sqlite'))
        },
        name: 'automatic list',
        read: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ root }),
      },
      {
        arrange: (_root: string) => undefined,
        name: 'forced gather hydration',
        read: (root: string) =>
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            hydrate: true,
            root,
          }),
      },
    ]

    for (const entry of cases) {
      const root = createRoot()
      const record = addCacheRecord(root)
      entry.arrange(root)
      let readerInitialisations = 0
      let writerInitialisations = 0
      cacheReadTestHooks.duringDatabaseInitialisation = mode => {
        if (mode === 'reader') {
          readerInitialisations += 1
          if (readerInitialisations === 1) {
            const { path, ...recordFile } = record
            writeFileSync(
              join(root, String(path)),
              `${JSON.stringify({ ...recordFile, payload: { summary: 'Changed after rebuild' } }, null, 2)}\n`,
            )
          }
        } else {
          writerInitialisations += 1
        }
      }

      assert.throws(
        () => entry.read(root),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED', entry.name)
          return true
        },
      )
      assert.equal(readerInitialisations, 1, entry.name)
      assert.equal(writerInitialisations, 1, entry.name)
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
    }
  })

  test('preserves a stale successor installed after corrupt-cache recovery', () => {
    const cases = [
      {
        name: 'automatic list',
        read: (root: string) => functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ root }),
      },
      {
        name: 'forced gather hydration',
        read: (root: string) =>
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({
            hydrate: true,
            root,
          }),
      },
    ]

    for (const entry of cases) {
      const root = createRoot()
      const record = addCacheRecord(root)
      const databasePath = cacheDatabasePath(root)
      const successorSource = join(root, 'post-rebuild-successor.sqlite')
      const displacedRebuild = join(root, 'post-rebuild-owned.sqlite')
      copyFileSync(databasePath, successorSource)
      mutateCache(root, database => {
        database.prepare("UPDATE record_search SET text = 'corrupt' WHERE id = ?").run(String(record.id))
      })
      let recoveryRebuilds = 0
      let writerInitialisations = 0
      cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
        recoveryRebuilds += 1
        const { path, ...recordFile } = record
        writeFileSync(
          join(root, String(path)),
          `${JSON.stringify({ ...recordFile, payload: { summary: 'Changed before successor read' } }, null, 2)}\n`,
        )
        renameSync(databasePath, displacedRebuild)
        copyFileSync(successorSource, databasePath)
      }
      cacheReadTestHooks.duringDatabaseInitialisation = mode => {
        if (mode === 'writer') {
          writerInitialisations += 1
        }
      }

      assert.throws(
        () => entry.read(root),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED', entry.name)
          return true
        },
      )
      assert.equal(recoveryRebuilds, 1, entry.name)
      assert.equal(writerInitialisations, 1, entry.name)
      assert.deepEqual(readFileSync(databasePath), readFileSync(successorSource), entry.name)
      cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = undefined
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
    }
  })

  test('normalises repeated SQLite schema failures before public wrapping', () => {
    const root = createRoot()
    addCacheRecord(root)
    const privateSentinel = 'private_schema_parser_sentinel'
    let schemaFailures = 0
    cacheReadTestHooks.afterIntegrityProbe = observation => {
      if (observation.name === 'metadata-columns') {
        schemaFailures += 1
        throw Object.assign(new Error(`malformed database schema (${privateSentinel})`), {
          code: 'SQLITE_CORRUPT',
        })
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        assert.doesNotMatch(causeChainText(error), new RegExp(privateSentinel, 'u'))
        return true
      },
    )
    assert.equal(schemaFailures, 2)
  })

  test('rebuilds an empty read-only cache file through writer preparation', {
    skip: process.platform === 'win32' ? 'Windows read-only file replacement semantics differ.' : false,
  }, () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    mkdirSync(join(root, 'node_modules', '.cache', 'encephalon'), {
      recursive: true,
    })
    writeFileSync(cachePath, '')
    chmodSync(cachePath, 0o444)

    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })
  })

  test('quarantines one exact cache after a platform-neutral SQLite readonly failure', () => {
    const root = createRoot()
    addCacheRecord(root)
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
        if (writerInitialisations === 1) {
          throw Object.assign(new Error('read-only recovery'), { errcode: 264 })
        }
      }
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }), {
      recordsIndexed: 1,
    })
    assert.equal(primaryQuarantines, 1)
    assert.equal(writerInitialisations, 2)
  })

  test('quarantines an exact forced-writer cache after a query-time corrupt failure', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const originalIdentity = lstatSync(databasePath, { bigint: true })
    let primaryQuarantines = 0
    let queryFailures = 0
    let recoveryRebuilds = 0
    let writerInitialisations = 0
    cacheReadTestHooks.afterIntegrityProbe = observation => {
      if (observation.name === 'metadata' && queryFailures === 0) {
        queryFailures += 1
        throw Object.assign(new Error('database disk image is malformed'), {
          code: 'SQLITE_CORRUPT',
        })
      }
    }
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        const currentIdentity = lstatSync(path, { bigint: true })
        assert.deepEqual(
          { dev: currentIdentity.dev, ino: currentIdentity.ino },
          { dev: originalIdentity.dev, ino: originalIdentity.ino },
        )
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      recoveryRebuilds += 1
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(api.hydrate({ root }), { recordsIndexed: 1 })
    assert.equal(queryFailures, 1)
    assert.equal(primaryQuarantines, 1)
    assert.equal(recoveryRebuilds, 1)
    assert.equal(writerInitialisations, 1)
  })

  test('revalidates exact FTS content after writer initialisation and before rebuild mutation', () => {
    const root = createRoot()
    addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const original = lstatSync(databasePath, { bigint: true })
    let exactQuarantines = 0
    let mutated = false
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        const current = lstatSync(path, { bigint: true })
        if (current.dev === original.dev && current.ino === original.ino) {
          exactQuarantines += 1
        }
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
        if (!mutated) {
          mutated = true
          mutateCache(root, database => {
            database.prepare("UPDATE record_search SET text = 'mutated after writer initialisation'").run()
          })
        }
      }
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }), {
      recordsIndexed: 1,
    })
    assert.equal(exactQuarantines, 1)
    assert.equal(writerInitialisations, 2)
  })

  test('reads a fresh cache without touching the database file', () => {
    const root = createRoot()
    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'read-only-cache-record',
      kind: 'context',
      payload: { summary: 'Read-only cache access' },
      root,
      searchText: 'stable reader metadata',
      source: 'agent',
      subject: 'cache.reader',
    })
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    const before = statSync(cachePath, { bigint: true }).mtimeNs

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    const showRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown> | null>('showRecord')
    const searchRecords =
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')
    const gatherRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')
    assert.equal(listRecords({ root })[0]?.id, record.id)
    assert.equal(showRecord({ id: record.id, root })?.id, record.id)
    assert.equal(searchRecords({ query: 'stable metadata', root })[0]?.id, record.id)
    assert.equal(
      (
        gatherRecords({ root, searches: ['stable reader'], shows: [record.id] }) as {
          records: Array<{ record: { id: string } | null }>
        }
      ).records[0]?.record?.id,
      record.id,
    )

    assert.equal(statSync(cachePath, { bigint: true }).mtimeNs, before)
  })

  test('waits for a concurrent SQLite writer before reading', async () => {
    const root = createRoot()
    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'read-after-sqlite-writer',
      kind: 'context',
      payload: { summary: 'Read waits for writer' },
      root,
      source: 'agent',
      subject: 'cache.reader',
    })
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    const readyPath = join(root, 'cache-writer-ready')
    const holder = spawn(
      process.execPath,
      [join(import.meta.dirname, 'fixtures', 'hold-cache-database-lock.ts'), cachePath, readyPath, '250'],
      { stdio: 'inherit' },
    )
    waitForPath(readyPath, holder)

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    assert.equal(listRecords({ root })[0]?.id, record.id)
    if (holder.exitCode === null) {
      await once(holder, 'exit')
    }
    assert.equal(holder.exitCode, 0)
  })

  test('returns a bounded error when a SQLite writer outlives the reader timeout', async () => {
    const root = createRoot()
    functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'blocked-by-sqlite-writer',
      kind: 'context',
      payload: { summary: 'Writer outlives reader timeout' },
      root,
      source: 'agent',
      subject: 'cache.reader',
    })
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite')
    const readyPath = join(root, 'cache-writer-timeout-ready')
    const holder = spawn(
      process.execPath,
      [join(import.meta.dirname, 'fixtures', 'hold-cache-database-lock.ts'), cachePath, readyPath, '4500'],
      { stdio: 'inherit' },
    )
    waitForPath(readyPath, holder)

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    const startedAt = Date.now()
    assert.throws(
      () => listRecords({ root }),
      (error: unknown) => {
        const candidate = error as { cause?: unknown; code?: unknown; message?: unknown }
        const cause = candidate.cause as { message?: unknown } | undefined
        assert.equal(candidate.code, 'IO_ERROR')
        assert.match(`${String(candidate.message)} ${String(cause?.message)}`, /locked|busy/i)
        return true
      },
    )
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= 800)
    assert.ok(elapsed < 4000)
    if (holder.exitCode === null) {
      await once(holder, 'exit')
    }
    assert.equal(holder.exitCode, 0)
  })

  const readRecoveryCases = [
    {
      name: 'list',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
          root,
        })
        assert.deepEqual(
          result.map(entry => entry.id),
          [record.id],
        )
      },
    },
    {
      name: 'show',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown> | null>(
          'showRecord',
        )({
          id: record.id,
          root,
        })
        assert.equal(result?.id, record.id)
      },
    },
    {
      name: 'full search',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('searchRecords')({
          query: 'recoverable cache row',
          root,
        })
        assert.deepEqual(
          result.map(entry => entry.id),
          [record.id],
        )
      },
    },
    {
      name: 'compact search',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>(
          'searchCompactRecords',
        )({
          query: 'recoverable cache row',
          root,
        })
        assert.deepEqual(
          result.map(entry => entry.id),
          [record.id],
        )
      },
    },
    {
      name: 'gather',
      read: (root: string, record: Record<string, unknown>) => {
        const result = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('gatherRecords')({
          root,
          searches: ['recoverable cache row'],
          shows: [record.id],
        }) as {
          records: Array<{ record: { id: unknown } | null }>
          searches: Array<{ results: Array<{ id: unknown }> }>
        }
        assert.equal(result.records[0]?.record?.id, record.id)
        assert.equal(result.searches[0]?.results[0]?.id, record.id)
      },
    },
  ] as const

  for (const { name, read } of readRecoveryCases) {
    test(`rebuilds invalid cached row JSON during ${name}`, () => {
      const root = createRoot()
      const record = addCacheRecord(root)
      mutateCache(root, database => {
        database.prepare('UPDATE records SET record_json = ? WHERE id = ?').run('{not-json', String(record.id))
      })

      read(root, record)
    })
  }

  test('normalises negative-zero confidence from an existing cache row before public reads', () => {
    const root = createRoot()
    const record = api.addRecord({
      confidence: -0,
      id: 'cached-negative-zero-confidence',
      kind: 'context',
      payload: { summary: 'Cached negative-zero confidence' },
      root,
      searchText: 'cached negative-zero confidence',
      source: 'agent',
      subject: 'cache.negative-zero-confidence',
    })
    mutateCache(root, database => {
      const row = database.prepare('SELECT record_json FROM records WHERE id = ?').get(record.id) as
        | { record_json?: unknown }
        | undefined
      assert.ok(row)
      assert.equal(typeof row.record_json, 'string')
      const cachedBytes = row.record_json as string
      const negativeZeroBytes = cachedBytes.replace('"confidence":0', '"confidence":-0')
      assert.notEqual(negativeZeroBytes, cachedBytes)
      database.prepare('UPDATE records SET record_json = ? WHERE id = ?').run(negativeZeroBytes, record.id)
    })
    let writerInitialisations = 0
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    const cached = [
      api.showRecord({ id: record.id, root }),
      api.listRecords({ root }).find(candidate => candidate.id === record.id),
      api.searchRecords({ query: 'cached negative-zero', root }).find(candidate => candidate.id === record.id),
    ]
    for (const candidate of cached) {
      assert.ok(candidate)
      assert.equal(Object.is(candidate.confidence, 0), true)
    }
    assert.equal(writerInitialisations, 0)
  })

  test('quarantines one exact corrupt cache generation before rebuilding', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    mutateCache(root, database => {
      database
        .prepare('UPDATE records SET record_json = CAST(zeroblob(?) AS TEXT) || ? WHERE id = ?')
        .run(1_052_673, 'private-cache-sentinel', String(record.id))
    })
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({ root }),
      [record],
    )
    assert.equal(primaryQuarantines, 1)
    assert.equal(writerInitialisations, 1)
  })

  test('bounds failed cache recovery without serving private cache content', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    mutateCache(root, database => {
      database
        .prepare('UPDATE records SET record_json = CAST(zeroblob(?) AS TEXT) || ? WHERE id = ?')
        .run(1_052_673, 'private-cache-sentinel', String(record.id))
    })
    let writerAttempts = 0
    let resultsServed = 0
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerAttempts += 1
        if (writerAttempts === 1) {
          throw Object.assign(new Error('Injected recovery writer failure.'), { code: 'EIO' })
        }
      }
    }
    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')

    assert.throws(
      () => {
        resultsServed = listRecords({ root }).length
      },
      (error: unknown) => {
        const publicError = error as {
          cause?: unknown
          code?: unknown
          details?: unknown
          message?: unknown
        }
        assert.ok(publicError.code === 'IO_ERROR' || publicError.code === 'INTERNAL_ERROR')
        assert.doesNotMatch(
          JSON.stringify({
            cause: publicError.cause instanceof Error ? publicError.cause.message : publicError.cause,
            details: publicError.details ?? null,
            message: publicError.message,
          }),
          /private-cache-sentinel/,
        )
        return true
      },
    )
    assert.equal(writerAttempts, 1)
    assert.equal(resultsServed, 0)
  })

  test('normalises malformed cache JSON throughout a terminal retry cause chain', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    mutateCache(root, database => {
      database.prepare('UPDATE records SET record_json = ? WHERE id = ?').run('{"first":,}', String(record.id))
    })
    const privateSentinel = 'private-ca'
    let databaseOpensAfterRecoveryStarted = 0
    cacheReadTestHooks.afterCanonicalValidation = () => {
      cacheLocationTestHooks.beforeDatabaseOpen = () => {
        databaseOpensAfterRecoveryStarted += 1
        if (databaseOpensAfterRecoveryStarted === 2) {
          cacheLocationTestHooks.beforeDatabaseOpen = undefined
          mutateCache(root, database => {
            database
              .prepare('UPDATE records SET record_json = ? WHERE id = ?')
              .run('private-cache-sentinel', String(record.id))
          })
        }
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
        assert.doesNotMatch(causeChainText(error), new RegExp(privateSentinel, 'u'))
        return true
      },
    )
    assert.equal(databaseOpensAfterRecoveryStarted, 2)
  })

  test('normalises malformed metadata throughout a terminal retry cause chain', () => {
    const root = createRoot()
    addCacheRecord(root)
    const privateSentinel = 'private-metadata-sentinel'
    mutateCache(root, database => {
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'artifactPaths'").run(`["${privateSentinel}",`)
    })
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = undefined
      mutateCache(root, database => {
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'artifactPaths'").run(`["${privateSentinel}",`)
      })
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
        assert.doesNotMatch(causeChainText(error), new RegExp(privateSentinel, 'u'))
        return true
      },
    )
  })

  test('bounds repeated semantic schema recovery without exposing schema names', () => {
    const root = createRoot()
    addCacheRecord(root)
    const privateSentinel = 'private_schema_sentinel'
    const installIncompatibleIndex = () => {
      mutateCache(root, database => {
        database.exec(`
          DROP INDEX records_kind_subject;
          CREATE INDEX ${privateSentinel} ON records(subject, kind);
        `)
      })
    }
    installIncompatibleIndex()
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = undefined
      installIncompatibleIndex()
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'INTERNAL_ERROR')
        assert.doesNotMatch(causeChainText(error), new RegExp(privateSentinel, 'u'))
        return true
      },
    )
    assert.equal(primaryQuarantines, 1)
    assert.equal(writerInitialisations, 1)
  })

  test('does not quarantine a foreign cache with a valid repository scope', () => {
    const root = createRoot()
    addCacheRecord(root)
    const foreignRepository = realpathSync.native(createOutsideDirectory())
    mutateCache(root, database => {
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'repositoryRealpath'").run(foreignRepository)
    })
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'CACHE_SCOPE_MISMATCH')
        return true
      },
    )
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 0)
  })

  test('forced hydration preserves a valid foreign-scope cache exactly', () => {
    const root = createRoot()
    addCacheRecord(root)
    const foreignRepository = realpathSync.native(createOutsideDirectory())
    mutateCache(root, database => {
      database.prepare("UPDATE metadata SET value = ? WHERE key = 'repositoryRealpath'").run(foreignRepository)
    })
    const databasePath = cacheDatabasePath(root)
    const beforeBytes = readFileSync(databasePath)
    const beforeIdentity = lstatSync(databasePath, { bigint: true })
    let primaryQuarantines = 0
    let recoveryRebuilds = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      recoveryRebuilds += 1
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.throws(
      () => api.hydrate({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'CACHE_SCOPE_MISMATCH')
        return true
      },
    )
    assert.equal(primaryQuarantines, 0)
    assert.equal(recoveryRebuilds, 0)
    assert.equal(writerInitialisations, 0)
    const afterIdentity = lstatSync(databasePath, { bigint: true })
    assert.deepEqual(
      { dev: afterIdentity.dev, ino: afterIdentity.ino },
      { dev: beforeIdentity.dev, ino: beforeIdentity.ino },
    )
    assert.deepEqual(readFileSync(databasePath), beforeBytes)
  })

  test('preserves terminal Encephalon cache errors regardless of recoverable causes', () => {
    const root = createRoot()
    api.prepare({ root })
    mutateCache(root, database => {
      database.prepare("UPDATE metadata SET value = 'stale' WHERE key = 'manifest'").run()
    })
    const location = inspectCacheLocation(root)
    const cacheDatabase = inspectCacheDatabase(location, 'brain.sqlite')
    assert.ok(cacheDatabase)
    const sqliteFailure = Object.assign(new Error('injected schema-like cause'), {
      code: 'SQLITE_SCHEMA',
    })
    const databaseFailure = new CacheDatabaseFailure(sqliteFailure, cacheDatabase, {
      cause: sqliteFailure,
    })
    const terminalError = new api.EncephalonError(
      'REPOSITORY_CHANGED',
      'Injected terminal cache error.',
      { invariant: 'terminal-error-priority' },
      { cause: databaseFailure },
    )
    let primaryQuarantines = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        primaryQuarantines += 1
      }
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
        if (writerInitialisations === 1) {
          throw terminalError
        }
      }
    }

    assert.throws(
      () => api.prepare({ root }),
      (error: unknown) => {
        assert.equal(error, terminalError)
        return true
      },
    )
    assert.equal(primaryQuarantines, 0)
    assert.equal(writerInitialisations, 1)
  })

  test('rebuilds non-text cached record JSON before reading it', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    mutateCache(root, database => {
      database.prepare('UPDATE records SET record_json = ? WHERE id = ?').run(42, String(record.id))
    })

    assert.deepEqual(
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({ root }).map(
        entry => entry.id,
      ),
      [record.id],
    )
  })

  test('rebuilds cached records with invalid shapes and runtime paths', () => {
    const invalidRecordJson = (record: Record<string, unknown>) => [
      JSON.stringify({ ...record, unexpected: true }),
      JSON.stringify({ ...record, path: '/tmp/elsewhere.json' }),
      JSON.stringify({ ...record, path: '../elsewhere.json' }),
    ]

    for (const recordJson of invalidRecordJson(addCacheRecord(createRoot()))) {
      const root = roots.at(-1)
      assert.ok(root)
      mutateCache(root, database => {
        database.prepare('UPDATE records SET record_json = ?').run(recordJson)
      })
      const records = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
        root,
      })
      assert.deepEqual(
        records.map(record => record.id),
        ['cache-record'],
      )
    }
  })

  test('rebuilds cached record columns that disagree with validated JSON', () => {
    const root = createRoot()
    const oldRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'old-cache-record',
      kind: 'context',
      payload: { summary: 'Old cache record' },
      root,
      source: 'agent',
      subject: 'cache.validation',
    })
    const newRecord = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'new-cache-record',
      kind: 'context',
      payload: { summary: 'New cache record' },
      root,
      source: 'agent',
      subject: 'cache.validation',
      supersedes: [oldRecord.id],
    })
    mutateCache(root, database => {
      database.prepare('UPDATE records SET kind = ? WHERE id = ?').run('decision', String(newRecord.id))
      database.prepare('UPDATE records SET active = 1 WHERE id = ?').run(String(oldRecord.id))
    })

    const listRecords = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')
    assert.deepEqual(listRecords({ kind: 'decision', root }), [])
    assert.deepEqual(
      listRecords({ root }).map(record => record.id),
      [newRecord.id],
    )
  })

  test('rebuilds invalid cache metadata instead of trusting it', () => {
    const metadataCases = [
      ['artifactPaths', JSON.stringify(['../outside'])],
      ['recordsIndexed', '-1'],
      ['recordsIndexed', String(Number.MAX_SAFE_INTEGER + 1)],
      ['recordFingerprint', 'not-a-fingerprint'],
      ['artifactPaths', JSON.stringify(['x'.repeat(1024 * 1024 + 1)])],
    ] as const

    for (const [key, value] of metadataCases) {
      const root = createRoot()
      addCacheRecord(root)
      mutateCache(root, database => {
        database.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(value, key)
      })
      assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
        hydrated: true,
        recordsIndexed: 1,
      })
    }

    const root = createRoot()
    addCacheRecord(root)
    mutateCache(root, database => {
      database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('unexpected', 'value')
    })
    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 1,
    })
  })

  test('bounds schema and metadata before transferring untrusted text', () => {
    const cases = [
      {
        expectedProbe: { name: 'metadata-columns', rows: 2 },
        mutate: (database: DatabaseSync) => {
          database.exec(`
            CREATE TABLE replacement_metadata(key TEXT, private_metadata_sentinel TEXT);
            DROP TABLE metadata;
            ALTER TABLE replacement_metadata RENAME TO metadata;
          `)
        },
        name: 'oversized metadata column name',
      },
      {
        expectedProbe: { name: 'record-search-schema', rows: 1 },
        mutate: (database: DatabaseSync) => {
          database.enableDefensive(false)
          database.exec(`
            DROP TABLE record_search;
            CREATE VIRTUAL TABLE record_search USING fts5(
              ${' '.repeat(4096)}id UNINDEXED,
              text
            );
          `)
        },
        name: 'oversized record_search schema SQL',
      },
      {
        expectedProbe: { name: 'metadata', rows: 8 },
        mutate: (database: DatabaseSync) => {
          database
            .prepare('INSERT INTO metadata(key, value) VALUES (?, ?)')
            .run('unexpected', 'private-metadata-sentinel')
        },
        name: 'eighth metadata row',
      },
      {
        expectedProbe: { name: 'metadata', rows: 7 },
        mutate: (database: DatabaseSync) => {
          database
            .prepare("UPDATE metadata SET value = CAST(zeroblob(?) AS TEXT) WHERE key = 'manifest'")
            .run(1024 * 1024 + 1)
        },
        name: 'oversized metadata value containing NUL',
      },
    ]

    for (const { expectedProbe, mutate, name } of cases) {
      const root = createRoot()
      addCacheRecord(root)
      mutateCache(root, mutate)
      const observations = observeCacheIntegrity()

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: 1 },
        name,
      )
      const probeIndex = observations.findIndex(
        observation => observation.kind === 'probe' && observation.name === expectedProbe.name,
      )
      assert.notEqual(probeIndex, -1, name)
      assert.deepEqual(observations.at(probeIndex), { kind: 'probe', ...expectedProbe }, name)
      assert.notDeepEqual(observations.at(probeIndex + 1), { kind: 'text-read', name: expectedProbe.name }, name)
    }
  })

  test('bounds cached record validation before transferring untrusted rows', () => {
    const cases = [
      {
        expectedRows: 1001,
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DELETE FROM records;
            WITH RECURSIVE generated(value) AS (
              SELECT 1
              UNION ALL
              SELECT value + 1 FROM generated WHERE value < 1001
            )
            INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
            SELECT
              printf('overflow-%04d', value), 'context', 'cache.overflow', 'test',
              '2026-08-16T00:00:00.000Z', printf('encephalon/context/overflow-%04d.json', value),
              1, NULL, '{}'
            FROM generated;
          `)
        },
        name: '1,001 rows',
      },
      {
        expectedRows: 1,
        mutate: (database: DatabaseSync) => {
          database.prepare('UPDATE records SET record_json = CAST(zeroblob(?) AS TEXT)').run(1_052_673)
        },
        name: 'oversized record JSON containing NUL',
      },
      {
        expectedRows: 13,
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DELETE FROM records;
            WITH RECURSIVE generated(value) AS (
              SELECT 1
              UNION ALL
              SELECT value + 1 FROM generated WHERE value < 13
            )
            INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
            SELECT
              printf('aggregate-%04d', value), 'context', 'cache.aggregate', 'test',
              '2026-08-16T00:00:00.000Z', printf('encephalon/context/aggregate-%04d.json', value),
              1, NULL, CAST(zeroblob(1048576) AS TEXT)
            FROM generated;
            UPDATE metadata SET value = '13' WHERE key = 'recordsIndexed';
          `)
        },
        name: 'aggregate record JSON above 12 MiB',
      },
      {
        expectedRows: 25,
        mutate: (database: DatabaseSync) => {
          database.exec(`
            CREATE TEMP TABLE original_record AS SELECT * FROM records;
            DELETE FROM records;
            WITH RECURSIVE generated(value) AS (
              SELECT 1
              UNION ALL
              SELECT value + 1 FROM generated WHERE value < 25
            )
            INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
            SELECT
              printf('aggregate-text-%04d-', value) || CAST(zeroblob(1048500) AS TEXT),
              kind, subject, source, created_at, path, active, summary, record_json
            FROM original_record CROSS JOIN generated;
            DROP TABLE original_record;
            UPDATE metadata SET value = '25' WHERE key = 'recordsIndexed';
          `)
        },
        name: 'aggregate denormalised record text above its bound',
      },
      {
        expectedRows: 1,
        mutate: (database: DatabaseSync) => {
          database.exec('PRAGMA ignore_check_constraints = ON; UPDATE records SET active = 9223372036854775807;')
        },
        name: 'hostile 64-bit active integer',
      },
    ] as const

    for (const { expectedRows, mutate, name } of cases) {
      const root = createRoot()
      const record = addCacheRecord(root)
      mutateCache(root, mutate)
      const observations = observeCacheIntegrity()

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: 1 },
        name,
      )
      const probeIndex = observations.findIndex(
        observation =>
          observation.kind === 'probe' && observation.name === 'records' && observation.rows === expectedRows,
      )
      assert.notEqual(probeIndex, -1, name)
      assert.notDeepEqual(observations.at(probeIndex + 1), { kind: 'text-read', name: 'records' }, name)
      assert.equal(
        functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({ root })[0]?.id,
        record.id,
        name,
      )
    }
  })

  test('bounds FTS validation before running relationship checks', () => {
    const cases: readonly {
      expectedRows: number
      mutate: (database: DatabaseSync) => void
      name: string
      setup?: ((root: string) => BrainRecord) | undefined
    }[] = [
      {
        expectedRows: 1001,
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DELETE FROM record_search;
            WITH RECURSIVE generated(value) AS (
              SELECT 1
              UNION ALL
              SELECT value + 1 FROM generated WHERE value < 1001
            )
            INSERT INTO record_search(id, text)
            SELECT printf('overflow-%04d', value), 'overflow search text'
            FROM generated;
          `)
        },
        name: '1,001 rows',
      },
      {
        expectedRows: 1,
        mutate: (database: DatabaseSync) => {
          database.prepare('UPDATE record_search SET text = CAST(zeroblob(?) AS TEXT)').run(6_316_033)
        },
        name: 'oversized FTS text containing NUL',
      },
      {
        expectedRows: 1,
        mutate: (database: DatabaseSync) => {
          database.prepare('UPDATE record_search SET id = ?').run('x'.repeat(256))
        },
        name: 'oversized textual FTS ID',
      },
      {
        expectedRows: 12,
        mutate: (database: DatabaseSync) => {
          database.exec(`
            DELETE FROM record_search;
            WITH RECURSIVE generated(value) AS (
              SELECT 1
              UNION ALL
              SELECT value + 1 FROM generated WHERE value < 12
            )
            INSERT INTO record_search(id, text)
            SELECT printf('cache-record-%02d', value), CAST(zeroblob(6242305) AS TEXT)
            FROM generated;
          `)
        },
        name: 'aggregate FTS text above its normalized projection bound',
        setup: root => {
          const kindDirectory = join(root, 'encephalon', 'context')
          mkdirSync(kindDirectory, { recursive: true })
          for (const value of Array.from({ length: 12 }, (_, index) => index + 1)) {
            const id = `cache-record-${String(value).padStart(2, '0')}`
            writeFileSync(
              join(kindDirectory, `${id}.json`),
              `${JSON.stringify({
                createdAt: `2026-08-16T00:00:${String(value).padStart(2, '0')}.000Z`,
                id,
                kind: 'context',
                payload: {},
                source: 'test',
                subject: `cache.aggregate-fts.${String(value).padStart(2, '0')}`,
              })}\n`,
            )
          }
          assert.deepEqual(api.hydrate({ root }), { recordsIndexed: 12 })
          const latest = api.listRecords({ root }).find(record => record.id === 'cache-record-12')
          assert.ok(latest)
          return latest
        },
      },
      {
        expectedRows: 1,
        mutate: (database: DatabaseSync) => {
          database.exec('UPDATE record_search SET id = 9223372036854775807;')
        },
        name: 'FTS integer ID',
      },
      {
        expectedRows: 1,
        mutate: (database: DatabaseSync) => {
          database.exec("UPDATE record_search SET id = x'63616368652d7265636f7264';")
        },
        name: 'FTS BLOB ID',
      },
    ]

    for (const { expectedRows, mutate, name, setup } of cases) {
      const root = createRoot()
      const record = setup === undefined ? addCacheRecord(root) : setup(root)
      const expectedRecordsIndexed = setup === undefined ? 1 : 12
      mutateCache(root, mutate)
      const observations = observeCacheIntegrity()

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: expectedRecordsIndexed },
        name,
      )
      const probeIndex = observations.findIndex(
        observation =>
          observation.kind === 'probe' && observation.name === 'record-search' && observation.rows === expectedRows,
      )
      assert.notEqual(probeIndex, -1, name)
      assert.notDeepEqual(observations.at(probeIndex + 1), { kind: 'text-read', name: 'record-search' }, name)
      assert.equal(
        functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({ root })[0]?.id,
        record.id,
        name,
      )
    }
  })

  test('bounds exact metadata and FTS per-value bytes before semantic recovery', () => {
    const root = createRoot()
    addCacheRecord(root)
    mutateCache(root, database => {
      database.prepare("UPDATE record_search SET text = replace(hex(zeroblob(?)), '00', 'x')").run(6_316_032)
      database
        .prepare("UPDATE metadata SET value = replace(hex(zeroblob(?)), '00', 'x') WHERE key = 'packageVersion'")
        .run(1_048_576)
    })
    const observations = observeCacheIntegrity()

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 1,
    })
    for (const probe of [
      { name: 'metadata', rows: 7 },
      { name: 'records', rows: 1 },
      { name: 'record-search', rows: 1 },
    ]) {
      const probeIndex = observations.findIndex(
        observation =>
          observation.kind === 'probe' && observation.name === probe.name && observation.rows === probe.rows,
      )
      assert.notEqual(probeIndex, -1, probe.name)
      assert.deepEqual(observations.at(probeIndex + 1), { kind: 'text-read', name: probe.name }, probe.name)
    }
  })

  test('bounds exact aggregate, row-count, and recordsIndexed values before semantic recovery', () => {
    const root = createRoot()
    addCacheRecord(root)
    mutateCache(root, database => {
      database.exec(`
        CREATE TEMP TABLE boundary_record AS SELECT * FROM records;
        DELETE FROM records;
        DELETE FROM record_search;
        WITH RECURSIVE generated(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM generated WHERE value < 1000
        ), candidates AS (
          SELECT
            printf('boundary-%04d', value) AS id,
            kind,
            printf('cache.boundary.%04d', value) AS subject,
            source,
            created_at,
            printf('encephalon/context/boundary-%04d.json', value) AS path,
            active,
            summary,
            CASE WHEN value <= 608 THEN 12485 ELSE 12484 END AS target_bytes,
            json_set(
              record_json,
              '$.id', printf('boundary-%04d', value),
              '$.subject', printf('cache.boundary.%04d', value),
              '$.path', printf('encephalon/context/boundary-%04d.json', value),
              '$.payload.padding', ''
            ) AS base_json
          FROM boundary_record CROSS JOIN generated
        )
        INSERT INTO records(id, kind, subject, source, created_at, path, active, summary, record_json)
        SELECT
          id,
          kind,
          subject,
          source,
          created_at,
          path,
          active,
          summary,
          json_set(
            base_json,
            '$.payload.padding',
            replace(hex(zeroblob(target_bytes - length(CAST(base_json AS BLOB)))), '00', 'x')
          )
        FROM candidates;
        WITH RECURSIVE generated(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM generated WHERE value < 1000
        )
        INSERT INTO record_search(id, text)
        SELECT printf('boundary-%04d', value), 'boundary search text'
        FROM generated;
        UPDATE metadata SET value = '1000' WHERE key = 'recordsIndexed';
        DROP TABLE boundary_record;
      `)
    })
    const observations = observeCacheIntegrity()

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 1,
    })
    for (const probe of [
      { name: 'metadata', rows: 7 },
      { name: 'records', rows: 1000 },
    ]) {
      const probeIndex = observations.findIndex(
        observation =>
          observation.kind === 'probe' && observation.name === probe.name && observation.rows === probe.rows,
      )
      assert.notEqual(probeIndex, -1, probe.name)
      assert.deepEqual(observations.at(probeIndex + 1), { kind: 'text-read', name: probe.name }, probe.name)
    }
    observations.splice(0)
    assert.equal(
      functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
        limit: 1,
        root,
      }).length,
      1,
    )
    assert.equal(
      observations.filter(observation => observation.kind === 'probe' && observation.name === 'record-search').length,
      1,
    )
  })

  test('pins cache validation and the public read to one verified SQLite snapshot', () => {
    const root = createRoot()
    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'snapshot-record',
      kind: 'context',
      payload: { generation: 'original' },
      root,
      source: 'agent',
      subject: 'cache.snapshot',
    })
    let indexProbes = 0
    let mutations = 0
    cacheReadTestHooks.afterIntegrityProbe = observation => {
      if (observation.name === 'records-indexes') {
        indexProbes += 1
        if (indexProbes === 1) {
          mutations += 1
          const successor = JSON.stringify({ ...record, payload: { generation: 'successor' } })
          const database = new DatabaseSync(cacheDatabasePath(root))
          try {
            database.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;')
            database.prepare('UPDATE records SET record_json = ? WHERE id = ?').run(successor, String(record.id))
            database.exec('DROP INDEX records_kind_subject;')
            database.exec('COMMIT')
          } finally {
            database.close()
          }
        }
      }
    }

    const [returned] = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
      root,
    })
    const generation = (returned?.payload as { generation?: unknown } | undefined)?.generation
    assert.equal(mutations, 1)
    assert.equal(indexProbes, 1)
    assert.deepEqual({ generation, id: returned?.id }, { generation: 'original', id: record.id })
    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 1,
    })
  })

  test('requires canonical recordsIndexed metadata', () => {
    const cases: Array<{
      expected: { hydrated: boolean; recordsIndexed: number }
      name: string
      value: Buffer | string
    }> = [
      { expected: { hydrated: false, recordsIndexed: 1 }, name: 'canonical integer', value: '1' },
      { expected: { hydrated: true, recordsIndexed: 1 }, name: 'negative integer', value: '-1' },
      { expected: { hydrated: true, recordsIndexed: 1 }, name: 'fraction', value: '1.5' },
      { expected: { hydrated: true, recordsIndexed: 1 }, name: 'exponent', value: '1e0' },
      { expected: { hydrated: true, recordsIndexed: 1 }, name: 'leading zero', value: '01' },
      { expected: { hydrated: true, recordsIndexed: 1 }, name: 'leading whitespace', value: ' 1' },
      { expected: { hydrated: true, recordsIndexed: 1 }, name: 'trailing whitespace', value: '1 ' },
      {
        expected: { hydrated: true, recordsIndexed: 1 },
        name: 'SQLite BLOB',
        value: Buffer.from('1'),
      },
      {
        expected: { hydrated: true, recordsIndexed: 1 },
        name: 'canonical limit overflow',
        value: '1001',
      },
    ]

    for (const { expected, name, value } of cases) {
      const root = createRoot()
      addCacheRecord(root)
      mutateCache(root, database => {
        database.prepare("UPDATE metadata SET value = ? WHERE key = 'recordsIndexed'").run(value)
      })

      try {
        assert.deepEqual(
          functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
          expected,
          name,
        )
      } catch (error) {
        assert.equal(String(error).includes(String(value)), false, name)
        throw error
      }
    }
  })

  test('recovers a non-canonical FTS projection during a representative public read', () => {
    const root = createRoot()
    const record = addCacheRecord(root)
    const databasePath = cacheDatabasePath(root)
    const original = lstatSync(databasePath, { bigint: true })
    const expected = Buffer.from(
      [
        'context',
        'cache.validation',
        'agent',
        'Cache record',
        '{"detail":"cache corruption marker","summary":"Cache record"}',
        'recoverable cache row',
      ].join('\n'),
      'utf8',
    )
    mutateCache(root, database => {
      database.prepare("UPDATE record_search SET text = 'x' || substr(text, 2) WHERE id = ?").run(String(record.id))
    })
    const observations = observeCacheIntegrity()
    let exactQuarantines = 0
    let readerInitialisations = 0
    let recoveryRebuilds = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        const current = lstatSync(path, { bigint: true })
        if (current.dev === original.dev && current.ino === original.ino) {
          exactQuarantines += 1
        }
      }
    }
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      recoveryRebuilds += 1
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      } else {
        readerInitialisations += 1
      }
    }

    const listed = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>[]>('listRecords')({
      root,
    })
    assert.deepEqual(
      listed.map(item => item.id),
      [record.id],
    )
    const corruptProbe = observations.findIndex(
      observation => observation.kind === 'probe' && observation.name === 'record-search' && observation.rows === 1,
    )
    assert.notEqual(corruptProbe, -1)
    assert.deepEqual(observations.at(corruptProbe + 1), {
      kind: 'text-read',
      name: 'record-search',
    })
    assert.equal(exactQuarantines, 1)
    assert.equal(readerInitialisations, 2)
    assert.equal(recoveryRebuilds, 1)
    assert.equal(writerInitialisations, 1)
    const rebuilt = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const row = rebuilt
        .prepare('SELECT CAST(text AS BLOB) AS bytes FROM record_search WHERE id = ?')
        .get(String(record.id)) as {
        bytes?: unknown
      }
      assert.equal(row.bytes instanceof Uint8Array, true)
      assert.deepEqual(Buffer.from(row.bytes as Uint8Array), expected)
    } finally {
      rebuilt.close()
    }
  })

  test('rejects invalid FTS bytes that decode to the canonical JavaScript string during forced hydrate', () => {
    const root = createRoot()
    const id = 'invalid-fts-bytes'
    functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id,
      kind: 'context',
      payload: { marker: '�' },
      root,
      source: 'agent',
      subject: 'cache.invalid-fts-bytes',
    })
    const canonical = 'context\ncache.invalid-fts-bytes\nagent\n{"marker":"�"}'
    const canonicalBytes = Buffer.from(canonical, 'utf8')
    const replacementBytes = Buffer.from('�', 'utf8')
    const replacementOffset = canonicalBytes.indexOf(replacementBytes)
    assert.notEqual(replacementOffset, -1)
    const invalidBytes = Buffer.concat([
      canonicalBytes.subarray(0, replacementOffset),
      Buffer.from([0x80]),
      canonicalBytes.subarray(replacementOffset + replacementBytes.length),
    ])
    mutateCache(root, database => {
      database.prepare('UPDATE record_search SET text = CAST(? AS TEXT) WHERE id = ?').run(invalidBytes, id)
      const row = database
        .prepare('SELECT text, CAST(text AS BLOB) AS bytes FROM record_search WHERE id = ?')
        .get(id) as { bytes?: unknown; text?: unknown }
      assert.equal(row.text, canonical)
      assert.equal(row.bytes instanceof Uint8Array, true)
      assert.deepEqual(Buffer.from(row.bytes as Uint8Array), invalidBytes)
      assert.equal(database.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode, 'delete')
    })
    let quarantines = 0
    let recoveryRebuilds = 0
    let writerInitialisations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'brain.sqlite') {
        const predecessor = new DatabaseSync(path, { readOnly: true })
        try {
          assert.equal(predecessor.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete')
        } finally {
          predecessor.close()
        }
        quarantines += 1
      }
    }
    cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = () => {
      recoveryRebuilds += 1
    }
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        writerInitialisations += 1
      }
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('hydrate')({ root }), {
      recordsIndexed: 1,
    })
    assert.equal(quarantines, 1)
    assert.equal(recoveryRebuilds, 1)
    assert.equal(writerInitialisations, 1)
    const rebuilt = new DatabaseSync(cacheDatabasePath(root), { readOnly: true })
    try {
      const row = rebuilt.prepare('SELECT CAST(text AS BLOB) AS bytes FROM record_search WHERE id = ?').get(id) as {
        bytes?: unknown
      }
      assert.equal(row.bytes instanceof Uint8Array, true)
      assert.deepEqual(Buffer.from(row.bytes as Uint8Array), canonicalBytes)
    } finally {
      rebuilt.close()
    }
  })

  test('rebuilds missing, duplicate, and orphaned FTS rows', () => {
    const cases = [
      {
        mutate: (database: DatabaseSync, id: string) => {
          database.prepare('DELETE FROM record_search WHERE id = ?').run(id)
        },
        name: 'missing row',
      },
      {
        mutate: (database: DatabaseSync, id: string) => {
          database.prepare('INSERT INTO record_search(id, text) VALUES (?, ?)').run(id, 'duplicate search row')
        },
        name: 'duplicate ID',
      },
      {
        mutate: (database: DatabaseSync, id: string) => {
          database.prepare("UPDATE record_search SET id = 'orphan-search-row' WHERE id = ?").run(id)
        },
        name: 'same-count orphan',
      },
    ] as const

    for (const fixture of cases) {
      const root = createRoot()
      const record = addCacheRecord(root)
      mutateCache(root, database => {
        fixture.mutate(database, String(record.id))
      })
      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: 1 },
        fixture.name,
      )
    }
  })

  test('binds every same-count FTS projection to exactly one cached record ID', () => {
    const cases = [
      {
        mutate: (database: DatabaseSync, first: { id: string; text: string }, second: { id: string; text: string }) => {
          database.prepare('UPDATE record_search SET text = ? WHERE id = ?').run(second.text, first.id)
          database.prepare('UPDATE record_search SET text = ? WHERE id = ?').run(first.text, second.id)
        },
        name: 'swapped canonical texts',
      },
      {
        mutate: (database: DatabaseSync, first: { id: string; text: string }, second: { id: string; text: string }) => {
          database.prepare('DELETE FROM record_search WHERE id = ?').run(second.id)
          database.prepare('INSERT INTO record_search(id, text) VALUES (?, ?)').run(first.id, first.text)
        },
        name: 'duplicate first ID with second ID missing',
      },
    ] as const

    for (const fixture of cases) {
      const root = createRoot()
      addCacheRecord(root)
      functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
        id: 'cache-record-two',
        kind: 'context',
        payload: { summary: 'Second cache record' },
        root,
        source: 'agent',
        subject: 'cache.validation.two',
      })
      mutateCache(root, database => {
        const rows = database.prepare('SELECT id, text FROM record_search ORDER BY id').all() as Array<{
          id: string
          text: string
        }>
        assert.equal(rows.length, 2)
        fixture.mutate(database, rows[0] as { id: string; text: string }, rows[1] as { id: string; text: string })
      })

      assert.deepEqual(
        functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
        { hydrated: true, recordsIndexed: 2 },
        fixture.name,
      )
    }
  })

  test('recovers an ownerless or malformed operation lock', () => {
    const root = createRoot()
    const lockPath = join(root, 'node_modules', '.cache', 'encephalon', 'operation.lock')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), 'not-json')
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
  })

  test('preserves established IO errors for fixed lock and recovery-marker extra children', () => {
    const cases = [
      {
        create: (root: string) => {
          const path = join(cacheDirectoryPath(root), 'operation.lock')
          mkdirSync(path, { recursive: true })
          writeFileSync(join(path, 'owner.json'), '{malformed fixed lock owner')
          writeFileSync(join(path, 'extra'), 'fixed lock extra child')
        },
        name: 'fixed operation lock',
      },
      {
        create: (root: string) => {
          const path = join(cacheDirectoryPath(root), 'operation-lock.recovery')
          const owner = {
            acquiredAt: '2026-08-24T10:00:00.000Z',
            phase: 'recovering',
            pid: process.pid,
            token: 'fixed-recovery-extra-child',
          } as const
          mkdirSync(path, { recursive: true })
          writeFileSync(join(path, 'owner.json'), `${JSON.stringify(owner)}\n`)
          writeFileSync(join(path, 'owner.recovered.json'), `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`)
          writeFileSync(join(path, 'extra'), 'fixed recovery extra child')
        },
        name: 'fixed recovery marker',
      },
    ] as const

    for (const fixedCase of cases) {
      const root = createRoot()
      fixedCase.create(root)
      let operationEntered = false

      assert.throws(
        () =>
          withOperationLock(root, () => {
            operationEntered = true
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'IO_ERROR', fixedCase.name)
          return true
        },
      )
      assert.equal(operationEntered, false, fixedCase.name)
    }
  })

  test('ignores stale owner metadata with a reused live PID after acquiring the gate', () => {
    const root = createRoot()
    const lockPath = join(root, 'node_modules', '.cache', 'encephalon', 'operation.lock')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({
        acquiredAt: '2026-08-06T10:00:00.000Z',
        pid: process.pid,
        token: 'stale-live-pid-owner',
      })}\n`,
    )
    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(existsSync(lockPath), false)
  })

  test('operation lock callback failure survives a simultaneous gate cleanup failure', () => {
    const root = createRoot()
    const callbackFailure = Object.assign(new Error('operation callback failure'), { code: 'EIO' })
    const cleanupFailure = Object.assign(new Error('operation gate cleanup failure'), {
      code: 'EIO',
    })
    let gateCloseAttempts = 0

    assert.throws(
      () =>
        withOperationLock(
          root,
          () => {
            throw callbackFailure
          },
          {
            gateClose: database => {
              gateCloseAttempts += 1
              database.close()
              throw cleanupFailure
            },
          },
        ),
      (error: unknown) => {
        assert.equal((error as { cause?: unknown }).cause, callbackFailure)
        return true
      },
    )
    assert.equal(gateCloseAttempts, 1)
  })

  test('operation lock cleanup failure surfaces when the callback succeeds', () => {
    const root = createRoot()
    const cleanupFailure = Object.assign(new Error('operation gate cleanup failure'), {
      code: 'EIO',
    })

    assert.throws(
      () =>
        withOperationLock(root, () => 'entered', {
          gateClose: database => {
            database.close()
            throw cleanupFailure
          },
        }),
      cleanupFailure,
    )
  })

  test('recovers a malformed disposable operation gate database', () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
  })

  test('owns the acquisition marker before opening a malformed operation gate', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
    const events: string[] = []
    cacheLocationTestHooks.beforeDatabaseOpen = database => {
      if (database.name === 'operation-lock.sqlite') {
        events.push('gate-open')
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered', {
        afterRecoveryCreation: () => {
          events.push('marker-created')
        },
      }),
      'entered',
    )
    assert.deepEqual(events.slice(0, 2), ['marker-created', 'gate-open'])
  })

  test('reclaims an abandoned operation gate recovery marker', () => {
    const root = createRoot()
    const recoveryPath = join(root, 'node_modules', '.cache', 'encephalon', 'operation-lock.recovery')
    const deadProcess = spawnSync(process.execPath, ['-e', ''])
    const deadPid = deadProcess.pid
    assert.equal(deadProcess.status, 0)
    assert.ok(deadPid !== undefined)
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({
        acquiredAt: new Date().toISOString(),
        pid: deadPid,
        token: 'dead-recovery-owner',
      })}\n`,
    )

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(existsSync(recoveryPath), false)
  })

  test('waits for bounded live recovery owners and reclaims stale malformed metadata', () => {
    const ownerCases = [
      { acquiredAt: '2026-08-06T10:00:00.000Z', expectedObservations: 2, token: 'old-live-owner' },
      { acquiredAt: 'not-a-date', expectedObservations: 1, token: 'unparseable-date-live-owner' },
      { acquiredAt: 'x'.repeat(64), expectedObservations: 1, token: 'timestamp-boundary' },
      { acquiredAt: '2026-08-06T10:00:00.000Z', expectedObservations: 2, token: 'x'.repeat(128) },
      { acquiredAt: '', expectedObservations: 1, token: 'empty-timestamp' },
      { acquiredAt: 'x'.repeat(65), expectedObservations: 1, token: 'long-timestamp' },
      { acquiredAt: '2026-08-06T10:00:00.000Z', expectedObservations: 1, token: '' },
      { acquiredAt: '2026-08-06T10:00:00.000Z', expectedObservations: 1, token: 'x'.repeat(129) },
      {
        acquiredAt: '2026-08-06T10:00:00.000Z',
        expectedObservations: 1,
        pid: 2_147_483_648,
        token: 'unsupported-pid',
      },
      {
        acquiredAt: '2026-08-06T10:00:00.000Z',
        expectedObservations: 1,
        phase: 'unknown',
        token: 'unsupported-phase',
      },
      {
        acquiredAt: '2026-08-06T10:00:00.000Z',
        expectedObservations: 1,
        extra: 'unexpected',
        phase: 'recovering',
        token: 'unexpected-key',
      },
    ] as const

    for (const ownerCase of ownerCases) {
      const root = createRoot()
      const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
      mkdirSync(recoveryPath, { recursive: true })
      writeFileSync(
        join(recoveryPath, 'owner.json'),
        `${JSON.stringify({
          acquiredAt: ownerCase.acquiredAt,
          ...('extra' in ownerCase ? { extra: ownerCase.extra } : {}),
          ...('phase' in ownerCase ? { phase: ownerCase.phase } : {}),
          pid: 'pid' in ownerCase ? ownerCase.pid : process.pid,
          token: ownerCase.token,
        })}\n`,
      )
      const oldTimestamp = new Date('2026-08-06T10:00:00.000Z')
      utimesSync(recoveryPath, oldTimestamp, oldTimestamp)
      let observations = 0

      assert.equal(
        withOperationLock(root, () => 'entered', {
          duringRecoveryObservation: () => {
            observations += 1
            if (observations === 2) {
              rmSync(recoveryPath, { recursive: true })
            }
          },
        }),
        'entered',
      )
      assert.equal(observations, ownerCase.expectedObservations)
    }
  })

  test('reclaims stale owner metadata with non-record JSON shapes', () => {
    for (const owner of [null, [], 42]) {
      const root = createRoot()
      const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
      mkdirSync(recoveryPath, { recursive: true })
      writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify(owner)}\n`)
      const oldTimestamp = new Date('2026-08-06T10:00:00.000Z')
      utimesSync(recoveryPath, oldTimestamp, oldTimestamp)

      assert.equal(
        withOperationLock(root, () => 'entered'),
        'entered',
      )
    }
  })

  test('reclaims a stale oversized recovery owner without reading it', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    mkdirSync(recoveryPath, { recursive: true })
    const oversizedOwner = `${JSON.stringify({
      acquiredAt: new Date().toISOString(),
      padding: 'x'.repeat(4096),
      pid: process.pid,
      token: 'oversized-live-owner',
    })}\n`
    assert.ok(Buffer.byteLength(oversizedOwner) > 4096)
    writeFileSync(join(recoveryPath, 'owner.json'), oversizedOwner)
    const oldTimestamp = new Date('2026-08-06T10:00:00.000Z')
    utimesSync(recoveryPath, oldTimestamp, oldTimestamp)
    let observations = 0
    let staleCallbacks = 0

    assert.equal(
      withOperationLock(root, () => 'entered', {
        afterRecoveryStaleObservation: () => {
          staleCallbacks += 1
        },
        duringRecoveryObservation: () => {
          observations += 1
          if (observations === 2) {
            rmSync(recoveryPath, { recursive: true })
          }
        },
      }),
      'entered',
    )
    assert.equal(observations, 1)
    assert.equal(staleCallbacks, 1)
  })

  test('reacquires recovery ownership when its owner token is replaced before gate recovery', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
    let recoveryCreations = 0
    let replacementObservations = 0

    assert.equal(
      withOperationLock(root, () => 'entered', {
        afterRecoveryCreation: () => {
          recoveryCreations += 1
          if (recoveryCreations === 1) {
            const owner = JSON.parse(readFileSync(join(recoveryPath, 'owner.json'), 'utf8')) as Record<string, unknown>
            writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify({ ...owner, token: 'replacement' })}\n`)
          }
        },
        duringRecoveryObservation: () => {
          replacementObservations += 1
          const replacement = JSON.parse(readFileSync(join(recoveryPath, 'owner.json'), 'utf8')) as {
            phase?: unknown
            token?: unknown
          }
          assert.equal(replacement.phase, 'recovering')
          assert.equal(replacement.token, 'replacement')
          rmSync(recoveryPath, { recursive: true })
        },
      }),
      'entered',
    )
    assert.equal(recoveryCreations, 2)
    assert.equal(replacementObservations, 1)
  })

  test('preserves a replacement recovery token installed immediately before cleanup', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    const replacementOwner = `${JSON.stringify({
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
      token: 'cleanup-replacement',
    })}\n`
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        writeFileSync(join(path, 'owner.json'), replacementOwner)
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(readFileSync(join(recoveryPath, 'owner.json'), 'utf8'), replacementOwner)
  })

  test('reclaims an exact recovery marker after its cleanup fails', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    mkdirSync(cachePath, { recursive: true })
    const gate = new DatabaseSync(join(cachePath, 'operation-lock.sqlite'))
    gate.close()
    let operationEntered = false
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        throw new Error('recovery cleanup fault')
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
          return 'primary result'
        }),
      (error: unknown) => {
        assert.equal((error as { cause?: { message?: unknown } }).cause?.message, 'recovery cleanup fault')
        return true
      },
    )
    assert.equal(operationEntered, false)
    const abandonedOwner = JSON.parse(
      readFileSync(join(cachePath, 'operation-lock.recovery', 'owner.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.deepEqual(Object.keys(abandonedOwner).sort(), ['acquiredAt', 'phase', 'pid', 'token'])
    assert.equal(typeof abandonedOwner.acquiredAt, 'string')
    assert.equal(abandonedOwner.phase, 'recovering')
    assert.equal(abandonedOwner.pid, process.pid)
    assert.equal(typeof abandonedOwner.token, 'string')
    const recoveredWitness = JSON.parse(
      readFileSync(join(cachePath, 'operation-lock.recovery', 'owner.recovered.json'), 'utf8'),
    ) as Record<string, unknown>
    assert.deepEqual(recoveredWitness, { ...abandonedOwner, phase: 'recovered' })
    assert.equal(
      withOperationLock(root, () => 'entered on retry'),
      'entered on retry',
    )
  })

  test('reclaims a recovered marker while its owner process remains alive', async () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const abandonedPath = join(root, 'recovered-marker-abandoned')
    const releaseOwnerPath = join(root, 'release-recovered-marker-owner')
    const successorEnteredPath = join(root, 'recovered-marker-successor-entered')
    mkdirSync(cachePath, { recursive: true })
    const gate = new DatabaseSync(join(cachePath, 'operation-lock.sqlite'))
    gate.close()
    const fixture = join(import.meta.dirname, 'fixtures', 'abandon-recovered-marker.ts')
    const owner = spawn(process.execPath, [fixture, 'owner', root, abandonedPath, releaseOwnerPath], {
      stdio: 'inherit',
    })
    let successor: ReturnType<typeof spawn> | undefined

    try {
      waitForPath(abandonedPath, owner)
      assert.equal(owner.exitCode, null)
      assert.equal(
        (
          JSON.parse(readFileSync(join(cachePath, 'operation-lock.recovery', 'owner.recovered.json'), 'utf8')) as {
            phase?: unknown
          }
        ).phase,
        'recovered',
      )
      successor = spawn(process.execPath, [fixture, 'successor', root, successorEnteredPath], {
        stdio: 'inherit',
      })
      waitForPath(successorEnteredPath, successor)
      assert.equal(owner.exitCode, null)
      await waitForChild(successor)
      assert.equal(successor.exitCode, 0)
    } finally {
      writeFileSync(releaseOwnerPath, 'release')
      await Promise.all([stopChild(owner), ...(successor === undefined ? [] : [stopChild(successor)])])
    }
  })

  test('reclaims an exact recovered owner without age-breaking live recovering owners', () => {
    const cases = [
      {
        expectedObservations: 2,
        expectedStaleCallbacks: 0,
        owner: { phase: 'recovering', token: 'live-recovering-owner' },
        witness: 'missing',
      },
      {
        expectedObservations: 2,
        expectedStaleCallbacks: 0,
        owner: { token: 'live-legacy-owner' },
        witness: 'missing',
      },
      {
        expectedObservations: 2,
        expectedStaleCallbacks: 0,
        owner: { token: 'legacy-owner-with-witness' },
        witness: 'matching',
      },
      {
        expectedObservations: 2,
        expectedStaleCallbacks: 0,
        owner: { phase: 'recovering', token: 'live-owner-partial-witness' },
        witness: 'partial',
      },
      {
        expectedObservations: 2,
        expectedStaleCallbacks: 0,
        owner: { phase: 'recovering', token: 'live-owner-mismatched-witness' },
        witness: 'mismatched',
      },
      {
        expectedObservations: 1,
        expectedStaleCallbacks: 1,
        owner: { phase: 'recovering', token: 'live-recovered-owner' },
        witness: 'matching',
      },
    ] as const

    for (const ownerCase of cases) {
      const root = createRoot()
      const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
      mkdirSync(recoveryPath, { recursive: true })
      writeFileSync(
        join(recoveryPath, 'owner.json'),
        `${JSON.stringify({
          acquiredAt: '2026-08-06T10:00:00.000Z',
          ...('phase' in ownerCase.owner ? { phase: ownerCase.owner.phase } : {}),
          pid: process.pid,
          token: ownerCase.owner.token,
        })}\n`,
      )
      if (ownerCase.witness !== 'missing') {
        writeFileSync(
          join(recoveryPath, 'owner.recovered.json'),
          ownerCase.witness === 'partial'
            ? '{"acquiredAt":'
            : `${JSON.stringify({
                acquiredAt: '2026-08-06T10:00:00.000Z',
                phase: 'recovered',
                pid: process.pid,
                token: ownerCase.witness === 'mismatched' ? 'different-owner-token' : ownerCase.owner.token,
              })}\n`,
        )
      }
      const oldTimestamp = new Date('2026-08-06T10:00:00.000Z')
      utimesSync(recoveryPath, oldTimestamp, oldTimestamp)
      let observations = 0
      let staleCallbacks = 0

      assert.equal(
        withOperationLock(root, () => 'entered', {
          afterRecoveryStaleObservation: () => {
            staleCallbacks += 1
          },
          duringRecoveryObservation: () => {
            observations += 1
            if (observations === 2) {
              rmSync(recoveryPath, { recursive: true })
            }
          },
          now: () => Date.parse('2026-08-24T10:00:00.000Z'),
        }),
        'entered',
      )
      assert.equal(observations, ownerCase.expectedObservations)
      assert.equal(staleCallbacks, ownerCase.expectedStaleCallbacks)
    }
  })

  test('retries when a recovered marker is reclaimed before stale-marker validation', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const owner = {
      acquiredAt: '2026-08-24T10:00:00.000Z',
      phase: 'recovering',
      pid: process.pid,
      token: 'reclaimed-recovery-witness',
    } as const
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify(owner)}\n`)
    writeFileSync(join(recoveryPath, 'owner.recovered.json'), `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`)
    let witnessOpens = 0
    cacheLocationTestHooks.beforeCacheOwnerOpen = path => {
      if (basename(path) === 'owner.recovered.json') {
        witnessOpens += 1
        if (witnessOpens === 2) {
          rmSync(recoveryPath, { recursive: true })
        }
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered after recovered marker reclaim'),
      'entered after recovered marker reclaim',
    )
    assert.ok(witnessOpens >= 2)
  })

  test('retries a transient sharing violation while reclaiming an observed recovered marker', () => {
    const root = createRoot()
    createRecoveredOperationMarker(root, 'shared-recovered-marker')
    let reclaimAttempts = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        reclaimAttempts += 1
        if (reclaimAttempts === 1) {
          throw Object.assign(new Error('observed recovery marker is temporarily shared'), {
            code: 'EPERM',
          })
        }
        cacheLocationTestHooks.beforeQuarantineRename = undefined
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered after sharing violation'),
      'entered after sharing violation',
    )
    assert.equal(reclaimAttempts, 2)
  })

  test('bounds persistent sharing violations while reclaiming an observed recovered marker', () => {
    const root = createRoot()
    const { recoveryPath } = createRecoveredOperationMarker(root, 'persistently-shared-recovered-marker')
    let operationEntered = false
    let reclaimAttempts = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        reclaimAttempts += 1
        throw Object.assign(new Error('observed recovery marker remains shared'), {
          code: 'EPERM',
        })
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        assert.equal(((error as { cause?: unknown }).cause as { code?: unknown }).code, 'EPERM')
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(reclaimAttempts, 3)
    assert.equal(existsSync(recoveryPath), true)
  })

  test('reobserves changed recovery evidence before retrying a sharing violation', () => {
    const root = createRoot()
    const { owner, recoveryPath } = createRecoveredOperationMarker(root, 'replaced-after-sharing-violation')
    const successor = { ...owner, token: 'successor-after-sharing-violation' }
    let reclaimAttempts = 0
    let recoveryObservations = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        reclaimAttempts += 1
        if (reclaimAttempts === 1) {
          writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify(successor)}\n`)
          writeFileSync(
            join(recoveryPath, 'owner.recovered.json'),
            `${JSON.stringify({ ...successor, phase: 'recovered' })}\n`,
          )
          throw Object.assign(new Error('predecessor recovery marker is temporarily shared'), {
            code: 'EPERM',
          })
        }
        if (recoveryObservations === 1) {
          throw new Error('Recovery marker reclaim retried before re-observing changed evidence.')
        }
        cacheLocationTestHooks.beforeQuarantineRename = undefined
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered after evidence re-observation', {
        duringRecoveryObservation: () => {
          recoveryObservations += 1
        },
      }),
      'entered after evidence re-observation',
    )
    assert.equal(recoveryObservations, 2)
    assert.equal(reclaimAttempts, 2)
  })

  test('stops recovery-marker sharing retries at the operation-lock deadline', () => {
    const root = createRoot()
    const { recoveryPath } = createRecoveredOperationMarker(root, 'deadline-shared-recovered-marker')
    let deadlineExpired = false
    let operationEntered = false
    let reclaimAttempts = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        reclaimAttempts += 1
        deadlineExpired = true
        throw Object.assign(new Error('recovery marker remained shared until the deadline'), {
          code: 'EPERM',
        })
      }
    }

    assert.throws(
      () =>
        withOperationLock(
          root,
          () => {
            operationEntered = true
          },
          { now: () => (deadlineExpired ? 60_000 : 0) },
        ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'CACHE_BUSY')
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(reclaimAttempts, 1)
    assert.equal(existsSync(recoveryPath), true)
  })

  test('continues when another contender reclaims an observed recovered marker', () => {
    const root = createRoot()
    createRecoveredOperationMarker(root, 'concurrently-reclaimed-marker')
    let reclaimed = false
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        rmSync(path, { recursive: true })
        reclaimed = true
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered after concurrent reclaim'),
      'entered after concurrent reclaim',
    )
    assert.equal(reclaimed, true)
  })

  test('retries when recovered evidence changes during initial marker observation', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const owner = {
      acquiredAt: '2026-08-24T10:00:00.000Z',
      phase: 'recovering',
      pid: process.pid,
      token: 'changing-recovery-witness',
    } as const
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify(owner)}\n`)
    writeFileSync(join(recoveryPath, 'owner.recovered.json'), `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`)
    let observations = 0
    cacheLocationTestHooks.beforeCacheOwnerOpen = path => {
      if (basename(path) === 'owner.recovered.json') {
        cacheLocationTestHooks.beforeCacheOwnerOpen = undefined
        rmSync(path)
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered after initial evidence change', {
        duringRecoveryObservation: () => {
          observations += 1
          if (observations === 2) {
            rmSync(recoveryPath, { recursive: true })
          }
        },
      }),
      'entered after initial evidence change',
    )
    assert.equal(observations, 2)
  })

  test('does not publish recovered across an owner phase replacement', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    let replacementObserved = false
    cacheLocationTestHooks.afterOwnerRecoveryCreation = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.afterOwnerRecoveryCreation = undefined
        const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as Record<string, unknown>
        writeFileSync(join(path, 'owner.json'), `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`)
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered', {
        duringRecoveryObservation: () => {
          replacementObserved = true
          const ownerContents = readFileSync(join(recoveryPath, 'owner.json'), 'utf8')
          assert.equal((JSON.parse(ownerContents) as { phase?: unknown }).phase, 'recovered')
          const witnessPath = join(recoveryPath, 'owner.recovered.json')
          assert.notEqual(existsSync(witnessPath) ? readFileSync(witnessPath, 'utf8') : undefined, ownerContents)
          rmSync(recoveryPath, { recursive: true })
        },
      }),
      'entered',
    )
    assert.equal(replacementObserved, true)
  })

  test('does not publish recovered across an identical-byte owner identity replacement', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const displacedOwnerPath = join(root, 'displaced-recovery-owner.json')
    let operationEntered = false
    cacheLocationTestHooks.afterOwnerRecoveryCreation = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.afterOwnerRecoveryCreation = undefined
        cacheLocationTestHooks.afterCacheOwnerRead = ownerPath => {
          if (basename(ownerPath) === 'owner.json') {
            cacheLocationTestHooks.afterCacheOwnerRead = undefined
            const contents = readFileSync(ownerPath, 'utf8')
            renameSync(ownerPath, displacedOwnerPath)
            writeFileSync(ownerPath, contents)
          }
        }
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(operationEntered, false)
    const ownerContents = readFileSync(join(recoveryPath, 'owner.json'), 'utf8')
    assert.equal(ownerContents, readFileSync(displacedOwnerPath, 'utf8'))
    const expectedWitness = `${JSON.stringify({ ...(JSON.parse(ownerContents) as Record<string, unknown>), phase: 'recovered' })}\n`
    const witnessPath = join(recoveryPath, 'owner.recovered.json')
    assert.notEqual(existsSync(witnessPath) ? readFileSync(witnessPath, 'utf8') : undefined, expectedWitness)
  })

  test('cleans a partial recovery witness after publication fails', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const publicationFailure = Object.assign(new Error('partial recovery witness publication failed'), { code: 'EIO' })
    let operationEntered = false
    cacheLocationTestHooks.afterOwnerRecoveryCreation = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.afterOwnerRecoveryCreation = undefined
        writeFileSync(join(path, 'owner.recovered.json'), '{"acquiredAt":')
        throw publicationFailure
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { cause?: unknown }).cause, publicationFailure)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(existsSync(recoveryPath), false)
    assert.equal(
      withOperationLock(root, () => 'entered after partial publication failure'),
      'entered after partial publication failure',
    )
  })

  test('does not accept an identity-replaced recovery witness before fsync', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const displacedWitnessPath = join(root, 'displaced-recovery-witness')
    let replacementReclaimed = false
    cacheLocationTestHooks.beforeOwnerRecoveryFsync = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeOwnerRecoveryFsync = undefined
        const witnessPath = join(path, 'owner.recovered.json')
        const contents = readFileSync(witnessPath, 'utf8')
        renameSync(witnessPath, displacedWitnessPath)
        writeFileSync(witnessPath, contents)
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered', {
        afterRecoveryStaleObservation: () => {
          replacementReclaimed = true
        },
      }),
      'entered',
    )
    assert.equal(replacementReclaimed, true)
    assert.equal((JSON.parse(readFileSync(displacedWitnessPath, 'utf8')) as { phase?: unknown }).phase, 'recovered')
    assert.equal(existsSync(recoveryPath), false)
  })

  test('preserves publication durability failure over cleanup failure and leaves reclaimable evidence', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const publicationFailure = Object.assign(new Error('recovery witness directory fsync failure'), { code: 'EIO' })
    const cleanupFailure = Object.assign(new Error('recovery witness cleanup failure'), {
      code: 'EIO',
    })
    let operationEntered = false
    cacheLocationTestHooks.fsyncOwnedDirectory = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.fsyncOwnedDirectory = undefined
        throw publicationFailure
      }
    }
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        throw cleanupFailure
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        assert.equal((error as { cause?: unknown }).cause, publicationFailure)
        assert.deepEqual((error as { details?: unknown }).details, {})
        const publicError = JSON.stringify({
          code: (error as { code?: unknown }).code,
          details: (error as { details?: unknown }).details,
          message: (error as { message?: unknown }).message,
        })
        assert.equal(publicError.includes('owner.recovered.json'), false)
        assert.equal(publicError.includes(String(process.pid)), false)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(
      (
        JSON.parse(readFileSync(join(recoveryPath, 'owner.recovered.json'), 'utf8')) as {
          phase?: unknown
        }
      ).phase,
      'recovered',
    )
    assert.equal(
      withOperationLock(root, () => 'entered after durability failure'),
      'entered after durability failure',
    )
  })

  test('preserves publication failure when evidence changes during failure inspection', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const publicationFailure = Object.assign(new Error('recovery witness fsync failed before evidence inspection'), {
      code: 'EIO',
    })
    let operationEntered = false
    cacheLocationTestHooks.beforeOwnerRecoveryFsync = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeOwnerRecoveryFsync = undefined
        cacheLocationTestHooks.beforeCacheOwnerOpen = ownerPath => {
          if (basename(ownerPath) === 'owner.recovered.json') {
            cacheLocationTestHooks.beforeCacheOwnerOpen = undefined
            rmSync(ownerPath)
          }
        }
        throw publicationFailure
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        assert.equal((error as { cause?: unknown }).cause, publicationFailure)
        assert.deepEqual((error as { details?: unknown }).details, {})
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(existsSync(recoveryPath), false)
    assert.equal(
      withOperationLock(root, () => 'entered after publication evidence inspection race'),
      'entered after publication evidence inspection race',
    )
  })

  test('preserves publication failure over a later post-BEGIN gate replacement', {
    skip: process.platform === 'win32' ? 'Windows does not permit renaming an open SQLite database.' : false,
  }, () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const gatePath = join(cachePath, 'operation-lock.sqlite')
    const displacedGatePath = join(root, 'post-publication-operation-lock.sqlite')
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    const publicationFailure = Object.assign(new Error('recovery witness fsync failure'), {
      code: 'EIO',
    })
    let operationEntered = false
    cacheLocationTestHooks.beforeOwnerRecoveryFsync = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeOwnerRecoveryFsync = undefined
        throw publicationFailure
      }
    }
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (database.name === 'operation-lock.sqlite') {
        cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
        renameSync(gatePath, displacedGatePath)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        assert.equal((error as { cause?: unknown }).cause, publicationFailure)
        assert.deepEqual((error as { details?: unknown }).details, {})
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(existsSync(recoveryPath), false)
    assert.equal(existsSync(displacedGatePath), true)
  })

  test('rejects hard-linked recovery owner evidence', { skip: hardLinkSkip }, () => {
    for (const evidenceName of ['owner.json', 'owner.recovered.json'] as const) {
      const root = createRoot()
      const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
      const aliasPath = join(root, `${evidenceName}.alias`)
      const owner = {
        acquiredAt: '2026-08-24T10:00:00.000Z',
        phase: 'recovering',
        pid: process.pid,
        token: `hard-linked-${evidenceName}`,
      }
      mkdirSync(recoveryPath, { recursive: true })
      writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify(owner)}\n`)
      writeFileSync(join(recoveryPath, 'owner.recovered.json'), `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`)
      linkSync(join(recoveryPath, evidenceName), aliasPath)
      let operationEntered = false

      assert.throws(
        () =>
          withOperationLock(root, () => {
            operationEntered = true
          }),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
          return true
        },
      )
      assert.equal(operationEntered, false)
      assert.equal(existsSync(aliasPath), true)
    }
  })

  test('retains quarantined recovery evidence when a child identity changes after directory quarantine', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const acquiredAt = '2026-08-24T10:00:00.000Z'
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({ acquiredAt, phase: 'recovering', pid: process.pid, token: 'quarantine-child-race' })}\n`,
    )
    writeFileSync(
      join(recoveryPath, 'owner.recovered.json'),
      `${JSON.stringify({ acquiredAt, phase: 'recovered', pid: process.pid, token: 'quarantine-child-race' })}\n`,
    )
    let quarantinePath: string | undefined
    let displacedWitnessPath: string | undefined
    cacheLocationTestHooks.beforeQuarantinedOwnerValidation = path => {
      if (basename(path).startsWith('.operation-lock.recovery.')) {
        cacheLocationTestHooks.beforeQuarantinedOwnerValidation = undefined
        quarantinePath = path
        const witnessPath = join(path, 'owner.recovered.json')
        const contents = readFileSync(witnessPath, 'utf8')
        displacedWitnessPath = join(path, 'displaced-owner.recovered.json')
        renameSync(witnessPath, displacedWitnessPath)
        writeFileSync(witnessPath, contents)
      }
    }

    assert.throws(
      () => withOperationLock(root, () => 'not entered'),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.ok(quarantinePath !== undefined)
    assert.ok(displacedWitnessPath !== undefined)
    assert.equal(existsSync(quarantinePath), true)
    assert.equal(existsSync(displacedWitnessPath), true)
    assert.equal(existsSync(join(quarantinePath, 'owner.json')), true)
  })

  test('does not enter after its recovered evidence changes inside quarantine', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    let operationEntered = false
    let quarantinePath: string | undefined
    cacheLocationTestHooks.beforeQuarantinedOwnerValidation = path => {
      if (basename(path).startsWith('.operation-lock.recovery.')) {
        cacheLocationTestHooks.beforeQuarantinedOwnerValidation = undefined
        quarantinePath = path
        const witnessPath = join(path, 'owner.recovered.json')
        const contents = readFileSync(witnessPath, 'utf8')
        renameSync(witnessPath, join(path, 'displaced-owner.recovered.json'))
        writeFileSync(witnessPath, contents)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(existsSync(recoveryPath), false)
    assert.ok(quarantinePath !== undefined)
    assert.equal(existsSync(join(quarantinePath, 'owner.json')), true)
    assert.equal(existsSync(join(quarantinePath, 'owner.recovered.json')), true)
    assert.equal(existsSync(join(quarantinePath, 'displaced-owner.recovered.json')), true)
  })

  test('does not remove recovered evidence replaced after quarantine validation', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    let operationEntered = false
    let quarantinePath: string | undefined
    cacheLocationTestHooks.beforeQuarantinedOwnerRemoval = path => {
      if (basename(path).startsWith('.operation-lock.recovery.')) {
        cacheLocationTestHooks.beforeQuarantinedOwnerRemoval = undefined
        quarantinePath = path
        const witnessPath = join(path, 'owner.recovered.json')
        const contents = readFileSync(witnessPath, 'utf8')
        renameSync(witnessPath, join(path, 'displaced-owner.recovered.json'))
        writeFileSync(witnessPath, contents)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(existsSync(recoveryPath), false)
    assert.ok(quarantinePath !== undefined)
    assert.equal(existsSync(join(quarantinePath, 'owner.json')), true)
    assert.equal(existsSync(join(quarantinePath, 'owner.recovered.json')), true)
    assert.equal(existsSync(join(quarantinePath, 'displaced-owner.recovered.json')), true)
  })

  test('leaves only complete owner metadata when phase publication is interrupted', async () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    const publicationPausedPath = join(root, 'owner-phase-publication-paused')
    mkdirSync(cachePath, { recursive: true })
    const gate = new DatabaseSync(join(cachePath, 'operation-lock.sqlite'))
    gate.close()
    const fixture = join(import.meta.dirname, 'fixtures', 'pause-owner-phase-publication.ts')
    const owner = spawn(process.execPath, [fixture, root, publicationPausedPath], {
      stdio: 'inherit',
    })

    try {
      waitForPath(publicationPausedPath, owner)
      const currentOwner = JSON.parse(readFileSync(join(recoveryPath, 'owner.json'), 'utf8')) as {
        phase?: unknown
      }
      const candidateOwner = readFileSync(join(recoveryPath, 'owner.recovered.json'), 'utf8')
      assert.equal(currentOwner.phase, 'recovering')
      assert.equal(candidateOwner, '{"acquiredAt":')
      await stopChild(owner)
      assert.equal(
        (JSON.parse(readFileSync(join(recoveryPath, 'owner.json'), 'utf8')) as { phase?: unknown }).phase,
        'recovering',
      )
      assert.equal(
        withOperationLock(root, () => 'entered after interrupted publication'),
        'entered after interrupted publication',
      )
      assert.equal(existsSync(recoveryPath), false)
    } finally {
      await stopChild(owner)
    }
  })

  test('reclaims a complete recovery witness after its publisher exits before fsync', async () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    const publicationPausedPath = join(root, 'complete-owner-phase-publication-paused')
    mkdirSync(cachePath, { recursive: true })
    const gate = new DatabaseSync(join(cachePath, 'operation-lock.sqlite'))
    gate.close()
    const fixture = join(import.meta.dirname, 'fixtures', 'pause-owner-phase-publication.ts')
    const owner = spawn(process.execPath, [fixture, root, publicationPausedPath, 'complete'], {
      stdio: 'inherit',
    })

    try {
      waitForPath(publicationPausedPath, owner)
      const recoveringOwner = JSON.parse(readFileSync(join(recoveryPath, 'owner.json'), 'utf8')) as Record<
        string,
        unknown
      >
      const recoveredWitness = JSON.parse(readFileSync(join(recoveryPath, 'owner.recovered.json'), 'utf8')) as Record<
        string,
        unknown
      >
      assert.deepEqual(recoveredWitness, { ...recoveringOwner, phase: 'recovered' })
      await stopChild(owner)
      assert.equal(
        withOperationLock(root, () => 'entered after complete interrupted publication'),
        'entered after complete interrupted publication',
      )
      assert.equal(existsSync(recoveryPath), false)
    } finally {
      await stopChild(owner)
    }
  })

  test('adopts only an exact existing recovered witness without replacing either file', () => {
    const cases = [
      { expectedKind: 'published', witnessToken: 'existing-exact' },
      { expectedKind: 'changed', witnessToken: 'different-token' },
    ] as const

    for (const ownerCase of cases) {
      const root = createRoot()
      const cachePath = cacheDirectoryPath(root)
      mkdirSync(cachePath, { recursive: true })
      const location = inspectCacheLocation(root)
      const directory = createCacheOwnedDirectory(location, 'operation-lock.recovery')
      const owner = {
        acquiredAt: '2026-08-24T10:00:00.000Z',
        phase: 'recovering',
        pid: process.pid,
        token: 'existing-exact',
      } as const
      const ownerContents = `${JSON.stringify(owner)}\n`
      const ownerFile = writeCacheOwner(location, directory, ownerContents)
      const witnessPath = join(directory.path, 'owner.recovered.json')
      const witnessContents = `${JSON.stringify({
        ...owner,
        phase: 'recovered',
        token: ownerCase.witnessToken,
      })}\n`
      writeFileSync(witnessPath, witnessContents)
      const ownerIdentity = statSync(join(directory.path, 'owner.json'), { bigint: true })
      const witnessIdentity = statSync(witnessPath, { bigint: true })

      const publication = publishCacheOwnerRecovery(
        location,
        directory,
        ownerFile,
        `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`,
      )

      assert.equal(publication.kind, ownerCase.expectedKind)
      assert.equal(
        sameCacheEntryIdentity(ownerIdentity, statSync(join(directory.path, 'owner.json'), { bigint: true })),
        true,
      )
      assert.equal(sameCacheEntryIdentity(witnessIdentity, statSync(witnessPath, { bigint: true })), true)
      assert.equal(readFileSync(witnessPath, 'utf8'), witnessContents)
    }
  })

  test('accepts an exact existing recovered witness reclaimed during final validation', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    mkdirSync(cachePath, { recursive: true })
    const location = inspectCacheLocation(root)
    const directory = createCacheOwnedDirectory(location, 'operation-lock.recovery')
    const owner = {
      acquiredAt: '2026-08-24T10:00:00.000Z',
      phase: 'recovering',
      pid: process.pid,
      token: 'existing-reclaimed',
    } as const
    const ownerFile = writeCacheOwner(location, directory, `${JSON.stringify(owner)}\n`)
    writeFileSync(join(directory.path, 'owner.recovered.json'), `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`)
    let ownerObservations = 0
    cacheLocationTestHooks.afterCacheOwnerRead = path => {
      if (basename(path) === 'owner.json') {
        ownerObservations += 1
        if (ownerObservations === 3) {
          cacheLocationTestHooks.afterCacheOwnerRead = undefined
          rmSync(directory.path, { recursive: true })
        }
      }
    }

    const publication = publishCacheOwnerRecovery(
      location,
      directory,
      ownerFile,
      `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`,
    )

    assert.equal(publication.kind, 'released')
    assert.equal(ownerObservations, 3)
    assert.equal(existsSync(directory.path), false)
  })

  test('rejects recovery-owner replacement between descriptor creation and publication', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const displacedOwnerPath = join(root, 'displaced-created-owner.json')
    mkdirSync(cachePath, { recursive: true })
    const location = inspectCacheLocation(root)
    const directory = createCacheOwnedDirectory(location, 'operation-lock.recovery')
    const ownerContents = `${JSON.stringify({
      acquiredAt: '2026-08-24T10:00:00.000Z',
      phase: 'recovering',
      pid: process.pid,
      token: 'created-owner-replacement',
    })}\n`
    cacheLocationTestHooks.afterRegularFileOpen = path => {
      if (basename(path) === 'owner.json') {
        cacheLocationTestHooks.afterRegularFileOpen = undefined
        renameSync(path, displacedOwnerPath)
        writeFileSync(path, ownerContents)
      }
    }

    assert.throws(
      () => writeCacheOwner(location, directory, ownerContents),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(readFileSync(join(directory.path, 'owner.json'), 'utf8'), ownerContents)
    assert.equal(readFileSync(displacedOwnerPath, 'utf8'), ownerContents)
  })

  test('rejects same-inode recovery-owner mutation across a bounded read', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    mkdirSync(cachePath, { recursive: true })
    const location = inspectCacheLocation(root)
    const directory = createCacheOwnedDirectory(location, 'operation-lock.recovery')
    const ownerContents = `${JSON.stringify({
      acquiredAt: '2026-08-24T10:00:00.000Z',
      phase: 'recovering',
      pid: process.pid,
      token: 'same-inode-owner-a',
    })}\n`
    const replacementContents = ownerContents.replace('same-inode-owner-a', 'same-inode-owner-longer')
    writeCacheOwner(location, directory, ownerContents)
    const ownerPath = join(directory.path, 'owner.json')
    const ownerIdentity = statSync(ownerPath, { bigint: true })
    cacheLocationTestHooks.afterCacheOwnerRead = path => {
      if (path === ownerPath) {
        cacheLocationTestHooks.afterCacheOwnerRead = undefined
        writeFileSync(path, replacementContents)
      }
    }

    assert.throws(
      () => observeCacheOwner(location, directory),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(sameCacheEntryIdentity(ownerIdentity, statSync(ownerPath, { bigint: true })), true)
    assert.equal(readFileSync(ownerPath, 'utf8'), replacementContents)
  })

  test('preserves owner errors and classifies a recovery witness disappearing before descriptor open', () => {
    const cases = [
      { expectedCode: 'ENOENT', filename: 'owner.json', observe: observeCacheOwner },
      {
        expectedCode: 'REPOSITORY_CHANGED',
        filename: 'owner.recovered.json',
        observe: observeCacheRecoveryWitness,
      },
    ] as const

    for (const ownerCase of cases) {
      const root = createRoot()
      const cachePath = cacheDirectoryPath(root)
      mkdirSync(cachePath, { recursive: true })
      const location = inspectCacheLocation(root)
      const directory = createCacheOwnedDirectory(location, 'operation-lock.recovery')
      const owner = {
        acquiredAt: '2026-08-24T10:00:00.000Z',
        phase: 'recovering',
        pid: process.pid,
        token: `disappearing-${ownerCase.filename}`,
      } as const
      writeCacheOwner(location, directory, `${JSON.stringify(owner)}\n`)
      writeFileSync(
        join(directory.path, 'owner.recovered.json'),
        `${JSON.stringify({ ...owner, phase: 'recovered' })}\n`,
      )
      const targetPath = join(directory.path, ownerCase.filename)
      cacheLocationTestHooks.beforeCacheOwnerOpen = path => {
        if (path === targetPath) {
          cacheLocationTestHooks.beforeCacheOwnerOpen = undefined
          rmSync(path)
        }
      }

      assert.throws(
        () => ownerCase.observe(location, directory),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, ownerCase.expectedCode)
          return true
        },
      )
      assert.equal(existsSync(targetPath), false)
    }
  })

  test('preserves public IO_ERROR when a recovery owner disappears before descriptor open', () => {
    const root = createRoot()
    let operationEntered = false
    cacheLocationTestHooks.beforeCacheOwnerOpen = path => {
      if (basename(path) === 'owner.json' && basename(dirname(path)) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeCacheOwnerOpen = undefined
        rmSync(path)
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'IO_ERROR')
        assert.deepEqual((error as { details?: unknown }).details, {})
        return true
      },
    )
    assert.equal(operationEntered, false)
  })

  test('continues when a complete recovered marker is reclaimed during final publication validation', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    let reclaimed = false
    cacheLocationTestHooks.afterCacheOwnerRead = path => {
      const witnessPath = join(recoveryPath, 'owner.recovered.json')
      if (
        basename(path) === 'owner.json' &&
        existsSync(witnessPath) &&
        readFileSync(witnessPath, 'utf8').includes('"phase":"recovered"')
      ) {
        cacheLocationTestHooks.afterCacheOwnerRead = undefined
        rmSync(recoveryPath, { recursive: true })
        reclaimed = true
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(reclaimed, true)
  })

  test('accepts recovered-marker cleanup completed by another process', () => {
    const root = createRoot()
    let reclaimed = false
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery' && existsSync(join(path, 'owner.recovered.json'))) {
        cacheLocationTestHooks.beforeQuarantineRename = undefined
        rmSync(path, { recursive: true })
        reclaimed = true
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(reclaimed, true)
  })

  test('cleans an exact recovery marker when setup fails after owner publication', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const setupFailure = Object.assign(new Error('recovery setup fault after owner publication'), {
      code: 'EIO',
    })

    assert.throws(
      () =>
        withOperationLock(root, () => 'not entered', {
          afterRecoveryCreation: () => {
            throw setupFailure
          },
        }),
      (error: unknown) => {
        assert.equal((error as { cause?: unknown }).cause, setupFailure)
        return true
      },
    )
    assert.equal(existsSync(recoveryPath), false)
    assert.equal(
      withOperationLock(root, () => 'entered on retry'),
      'entered on retry',
    )
  })

  test('publishes reclaimable cleanup debt when recovery setup and initial cleanup both fail', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const setupFailure = Object.assign(new Error('recovery setup fault with cleanup failure'), {
      code: 'EIO',
    })
    let cleanupAttempts = 0
    let operationEntered = false
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cleanupAttempts += 1
        if (cleanupAttempts <= 3) {
          throw Object.assign(new Error('recovery cleanup is temporarily unavailable'), {
            code: 'EPERM',
          })
        }
      }
    }

    assert.throws(
      () =>
        withOperationLock(
          root,
          () => {
            operationEntered = true
          },
          {
            afterRecoveryCreation: () => {
              throw setupFailure
            },
          },
        ),
      (error: unknown) => {
        assert.equal((error as { cause?: unknown }).cause, setupFailure)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(cleanupAttempts, 4)
    assert.equal(existsSync(recoveryPath), false)
    assert.equal(
      withOperationLock(root, () => 'entered on retry'),
      'entered on retry',
    )
  })

  test('reclaims a marker abandoned during gate acquisition setup', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    let operationEntered = false
    const setupFailure = Object.assign(new Error('recovery setup fault'), { code: 'EIO' })

    assert.throws(
      () =>
        withOperationLock(
          root,
          () => {
            operationEntered = true
          },
          {
            afterRecoveryCreation: () => {
              rmSync(join(recoveryPath, 'owner.json'))
              throw setupFailure
            },
          },
        ),
      (error: unknown) => {
        assert.equal((error as { cause?: unknown }).cause, setupFailure)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(existsSync(recoveryPath), true)
    assert.equal(existsSync(join(recoveryPath, 'owner.json')), false)
    assert.equal(
      withOperationLock(root, () => 'entered on retry'),
      'entered on retry',
    )
    assert.equal(existsSync(recoveryPath), false)
  })

  test('cleans an exact recovery directory when owner publication fails', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const publicationFailure = Object.assign(new Error('recovery owner publication failed'), {
      code: 'EIO',
    })
    let operationEntered = false
    cacheLocationTestHooks.afterRegularFileOpen = path => {
      if (basename(path) === 'owner.json' && basename(dirname(path)) === 'operation-lock.recovery') {
        cacheLocationTestHooks.afterRegularFileOpen = undefined
        throw publicationFailure
      }
    }

    assert.throws(
      () =>
        withOperationLock(root, () => {
          operationEntered = true
        }),
      (error: unknown) => {
        assert.equal((error as { cause?: unknown }).cause, publicationFailure)
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(existsSync(recoveryPath), false)
    assert.equal(
      withOperationLock(root, () => 'entered after recovery owner publication failure'),
      'entered after recovery owner publication failure',
    )
  })

  test('retries a transient recovery-marker sharing violation', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
    let attempts = 0
    cacheLocationTestHooks.beforeQuarantineRename = path => {
      if (basename(path) === 'operation-lock.recovery') {
        attempts += 1
        if (attempts === 1) {
          throw Object.assign(new Error('recovery marker is temporarily shared'), {
            code: 'EPERM',
          })
        }
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
    assert.equal(attempts, 2)
  })

  test('bounds optional sidecar canonicalisation retries', () => {
    const createWalGate = () => {
      const root = createRoot()
      const location = inspectCacheLocation(root)
      const path = join(location.directory, 'operation-lock.sqlite')
      const owner = new DatabaseSync(path)
      assert.equal(owner.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode, 'wal')
      owner.exec('CREATE TABLE retained_sidecar (value TEXT)')
      return { location, owner }
    }

    const transient = createWalGate()
    let transientMismatches = 0
    cacheLocationTestHooks.regularFileRealpath = (path, actual) => {
      if (path.endsWith('operation-lock.sqlite-shm') && transientMismatches === 0) {
        transientMismatches += 1
        return `${actual}-transient-mismatch`
      }
      return actual
    }
    const reopened = openVerifiedCacheDatabase({
      DatabaseConstructor: DatabaseSync,
      location: transient.location,
      name: 'operation-lock.sqlite',
      openOptions: {},
      primary: { kind: 'create-if-missing' },
    })
    reopened.database.close()
    transient.owner.close()
    assert.equal(transientMismatches, 1)

    const persistent = createWalGate()
    let persistentMismatches = 0
    cacheLocationTestHooks.regularFileRealpath = (path, actual) => {
      if (path.endsWith('operation-lock.sqlite-shm')) {
        persistentMismatches += 1
        return `${actual}-persistent-mismatch`
      }
      return actual
    }
    assert.throws(
      () =>
        openVerifiedCacheDatabase({
          DatabaseConstructor: DatabaseSync,
          location: persistent.location,
          name: 'operation-lock.sqlite',
          openOptions: {},
          primary: { kind: 'create-if-missing' },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
    persistent.owner.close()
    assert.equal(persistentMismatches, 3)
  })

  test('preserves live token and identity replacements for an abandoned recovery marker', () => {
    const cases = ['replacement-token', 'replacement-identity'] as const
    for (const replacement of cases) {
      const root = createRoot()
      const cachePath = cacheDirectoryPath(root)
      const recoveryPath = join(cachePath, 'operation-lock.recovery')
      const displacedAbandonedPath = join(root, `${replacement}-abandoned`)
      const preservedReplacementPath = join(root, `${replacement}-preserved`)
      mkdirSync(cachePath, { recursive: true })
      writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
      cacheLocationTestHooks.beforeQuarantineRename = path => {
        if (basename(path) === 'operation-lock.recovery') {
          cacheLocationTestHooks.beforeQuarantineRename = undefined
          throw new Error('recovery cleanup fault')
        }
      }

      assert.throws(() => withOperationLock(root, () => 'not entered'))
      const abandonedIdentity = statSync(recoveryPath, { bigint: true })
      const abandonedOwner = JSON.parse(readFileSync(join(recoveryPath, 'owner.json'), 'utf8')) as {
        acquiredAt: string
        phase: 'recovered' | 'recovering'
        pid: number
        token: string
      }
      const replacementOwner =
        replacement === 'replacement-token'
          ? { ...abandonedOwner, phase: 'recovering' as const, token: 'live-replacement-token' }
          : { ...abandonedOwner, phase: 'recovering' as const }
      if (replacement === 'replacement-identity') {
        renameSync(recoveryPath, displacedAbandonedPath)
        mkdirSync(recoveryPath)
      }
      writeFileSync(join(recoveryPath, 'owner.json'), `${JSON.stringify(replacementOwner)}\n`)
      const replacementIdentity = statSync(recoveryPath, { bigint: true })
      assert.equal(sameCacheEntryIdentity(abandonedIdentity, replacementIdentity), replacement === 'replacement-token')
      let observations = 0
      let staleCallbacks = 0

      assert.equal(
        withOperationLock(root, () => 'entered', {
          afterRecoveryStaleObservation: () => {
            staleCallbacks += 1
          },
          duringRecoveryObservation: () => {
            observations += 1
            assert.deepEqual(JSON.parse(readFileSync(join(recoveryPath, 'owner.json'), 'utf8')), replacementOwner)
            assert.equal(sameCacheEntryIdentity(replacementIdentity, statSync(recoveryPath, { bigint: true })), true)
            if (observations === 2) {
              renameSync(recoveryPath, preservedReplacementPath)
            }
          },
        }),
        'entered',
      )
      assert.equal(observations, 2, replacement)
      assert.equal(staleCallbacks, 0, replacement)
      assert.equal(
        sameCacheEntryIdentity(replacementIdentity, statSync(preservedReplacementPath, { bigint: true })),
        true,
      )
      assert.deepEqual(JSON.parse(readFileSync(join(preservedReplacementPath, 'owner.json'), 'utf8')), replacementOwner)
    }
  })

  test('reobserves a recovery marker that disappears between directory lstat and realpath', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'realpath-gap' })}\n`,
    )
    cacheLocationTestHooks.duringOwnedDirectoryInspection = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.duringOwnedDirectoryInspection = undefined
        rmSync(path, { recursive: true })
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered'),
      'entered',
    )
  })

  test('reclassifies an owned-directory realpath failure only after identity loss', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const displacedPath = join(root, 'owned-directory-realpath-failure-predecessor')
    mkdirSync(recoveryPath, { recursive: true })
    const location = inspectCacheLocation(root)
    const failure = Object.assign(new Error('simulated Windows realpath race'), { code: 'EBADF' })

    cacheLocationTestHooks.ownedDirectoryRealpath = () => {
      throw failure
    }
    assert.throws(
      () => inspectCacheOwnedDirectory(location, 'operation-lock.recovery'),
      error => error === failure,
    )

    cacheLocationTestHooks.ownedDirectoryRealpath = path => {
      rmSync(path, { recursive: true })
      throw failure
    }
    assert.throws(
      () => inspectCacheOwnedDirectory(location, 'operation-lock.recovery'),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )

    mkdirSync(recoveryPath)
    const predecessor = statSync(recoveryPath, { bigint: true })
    cacheLocationTestHooks.ownedDirectoryRealpath = path => {
      renameSync(path, displacedPath)
      mkdirSync(path)
      throw failure
    }
    assert.throws(
      () => inspectCacheOwnedDirectory(location, 'operation-lock.recovery'),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    assert.equal(sameCacheEntryIdentity(predecessor, statSync(recoveryPath, { bigint: true })), false)
  })

  test('reports a recovery marker missing only after a stable absent observation', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    let inspections = 0
    cacheLocationTestHooks.duringOwnedDirectoryInspection = path => {
      if (basename(path) === 'operation-lock.recovery') {
        inspections += 1
        if (inspections === 1) {
          mkdirSync(path)
          writeFileSync(
            join(path, 'owner.json'),
            `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'appearing' })}\n`,
          )
        } else if (inspections === 2) {
          rmSync(path, { recursive: true })
        } else if (inspections === 3) {
          cacheLocationTestHooks.duringOwnedDirectoryInspection = undefined
        }
      }
    }

    assert.equal(
      withOperationLock(root, () => {
        assert.equal(existsSync(recoveryPath), false)
        return 'entered'
      }),
      'entered',
    )
    assert.equal(inspections, 3)
  })

  test('rejects an ambiguous owned-directory observation after a successor replaces it', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const displacedPath = join(root, 'owned-directory-realpath-predecessor')
    mkdirSync(recoveryPath, { recursive: true })
    const predecessor = statSync(recoveryPath, { bigint: true })
    const location = inspectCacheLocation(root)
    cacheLocationTestHooks.duringOwnedDirectoryInspection = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.duringOwnedDirectoryInspection = undefined
        renameSync(path, displacedPath)
        mkdirSync(path)
      }
    }

    assert.throws(
      () => inspectCacheOwnedDirectory(location, 'operation-lock.recovery'),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        return true
      },
    )
    const successor = statSync(recoveryPath, { bigint: true })
    assert.equal(sameCacheEntryIdentity(predecessor, successor), false)
    assert.equal(sameCacheEntryIdentity(predecessor, statSync(displacedPath, { bigint: true })), true)
  })

  test('reobserves a recovery successor replaced at the final directory identity boundary', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const displacedPath = join(root, 'final-identity-recovery-predecessor')
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'final-predecessor' })}\n`,
    )
    cacheLocationTestHooks.beforeOwnedDirectoryFinalIdentity = path => {
      if (basename(path) === 'operation-lock.recovery') {
        cacheLocationTestHooks.beforeOwnedDirectoryFinalIdentity = undefined
        renameSync(path, displacedPath)
        mkdirSync(path)
        writeFileSync(
          join(path, 'owner.json'),
          `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'final-successor' })}\n`,
        )
      }
    }
    let successorObservations = 0

    assert.equal(
      withOperationLock(
        root,
        () => {
          assert.equal(existsSync(recoveryPath), false)
          return 'entered'
        },
        {
          duringRecoveryObservation: () => {
            successorObservations += 1
            assert.match(readFileSync(join(recoveryPath, 'owner.json'), 'utf8'), /final-successor/u)
            rmSync(recoveryPath, { recursive: true })
          },
        },
      ),
      'entered',
    )
    assert.equal(successorObservations, 1)
    assert.match(readFileSync(join(displacedPath, 'owner.json'), 'utf8'), /final-predecessor/u)
  })

  test('reobserves when a recovery predecessor completes during observation', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'completing-predecessor' })}\n`,
    )
    let observations = 0

    assert.equal(
      withOperationLock(root, () => 'entered', {
        duringRecoveryObservation: () => {
          observations += 1
          rmSync(recoveryPath, { recursive: true })
        },
      }),
      'entered',
    )
    assert.equal(observations, 1)
  })

  test('reobserves a successor that replaces a recovery predecessor during observation', () => {
    const root = createRoot()
    const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
    const displacedPath = join(root, 'observed-recovery-predecessor')
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'observed-predecessor' })}\n`,
    )
    let observations = 0

    assert.equal(
      withOperationLock(root, () => 'entered', {
        duringRecoveryObservation: () => {
          observations += 1
          if (observations === 1) {
            renameSync(recoveryPath, displacedPath)
            mkdirSync(recoveryPath)
            writeFileSync(
              join(recoveryPath, 'owner.json'),
              `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'observed-successor' })}\n`,
            )
          } else {
            rmSync(recoveryPath, { recursive: true })
          }
        },
      }),
      'entered',
    )
    assert.equal(observations, 2)
    assert.match(readFileSync(join(displacedPath, 'owner.json'), 'utf8'), /observed-predecessor/u)
  })

  test('reobserves a live owner token installed before stale-marker reclaim', () => {
    const root = createRoot()
    const recoveryPath = join(root, 'node_modules', '.cache', 'encephalon', 'operation-lock.recovery')
    const completedProcess = spawnSync(process.execPath, ['-e', ''])
    assert.equal(completedProcess.status, 0)
    assert.ok(completedProcess.pid !== undefined)
    mkdirSync(recoveryPath, { recursive: true })
    writeFileSync(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: completedProcess.pid, token: 'predecessor' })}\n`,
    )
    let observations = 0
    let staleCallbacks = 0

    assert.equal(
      withOperationLock(root, () => 'entered', {
        afterRecoveryStaleObservation: () => {
          staleCallbacks += 1
          assert.equal(staleCallbacks, 1)
          writeFileSync(
            join(recoveryPath, 'owner.json'),
            `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'successor' })}\n`,
          )
        },
        duringRecoveryObservation: () => {
          observations += 1
          if (observations === 2) {
            assert.match(readFileSync(join(recoveryPath, 'owner.json'), 'utf8'), /successor/u)
            rmSync(recoveryPath, { recursive: true })
          }
        },
      }),
      'entered',
    )
    assert.equal(observations, 2)
    assert.equal(staleCallbacks, 1)
  })

  test('applies the total deadline after recovery ownership is repeatedly lost', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
    let recoveryCreations = 0
    const clock = [0, 0, 0, 60_000]
    const hooks = {
      afterRecoveryCreation: () => {
        recoveryCreations += 1
        rmSync(recoveryPath, { recursive: true })
        if (recoveryCreations === 3) {
          throw new Error('recovery deadline was not applied')
        }
      },
      now: () => clock.shift() ?? 60_000,
    }

    assert.throws(
      () => withOperationLock(root, () => 'entered', hooks),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'CACHE_BUSY')
        return true
      },
    )
    assert.equal(recoveryCreations, 1)
  })

  test('cleans only the captured recovery directory identity', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    const displacedPath = join(root, 'displaced-owned-recovery')
    const completedSuccessorPath = join(root, 'completed-successor-recovery')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
    let predecessorIdentity: { dev: bigint; ino: bigint } | undefined
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    let recoveryCreations = 0

    assert.equal(
      withOperationLock(root, () => 'entered', {
        afterRecoveryCreation: () => {
          recoveryCreations += 1
          if (recoveryCreations === 1) {
            predecessorIdentity = statSync(recoveryPath, { bigint: true })
            renameSync(recoveryPath, displacedPath)
            mkdirSync(recoveryPath)
            writeFileSync(
              join(recoveryPath, 'owner.json'),
              `${JSON.stringify({
                acquiredAt: new Date().toISOString(),
                pid: process.pid,
                token: 'identity-successor',
              })}\n`,
            )
            writeFileSync(join(recoveryPath, 'successor-sentinel'), 'successor recovery')
            successorIdentity = statSync(recoveryPath, { bigint: true })
          }
        },
        duringRecoveryObservation: () => {
          renameSync(recoveryPath, completedSuccessorPath)
        },
      }),
      'entered',
    )
    assert.equal(recoveryCreations, 2)
    assert.ok(predecessorIdentity !== undefined)
    assert.ok(successorIdentity !== undefined)
    assert.equal(sameCacheEntryIdentity(predecessorIdentity, statSync(displacedPath, { bigint: true })), true)
    assert.equal(sameCacheEntryIdentity(successorIdentity, statSync(completedSuccessorPath, { bigint: true })), true)
    assert.equal(readFileSync(join(completedSuccessorPath, 'successor-sentinel'), 'utf8'), 'successor recovery')
  })

  test('reacquires recovery ownership lost while quarantining the corrupt gate', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
    let recoveryCreations = 0
    let replacementObservations = 0
    let recoveryLost = false
    cacheLocationTestHooks.afterQuarantineRename = path => {
      if (!recoveryLost && basename(path).includes('.operation-lock.sqlite.')) {
        recoveryLost = true
        writeFileSync(
          join(recoveryPath, 'owner.json'),
          `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'gate-successor' })}\n`,
        )
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered', {
        afterRecoveryCreation: () => {
          recoveryCreations += 1
        },
        duringRecoveryObservation: () => {
          replacementObservations += 1
          rmSync(recoveryPath, { recursive: true })
        },
      }),
      'entered',
    )
    assert.equal(recoveryLost, true)
    assert.equal(recoveryCreations, 2)
    assert.equal(replacementObservations, 1)
  })

  test('rejects a successor inserted after gate quarantine and recovery ownership loss', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const gatePath = join(cachePath, 'operation-lock.sqlite')
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(gatePath, 'not a sqlite database')
    let operationEntered = false
    let replacementObservations = 0
    let successorIdentity: { dev: bigint; ino: bigint } | undefined
    cacheLocationTestHooks.afterQuarantineRename = path => {
      if (successorIdentity === undefined && basename(path).includes('.operation-lock.sqlite.')) {
        const successor = new DatabaseSync(gatePath)
        successor.close()
        successorIdentity = statSync(gatePath, { bigint: true })
        writeFileSync(
          join(recoveryPath, 'owner.json'),
          `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'gate-successor' })}\n`,
        )
      }
    }

    assert.throws(
      () =>
        withOperationLock(
          root,
          () => {
            operationEntered = true
            return 'entered'
          },
          {
            duringRecoveryObservation: () => {
              replacementObservations += 1
              rmSync(recoveryPath, { recursive: true })
            },
          },
        ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.sqlite',
          invariant: 'stable-identity',
        })
        return true
      },
    )
    assert.equal(operationEntered, false)
    assert.equal(replacementObservations, 1)
    assert.ok(successorIdentity !== undefined)
    assert.equal(sameCacheEntryIdentity(successorIdentity, statSync(gatePath, { bigint: true })), true)
  })

  test('reacquires recovery ownership lost after the recovered gate begins', () => {
    const root = createRoot()
    const cachePath = cacheDirectoryPath(root)
    const recoveryPath = join(cachePath, 'operation-lock.recovery')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'operation-lock.sqlite'), 'not a sqlite database')
    let recoveryCreations = 0
    let replacementObservations = 0
    let recoveryLost = false
    cacheLocationTestHooks.afterDatabaseLockInitialisation = database => {
      if (!recoveryLost && database.name === 'operation-lock.sqlite' && existsSync(recoveryPath)) {
        recoveryLost = true
        writeFileSync(
          join(recoveryPath, 'owner.json'),
          `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'initialisation-successor' })}\n`,
        )
      }
    }

    assert.equal(
      withOperationLock(root, () => 'entered', {
        afterRecoveryCreation: () => {
          recoveryCreations += 1
        },
        duringRecoveryObservation: () => {
          replacementObservations += 1
          rmSync(recoveryPath, { recursive: true })
        },
      }),
      'entered',
    )
    assert.equal(recoveryLost, true)
    assert.equal(recoveryCreations, 2)
    assert.equal(replacementObservations, 1)
  })

  test('preserves directory replacements at lock and recovery quarantine paths', () => {
    const cases = ['operation.lock', 'operation-lock.recovery'] as const
    for (const name of cases) {
      const root = createRoot()
      const path = join(cacheDirectoryPath(root), name)
      mkdirSync(path, { recursive: true })
      writeFileSync(
        join(path, 'owner.json'),
        `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: 2_147_483_647, token: name })}\n`,
      )
      let quarantinePath: string | undefined
      cacheLocationTestHooks.afterQuarantineRename = candidate => {
        if (candidate.includes(`.${name}.`)) {
          quarantinePath = candidate
          rmSync(candidate, { recursive: true })
          mkdirSync(candidate)
          writeFileSync(join(candidate, 'replacement-sentinel'), name)
        }
      }

      assert.throws(
        () => withOperationLock(root, () => 'entered'),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
          return true
        },
      )
      assert.ok(quarantinePath !== undefined)
      assert.equal(readFileSync(join(quarantinePath, 'replacement-sentinel'), 'utf8'), name)
      cacheLocationTestHooks.afterQuarantineRename = undefined
    }
  })

  test('reports a quarantine move only after verifying the moved directory identity', () => {
    const root = createRoot()
    const location = inspectCacheLocation(root)
    const directory = createCacheOwnedDirectory(location, 'operation-lock.recovery')
    const predecessorPath = join(location.directory, '.recovery-predecessor')
    let ownershipChecks = 0
    let moved = false
    let renamed = false

    assert.throws(
      () =>
        quarantineCacheOwnedDirectory(
          location,
          directory,
          () => {
            ownershipChecks += 1
            if (ownershipChecks === 2) {
              renameSync(directory.path, predecessorPath)
              mkdirSync(directory.path)
              writeFileSync(join(directory.path, 'successor-sentinel'), 'successor')
            }
            return true
          },
          {
            onMove: () => {
              moved = true
            },
            onRename: () => {
              renamed = true
            },
          },
        ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'REPOSITORY_CHANGED')
        assert.deepEqual((error as { details?: unknown }).details, {
          entry: 'node_modules/.cache/encephalon/operation-lock.recovery',
          invariant: 'stable-quarantine-identity',
        })
        return true
      },
    )

    const quarantines = readdirSync(location.directory).filter(
      name => name.startsWith('.operation-lock.recovery.') && name.endsWith('.quarantine'),
    )
    assert.equal(ownershipChecks, 2)
    assert.equal(moved, false)
    assert.equal(renamed, true)
    assert.equal(quarantines.length, 1)
    assert.equal(
      readFileSync(join(location.directory, quarantines[0] as string, 'successor-sentinel'), 'utf8'),
      'successor',
    )
    assert.equal(existsSync(predecessorPath), true)
  })

  test('serialises two contenders recovering the same malformed operation gate', async () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon')
    const gatePath = join(cachePath, 'operation-lock.sqlite')
    const firstRelease = join(root, 'release-first-corrupt-gate-contender')
    const secondRelease = join(root, 'release-second-corrupt-gate-contender')
    const activePath = join(root, 'active-corrupt-gate-contender')
    const firstReady = join(root, 'first-corrupt-gate-ready')
    const secondReady = join(root, 'second-corrupt-gate-ready')
    const markerOwned = join(root, 'corrupt-gate-marker-owned')
    const markerObserved = join(root, 'corrupt-gate-marker-observed')
    const firstEntered = join(root, 'first-corrupt-gate-entered')
    const secondEntered = join(root, 'second-corrupt-gate-entered')
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(gatePath, 'not a sqlite database')

    const fixture = join(import.meta.dirname, 'fixtures', 'contend-for-corrupt-gate.ts')
    const first = spawn(
      process.execPath,
      [fixture, root, firstReady, firstRelease, activePath, firstEntered, '300', 'owner', markerOwned, markerObserved],
      { stdio: 'inherit' },
    )
    const second = spawn(
      process.execPath,
      [
        fixture,
        root,
        secondReady,
        secondRelease,
        activePath,
        secondEntered,
        '300',
        'observer',
        markerOwned,
        markerObserved,
      ],
      {
        stdio: 'inherit',
      },
    )

    try {
      waitForPath(firstReady, first)
      waitForPath(secondReady, second)
      writeFileSync(firstRelease, 'release')
      waitForPath(markerOwned, first)
      writeFileSync(secondRelease, 'release')
      waitForPath(markerObserved, second)

      await Promise.all([waitForChild(first), waitForChild(second)])
      assert.equal(first.exitCode, 0)
      assert.equal(second.exitCode, 0)
      assert.equal(existsSync(firstEntered), true)
      assert.equal(existsSync(secondEntered), true)
    } finally {
      await Promise.all([stopChild(first), stopChild(second)])
    }
  })

  test('serialises two contenders that both observed the same stale lock', async () => {
    const root = createRoot()
    const cachePath = join(root, 'node_modules', '.cache', 'encephalon')
    const lockPath = join(cachePath, 'operation.lock')
    const releasePath = join(root, 'release-contenders')
    const activePath = join(root, 'active-contender')
    const firstObserved = join(root, 'first-observed')
    const secondObserved = join(root, 'second-observed')
    const firstEntered = join(root, 'first-entered')
    const secondEntered = join(root, 'second-entered')
    const deadProcess = spawnSync(process.execPath, ['-e', ''])
    const deadPid = deadProcess.pid
    assert.equal(deadProcess.status, 0)
    assert.ok(deadPid !== undefined)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({
        acquiredAt: '2026-08-06T10:00:00.000Z',
        pid: deadPid,
        token: 'dead-owner',
      })}\n`,
    )

    const fixture = join(import.meta.dirname, 'fixtures', 'contend-for-stale-lock.ts')
    const first = spawn(process.execPath, [fixture, root, firstObserved, releasePath, activePath, firstEntered, '0'], {
      stdio: 'inherit',
    })
    const second = spawn(
      process.execPath,
      [fixture, root, secondObserved, releasePath, activePath, secondEntered, '75'],
      { stdio: 'inherit' },
    )

    const deadline = Date.now() + 5000
    while (
      !(existsSync(firstObserved) && existsSync(secondObserved)) &&
      first.exitCode === null &&
      second.exitCode === null &&
      Date.now() < deadline
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    assert.equal(existsSync(firstObserved), true)
    assert.equal(existsSync(secondObserved), true)
    writeFileSync(releasePath, 'release')

    if (first.exitCode === null) {
      await once(first, 'exit')
    }
    if (second.exitCode === null) {
      await once(second, 'exit')
    }
    assert.equal(first.exitCode, 0)
    assert.equal(second.exitCode, 0)
    assert.equal(existsSync(firstEntered), true)
    assert.equal(existsSync(secondEntered), true)
    assert.equal(existsSync(join(cachePath, 'operation-lock.sqlite')), true)
  })

  test('keeps a persistent WAL operation gate exclusive until its holder releases', async () => {
    const root = createRoot()
    withOperationLock(root, () => 'prepared')
    const gatePath = join(cacheDirectoryPath(root), 'operation-lock.sqlite')
    const database = new DatabaseSync(gatePath)
    try {
      const mode = database.prepare('PRAGMA journal_mode = WAL').get() as {
        journal_mode?: unknown
      }
      assert.equal(mode.journal_mode, 'wal')
    } finally {
      database.close()
    }
    const fixture = join(import.meta.dirname, 'fixtures', 'hold-operation-lock-until-release.ts')
    const releasePath = join(root, 'release-wal-operation-lock')
    const firstAttempted = join(root, 'first-wal-lock-attempted')
    const firstEntered = join(root, 'first-wal-lock-entered')
    const secondAttempted = join(root, 'second-wal-lock-attempted')
    const secondEntered = join(root, 'second-wal-lock-entered')
    const first = spawn(process.execPath, [fixture, root, firstAttempted, firstEntered, releasePath], {
      stdio: 'inherit',
    })
    waitForPath(firstEntered, first)
    const second = spawn(process.execPath, [fixture, root, secondAttempted, secondEntered, releasePath], {
      stdio: 'inherit',
    })
    waitForPath(secondAttempted, second)
    const secondEnteredBeforeRelease = existsSync(secondEntered)
    assert.equal(existsSync(secondAttempted), true)
    assert.equal(first.exitCode, null)
    assert.equal(second.exitCode, null)
    assert.equal(secondEnteredBeforeRelease, false)
    writeFileSync(releasePath, 'release')

    if (first.exitCode === null) {
      await once(first, 'exit')
    }
    if (second.exitCode === null) {
      await once(second, 'exit')
    }
    assert.equal(first.exitCode, 0)
    assert.equal(second.exitCode, 0)
    assert.equal(existsSync(secondEntered), true)
  })

  test('rejects a symlinked canonical root without traversing it', {
    skip: process.platform === 'win32' ? 'Windows runners may not permit directory symlink creation.' : false,
  }, () => {
    const root = createRoot()
    const target = createRoot()
    symlinkSync(target, join(root, 'encephalon'), 'dir')
    const prepare = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')
    assert.throws(
      () => prepare({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
  })

  test('serialises cache mutations across processes', async () => {
    const root = createRoot()
    const readyPath = join(root, 'lock-ready')
    const holder = spawn(
      process.execPath,
      [join(import.meta.dirname, 'fixtures', 'hold-operation-lock.ts'), root, readyPath],
      { stdio: 'inherit' },
    )
    const deadline = Date.now() + 5000
    while (!existsSync(readyPath) && holder.exitCode === null && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    assert.equal(existsSync(readyPath), true)

    const record = functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
      id: 'added-after-external-lock',
      kind: 'context',
      payload: { summary: 'Cross-process serialisation' },
      root,
      source: 'test',
      subject: 'cache.locking',
    })
    assert.equal(record.id, 'added-after-external-lock')
    if (holder.exitCode === null) {
      await once(holder, 'exit')
    }
    assert.equal(holder.exitCode, 0)
  })

  test('rejects a cache shared by two repository realpaths', () => {
    const firstRoot = createRoot()
    const secondRoot = createRoot()
    functionFromApi<(input: Record<string, unknown>) => unknown>('addRecord')({
      id: 'first-scope-record',
      kind: 'context',
      payload: { summary: 'First repository' },
      root: firstRoot,
      source: 'agent',
      subject: 'repository.scope',
    })

    rmSync(join(secondRoot, 'node_modules'), { recursive: true })
    symlinkSync(join(firstRoot, 'node_modules'), join(secondRoot, 'node_modules'), 'dir')
    const listRecords = functionFromApi<(input: Record<string, unknown>) => unknown>('listRecords')
    assert.throws(
      () => listRecords({ root: secondRoot }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        return true
      },
    )
  })
})
