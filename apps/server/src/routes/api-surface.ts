import { type Principal, can, leafGroups, outerGroups } from '@holtkeeper/access'
import type {
  CreateMcpTokenInput,
  CreateMcpTokenResult,
  McpTokenList,
  McpPersonUsage,
  McpUsageOverview,
  PublicApiDiff,
  PublicApiPackageDetail,
  PublicApiMatch,
  PublicApiPackageList,
  PublicApiSearchResult,
  PublicApiSymbol,
} from '@holtkeeper/api'
import { apiSymbolKinds, isApiSymbolKind, renderPackage } from '@holtkeeper/api-surface'
import type { RepoRef } from '@holtkeeper/forge'
import { createGuideResolver, familyOf, proposeRule, scopesFor } from '@holtkeeper/guide'
import { latestVersions, libraryApi } from '@holtkeeper/libraries'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type RepoFilter, cachedCatalog, createApiCatalog } from '../api-surface/catalog.ts'
import { handleMcpRequest } from '../api-surface/mcp.ts'
import { type McpTokens, mcpTokens } from '../api-surface/tokens.ts'
import { type McpPersonCalls, mcpUsage } from '../api-surface/usage.ts'
import { createUsageIndex } from '../api-surface/usages.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  forgeFor,
  groupLabeler,
  principalOf,
  publicUrlOf,
  parseRepo,
  readBody,
  repoTarget,
} from '../context.ts'
import { createFleetCache } from '../fleet-cache.ts'
import { autoAcceptLearning } from '../learnings.ts'
import {
  agentSummarize,
  githubClientFor,
  librariesConfigOf,
  libraryReader,
  ownPackageOf,
  serverLibraryDocs,
  visibleLibraries,
} from '../libraries.ts'
import { principalOpsAccess } from '../ops-tools.ts'
import { releaseToolsAccess } from '../release-steps.ts'
import { releaseServiceFor } from '../releases.ts'
import { analyzerOffFilter } from '../repo-analyzers.ts'
import { taskToolsAccess } from '../tasks.ts'
import { storedAssetTools } from '../tools/assets.ts'
import type { KnowledgeToolsContext } from '../tools/knowledge.ts'
import type { LibraryIndex } from '../tools/libraries.ts'
import { storedStackTools } from '../tools/registry.ts'
import type { SupplyToolsAccess } from '../tools/repos.ts'
import {
  type CommitConventionsAccess,
  type RulesAccess,
  commitConventionsReader,
  testIdsReader,
} from '../tools/rules.ts'
import {
  type CatalogReach,
  canReadShared,
  canSee,
  catalogReach,
  scopeOwner,
} from '../visibility.ts'
import { dependencyRoutes } from './dependencies.ts'
import { homeGroupsOf } from './preferences.ts'
import { usageRoutes } from './usages.ts'

const GLOBAL = { kind: 'global' } as const

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(0).max(3650).default(90),
  scopes: z
    .array(z.enum(['release', 'tasks']))
    .max(2)
    .optional(),
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

const matches: readonly PublicApiMatch[] = ['exact', 'prefix', 'part', 'doc']
const SYMBOL_HISTORY = 20
const SYMBOL_HISTORY_MAX = 100

const kindParam = (c: AppContext) => {
  const kind = c.req.query('kind')
  if (!kind) return undefined
  if (!isApiSymbolKind(kind))
    throw new HTTPException(400, { message: `kind must be one of ${apiSymbolKinds.join(', ')}` })
  return kind
}

const matchParam = (c: AppContext) => {
  const match = c.req.query('match')
  if (!match) return undefined
  const found = matches.find((value) => value === match)
  if (!found)
    throw new HTTPException(400, { message: `match must be one of ${matches.join(', ')}` })
  return found
}

const historyLimit = (value: string | undefined) => {
  if (value === undefined) return SYMBOL_HISTORY
  const limit = Number(value)
  if (!/^\d+$/.test(value) || limit < 1 || limit > SYMBOL_HISTORY_MAX)
    throw new HTTPException(400, {
      message: `limit must be a whole number from 1 to ${SYMBOL_HISTORY_MAX}`,
    })
  return limit
}

