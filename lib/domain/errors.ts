export type DomainErrorCode =
  | 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED' | 'INSUFFICIENT_CREDIT'
  | 'NO_PRICE' | 'BAD_LINE' | 'NOT_FOUND' | 'INVALID_INPUT'
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'BUY_CAP_EXCEEDED'

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

const STATUS: Record<DomainErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INSUFFICIENT_STOCK: 409,
  PRICE_CHANGED: 409,
  INSUFFICIENT_CREDIT: 409,
  NO_PRICE: 409,
  BAD_LINE: 409,
  BUY_CAP_EXCEEDED: 409,
}

// Framework-free mapping so domain tests never import next/server.
export function toHttpError(e: unknown):
  | { status: number; body: { error: string; code: DomainErrorCode; meta?: Record<string, unknown> } }
  | null {
  if (!(e instanceof DomainError)) return null
  return {
    status: STATUS[e.code],
    body: { error: e.message, code: e.code, ...(e.meta ? { meta: e.meta } : {}) },
  }
}
