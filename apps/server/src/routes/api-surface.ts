import { type Principal, can } from '@holtkeeper/access'
import type {
  CreateMcpTokenInput,
  CreateMcpTokenResult,
  McpTokenList,
  McpUsageOverview,
  PublicApiDiff,
  PublicApiPackageDetail,
  PublicApiPackageList,
  PublicApiSearchResult,
} from '@holtkeeper/api'
import { apiSymbolKinds, isApiSymbolKind, renderPackage } from '@holtkeeper/api-surface'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { createApiCatalog } from '../api-surface/catalog.ts'
import { handleMcpRequest } from '../api-surface/mcp.ts'
import { type McpTokens, mcpTokens } from '../api-surface/tokens.ts'
import { mcpUsage } from '../api-surface/usage.ts'
import { createUsageIndex } from '../api-surface/usages.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  principalOf,
  publicUrlOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { canSee } from '../visibility.ts'
import { usageRoutes } from './usages.ts'

const GLOBAL = { kind: 'global' } as const

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(0).max(3650).default(90),
})

const bearerToken = (request: Request) =>
  /^Bearer\s+hk_mcp_/i.test(request.headers.get('authorization') ?? '')

const clientOf = (request: Request) =>
  request.headers.get('user-agent')?.split(/\s+/)[0]?.slice(0, 60) || undefined

const requireName = (c: AppContext) => {
  const name = c.req.query('name')
  if (!name) throw new HTTPException(400, { message: 'name is required' })
  return name
}

const resolveQuery = (c: AppContext) => {
  const version = c.req.query('version')
  const repo = c.req.query('repo')
  return { ...(version ? { version } : {}), ...(repo ? { repo } : {}) }
}

/**
 * The API catalog built from `api-surface` records and the usage index built from `usages`
 * records: routes under `/api/api-surface` for the web UI, the MCP endpoint for agents, personal
 * access tokens for both and MCP call statistics.
 */
