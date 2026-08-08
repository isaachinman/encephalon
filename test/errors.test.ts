import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cliErrorResponse, EncephalonError, wrapIo } from '../src/errors.ts'

const wrappedError = (cause: unknown) => {
  try {
    wrapIo('Unable to complete the operation.', cause)
  } catch (error) {
    assert.equal(error instanceof EncephalonError, true)
    return error as EncephalonError
  }
  return assert.fail('wrapIo must throw.')
}

describe('error classification', () => {
  test('wraps recognized filesystem and SQLite failures as expected I/O errors', () => {
    const causes = [
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      Object.assign(new Error('no space left'), { code: 'ENOSPC' }),
      Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' }),
      Object.assign(new Error('database is locked'), { errcode: 5 }),
      Object.assign(new Error('database disk image is malformed'), { errcode: 11 }),
      Object.assign(new Error('file is not a database'), { errcode: 26 }),
    ]

    for (const cause of causes) {
      const error = wrappedError(cause)
      assert.equal(error.code, 'IO_ERROR')
      assert.equal(error.cause, cause)
    }
  })

  test('wraps programming defects as internal errors while preserving the API cause', () => {
    for (const cause of [new TypeError('bad invariant'), new RangeError('bad range')]) {
      const error = wrappedError(cause)
      assert.equal(error.code, 'INTERNAL_ERROR')
      assert.equal(error.cause, cause)
    }
  })

  test('projects internal errors as exit status 1 with CLI-safe details', () => {
    const error = new EncephalonError('INTERNAL_ERROR', '/tmp/repository leaked', {
      cause: { message: 'raw cause' },
      field: 'payload',
      path: 'encephalon/decision/example.json',
      stack: 'Error: leaked',
    })

    assert.deepEqual(cliErrorResponse(error), {
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          details: {
            field: 'payload',
            path: 'encephalon/decision/example.json',
          },
          message: 'An unexpected internal error occurred.',
        },
      },
      exitCode: 1,
    })
  })
})
