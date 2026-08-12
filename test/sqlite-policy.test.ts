import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { cacheReadTestHooks } from '../src/cache.ts'
import { cacheLocationTestHooks } from '../src/cache-location.ts'
import { EncephalonError, wrapIo } from '../src/errors.ts'
import { prepare } from '../src/index.ts'
import { withOperationLock } from '../src/lock.ts'
import { classifySQLiteError, type SQLiteErrorCategory } from '../src/sqlite-error.ts'
import { createTestRepository, removeTestRepository } from './helpers.ts'

type PolicyCase = {
  category: SQLiteErrorCategory
  error: Error
  publicCode: 'INTERNAL_ERROR' | 'IO_ERROR'
}

const sqliteError = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields)

const policyCases: PolicyCase[] = [
  { category: 'busy', error: sqliteError('busy snapshot', { errcode: 517 }), publicCode: 'IO_ERROR' },
  {
    category: 'cantopen',
    error: sqliteError('cannot open directory', { code: 'SQLITE_CANTOPEN_ISDIR' }),
    publicCode: 'IO_ERROR',
  },
  {
    category: 'corrupt',
    error: sqliteError('database disk image is malformed', { code: 'ERR_SQLITE_ERROR' }),
    publicCode: 'IO_ERROR',
  },
  { category: 'io', error: sqliteError('I/O read', { errcode: 266 }), publicCode: 'IO_ERROR' },
  {
    category: 'locked',
    error: sqliteError('shared cache lock', { code: 'SQLITE_LOCKED_SHAREDCACHE' }),
    publicCode: 'IO_ERROR',
  },
  {
    category: 'notadb',
    error: sqliteError('file is not a database', { code: 'ERR_SQLITE_ERROR' }),
    publicCode: 'IO_ERROR',
  },
  { category: 'readonly', error: sqliteError('read-only recovery', { errcode: 264 }), publicCode: 'IO_ERROR' },
  {
    category: 'schema',
    error: sqliteError('no such table: metadata', { code: 'ERR_SQLITE_ERROR' }),
    publicCode: 'INTERNAL_ERROR',
  },
  {
    category: 'unknown',
    error: sqliteError('database is locked', { code: 'SQLITE_BUSY', errcode: 19 }),
    publicCode: 'INTERNAL_ERROR',
  },
]

const corruptRecoveryError = sqliteError('corrupt virtual table', { errcode: 267 })

const roots: string[] = []

const createRoot = () => {
  const root = createTestRepository()
  roots.push(root)
  return root
}

const assertErrorCode = (operation: () => unknown, code: string) => {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof EncephalonError)
    assert.equal(error.code, code)
    return true
  })
}

afterEach(() => {
  cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
  cacheReadTestHooks.duringDatabaseInitialisation = undefined
  roots.splice(0).forEach(removeTestRepository)
})

describe('SQLite consumer policies', () => {
  test('public wrapping preserves category policy across SQLite representations', () => {
    for (const entry of policyCases) {
      assert.equal(classifySQLiteError(entry.error), entry.category, entry.category)
      assertErrorCode(() => wrapIo('Wrapped failure.', entry.error), entry.publicCode)
    }
  })

  test('cache recovery accepts only disposable cache categories', () => {
    const recoverable = new Set(['cantopen', 'corrupt', 'notadb', 'readonly', 'schema'])
    for (const entry of policyCases) {
      const root = createRoot()
      let writerInitialisations = 0
      cacheReadTestHooks.duringDatabaseInitialisation = mode => {
        if (mode === 'writer') {
          writerInitialisations += 1
          if (writerInitialisations === 1) {
            throw entry.error
          }
        }
      }

      if (recoverable.has(entry.category)) {
        assert.deepEqual(prepare({ root }), { hydrated: true, recordsIndexed: 0 }, entry.category)
        assert.equal(writerInitialisations, 2, entry.category)
      } else {
        assertErrorCode(() => prepare({ root }), entry.publicCode)
        assert.equal(writerInitialisations, 1, entry.category)
      }
      cacheReadTestHooks.duringDatabaseInitialisation = undefined
    }

    const root = createRoot()
    let exhaustedSchemaInitialisations = 0
    cacheReadTestHooks.duringDatabaseInitialisation = mode => {
      if (mode === 'writer') {
        exhaustedSchemaInitialisations += 1
        throw sqliteError('no such table: metadata', { code: 'ERR_SQLITE_ERROR' })
      }
    }
    assertErrorCode(() => prepare({ root }), 'INTERNAL_ERROR')
    assert.equal(exhaustedSchemaInitialisations, 2)
  })

  test('operation gate handles only contention and disposable corruption categories', () => {
    const recoverable = new Set(['corrupt', 'notadb'])
    for (const entry of policyCases) {
      const root = createRoot()
      let gateInitialisations = 0
      cacheLocationTestHooks.afterDatabaseLockInitialisation = () => {
        gateInitialisations += 1
        if (gateInitialisations === 1) {
          throw entry.error
        }
      }

      if (entry.category === 'busy' || entry.category === 'locked') {
        assertErrorCode(() => withOperationLock(root, () => 'entered'), 'CACHE_BUSY')
        assert.equal(gateInitialisations, 1, entry.category)
      } else if (recoverable.has(entry.category)) {
        assert.equal(
          withOperationLock(root, () => 'entered'),
          'entered',
          entry.category,
        )
        assert.equal(gateInitialisations, 2, entry.category)
      } else {
        assertErrorCode(() => withOperationLock(root, () => 'entered'), entry.publicCode)
        assert.equal(gateInitialisations, 1, entry.category)
      }
      cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
    }
  })

  test('operation gate preserves category policy while corrupt recovery is held', () => {
    const recoverable = new Set(['corrupt', 'notadb'])
    for (const entry of policyCases) {
      const root = createRoot()
      let gateInitialisations = 0
      cacheLocationTestHooks.afterDatabaseLockInitialisation = () => {
        gateInitialisations += 1
        if (gateInitialisations === 1) {
          throw corruptRecoveryError
        }
        if (gateInitialisations === 2) {
          throw entry.error
        }
      }

      if (entry.category === 'busy' || entry.category === 'locked') {
        assertErrorCode(() => withOperationLock(root, () => 'entered'), 'CACHE_BUSY')
        assert.equal(gateInitialisations, 2, entry.category)
      } else if (recoverable.has(entry.category)) {
        assert.equal(
          withOperationLock(root, () => 'entered'),
          'entered',
          entry.category,
        )
        assert.equal(gateInitialisations, 3, entry.category)
      } else {
        assertErrorCode(() => withOperationLock(root, () => 'entered'), entry.publicCode)
        assert.equal(gateInitialisations, 2, entry.category)
      }
      cacheLocationTestHooks.afterDatabaseLockInitialisation = undefined
    }
  })
})