export function createApiSurface(deps: ServerDeps) {
  const { store, config } = deps
  const catalog = createApiCatalog({ analyses: store.analyses })
  const usages = createUsageIndex({ analyses: store.analyses })
  const usage = mcpUsage({ ...(store.kv ? { kv: store.kv } : {}), now: deps.now })
  const tokens: McpTokens | undefined = store.kv
    ? mcpTokens({ kv: store.kv, users: store.users, now: deps.now })
    : undefined
  const readable = (principal: Principal) => (repo: { forge: string; path: string }) =>
    canSee(principal, 'analyses:read', repoTarget(config, repo))
  const tokensOf = () => {
    if (!tokens) throw new HTTPException(503, { message: 'the store keeps no key-value state' })
    return tokens
  }
  const endpointOf = (c: AppContext) => `${publicUrlOf(deps, c)}/mcp`

  const routes = new Hono<Env>()
  routes.route('/', usageRoutes({ catalog, usages, readable }))

  routes.get('/api-surface/packages', async (c) => {
    const principal = principalOf(c)
    const packages = await catalog.packages(readable(principal), c.req.query('q') || undefined)
    const indexedAt = catalog.indexedAt()
    return c.json<PublicApiPackageList>({ packages, ...(indexedAt ? { indexedAt } : {}) })
  })

  routes.get('/api-surface/package', async (c) => {
    const principal = principalOf(c)
    const name = requireName(c)
    const found = await catalog.resolve(readable(principal), name, resolveQuery(c))
    if (!found) throw new HTTPException(404, { message: `no recorded version of ${name}` })
    return c.json<PublicApiPackageDetail>({
      repo: found.record.repo,
      ...(found.record.ref ? { ref: found.record.ref } : {}),
      analysisId: found.record.id,
      analyzedAt: found.record.createdAt,
      package: found.package,
      versions: found.versions,
      alsoIn: found.alsoIn,
    })
  })

  routes.get('/api-surface/package.md', async (c) => {
    const principal = principalOf(c)
    const name = requireName(c)
    const found = await catalog.resolve(readable(principal), name, resolveQuery(c))
    if (!found) throw new HTTPException(404, { message: `no recorded version of ${name}` })
    const subpath = c.req.query('subpath')
    const markdown = renderPackage(found.package, {
      repo: `${found.record.repo.forge}:${found.record.repo.path}`,
      ...(found.record.ref ? { ref: found.record.ref } : {}),
      analyzedAt: found.record.createdAt,
      ...(subpath ? { subpath } : {}),
      ...(c.req.query('docs') === 'false' ? { docs: false } : {}),
    })
    return c.body(markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' })
  })

  routes.get('/api-surface/diff', async (c) => {
    const principal = principalOf(c)
    const name = requireName(c)
    const from = c.req.query('from')
    const to = c.req.query('to')
    const repo = c.req.query('repo')
    const result = await catalog.diff(readable(principal), name, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(repo ? { repo } : {}),
    })
    if (!result) throw new HTTPException(404, { message: `no two versions of ${name} to compare` })
    return c.json<PublicApiDiff>(result)
  })

  routes.get('/api-surface/search', async (c) => {
    const principal = principalOf(c)
    const kind = c.req.query('kind')
    if (kind && !isApiSymbolKind(kind))
      throw new HTTPException(400, { message: `kind must be one of ${apiSymbolKinds.join(', ')}` })
    const name = c.req.query('package')
    const result = await catalog.search(readable(principal), c.req.query('q') ?? '', {
      ...(name ? { package: name } : {}),
      ...(kind && isApiSymbolKind(kind) ? { kind } : {}),
      limit: Math.min(Math.max(Number(c.req.query('limit')) || 30, 1), 100),
    })
    return c.json<PublicApiSearchResult>(result)
  })

  routes.post('/api-surface/rescan', async (c) => {
    authorize(c, 'analyses:run', GLOBAL)
    await Promise.all([catalog.rescan(), usages.rescan()])
    return c.json({ indexedAt: catalog.indexedAt() })
  })

  routes.get('/api-surface/mcp/tokens', async (c) => {
    const principal = principalOf(c)
    if (!tokens) return c.json<McpTokenList>({ tokens: [], available: false })
    return c.json<McpTokenList>({ tokens: await tokens.list(principal), available: true })
  })

  routes.post('/api-surface/mcp/tokens', async (c) => {
    const principal = principalOf(c)
    if (bearerToken(c.req.raw))
      throw new HTTPException(403, { message: 'tokens cannot issue tokens; sign in instead' })
    const input: CreateMcpTokenInput = await readBody(c, createTokenSchema)
    const result = await tokensOf().create(principal, {
      name: input.name,
      expiresInDays: input.expiresInDays ?? 90,
    })
    await store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'mcp.token.created',
      subject: result.token.id,
      details: {
        name: result.token.name,
        ...(result.token.expiresAt ? { expiresAt: result.token.expiresAt } : {}),
      },
    })
    return c.json<CreateMcpTokenResult>(result, 201)
  })

  routes.delete('/api-surface/mcp/tokens/:id', async (c) => {
    const principal = principalOf(c)
    if (bearerToken(c.req.raw))
      throw new HTTPException(403, { message: 'tokens cannot revoke tokens; sign in instead' })
    if (!(await tokensOf().revoke(principal, c.req.param('id'))))
      throw new HTTPException(404, { message: 'no such token' })
    await store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'mcp.token.revoked',
      subject: c.req.param('id'),
    })
    return c.body(null, 204)
  })

  routes.get('/api-surface/mcp/usage', async (c) => {
    const principal = principalOf(c)
    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 90)
    return c.json<McpUsageOverview>(
      await usage.overview({
        days,
        self: principal.id,
        everyone: can(principal, 'users:read', GLOBAL),
        endpoint: endpointOf(c),
      }),
    )
  })

  /** Serves `/mcp`; mount at the application root. */
  const mcp = async (c: AppContext) => {
    if (c.req.method !== 'POST')
      return c.json({ error: 'the MCP endpoint is stateless; POST JSON-RPC requests' }, 405, {
        allow: 'POST',
      })
    const principal = c.get('principal')
    if (!principal)
      return c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32001,
            message: 'send Authorization: Bearer <MCP token from the API page>',
          },
        },
        401,
        { 'www-authenticate': 'Bearer realm="holtkeeper"' },
      )
    const client = clientOf(c.req.raw)
    return handleMcpRequest(c.req.raw, {
      catalog,
      usages,
      usage,
      principal,
      canRead: readable(principal),
      ...(client ? { client } : {}),
      now: deps.now,
    })
  }

  /**
   * The read-only principal of an MCP token, for requests to `/mcp` and reads of
   * `/api/api-surface/*` that carry one and are otherwise anonymous.
   */
  const tokenPrincipal = async (request: Request, path: string) => {
    if (!tokens || !bearerToken(request)) return undefined
    const allowed =
      path === '/mcp' || (request.method === 'GET' && path.startsWith('/api/api-surface/'))
    return allowed ? tokens.authenticate(request) : undefined
  }

  return { routes, mcp, tokenPrincipal, flush: usage.flush }
}
