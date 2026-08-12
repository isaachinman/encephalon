import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CacheDatabaseFailure } from '../src/cache-location.ts'
import { cliErrorResponse, EncephalonError, wrapIo } from '../src/errors.ts'
import type { EncephalonErrorCode } from '../src/types.ts'

const assertWrappedCode = (cause: unknown, code: EncephalonErrorCode) => {
  assert.throws(
    () => wrapIo('Wrapped failure.', cause),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, code)
      return true
    },
  )
}

describe('error classification', () => {
  test('classifies expected filesystem errno values as I/O failures', () => {
    for (const code of ['EDQUOT', 'ESTALE', 'EAGAIN']) {
      assertWrappedCode(Object.assign(new Error(code), { code }), 'IO_ERROR')
    }
  })

  test('keeps SQLite programmer errors internal while allowing environmental failures', () => {
    assertWrappedCode(
      Object.assign(new Error('constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 19 }),
      'INTERNAL_ERROR',
    )
    assertWrappedCode(Object.assign(new Error('bad SQL'), { code: 'ERR_SQLITE_ERROR', errcode: 1 }), 'INTERNAL_ERROR')
    assertWrappedCode(
      Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }),
      'IO_ERROR',
    )
    assertWrappedCode(
      Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 266 }),
      'IO_ERROR',
    )
    assertWrappedCode(
      Object.assign(new Error('file is not a database'), { code: 'ERR_SQLITE_ERROR', errcode: 26 }),
      'IO_ERROR',
    )
    assertWrappedCode(
      Object.assign(new Error('UNIQUE constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 1555 }),
      'INTERNAL_ERROR',
    )
  })

  test('classifies plain errors without errno as internal defects', () => {
    assertWrappedCode(new Error('Unable to write file.'), 'INTERNAL_ERROR')
  })

  test('classifies wrapped SQLite I/O failures as expected public errors', () => {
    const database = {
      dev: 1n,
      ino: 2n,
      name: 'brain.sqlite' as const,
      path: 'brain.sqlite',
      relativePath: 'node_modules/.cache/encephalon/brain.sqlite',
      sidecars: {},
    }
    for (const errcode of [10, 14]) {
      const failure = Object.assign(new Error(`SQLite failure ${errcode}`), {
        code: 'ERR_SQLITE_ERROR',
        errcode,
      })
      const wrapped = new CacheDatabaseFailure(failure, database, { cause: failure })

      assert.throws(
        () => wrapIo('Unable to access the cache.', wrapped),
        (error: unknown) => {
          const classified = error as EncephalonError
          assert.equal(classified.code, 'IO_ERROR')
          assert.equal(classified.cause, wrapped)
          assert.equal(cliErrorResponse(classified).exitCode, 2)
          return true
        },
      )
    }
  })
})

describe('CLI error projection', () => {
  test('uses exit 2 for expected errors and exit 1 for internal defects', () => {
    assert.equal(cliErrorResponse(new EncephalonError('IO_ERROR', 'Disk full.')).exitCode, 2)
    assert.equal(cliErrorResponse(new EncephalonError('INTERNAL_ERROR', 'Boom.')).exitCode, 1)
  })

  test('redacts absolute, URL-like, and Windows path shapes from CLI details', () => {
    const response = cliErrorResponse(
      new EncephalonError('CACHE_SCOPE_MISMATCH', 'Wrong cache.', {
        cachedRepository: 'file:///home/secret/repo',
        csvPath: 'path,/var/lib/x',
        openPath: 'open:/tmp/secret',
        relative: 'records/foo.json',
        windowsPath: '\\Users\\secret\\repo',
      }),
    )
    assert.deepEqual(response.body.error.details, { relative: 'records/foo.json' })
  })

  test('drops detail arrays that contain any unsafe element', () => {
    const response = cliErrorResponse(
      new EncephalonError('VALIDATION_FAILED', 'Bad input.', {
        paths: ['records/a.json', '/etc/passwd', 'records/b.json'],
      }),
    )
    assert.deepEqual(response.body.error.details, {})
  })
})
