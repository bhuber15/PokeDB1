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
