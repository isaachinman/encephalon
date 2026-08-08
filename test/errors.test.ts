import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { wrapIo } from '../src/errors.ts'
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
      Object.assign(new Error('file is not a database'), { code: 'ERR_SQLITE_ERROR', errcode: 26 }),
      'IO_ERROR',
    )
  })
})
