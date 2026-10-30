import { rootPrincipal } from '@holtkeeper/access'
import {
  type AuthProvider,
  clearCookie,
  createSessionCodec,
  json,
  readCookie,
  safeEqual,
  sessionCookie,
} from '@holtkeeper/auth'
import { type Secret, resolveSecret } from '@holtkeeper/forge'

export interface PasswordAuthOptions {
  /** The root password. */
  password: Secret
  /** Signs session cookies; at least 32 characters. */
  sessionSecret: Secret
  /** Display name of the single user. Default `root`. */
  name?: string
  /** Default 12. */
  sessionTtlHours?: number
  /** Default true; disable only for plain-HTTP local development. */
  secureCookies?: boolean
  /** Failed attempts allowed per minute before logins are refused for a minute. Default 5. */
  maxFailuresPerMinute?: number
  now?: () => number
}

const COOKIE = 'hk_session'

interface Session {
  /** Fingerprint of the password the session was issued for, so changing it signs everyone out. */
  k: string
}

/**
 * One root user behind a password. Sessions are signed cookies; changing the password invalidates
 * them. Failed attempts are throttled per process.
 */
export function passwordAuth(options: PasswordAuthOptions): AuthProvider {
  const {
    name = 'root',
    sessionTtlHours = 12,
    secureCookies = true,
    maxFailuresPerMinute = 5,
    now = Date.now,
  } = options
  const principal = rootPrincipal('password', name)
  let codec: ReturnType<typeof createSessionCodec<Session>> | undefined
  const sessions = () =>
    (codec ??= createSessionCodec<Session>(resolveSecret(options.sessionSecret), now))
  const fingerprint = () =>
    new Bun.CryptoHasher('sha256')
      .update(resolveSecret(options.password))
      .digest('hex')
      .slice(0, 16)
  let failures: number[] = []

  return {
    name: 'password',
    async authenticate(request) {
      const token = readCookie(request, COOKIE)
      const session = token ? await sessions().verify(token) : undefined
      return session?.k === fingerprint() ? principal : undefined
    },
    async handle(request, path) {
      if (request.method !== 'POST') return undefined
      if (path === '/logout') {
        return new Response(null, { status: 204, headers: { 'set-cookie': clearCookie(COOKIE) } })
      }
      if (path !== '/login') return undefined

      failures = failures.filter((at) => now() - at < 60_000)
      if (failures.length >= maxFailuresPerMinute) {
        return json({ error: 'too many attempts, try again in a minute' }, { status: 429 })
      }
      const body: unknown = await request.json().catch(() => undefined)
      const password =
        typeof body === 'object' && body !== null && 'password' in body ? body.password : undefined
      if (typeof password !== 'string' || !safeEqual(password, resolveSecret(options.password))) {
        failures.push(now())
        return json({ error: 'wrong password' }, { status: 401 })
      }
      const token = await sessions().issue({ k: fingerprint() }, sessionTtlHours * 3600)
      return new Response(null, {
        status: 204,
        headers: {
          'set-cookie': sessionCookie(COOKIE, token, {
            maxAgeSeconds: sessionTtlHours * 3600,
            secure: secureCookies,
          }),
        },
      })
    },
    info: () => ({
      provider: 'password',
      methods: [{ kind: 'password' }],
      logoutUrl: '/auth/password/logout',
    }),
  }
}
