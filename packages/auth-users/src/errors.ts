import { json } from '@holtkeeper/auth'
import type { z } from 'zod'

/** An error that maps to an HTTP status and an `{ error }` body, plus `details` when given. */
export class HttpError extends Error {
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.details = details
  }
}

export const errorResponse = (error: HttpError) =>
  json({ error: error.message, ...error.details }, { status: error.status })

/** Parses a JSON body with `schema`; throws a 400 `HttpError` on malformed or invalid input. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new HttpError(400, 'request body must be JSON')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    throw new HttpError(400, `invalid input: ${where}${issue?.message ?? 'malformed'}`)
  }
  return parsed.data
}
