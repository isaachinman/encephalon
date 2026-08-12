export type SQLiteErrorCategory =
  | 'busy'
  | 'cantopen'
  | 'corrupt'
  | 'io'
  | 'locked'
  | 'notadb'
  | 'readonly'
  | 'schema'
  | 'unknown'

const MAX_MESSAGE_FALLBACK_LENGTH = 512
const SQLITE_PRIMARY_RESULT_MASK = 0xff
const SQLITE_RESULT_ERROR = 1
const SQLITE_RESULT_PERM = 3
const SQLITE_RESULT_BUSY = 5
const SQLITE_RESULT_LOCKED = 6
const SQLITE_RESULT_NOMEM = 7
const SQLITE_RESULT_READONLY = 8
const SQLITE_RESULT_IOERR = 10
const SQLITE_RESULT_CORRUPT = 11
const SQLITE_RESULT_FULL = 13
const SQLITE_RESULT_CANTOPEN = 14
const SQLITE_RESULT_SCHEMA = 17
const SQLITE_RESULT_NOTADB = 26

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && !Array.isArray(value) && typeof value === 'object'

const categoryForPrimaryCode = (code: number): SQLiteErrorCategory => {
  switch (code) {
    case SQLITE_RESULT_PERM:
    case SQLITE_RESULT_NOMEM:
    case SQLITE_RESULT_IOERR:
    case SQLITE_RESULT_FULL:
      return 'io'
    case SQLITE_RESULT_BUSY:
      return 'busy'
    case SQLITE_RESULT_LOCKED:
      return 'locked'
    case SQLITE_RESULT_READONLY:
      return 'readonly'
    case SQLITE_RESULT_CORRUPT:
      return 'corrupt'
    case SQLITE_RESULT_CANTOPEN:
      return 'cantopen'
    case SQLITE_RESULT_SCHEMA:
      return 'schema'
    case SQLITE_RESULT_NOTADB:
      return 'notadb'
    default:
      return 'unknown'
  }
}

const categoryForSymbolicCode = (code: string): SQLiteErrorCategory => {
  const match = /^SQLITE_([A-Z]+)(?:_[A-Z0-9]+)*$/.exec(code)
  if (match !== null) {
    switch (match[1]) {
      case 'BUSY':
        return 'busy'
      case 'CANTOPEN':
        return 'cantopen'
      case 'CORRUPT':
        return 'corrupt'
      case 'FULL':
      case 'IOERR':
      case 'NOMEM':
      case 'PERM':
        return 'io'
      case 'LOCKED':
        return 'locked'
      case 'NOTADB':
        return 'notadb'
      case 'READONLY':
        return 'readonly'
      case 'SCHEMA':
        return 'schema'
      default:
        return 'unknown'
    }
  }
  return 'unknown'
}

const categoryForSchemaMessage = (message: string): SQLiteErrorCategory => {
  if (/^(?:no such (?:column|table):|table .+ has no column named )/i.test(message)) {
    return 'schema'
  }
  return 'unknown'
}

const categoryForRuntimeMessage = (message: unknown): SQLiteErrorCategory => {
  if (typeof message === 'string') {
    const bounded = message.slice(0, MAX_MESSAGE_FALLBACK_LENGTH).trim()
    if (/^database is locked(?:$|:)/i.test(bounded)) {
      return 'busy'
    }
    if (/^database table is locked(?:$|:)/i.test(bounded)) {
      return 'locked'
    }
    if (/^(?:database disk image is malformed|malformed database schema)/i.test(bounded)) {
      return 'corrupt'
    }
    if (/^file is not a database/i.test(bounded)) {
      return 'notadb'
    }
    if (/^attempt to write a readonly database/i.test(bounded)) {
      return 'readonly'
    }
    if (/^unable to open database file/i.test(bounded)) {
      return 'cantopen'
    }
    if (/^(?:access permission denied|database or disk is full|disk I\/O error|out of memory)/i.test(bounded)) {
      return 'io'
    }
    return categoryForSchemaMessage(bounded)
  }
  return 'unknown'
}

export const classifySQLiteError = (error: unknown): SQLiteErrorCategory => {
  if (isRecord(error)) {
    const { code, errcode, message } = error
    if (typeof errcode === 'number' && Number.isSafeInteger(errcode) && errcode >= 0) {
      const primaryCode = errcode & SQLITE_PRIMARY_RESULT_MASK
      const category = categoryForPrimaryCode(primaryCode)
      if (category !== 'unknown') {
        return category
      }
      if (primaryCode === SQLITE_RESULT_ERROR && typeof message === 'string') {
        return categoryForSchemaMessage(message.slice(0, MAX_MESSAGE_FALLBACK_LENGTH).trim())
      }
      return 'unknown'
    }
    if (typeof code === 'string') {
      const category = categoryForSymbolicCode(code)
      if (category !== 'unknown') {
        return category
      }
      if (code === 'ERR_SQLITE_ERROR') {
        return categoryForRuntimeMessage(message)
      }
      if (code === 'SQLITE_ERROR' && typeof message === 'string') {
        return categoryForSchemaMessage(message.slice(0, MAX_MESSAGE_FALLBACK_LENGTH).trim())
      }
    }
  }
  return 'unknown'
}
