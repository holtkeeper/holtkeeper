import { clearCookie, createSessionCodec, readCookie, sessionCookie } from '@holtkeeper/auth'
import type { z } from 'zod'

/** A signed, expiring cookie whose payload is checked against a schema when read. */
export interface SignedCookie<T> {
  /** A `Set-Cookie` value carrying `payload`. */
  issue(payload: T): Promise<string>
  read(request: Request): Promise<T | undefined>
  /** A `Set-Cookie` value that removes the cookie. */
  clear(): string
}

export interface SignedCookieOptions<T> {
  name: string
  secret: string
  /** Separates keys, so a cookie issued for one purpose never verifies as another. */
  purpose: string
  ttlSeconds: number
  secure: boolean
  schema: z.ZodType<T>
  now: () => Date
}

export function signedCookie<T>(options: SignedCookieOptions<T>): SignedCookie<T> {
  const codec = createSessionCodec<unknown>(`${options.secret}\u0000${options.purpose}`, () =>
    options.now().getTime(),
  )
  return {
    async issue(payload) {
      const token = await codec.issue(payload, options.ttlSeconds)
      return sessionCookie(options.name, token, {
        maxAgeSeconds: options.ttlSeconds,
        secure: options.secure,
      })
    },
    async read(request) {
      const token = readCookie(request, options.name)
      if (!token) return undefined
      const parsed = options.schema.safeParse(await codec.verify(token))
      return parsed.success ? parsed.data : undefined
    },
    clear: () => clearCookie(options.name),
  }
}
