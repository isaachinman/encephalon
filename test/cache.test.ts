import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { basename, join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { afterEach, describe, test } from 'node:test'
import { artifactInspectionTestHooks } from '../src/artifact-inspection.ts'
import { cacheReadTestHooks } from '../src/cache.ts'
import {
  CacheDatabaseFailure,
  cacheLocationTestHooks,
  inspectCacheDatabase,
  inspectCacheLocation,
  inspectCacheOwnedDirectory,
  openVerifiedCacheDatabase,
  sameCacheEntryIdentity,
} from '../src/cache-location.ts'
import { CanonicalDirectoryChangedError } from '../src/canonical-layout.ts'
import { PACKAGE_VERSION } from '../src/generated/version.ts'
import * as api from '../src/index.ts'
import { withOperationLock } from '../src/lock.ts'
import { ordinalStringCompare } from '../src/order.ts'
import { recordWriteTestHooks } from '../src/records.ts'
import { repositoryTestHooks } from '../src/repository.ts'
import { responseBudgetTestHooks } from '../src/response-budget.ts'
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

afterEach(() => {
  artifactInspectionTestHooks.close = undefined
  artifactInspectionTestHooks.fault = undefined
  artifactInspectionTestHooks.open = undefined
  cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
  cacheLocationTestHooks.afterDatabaseOpen = undefined
  cacheLocationTestHooks.afterPrimaryBootstrapClose = undefined
  cacheLocationTestHooks.afterQuarantineRename = undefined
  cacheLocationTestHooks.beforeDatabaseOpen = undefined
  cacheLocationTestHooks.beforeLocationInspection = undefined
  cacheLocationTestHooks.beforeOwnedDirectoryFinalIdentity = undefined
  cacheLocationTestHooks.beforeQuarantineRename = undefined
  cacheLocationTestHooks.duringOwnedDirectoryInspection = undefined
  cacheLocationTestHooks.regularFileRealpath = undefined
  cacheReadTestHooks.afterCanonicalValidation = undefined
  cacheReadTestHooks.afterDisposableCacheRecoveryRebuild = undefined
  cacheReadTestHooks.afterGatherSearchEvaluation = undefined
  cacheReadTestHooks.afterIntegrityProbe = undefined
  cacheReadTestHooks.afterManifestKindEnumeration = undefined
  cacheReadTestHooks.afterManifestEntryLstat = undefined
  cacheReadTestHooks.afterManifestRootEnumeration = undefined
  cacheReadTestHooks.afterMissingPrimaryRecoveryObservation = undefined
  cacheReadTestHooks.afterPrimaryDatabaseObservation = undefined
  cacheReadTestHooks.beforeManifestEntryLstat = undefined
  cacheReadTestHooks.beforeIntegrityTextRead = undefined
  cacheReadTestHooks.duringDatabaseInitialisation = undefined
  responseBudgetTestHooks.afterCharge = undefined
  recordWriteTestHooks.fault = undefined
  repositoryTestHooks.afterGitMarkerDecision = undefined
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
  functionFromApi<(input: Record<string, unknown>) => Record<string, unknown>>('addRecord')({
    id: 'cache-record',
    kind: 'context',
    payload: { detail: 'cache corruption marker', summary: 'Cache record' },
    root,
    searchText: 'recoverable cache row',
    source: 'agent',
    subject: 'cache.validation',
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

test('does not accept an artifact mutation during fresh record-manifest enumeration', () => {
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
  cacheReadTestHooks.afterManifestRootEnumeration = () => {
    if (!mutated) {
      writeFileSync(artifactPath, '<svg>after-enumeration</svg>')
      mutated = true
    }
  }

  assert.deepEqual(api.prepare({ root }), { hydrated: true, recordsIndexed: 1 })
  assert.equal(mutated, true)
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
          assert.equal(JSON.stringify(error).includes(outside), false)
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
        assert.equal(JSON.stringify(error).includes(outside), false)
        return true
      },
    )
    assert.equal(readFileSync(target, 'utf8'), 'outside database bytes')
    assert.equal(readFileSync(cacheDatabasePath(root), 'utf8'), 'outside database bytes')
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

  test('rejects an operation lock candidate symlink without changing its target', () => {
    const root = createRoot()
    const outside = createOutsideDirectory()
    mkdirSync(cacheDirectoryPath(root), { recursive: true })
    writeFileSync(join(outside, 'sentinel'), 'outside candidate')
    symlinkSync(
      outside,
      join(cacheDirectoryPath(root), 'operation.lock.00000000-0000-4000-8000-000000000000'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    assertCacheLayoutRejected(() => withOperationLock(root, () => 'entered'))
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside candidate')
  })
})

describe('SQLite cache and reads', () => {
  test('rejects invalid public API inputs before repository side effects', () => {
    const cases: [string, (root: string) => void][] = [
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

  test('retries record disappearance at the manifest lstat boundary', () => {
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
    cacheReadTestHooks.beforeManifestEntryLstat = path => {
      if (path === recordPath && !removed) {
        removed = true
        rmSync(recordPath)
      }
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 0,
    })
    assert.equal(removed, true)
  })

  test('does not follow a missing-target link replacement at the manifest lstat boundary', () => {
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
    cacheReadTestHooks.beforeManifestEntryLstat = path => {
      if (path === recordPath && !replaced) {
        replaced = true
        rmSync(recordPath)
        symlinkSync(missingTarget, recordPath, process.platform === 'win32' ? 'junction' : 'file')
      }
    }

    assert.throws(
      () => functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'VALIDATION_FAILED')
        assert.equal(JSON.stringify(error).includes(missingTarget), false)
        return true
      },
    )
    assert.equal(replaced, true)
  })

  test('classifies a kind ancestor replacement after manifest entry lstat as repository change', () => {
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
    cacheReadTestHooks.beforeManifestEntryLstat = path => {
      if (path === kindDirectory && replaced) {
        rmSync(kindDirectory)
        renameSync(preservedKindDirectory, kindDirectory)
        replaced = false
      }
    }
    cacheReadTestHooks.afterManifestEntryLstat = path => {
      if (path === kindDirectory && !replaced) {
        renameSync(kindDirectory, preservedKindDirectory)
        symlinkSync(outside, kindDirectory, process.platform === 'win32' ? 'junction' : 'dir')
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
    cacheReadTestHooks.afterManifestRootEnumeration = () => {
      if (replaced) {
        rmSync(artifactDirectory)
        renameSync(preservedArtifactDirectory, artifactDirectory)
        replaced = false
      }
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

  test('retries a kind disappearance during manifest collection without an I/O failure', () => {
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
    cacheReadTestHooks.afterManifestKindEnumeration = () => {
      cacheReadTestHooks.afterManifestKindEnumeration = undefined
      rmSync(kindDirectory, { recursive: true })
    }

    assert.deepEqual(functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root }), {
      hydrated: true,
      recordsIndexed: 0,
    })
  })

  test('bounds persistent manifest replacement as repository change and preserves operational I/O errors', () => {
    const persistentRoot = createRoot()
    const persistentKind = join(persistentRoot, 'encephalon', 'decision')
    mkdirSync(persistentKind, { recursive: true })
    cacheReadTestHooks.afterCanonicalValidation = () => {
      mkdirSync(persistentKind, { recursive: true })
    }
    cacheReadTestHooks.afterManifestRootEnumeration = () => {
      rmSync(persistentKind, { recursive: true })
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
    cacheReadTestHooks.afterManifestRootEnumeration = undefined
    cacheReadTestHooks.beforeManifestEntryLstat = () => {
      throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' })
    }
    const ioRoot = createRoot()
    mkdirSync(join(ioRoot, 'encephalon'))
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
    const prepare =
      functionFromApi<
        (input: Record<string, unknown>) => {
          hydrated: boolean
          recordsIndexed: number
        }
      >('prepare')
    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
    const database = new DatabaseSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'))
    const metadata = database.prepare("SELECT value FROM metadata WHERE key = 'packageVersion'").get()
    assert.equal(metadata?.value, PACKAGE_VERSION)
    database.prepare("UPDATE metadata SET value = '9.9.9' WHERE key = 'packageVersion'").run()
    database.close()

    assert.deepEqual(prepare({ root }), { hydrated: false, recordsIndexed: 0 })

    const schemaDatabase = new DatabaseSync(join(root, 'node_modules', '.cache', 'encephalon', 'brain.sqlite'))
    schemaDatabase.prepare("UPDATE metadata SET value = '0' WHERE key = 'schemaVersion'").run()
    schemaDatabase.close()

    assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 })
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
          gatherRecords({ root, shows: ['not a valid record id', ...Array.from({ length: 64 }, () => 'missing')] }),
      },
      {
        expected: { budget: 'gatherShows', field: 'shows', maximum: 64 },
        run: root => gatherRecords({ root, searches: [42], shows: Array.from({ length: 65 }, () => 'missing') }),
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
          record: { id: string; payload: { detail?: { markers?: string[] }; summary?: string } } | null
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
        throw Object.assign(new Error('private rejected gather generation'), { code: 'SQLITE_CORRUPT' })
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
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({ hydrate: true, root }),
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
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({ hydrate: true, root }),
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

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })

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

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })

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
    cacheReadTestHooks.afterManifestRootEnumeration = () => {
      if (writerOpened && !repositoryRetryInjected) {
        repositoryRetryInjected = true
        throw new CanonicalDirectoryChangedError(root)
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

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })

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
    cacheReadTestHooks.afterManifestRootEnumeration = () => {
      if (writerOpened && !repositoryRetryInjected) {
        repositoryRetryInjected = true
        throw new CanonicalDirectoryChangedError(root)
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
      { expectedHydrated: false, name: 'successor appears after missing observation', successor: true },
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

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })

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

    const result = functionFromApi<(input: Record<string, unknown>) => unknown>('prepare')({ root })
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
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({ hydrate: true, root }),
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
          functionFromApi<(input: Record<string, unknown>) => unknown>('gatherRecords')({ hydrate: true, root }),
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
        throw Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' })
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
        const publicError = error as { cause?: unknown; code?: unknown; details?: unknown; message?: unknown }
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
    const sqliteFailure = Object.assign(new Error('injected schema-like cause'), { code: 'SQLITE_SCHEMA' })
    const databaseFailure = new CacheDatabaseFailure(sqliteFailure, cacheDatabase, { cause: sqliteFailure })
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
        expectedProbe: { name: 'metadata', rows: 7 },
        mutate: (database: DatabaseSync) => {
          database
            .prepare('INSERT INTO metadata(key, value) VALUES (?, ?)')
            .run('unexpected', 'private-metadata-sentinel')
        },
        name: 'seventh metadata row',
      },
      {
        expectedProbe: { name: 'metadata', rows: 6 },
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
    const cases = [
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
            CREATE TABLE replacement_records (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              subject TEXT NOT NULL,
              source TEXT NOT NULL,
              created_at TEXT NOT NULL,
              path TEXT NOT NULL,
              active INTEGER NOT NULL CHECK (active IN (0, 1)),
              summary TEXT,
              record_json TEXT NOT NULL
            );
            WITH RECURSIVE generated(value) AS (
              SELECT 1
              UNION ALL
              SELECT value + 1 FROM generated WHERE value < 12
            )
            INSERT INTO replacement_records
            SELECT printf('%s-%02d', id, value), kind, subject, source, created_at,
              printf('encephalon/context/cache-record-%02d.json', value), active, summary,
              json_set(
                record_json,
                '$.id', printf('%s-%02d', id, value),
                '$.path', printf('encephalon/context/cache-record-%02d.json', value)
              )
            FROM records CROSS JOIN generated;
            DROP TABLE records;
            ALTER TABLE replacement_records RENAME TO records;
            CREATE INDEX records_active_order ON records(active, created_at DESC, id DESC);
            CREATE INDEX records_kind_subject ON records(kind, subject);
            DELETE FROM record_search;
            WITH RECURSIVE generated(value) AS (
              SELECT 1
              UNION ALL
              SELECT value + 1 FROM generated WHERE value < 12
            )
            INSERT INTO record_search(id, text)
            SELECT printf('cache-record-%02d', value), CAST(zeroblob(6242305) AS TEXT)
            FROM generated;
            UPDATE metadata SET value = '12' WHERE key = 'recordsIndexed';
          `)
        },
        name: 'aggregate FTS text above its normalized projection bound',
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

  test('bounds exact cache per-value bytes before semantic FTS recovery', () => {
    const root = createRoot()
    addCacheRecord(root)
    mutateCache(root, database => {
      database
        .prepare(
          `UPDATE records
          SET record_json = json_set(
            record_json,
            '$.payload.padding',
            replace(
              hex(zeroblob(? - length(CAST(json_set(record_json, '$.payload.padding', '') AS BLOB)))),
              '00',
              'x'
            )
          )`,
        )
        .run(1_052_672)
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
      { name: 'metadata', rows: 6 },
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
      { name: 'metadata', rows: 6 },
      { name: 'records', rows: 1000 },
      { name: 'record-search', rows: 1000 },
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
      { expected: { hydrated: true, recordsIndexed: 1 }, name: 'SQLite BLOB', value: Buffer.from('1') },
      { expected: { hydrated: true, recordsIndexed: 1 }, name: 'canonical limit overflow', value: '1001' },
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
    assert.deepEqual(observations.at(corruptProbe + 1), { kind: 'text-read', name: 'record-search' })
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
      { acquiredAt: 'not-a-date', expectedObservations: 2, token: 'unparseable-date-live-owner' },
      { acquiredAt: 'x'.repeat(64), expectedObservations: 2, token: 'timestamp-boundary' },
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
    ] as const

    for (const ownerCase of ownerCases) {
      const root = createRoot()
      const recoveryPath = join(cacheDirectoryPath(root), 'operation-lock.recovery')
      mkdirSync(recoveryPath, { recursive: true })
      writeFileSync(
        join(recoveryPath, 'owner.json'),
        `${JSON.stringify({
          acquiredAt: ownerCase.acquiredAt,
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
            writeFileSync(
              join(recoveryPath, 'owner.json'),
              `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: 'replacement' })}\n`,
            )
          }
        },
        duringRecoveryObservation: () => {
          replacementObservations += 1
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
    let clockReads = 0
    assert.equal(
      withOperationLock(root, () => 'entered on retry', {
        now: () => {
          clockReads += 1
          return clockReads <= 10 ? 0 : 60_000
        },
      }),
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
          throw Object.assign(new Error('recovery marker is temporarily shared'), { code: 'EPERM' })
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
        pid: number
        token: string
      }
      const replacementOwner =
        replacement === 'replacement-token' ? { ...abandonedOwner, token: 'live-replacement-token' } : abandonedOwner
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
