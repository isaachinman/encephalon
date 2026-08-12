import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { classifySQLiteError, type SQLiteErrorCategory } from '../src/sqlite-error.ts'

type ClassificationCase = {
  category: SQLiteErrorCategory
  error: unknown
  name: string
}

const assertClassifications = (cases: ClassificationCase[]) => {
  for (const entry of cases) {
    assert.equal(classifySQLiteError(entry.error), entry.category, entry.name)
  }
}

describe('SQLite error classification', () => {
  test('normalises primary and extended numeric result codes', () => {
    assertClassifications([
      { category: 'busy', error: { errcode: 5 }, name: 'BUSY' },
      { category: 'busy', error: { errcode: 517 }, name: 'BUSY_SNAPSHOT' },
      { category: 'locked', error: { errcode: 6 }, name: 'LOCKED' },
      { category: 'locked', error: { errcode: 262 }, name: 'LOCKED_SHAREDCACHE' },
      { category: 'corrupt', error: { errcode: 11 }, name: 'CORRUPT' },
      { category: 'corrupt', error: { errcode: 267 }, name: 'CORRUPT_VTAB' },
      { category: 'notadb', error: { errcode: 26 }, name: 'NOTADB' },
      { category: 'readonly', error: { errcode: 8 }, name: 'READONLY' },
      { category: 'readonly', error: { errcode: 264 }, name: 'READONLY_RECOVERY' },
      { category: 'cantopen', error: { errcode: 14 }, name: 'CANTOPEN' },
      { category: 'cantopen', error: { errcode: 270 }, name: 'CANTOPEN_NOTEMPDIR' },
      { category: 'io', error: { errcode: 10 }, name: 'IOERR' },
      { category: 'io', error: { errcode: 266 }, name: 'IOERR_READ' },
      { category: 'io', error: { errcode: 3 }, name: 'PERM' },
      { category: 'io', error: { errcode: 7 }, name: 'NOMEM' },
      { category: 'io', error: { errcode: 13 }, name: 'FULL' },
      { category: 'unknown', error: { errcode: 19 }, name: 'CONSTRAINT' },
      { category: 'unknown', error: { errcode: 1555 }, name: 'CONSTRAINT_PRIMARYKEY' },
    ])
  })

  test('accepts extended symbolic result codes and gives numeric codes precedence', () => {
    assertClassifications([
      { category: 'busy', error: { code: 'SQLITE_BUSY_SNAPSHOT' }, name: 'symbolic BUSY_SNAPSHOT' },
      {
        category: 'locked',
        error: { code: 'SQLITE_LOCKED_SHAREDCACHE' },
        name: 'symbolic LOCKED_SHAREDCACHE',
      },
      { category: 'corrupt', error: { code: 'SQLITE_CORRUPT_SEQUENCE' }, name: 'symbolic CORRUPT_SEQUENCE' },
      { category: 'notadb', error: { code: 'SQLITE_NOTADB' }, name: 'symbolic NOTADB' },
      { category: 'readonly', error: { code: 'SQLITE_READONLY_ROLLBACK' }, name: 'symbolic READONLY_ROLLBACK' },
      { category: 'cantopen', error: { code: 'SQLITE_CANTOPEN_ISDIR' }, name: 'symbolic CANTOPEN_ISDIR' },
      { category: 'io', error: { code: 'SQLITE_IOERR_FSYNC' }, name: 'symbolic IOERR_FSYNC' },
      { category: 'io', error: { code: 'SQLITE_FULL' }, name: 'symbolic FULL' },
      {
        category: 'unknown',
        error: { code: 'SQLITE_BUSY_SNAPSHOT', errcode: 19, message: 'database is locked' },
        name: 'numeric constraint contradicts busy code and message',
      },
      {
        category: 'corrupt',
        error: { code: 'SQLITE_BUSY', errcode: 267, message: 'database is locked' },
        name: 'numeric extended corruption contradicts busy code and message',
      },
      {
        category: 'unknown',
        error: { code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'database is locked' },
        name: 'symbolic constraint contradicts busy message',
      },
    ])
  })

  test('uses bounded message fallback only for generic SQLite runtime errors', () => {
    assertClassifications([
      {
        category: 'busy',
        error: Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }),
        name: 'runtime-only busy message',
      },
      {
        category: 'locked',
        error: Object.assign(new Error('database table is locked'), { code: 'ERR_SQLITE_ERROR' }),
        name: 'runtime-only locked message',
      },
      {
        category: 'corrupt',
        error: Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR' }),
        name: 'runtime-only corrupt message',
      },
      {
        category: 'notadb',
        error: Object.assign(new Error('file is not a database'), { code: 'ERR_SQLITE_ERROR' }),
        name: 'runtime-only not-a-database message',
      },
      {
        category: 'readonly',
        error: Object.assign(new Error('attempt to write a readonly database'), { code: 'ERR_SQLITE_ERROR' }),
        name: 'runtime-only read-only message',
      },
      {
        category: 'cantopen',
        error: Object.assign(new Error('unable to open database file'), { code: 'ERR_SQLITE_ERROR' }),
        name: 'runtime-only cannot-open message',
      },
      {
        category: 'io',
        error: Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' }),
        name: 'runtime-only I/O message',
      },
      {
        category: 'schema',
        error: Object.assign(new Error('no such table: metadata'), { code: 'ERR_SQLITE_ERROR', errcode: 1 }),
        name: 'generic SQLite result refined by schema message',
      },
      {
        category: 'unknown',
        error: Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 1 }),
        name: 'generic numeric result is not overridden by a busy message',
      },
      { category: 'unknown', error: new Error('database is locked'), name: 'arbitrary locked Error' },
      {
        category: 'unknown',
        error: Object.assign(new Error(`${'x'.repeat(4096)}database is locked`), { code: 'ERR_SQLITE_ERROR' }),
        name: 'message outside fallback bound',
      },
    ])
  })
})
