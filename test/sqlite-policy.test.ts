import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { cacheReadTestHooks } from '../src/cache.ts'
import { cacheLocationTestHooks } from '../src/cache-location.ts'
import { EncephalonError } from '../src/errors.ts'
import { prepare } from '../src/index.ts'
import { withOperationLock } from '../src/lock.ts'
import type { SQLiteErrorCategory } from '../src/sqlite-error.ts'
import { createTestRepository, removeTestRepository } from './helpers.ts'

type PolicyCase = {
  category: SQLiteErrorCategory
  error: Error
  publicCode: 'INTERNAL_ERROR' | 'IO_ERROR'
}

const sqliteError = (errcode: number, message: string) =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })

const policyCases: PolicyCase[] = [
  { category: 'busy', error: sqliteError(5, 'database is locked'), publicCode: 'IO_ERROR' },
  { category: 'cantopen', error: sqliteError(14, 'unable to open database file'), publicCode: 'IO_ERROR' },
  { category: 'corrupt', error: sqliteError(11, 'database disk image is malformed'), publicCode: 'IO_ERROR' },
  { category: 'io', error: sqliteError(10, 'disk I/O error'), publicCode: 'IO_ERROR' },
  { category: 'locked', error: sqliteError(6, 'database table is locked'), publicCode: 'IO_ERROR' },
  { category: 'notadb', error: sqliteError(26, 'file is not a database'), publicCode: 'IO_ERROR' },
  { category: 'readonly', error: sqliteError(8, 'attempt to write a readonly database'), publicCode: 'IO_ERROR' },
  { category: 'schema', error: sqliteError(1, 'no such table: metadata'), publicCode: 'INTERNAL_ERROR' },
  { category: 'unknown', error: sqliteError(19, 'constraint failed'), publicCode: 'INTERNAL_ERROR' },
]

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
        throw sqliteError(1, 'no such table: metadata')
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
})
