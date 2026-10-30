import type { Action, Grant, Principal } from '@holtkeeper/access'
import { grantSchema } from '@holtkeeper/access'
import type { McpTokenView } from '@holtkeeper/api'
import type { KvStore, UserStore } from '@holtkeeper/store'
import { z } from 'zod'

/** What a token may do, whatever its owner may: read the API catalog, nothing else. */
const tokenActions: readonly Action[] = ['analyses:read', 'repos:read']

const prefix = 'hk_mcp_'
const tokenKey = (hash: string) => `mcp:token:${hash}`
const ownerKey = (principalId: string) => `mcp:tokens:${principalId}`
const touchEveryMs = 3_600_000

const ownedTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
  hash: z.string(),
})

const storedTokenSchema = ownedTokenSchema.extend({
  principal: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().optional(),
    provider: z.string(),
    grants: z.array(grantSchema),
  }),
  /** `User.sessionVersion` at issue time; bumping it revokes the token. */
  sessionVersion: z.number().optional(),
})

type StoredToken = z.infer<typeof storedTokenSchema>

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const hashSecret = async (secret: string) =>
  toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))

const randomSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `${prefix}${Buffer.from(bytes).toString('base64url')}`
}

/** `grants` cut down to `tokenActions`; grants left without actions are dropped. */
function readOnlyGrants(grants: readonly Grant[]): Grant[] {
  return grants.flatMap((grant) => {
    const actions = grant.actions.includes('*')
      ? [...tokenActions]
      : tokenActions.filter((action) => grant.actions.includes(action))
    return actions.length ? [{ scope: grant.scope, actions }] : []
  })
}

const view = ({ id, name, prefix: shown, createdAt, expiresAt, lastUsedAt }: McpTokenView) => ({
  id,
  name,
  prefix: shown,
  createdAt,
  ...(expiresAt ? { expiresAt } : {}),
  ...(lastUsedAt ? { lastUsedAt } : {}),
})

/** Options of `mcpTokens`. */
export interface McpTokensOptions {
  kv: KvStore
  /** Users of the `users` auth provider; their tokens follow the current grants and status. */
  users?: Pick<UserStore, 'getUser'>
  now: () => Date
}

/**
 * Personal access tokens for the MCP endpoint and the API catalog routes. Only a SHA-256 of each
 * secret is stored. A token acts as its owner with read-only grants: for `users` accounts the
 * owner's current grants, and disabling the user or signing them out everywhere revokes it; for
 * other providers the grants at issue time.
 */
export function mcpTokens({ kv, users, now }: McpTokensOptions) {
  const listOf = async (principalId: string) => {
    const parsed = z.array(ownedTokenSchema).safeParse(await kv.get(ownerKey(principalId)))
    return parsed.success ? parsed.data : []
  }

  const live = async (principalId: string) => {
    const tokens = await listOf(principalId)
    const at = now().toISOString()
    const alive = tokens.filter((token) => !token.expiresAt || token.expiresAt > at)
    if (alive.length !== tokens.length) await kv.set(ownerKey(principalId), alive)
    return alive
  }

  return {
    /** The caller's tokens that have not expired, newest first. */
    list: async (principal: Principal): Promise<McpTokenView[]> =>
      (await live(principal.id))
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(view),

    /** Issues a token; `expiresInDays` 0 never expires. Returns the secret once. */
    async create(principal: Principal, input: { name: string; expiresInDays: number }) {
      const secret = randomSecret()
      const hash = await hashSecret(secret)
      const createdAt = now()
      const expiresAt = input.expiresInDays
        ? new Date(createdAt.getTime() + input.expiresInDays * 86_400_000).toISOString()
        : undefined
      const user = principal.provider === 'users' ? await users?.getUser(principal.id) : undefined
      const token: StoredToken = {
        id: hash.slice(0, 16),
        name: input.name,
        prefix: secret.slice(0, prefix.length + 4),
        createdAt: createdAt.toISOString(),
        ...(expiresAt ? { expiresAt } : {}),
        hash,
        principal: { ...principal, grants: readOnlyGrants(principal.grants) },
        ...(user ? { sessionVersion: user.sessionVersion } : {}),
      }
      await kv.set(
        tokenKey(hash),
        token,
        input.expiresInDays ? input.expiresInDays * 86_400 : undefined,
      )
      await kv.set(ownerKey(principal.id), [
        ...(await live(principal.id)),
        { ...view(token), hash },
      ])
      return { token: view(token), secret }
    },

    /** Revokes one of the caller's tokens; `false` when it has none with that id. */
    async revoke(principal: Principal, id: string) {
      const tokens = await live(principal.id)
      const token = tokens.find((item) => item.id === id)
      if (!token) return false
      await kv.delete(tokenKey(token.hash))
      await kv.set(
        ownerKey(principal.id),
        tokens.filter((item) => item.id !== id),
      )
      return true
    },

    /**
     * The read-only principal behind `Authorization: Bearer hk_mcp_…`, or `undefined` when the
     * request carries no valid token.
     */
    async authenticate(request: Request): Promise<Principal | undefined> {
      const header = request.headers.get('authorization') ?? ''
      const secret = /^Bearer\s+(hk_mcp_[\w-]+)$/i.exec(header.trim())?.[1]
      if (!secret) return undefined
      const hash = await hashSecret(secret)
      const parsed = storedTokenSchema.safeParse(await kv.get(tokenKey(hash)))
      if (!parsed.success) return undefined
      const stored = parsed.data
      const at = now()
      if (stored.expiresAt && stored.expiresAt <= at.toISOString()) return undefined
      if (!(await live(stored.principal.id)).some((token) => token.id === stored.id))
        return undefined
      let principal = stored.principal
      if (principal.provider === 'users' && users) {
        const user = await users.getUser(principal.id)
        if (!user || user.disabled) return undefined
        if (stored.sessionVersion !== undefined && user.sessionVersion !== stored.sessionVersion)
          return undefined
        principal = { ...principal, name: user.name, grants: readOnlyGrants(user.grants) }
      }
      if (!stored.lastUsedAt || at.getTime() - Date.parse(stored.lastUsedAt) >= touchEveryMs) {
        const lastUsedAt = at.toISOString()
        const ttl = stored.expiresAt
          ? Math.max(1, Math.ceil((Date.parse(stored.expiresAt) - at.getTime()) / 1000))
          : undefined
        await kv.set(tokenKey(hash), { ...stored, lastUsedAt }, ttl)
        const tokens = await listOf(stored.principal.id)
        await kv.set(
          ownerKey(stored.principal.id),
          tokens.map((token) => (token.id === stored.id ? { ...token, lastUsedAt } : token)),
        )
      }
      return principal
    },
  }
}

export type McpTokens = ReturnType<typeof mcpTokens>
