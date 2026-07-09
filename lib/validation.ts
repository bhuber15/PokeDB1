import { z } from 'zod'
import { DomainError } from '@/lib/domain/errors'

// Parses and validates a JSON request body. Malformed JSON or a schema miss
// throws DomainError('INVALID_INPUT'), which guarded() maps to a 400.
// Framework-free (plain Request) so it can be tested without next/server.
export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new DomainError('INVALID_INPUT', 'Invalid JSON body')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue.path.join('.')
    throw new DomainError('INVALID_INPUT', path ? `${path}: ${issue.message}` : issue.message)
  }
  return result.data
}

// Parses a route or query-string id into a positive integer. Throws
// INVALID_INPUT (mapped to 400 by guarded) so a malformed id like "abc", ""
// or "1.5" fails fast instead of binding NaN and masquerading as a 404.
export function parseIdParam(raw: string | null | undefined, field = 'id'): number {
  const n = Number(raw)
  if (!raw || !Number.isInteger(n) || n < 1) {
    throw new DomainError('INVALID_INPUT', `Invalid ${field}`)
  }
  return n
}
