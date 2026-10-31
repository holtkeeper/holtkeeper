import { createHash, timingSafeEqual } from 'node:crypto'

import type {
  DeleteEgressCacheResult,
  EgressCacheRule,
  EgressCacheView,
  EgressRule,
  EgressRulesResponse,
} from '@holtkeeper/api'
import { resolveSecret } from '@holtkeeper/forge'
import { gitlabPackageFiles, gitlabPackageRegistry } from '@holtkeeper/forge-gitlab'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, authorize, readBody } from '../context.ts'
import { EGRESS_SECRET_KIND, egressSecretRules } from '../egress-secrets.ts'

const digest = (value: string) => createHash('sha256').update(value).digest()

const sameSecret = (given: string, expected: string) =>
  timingSafeEqual(digest(given), digest(expected))

/**
 * Egress proxy rules from the panel GitLab forges (all but those with `packages: false`): GET and
 * HEAD requests to their package registries get `Authorization: Bearer <token>` with the forge
 * credential's current token; forges with `cachePackages` add a private cache rule for their
 * package files. Then every `egress-secret` credential's replacement rules. Forges and secrets
 * that cannot be read are left out.
 */
async function egressRules(
  deps: Pick<ServerDeps, 'store' | 'credentials'>,
  log: (line: string) => void = () => {},
): Promise<EgressRulesResponse> {
  const forges = (await deps.store.config?.list('forge')) ?? []
  const rules: EgressRule[] = []
  const cache: EgressCacheRule[] = []
  for (const forge of forges) {
    if (forge.data.packages === false || forge.data.kind !== 'gitlab') continue
    try {
      const token = await deps.credentials.reveal(forge.data.credentialId)
      rules.push({
        ...gitlabPackageRegistry(forge.data.url),
        methods: ['GET', 'HEAD'],
        headers: { Authorization: `Bearer ${token}` },
      })
      if (forge.data.cachePackages === true)
        cache.push({ kind: 'packages', ...gitlabPackageFiles(forge.data.url), private: true })
    } catch (error) {
      log(`egress: forge ${forge.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const credential of await deps.credentials.list()) {
    if (credential.kind !== EGRESS_SECRET_KIND) continue
    try {
      rules.push(...egressSecretRules(credential, await deps.credentials.reveal(credential.id)))
    } catch (error) {
      log(
        `egress: secret ${credential.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { rules, ...(cache.length ? { cache } : {}) }
}

/** The reserved host on which the egress proxy answers about its cache instead of forwarding. */
const CACHE_ADMIN = 'http://egress-cache.invalid'

const deleteSchema = z
  .object({
    paths: z.array(z.string().min(1).max(2000)).max(10_000).optional(),
    kind: z.enum(['packages', 'tools']).optional(),
  })
  .optional()

const kindSchema = z.enum(['packages', 'tools'])
const stamp = z.string().min(1)

const cacheViewSchema = z.object({
  backend: z.object({ kind: z.enum(['dir', 's3']), location: z.string() }),
  ttlSeconds: z.object({ packages: z.number(), tools: z.number() }),
  maxBytes: z.number().nullable(),
  maxEntryBytes: z.number(),
  since: stamp,
  syncedAt: stamp.nullable(),
  stats: z.object({
    hits: z.number(),
    misses: z.number(),
    stored: z.number(),
    servedBytes: z.number(),
    errors: z.number(),
  }),
  rules: z.array(
    z.object({
      kind: kindSchema,
      host: z.string(),
      paths: z.array(z.string()),
      private: z.boolean(),
    }),
  ),
  total: z.object({ count: z.number(), bytes: z.number() }),
  entries: z.array(
    z.object({
      path: z.string(),
      url: z.string(),
      kind: kindSchema,
      size: z.number(),
      hits: z.number(),
      storedAt: stamp,
      lastUsedAt: stamp,
      expiresAt: stamp,
      expired: z.boolean(),
    }),
  ),
})

const deleteResultSchema = z.object({ removed: z.number(), bytes: z.number() })

const proxyErrorSchema = z.object({ error: z.string() })

/** A request to the proxy's cache admin host, sent through the proxy itself. */
async function cacheRequest<T>(
  egress: { secret: Parameters<typeof resolveSecret>[0]; proxy: string },
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${CACHE_ADMIN}${path}`, {
    method: init.method ?? 'GET',
    proxy: egress.proxy,
    headers: {
      authorization: `Bearer ${resolveSecret(egress.secret)}`,
      'content-type': 'application/json',
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = proxyErrorSchema.safeParse(body).data?.error
    throw new Error(
      response.status === 401
        ? 'the proxy refused the egress secret'
        : `the proxy answered ${response.status}${message ? `: ${message}` : ''}`,
    )
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new Error('the proxy answered something that is not a cache report')
  return parsed.data
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * `GET /egress/rules` for the egress proxy, which authenticates with `server.egress.secret` as a
 * bearer token. Not found when the config has no `server.egress`; no browser session grants it.
 */
export function egressRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  app.get('/egress/rules', async (c) => {
    const secret = deps.config.server?.egress?.secret
    if (!secret) throw new HTTPException(404, { message: 'not found' })
    const given = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() ?? '')?.[1] ?? ''
    if (!sameSecret(given, resolveSecret(secret)))
      throw new HTTPException(401, { message: 'unauthorized' })
    c.header('cache-control', 'no-store')
    return c.json<EgressRulesResponse>(await egressRules(deps, console.error))
  })

  app.get('/egress/cache', async (c) => {
    authorize(c, 'settings:read', { kind: 'global' })
    const egress = deps.config.server?.egress
    if (!egress?.proxy) return c.json<EgressCacheView>({ configured: false })
    try {
      const view = await cacheRequest(
        { ...egress, proxy: egress.proxy },
        '/v1/cache',
        cacheViewSchema,
      )
      return c.json<EgressCacheView>({ configured: true, ...view })
    } catch (error) {
      return c.json<EgressCacheView>({ configured: true, error: reason(error) })
    }
  })

  app.post('/egress/cache/delete', async (c) => {
    const principal = authorize(c, 'settings:write', { kind: 'global' })
    const egress = deps.config.server?.egress
    if (!egress?.proxy) throw new HTTPException(404, { message: 'no egress proxy configured' })
    const input = (await readBody(c, deleteSchema)) ?? {}
    let result: DeleteEgressCacheResult
    try {
      result = await cacheRequest(
        { ...egress, proxy: egress.proxy },
        '/v1/cache/delete',
        deleteResultSchema,
        { method: 'POST', body: input },
      )
    } catch (error) {
      throw new HTTPException(502, { message: reason(error) })
    }
    await deps.store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'egress-cache.cleared',
      subject: input.kind ?? (input.paths ? 'entries' : 'all'),
      details: { ...(input.paths ? { entries: input.paths.length } : {}), ...result },
    })
    return c.json<DeleteEgressCacheResult>(result)
  })
  return app
}
