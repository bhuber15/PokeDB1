export type DomainErrorCode =
  | 'INSUFFICIENT_STOCK' | 'PRICE_CHANGED' | 'INSUFFICIENT_CREDIT'
  | 'NO_PRICE' | 'BAD_LINE' | 'NOT_FOUND' | 'INVALID_INPUT'
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'BUY_CAP_EXCEEDED'
  | 'MARGIN_NO_COST' | 'PLAN_LIMIT' | 'CASH_UP_EXISTS'
  | 'SALE_VOIDED' | 'VOID_NOT_ALLOWED'

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
  MARGIN_NO_COST: 422,
  PLAN_LIMIT: 403,
  CASH_UP_EXISTS: 409,
  SALE_VOIDED: 409,
  VOID_NOT_ALLOWED: 409,
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

// True when `e` is a SQLite UNIQUE-constraint violation on the given
// "table.column" constraint. Drizzle wraps driver errors (DrizzleQueryError
// puts the failed SQL in .message and the SQLITE_CONSTRAINT text on the
// cause), so the whole cause chain is checked, not just the top message.
export function isUniqueViolation(e: unknown, constraint: string): boolean {
  const needle = `UNIQUE constraint failed: ${constraint}`
  let current: unknown = e
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.message.includes(needle)) return true
    current = current.cause
  }
  return false
}
