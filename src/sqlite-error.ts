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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && !Array.isArray(value) && typeof value === 'object'

const categoryForPrimaryCode = (code: number): SQLiteErrorCategory => {
  switch (code) {
    case 3:
    case 7:
    case 10:
    case 13:
      return 'io'
    case 5:
      return 'busy'
    case 6:
      return 'locked'
    case 8:
      return 'readonly'
    case 11:
      return 'corrupt'
    case 14:
      return 'cantopen'
    case 26:
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
      const primaryCode = errcode & 0xff
      const category = categoryForPrimaryCode(primaryCode)
      if (category !== 'unknown') {
        return category
      }
      if (primaryCode === 1 && typeof message === 'string') {
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