const params = <K extends string>(c: AppContext, keys: readonly K[]) => {
  const found: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const value = c.req.query(key)
    if (value) found[key] = value
  }
  return found
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
export function createApiSurface(
  deps: ServerDeps,
  supplyFor: (principal: Principal) => SupplyToolsAccess,
) {
  const { store, config } = deps
  const catalog = createApiCatalog({ analyses: store.analyses })
  const usages = createUsageIndex({ analyses: store.analyses })
  const cache = createFleetCache()
  const usage = mcpUsage({ ...(store.kv ? { kv: store.kv } : {}), now: deps.now })
  const tokens: McpTokens | undefined = store.kv
    ? mcpTokens({ kv: store.kv, users: store.users, now: deps.now })
    : undefined
  const targetOf = (repo: RepoRef) => repoTarget(config, repo)
  const reach = catalogReach(store.settings, targetOf)
  const groupsOf = (repo: RepoRef) => targetOf(repo).groups
  const groupLabel = groupLabeler(config)
  const ownerOf = (repo: RepoRef) => leafGroups(groupsOf(repo)).map(groupLabel)
  const readable = async (principal: Principal) => (await reach(principal)).catalog
  const analysesOf = (principal: Principal) => (repo: RepoRef) =>
    canSee(principal, 'analyses:read', targetOf(repo))
  const tokensOf = () => {
    if (!tokens) throw new HTTPException(503, { message: 'the store keeps no key-value state' })
    return tokens
  }
  const endpointOf = (c: AppContext) => `${publicUrlOf(deps, c)}/mcp`

  const conventions = commitConventionsReader({
    forgeOf: (forge) => forgeFor(config, forge),
    settings: store.settings,
    now: deps.now,
  })
  const commitContext = (principal: Principal): CommitConventionsAccess => ({
    conventions: async (value, commits) => {
      const separator = value.indexOf(':')
      if (separator < 1 || separator === value.length - 1) return undefined
      const repo = { forge: value.slice(0, separator), path: value.slice(separator + 1) }
      if (!config.forges[repo.forge] || !analysesOf(principal)(repo)) return undefined
      return conventions(repoTarget(config, repo), commits)
    },
  })

  const libraryContext = (principal: Principal, canRead: RepoFilter): LibraryIndex | undefined => {
    const artifacts = deps.artifacts
    if (!store.libraries || !artifacts) return undefined
    const libraries = visibleLibraries(
      store.libraries,
      libraryReader({ canRead, global: can(principal, 'analyses:read', GLOBAL) }),
    )
    const docs = serverLibraryDocs({
      libraries,
      artifacts,
      ...(store.kv ? { kv: store.kv } : {}),
      github: async () =>
        githubClientFor(
          deps.credentials,
          (await librariesConfigOf(store.settings))?.github,
          store.kv ? { kv: store.kv } : {},
        ),
      summarize: async (repo) => {
        const target = repo ? parseRepo(repo) : undefined
        if (!target || !deps.agentFor || !analysesOf(principal)(target)) return undefined
        if (!(await librariesConfigOf(store.settings))?.digests) return undefined
        const agent = await deps.agentFor(target)
        return agent ? agentSummarize(agent) : undefined
      },
      ownPackage: ownPackageOf(catalog, canRead),
    })
    return { docs, api: libraryApi({ store: libraries, artifacts }), store: libraries }
  }

  const knowledgeContext = (
    principal: Principal,
    reached: CatalogReach,
  ): KnowledgeToolsContext => ({
    store,
    canReadScope: (scope) => can(principal, 'knowledge:read', { kind: 'scope', scope }),
    canReadShared: (scope) => canReadShared(principal, scope, reached.policy),
    ownerOf: (scope) =>
      outerGroups(scopeOwner(scope, (other) => leafGroups(groupsOf(other)))).map(groupLabel),
    groupLabel,
    repoOf: (value) => {
      const separator = value.indexOf(':')
      if (separator < 1 || separator === value.length - 1) return undefined
      const target = repoTarget(config, {
        forge: value.slice(0, separator),
        path: value.slice(separator + 1),
      })
      return canSee(principal, 'knowledge:read', target) ? target : undefined
    },
    actor: principal.id,
    now: deps.now,
  })

  const resolveGuide = createGuideResolver({ store, groupTitle: groupLabel })
  const testIdsOf = testIdsReader({ store })
  const rulesContext = (
    principal: Principal,
    knowledge: KnowledgeToolsContext,
  ): Omit<RulesAccess, 'commits'> => ({
    guide: {
      resolve: async (value, request) => {
        const target = knowledge.repoOf(value)
        return target ? resolveGuide({ repo: target, ...request }) : undefined
      },
    },
    proposals: {
      propose: async (value, input) => {
        const target = knowledge.repoOf(value)
        if (!target) return undefined
        const repo = `${target.forge}:${target.path}`
        const at = deps.now().toISOString()
        const family = input.targetScope ? familyOf(await store.families.list(), repo) : undefined
        const outcome = await proposeRule(store, {
          repo,
          rule: input.rule,
          section: input.section,
          ...(input.scope && { suggestedScope: input.scope }),
          ...(input.targetScope && {
            targetScope: input.targetScope,
            scopes: scopesFor(target, family?.id),
          }),
          reason: input.reason,
          by: principal.id,
          at,
        })
        if (outcome.status === 'proposed')
          await store.audit.append({
            at,
            actor: { id: principal.id, name: principal.name, provider: principal.provider },
            via: 'api',
            action: 'learning.propose',
            target: { type: 'learning', id: outcome.candidate.id, repo },
            outcome: 'ok',
            details: {
              section: input.section,
              rule: outcome.candidate.rule,
              ...(outcome.candidate.targetScope && { scope: outcome.candidate.targetScope }),
              through: 'mcp',
            },
          })
        if (outcome.status !== 'proposed' || !canSee(principal, 'knowledge:write', target))
          return outcome
        const accepted = await autoAcceptLearning(deps, outcome.candidate, 'mcp')
        return accepted ? { ...outcome, candidate: accepted } : outcome
      },
    },
    testIds: {
      testIds: async (value) => {
        const separator = value.indexOf(':')
        if (separator < 1 || separator === value.length - 1) return undefined
        const repo = { forge: value.slice(0, separator), path: value.slice(separator + 1) }
        return analysesOf(principal)(repo) ? testIdsOf(repoTarget(config, repo)) : undefined
      },
    },
  })

  const routes = new Hono<Env>()
  routes.route('/', usageRoutes({ catalog, usages, reach, groupsOf }))
  routes.route(
    '/',
    dependencyRoutes(deps, { catalog, usages, reach, libraryIndex: libraryContext, cache }),
  )

  routes.get('/api-surface/packages', async (c) => {
    const canRead = await readable(principalOf(c))
    const kind = kindParam(c)
    const query = {
      ...params(c, ['q', 'repo']),
      ...(kind ? { kind } : {}),
    }
    const list = await cachedCatalog(
      cache,
      catalog,
      canRead,
      `api-surface/packages?${new URLSearchParams(query).toString()}`,
      async () => catalog.packageList(canRead, query),
    )
    const indexedAt = catalog.indexedAt()
    return c.json<PublicApiPackageList>({ ...list, ...(indexedAt ? { indexedAt } : {}) })
  })

  routes.get('/api-surface/symbol', async (c) => {
    const pkg = c.req.query('package')
    const name = c.req.query('name')
    if (!pkg || !name) throw new HTTPException(400, { message: 'package and name are required' })
    const canRead = await readable(principalOf(c))
    const query = {
      package: pkg,
      name,
      ...params(c, ['subpath', 'version', 'repo']),
      limit: historyLimit(c.req.query('limit')),
    }
    const found = await cachedCatalog(
      cache,
      catalog,
      canRead,
      `api-surface/symbol?${new URLSearchParams({ ...query, limit: String(query.limit) }).toString()}`,
      async () => catalog.symbol(canRead, query),
    )
    if (!found) throw new HTTPException(404, { message: `no recorded symbol ${name} in ${pkg}` })
    return c.json<PublicApiSymbol>(found)
  })

  routes.get('/api-surface/package', async (c) => {
    const principal = principalOf(c)
    const name = requireName(c)
    const found = await catalog.resolve(await readable(principal), name, resolveQuery(c))
    if (!found) throw new HTTPException(404, { message: `no recorded version of ${name}` })
    return c.json<PublicApiPackageDetail>({
      repo: found.record.repo,
      ...(found.record.ref ? { ref: found.record.ref } : {}),
      analysisId: found.record.id,
      analyzedAt: found.record.createdAt,
      package: found.package,
      versions: found.versions,
      alsoIn: found.alsoIn,
      ...(found.removed ? { removed: found.removed } : {}),
    })
  })

  routes.get('/api-surface/package.md', async (c) => {
    const principal = principalOf(c)
    const name = requireName(c)
    const found = await catalog.resolve(await readable(principal), name, resolveQuery(c))
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
    const result = await catalog.diff(await readable(principal), name, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(repo ? { repo } : {}),
    })
    if (!result) throw new HTTPException(404, { message: `no two versions of ${name} to compare` })
    return c.json<PublicApiDiff>(result)
  })

  routes.get('/api-surface/search', async (c) => {
    const principal = principalOf(c)
    const kind = kindParam(c)
    const match = matchParam(c)
    const { facets, ...result } = await catalog.search(
      await readable(principal),
      c.req.query('q') ?? '',
      {
        ...params(c, ['package', 'repo', 'subpath']),
        ...(kind ? { kind } : {}),
        ...(match ? { match } : {}),
        limit: Math.min(Math.max(Number(c.req.query('limit')) || 30, 1), 100),
        facets: true,
      },
    )
    return c.json<PublicApiSearchResult>({
      ...result,
      facets: facets ?? { kinds: [], packages: [], repos: [], subpaths: [], matches: [] },
    })
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
      throw new HTTPException(401, { message: 'tokens cannot issue tokens; sign in instead' })
    const input: CreateMcpTokenInput = await readBody(c, createTokenSchema)
    const result = await tokensOf().create(principal, {
      name: input.name,
      expiresInDays: input.expiresInDays ?? 90,
      ...(input.scopes?.length ? { scopes: input.scopes } : {}),
    })
    c.set('audit', {
      action: 'mcp_token.create',
      target: { type: 'mcp_token', id: result.token.id },
      details: {
        name: result.token.name,
        ...(result.token.expiresAt ? { expiresAt: result.token.expiresAt } : {}),
        ...(result.token.scopes ? { scopes: result.token.scopes } : {}),
      },
    })
    return c.json<CreateMcpTokenResult>(result, 201)
  })

  routes.delete('/api-surface/mcp/tokens/:id', async (c) => {
    const principal = principalOf(c)
    if (bearerToken(c.req.raw))
      throw new HTTPException(401, { message: 'tokens cannot revoke tokens; sign in instead' })
    if (!(await tokensOf().revoke(principal, c.req.param('id'))))
      throw new HTTPException(404, { message: 'no such token' })
    c.set('audit', {
      action: 'mcp_token.delete',
      target: { type: 'mcp_token', id: c.req.param('id') },
    })
    return c.body(null, 204)
  })

  const describePerson = async (
    person: McpPersonCalls,
    self: Principal,
  ): Promise<McpPersonUsage> => {
    const grants =
      person.id === self.id ? self.grants : (await store.users?.getUser(person.id))?.grants
    const [teams, activeTokens] = await Promise.all([
      grants ? homeGroupsOf(deps, { ...self, id: person.id, grants }) : [],
      tokens ? tokens.active(person.id) : 0,
    ])
    return { ...person, teams, activeTokens }
  }

  routes.get('/api-surface/mcp/usage', async (c) => {
    const principal = principalOf(c)
    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 90)
    const overview = await usage.overview({
      days,
      self: { id: principal.id, name: principal.name },
      everyone: can(principal, 'users:read', GLOBAL),
      endpoint: endpointOf(c),
    })
    const [people, me] = await Promise.all([
      Promise.all(overview.people.map((person) => describePerson(person, principal))),
      describePerson(overview.me, principal),
    ])
    return c.json<McpUsageOverview>({ ...overview, people, me })
  })

  const fromToken = new WeakMap<Principal, string>()

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
            message: 'send Authorization: Bearer <token from Account › Connect agents>',
          },
        },
        401,
        { 'www-authenticate': 'Bearer realm="holtkeeper"' },
      )
    const client = clientOf(c.req.raw)
    const token = fromToken.get(principal)
    const scope = await reach(principal)
    const library = libraryContext(principal, scope.catalog)
    const knowledge = knowledgeContext(principal, scope)
    return handleMcpRequest(c.req.raw, {
      ...(library ? { library } : {}),
      catalog,
      usages,
      usage,
      store,
      knowledge,
      commits: commitContext(principal),
      ...rulesContext(principal, knowledge),
      releases: releaseToolsAccess(deps, {
        principal,
        canRead: (target) => canSee(principal, 'releases:read', target),
        steps:
          fromToken.has(principal) &&
          principal.grants.some((grant) => grant.actions.includes('releases:run')),
        channel: 'mcp',
      }),
      ops: principalOpsAccess(deps, principal, () => releaseServiceFor(deps).snapshot(principal)),
      tasks: taskToolsAccess(
        { ...deps, readOnly: deps.readOnly ?? (async () => false) },
        principal,
        {
          mayRun: fromToken.has(principal),
          ...(client ? { client } : {}),
        },
      ),
      assets: storedAssetTools(store, {
        targetOf: (repo) => repoTarget(config, repo),
        canRead: (target) => canSee(principal, 'analyses:read', target),
        canReadScope: (entryScope) =>
          can(principal, 'settings:read', { kind: 'scope', scope: entryScope }),
        groupLabel,
      }),
      supply: supplyFor(principal),
      principal,
      canRead: scope.catalog,
      canReadSnippets: scope.snippets,
      ownerOf,
      stack: storedStackTools(store.analyses, {
        canRead: scope.catalog,
        canDetail: analysesOf(principal),
        groupsOf,
        groupLabel,
      }),
      ...(store.kv ? { latest: latestVersions(store.kv) } : {}),
      canReadAnalyses: analysesOf(principal),
      canReadAudits: (repo) => canSee(principal, 'audits:read', repoTarget(config, repo)),
      auditOff: () => analyzerOffFilter(store, (repo) => repoTarget(config, repo), 'audit'),
      ...(client ? { client } : {}),
      ...(token ? { token } : {}),
      now: deps.now,
    })
  }

  /**
   * The read-only principal of an MCP token, for requests to `/mcp` and reads of
   * `/api/api-surface/*` and `/api/dependencies*` that carry one and are otherwise anonymous.
   */
  const tokenPrincipal = async (request: Request, path: string) => {
    if (!tokens || !bearerToken(request)) return undefined
    const allowed =
      path === '/mcp' ||
      (request.method === 'GET' &&
        (path.startsWith('/api/api-surface/') ||
          path === '/api/dependencies' ||
          path.startsWith('/api/dependencies/')))
    const found = allowed ? await tokens.authenticate(request) : undefined
    if (!found) return undefined
    fromToken.set(found.principal, found.token)
    return found.principal
  }

  return { routes, mcp, tokenPrincipal, flush: usage.flush }
}
