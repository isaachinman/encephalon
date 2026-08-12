import type { EncephalonErrorCode, JsonValue } from './types.ts'

const FILESYSTEM_ERROR_CODES = new Set([
  'EACCES',
  'EAGAIN',
  'EBUSY',
  'EDQUOT',
  'EEXIST',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'ENOTEMPTY',
  'EPERM',
  'EROFS',
  'ESTALE',
  'EXDEV',
])
const SQLITE_IO_ERROR_CODES = new Set([3, 5, 6, 7, 8, 10, 11, 13, 14, 26])
const SQLITE_IO_STRING_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_CANTOPEN',
  'SQLITE_CORRUPT',
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_NOTADB',
  'SQLITE_PERM',
  'SQLITE_READONLY',
])
const MAX_CLI_STRING_LENGTH = 256
const MAX_CLI_ARRAY_LENGTH = 25
const MAX_CLI_OBJECT_KEYS = 25
const MAX_CLI_NUMBER_MAGNITUDE = 1_000_000_000_000
const UNSAFE_CLI_DETAIL_KEYS = new Set(['cause', 'stack'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && !Array.isArray(value) && typeof value === 'object'

const containsAbsolutePath = (value: string) =>
  /(^|[\s("'=:;,])(\/|[A-Za-z]:[\\/]|\\\\)/.test(value) ||
  /(^|[\s("'=:;,])\\[A-Za-z]/.test(value) ||
  /(^|[\s("'=:;,])file:\/\//i.test(value) ||
  /^[a-z][a-z0-9+.-]*:\//i.test(value)

const isRecognizedFilesystemError = (error: unknown) => {
  if (!isRecord(error)) {
    return false
  }
  return typeof error.code === 'string' && FILESYSTEM_ERROR_CODES.has(error.code)
}

const isRecognizedSQLiteError = (error: unknown) => {
  if (!isRecord(error)) {
    return false
  }
  return (
    (typeof error.code === 'string' && SQLITE_IO_STRING_CODES.has(error.code)) ||
    (typeof error.errcode === 'number' && SQLITE_IO_ERROR_CODES.has(error.errcode & 0xff)) ||
    (typeof error.message === 'string' &&
      /database disk image is malformed|database is locked|file is not a database|SQLITE_(?:BUSY|CANTOPEN|CORRUPT|FULL|IOERR|LOCKED|NOMEM|NOTADB|PERM|READONLY)/i.test(
        error.message,
      ))
  )
}

const hasRecognizedIoCause = (cause: unknown, remainingDepth = 8): boolean =>
  isRecognizedFilesystemError(cause) ||
  isRecognizedSQLiteError(cause) ||
  (remainingDepth > 0 && isRecord(cause) && hasRecognizedIoCause(cause.cause, remainingDepth - 1))

const errorCodeForCause = (cause: unknown): EncephalonErrorCode =>
  hasRecognizedIoCause(cause) ? 'IO_ERROR' : 'INTERNAL_ERROR'

const isCliSafeString = (value: string) =>
  value.length <= MAX_CLI_STRING_LENGTH && !/[\r\n]/.test(value) && !containsAbsolutePath(value)

const cliSafeValue = (value: JsonValue): JsonValue | undefined => {
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= MAX_CLI_NUMBER_MAGNITUDE ? value : undefined
  }
  if (typeof value === 'string') {
    return isCliSafeString(value) ? value : undefined
  }
  if (Array.isArray(value)) {
    const withinLimit = value.length <= MAX_CLI_ARRAY_LENGTH
    const projected = withinLimit ? value.map(item => cliSafeValue(item)) : undefined
    if (projected?.every(item => item !== undefined)) {
      return projected as JsonValue[]
    }
    return
  }
  const safeEntries = Object.entries(value)
    .slice(0, MAX_CLI_OBJECT_KEYS)
    .flatMap(([key, entry]) => {
      if (UNSAFE_CLI_DETAIL_KEYS.has(key)) {
        return []
      }
      const safe = cliSafeValue(entry)
      return safe === undefined ? [] : [[key, safe] as const]
    })
  return Object.fromEntries(safeEntries) as Record<string, JsonValue>
}

export class EncephalonError extends Error {
  readonly code: EncephalonErrorCode
  readonly details: Record<string, JsonValue>

  constructor(
    code: EncephalonErrorCode,
    message: string,
    details: Record<string, JsonValue> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'EncephalonError'
    this.code = code
    this.details = details
  }
}

export const fail = (code: EncephalonErrorCode, message: string, details: Record<string, JsonValue> = {}): never => {
  throw new EncephalonError(code, message, details)
}

export const failWithCause = (
  code: EncephalonErrorCode,
  message: string,
  details: Record<string, JsonValue>,
  cause: unknown,
): never => {
  throw new EncephalonError(code, message, details, { cause })
}

export const wrapIo = (message: string, cause: unknown): never =>
  failWithCause(errorCodeForCause(cause), message, {}, cause)

const cliSafeMessage = (error: EncephalonError) => {
  if (error.code === 'INTERNAL_ERROR') {
    return 'An unexpected internal error occurred.'
  }
  if (isCliSafeString(error.message)) {
    return error.message
  }
  return 'The command failed.'
}

export const cliErrorResponse = (error: EncephalonError) => ({
  body: {
    error: {
      code: error.code,
      details: cliSafeValue(error.details) as Record<string, JsonValue>,
      message: cliSafeMessage(error),
    },
  },
  exitCode: error.code === 'INTERNAL_ERROR' ? 1 : 2,
})
