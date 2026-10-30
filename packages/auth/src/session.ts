const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const fromBase64Url = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'))

export interface SessionCodec<Payload> {
  /** A signed token carrying `payload` that expires after `ttlSeconds`. */
  issue(payload: Payload, ttlSeconds: number): Promise<string>
  /** The payload of a valid, unexpired token signed with the same secret; otherwise `undefined`. */
  verify(token: string): Promise<Payload | undefined>
}

/**
 * Stateless signed tokens (HMAC-SHA256) for session cookies. Payloads are readable by the client,
 * so they must not contain secrets. Revocation is the caller's job, e.g. via a version number in
 * the payload that the store can bump.
 */
export function createSessionCodec<Payload>(
  secret: string,
  now: () => number = Date.now,
): SessionCodec<Payload> {
  if (secret.length < 32) throw new Error('session secret must be at least 32 characters')
  const key = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

  return {
    async issue(payload, ttlSeconds) {
      const body = toBase64Url(
        encoder.encode(JSON.stringify({ p: payload, e: now() + ttlSeconds * 1000 })),
      )
      const signature = await crypto.subtle.sign('HMAC', await key, encoder.encode(body))
      return `${body}.${toBase64Url(new Uint8Array(signature))}`
    },
    async verify(token) {
      const [body, signature] = token.split('.')
      if (!body || !signature) return undefined
      const valid = await crypto.subtle.verify(
        'HMAC',
        await key,
        fromBase64Url(signature),
        encoder.encode(body),
      )
      if (!valid) return undefined
      try {
        const data: unknown = JSON.parse(Buffer.from(body, 'base64url').toString())
        if (typeof data !== 'object' || data === null || !('e' in data) || !('p' in data))
          return undefined
        if (typeof data.e !== 'number' || data.e < now()) return undefined
        // The signature proves this server issued the payload, so it has the issued type.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return data.p as Payload
      } catch {
        return undefined
      }
    },
  }
}

/** Reads one cookie from a request. */
export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

export interface CookieOptions {
  maxAgeSeconds: number
  /** Default true; set false only for plain-HTTP local development. */
  secure?: boolean
}

/** A `Set-Cookie` value for an HTTP-only, same-site session cookie. */
export const sessionCookie = (
  name: string,
  value: string,
  { maxAgeSeconds, secure = true }: CookieOptions,
) =>
  [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
    .concat(secure ? ['Secure'] : [])
    .join('; ')

/** A `Set-Cookie` value that removes the cookie. */
export const clearCookie = (name: string) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

/** A JSON response, the shape every provider endpoint uses. */
export const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init)
