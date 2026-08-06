import type { EncephalonErrorCode, JsonValue } from './types.ts'

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

export const wrapIo = (message: string, cause: unknown): never => failWithCause('IO_ERROR', message, {}, cause)
