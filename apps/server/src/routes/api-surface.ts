import { type Principal, can } from '@holtkeeper/access'
import type {
  CreateMcpTokenInput,
  CreateMcpTokenResult,
  McpTokenList,
  McpTokenToolsetsInput,
  McpToolsetName,
  McpPersonUsage,
  McpUsageOverview,
  PublicApiDiff,
  PublicApiPackageDetail,
  PublicApiMatch,
  PublicApiPackageList,
  PublicApiSearchResult,
  PublicApiSymbol,
  SecretReportingMode,
  UpdateMcpTokenInput,
} from '@holtkeeper/api'
import { mcpToolsetCatalog, mcpToolsetNames } from '@holtkeeper/api'
import { apiSymbolKinds, isApiSymbolKind, renderPackage } from '@holtkeeper/api-surface'
import type { RepoRef } from '@holtkeeper/forge'
import { latestVersions, libraryApi } from '@holtkeeper/libraries'
import {
  DEFAULT_REPORTING_MODE,
  LICENSE_NAME,
  REPORT_TOOL,
  reportingModes,
} from '@holtkeeper/secret-reports'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type RepoFilter, cachedCatalog, createApiCatalog } from '../api-surface/catalog.ts'
import { handleMcpRequest } from '../api-surface/mcp.ts'
import { knownRepoChecker, repoArgResolver } from '../api-surface/repo-arg.ts'
import { type McpTokens, mcpTokens } from '../api-surface/tokens.ts'
import { type McpPersonCalls, mcpUsage } from '../api-surface/usage.ts'
import { createUsageIndex } from '../api-surface/usages.ts'
import { askService } from '../ask.ts'
import { canReadRepo } from '../chat-threads.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  forgeFor,
  teamLabeler,
  principalOf,
  publicUrlOf,
  parseRepo,
  readBody,
  repoTarget,
  withTeams,
} from '../context.ts'
import { createFleetCache } from '../fleet-cache.ts'
import {
  agentSummarize,
  githubClientFor,
  librariesConfigOf,
  libraryReader,
  ownPackageOf,
  ownPackageSource,
  serverLibraryDocs,
  visibleLibraries,
} from '../libraries.ts'
import { noteReviewJob } from '../mr-status.ts'
import { qaToolsAccess } from '../qa.ts'
import { releaseToolsAccess } from '../release-steps.ts'
import { analyzerOffFilter } from '../repo-analyzers.ts'
import { reviewToolsAccess } from '../review-status.ts'
import { createRulesResolver, readForgeRuleFiles } from '../rules.ts'
import { secretReportsFor } from '../secret-reports.ts'
import { storedAssetTools } from '../tools/assets.ts'
import type { KnowledgeToolsContext } from '../tools/knowledge.ts'
import type { LibraryIndex } from '../tools/packages.ts'
import { repoRulesAccess, storedStackTools } from '../tools/registry.ts'
import {
  type CommitConventionsAccess,
  type RulesAccess,
  commitConventionsReader,
  testIdsReader,
} from '../tools/rules.ts'
import { canSee, catalogReach } from '../visibility.ts'
import { dependencyRoutes } from './dependencies.ts'
import { homeTeamsOf } from './preferences.ts'
import { usageRoutes } from './usages.ts'

const GLOBAL = { kind: 'global' } as const

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(0).max(3650).default(90),
  scopes: z
    .array(z.enum(['release', 'tasks']))
    .max(2)
    .optional(),
  secretReports: z.enum(reportingModes).optional(),
  toolsets: z.array(z.enum(mcpToolsetNames)).max(mcpToolsetNames.length).optional(),
})

const toolsetsSchema = z.object({
  toolsets: z.array(z.enum(mcpToolsetNames)).max(mcpToolsetNames.length),
})

const updateTokenSchema = z.object({ secretReports: z.enum(reportingModes) })

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
export function createApiSurface(deps: ServerDeps) {
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
  const teamsOf = (repo: RepoRef) => targetOf(repo).teams
  const teamLabel = teamLabeler(config)
  const ownerOf = (repo: RepoRef) => teamsOf(repo).map(teamLabel)
  const readable = async (principal: Principal) => (await reach(principal)).catalog
  const analysesOf = (principal: Principal) => (repo: RepoRef) =>
    canSee(principal, 'analyses:read', targetOf(repo))
  const tokensOf = () => {
    if (!tokens) throw new HTTPException(503, { message: 'the store keeps no key-value state' })
    return tokens
  }
  const endpointOf = (c: AppContext) => `${publicUrlOf(deps, c)}/mcp`
  const secretReports = secretReportsFor(deps)
  const secretReportsInfo = secretReports
    ? { defaultMode: DEFAULT_REPORTING_MODE, licenseName: LICENSE_NAME }
    : undefined

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
      ownSource: ownPackageSource({
        catalog,
        filter: canRead,
        forgeOf: (name) => config.forges[name]?.create(),
      }),
    })
    return { docs, api: libraryApi({ store: libraries, artifacts }), store: libraries }
  }

  const knowledgeContext = (principal: Principal): KnowledgeToolsContext => ({
    store,
    config,
    canReadScope: (scope) => can(principal, 'knowledge:read', { kind: 'scope', scope }),
    teamLabel,
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
    audit: {
      actor: { id: principal.id, name: principal.name, provider: principal.provider },
      via: 'api',
    },
    now: deps.now,
  })

  const resolveRules = createRulesResolver({ store, config, now: deps.now })
  const testIdsOf = testIdsReader({ store })
  const rulesContext = (
    principal: Principal,
    knowledge: KnowledgeToolsContext,
  ): Omit<RulesAccess, 'commits'> => ({
    rules: repoRulesAccess({
      store,
      resolve: resolveRules,
      repoFiles: (target) =>
        readForgeRuleFiles({
          forge: forgeFor(config, target.forge),
          forgeId: target.forge,
          repo: target.path,
          ...(store.kv && { kv: store.kv }),
        }),
      readable: knowledge.repoOf,
      canReadScope: knowledge.canReadScope,
    }),
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
  routes.route('/', usageRoutes({ catalog, usages, reach, teamsOf }))
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
    const info = {
      ...(secretReportsInfo ? { secretReports: secretReportsInfo } : {}),
      toolsets: [...mcpToolsetCatalog],
    }
    if (!tokens) return c.json<McpTokenList>({ tokens: [], available: false, ...info })
    return c.json<McpTokenList>({ tokens: await tokens.list(principal), available: true, ...info })
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
      ...(input.secretReports && { secretReports: input.secretReports }),
      ...(input.toolsets && { toolsets: input.toolsets }),
    })
    // The audit event leaves out the reporting choice: administrators read the audit log, and
    // nobody may learn who reports anonymously or not at all.
    c.set('audit', {
      action: 'mcp_token.create',
      target: { type: 'mcp_token', id: result.token.id },
      details: {
        name: result.token.name,
        ...(result.token.expiresAt ? { expiresAt: result.token.expiresAt } : {}),
        ...(result.token.scopes ? { scopes: result.token.scopes } : {}),
        toolsets: result.token.toolsets,
      },
    })
    return c.json<CreateMcpTokenResult>(result, 201)
  })

  routes.put('/api-surface/mcp/tokens/:id/toolsets', async (c) => {
    const principal = principalOf(c)
    if (bearerToken(c.req.raw))
      throw new HTTPException(401, { message: 'tokens cannot change tokens; sign in instead' })
    const input: McpTokenToolsetsInput = await readBody(c, toolsetsSchema)
    if (!(await tokensOf().setToolsets(principal, c.req.param('id'), input.toolsets)))
      throw new HTTPException(404, { message: 'no such token' })
    c.set('audit', {
      action: 'mcp_token.toolsets',
      target: { type: 'mcp_token', id: c.req.param('id') },
      details: { toolsets: input.toolsets },
    })
    return c.body(null, 204)
  })

  // Not audited at all (see `isAudited`): even the fact that someone changed their reporting
  // choice is theirs alone.
  routes.patch('/api-surface/mcp/tokens/:id', async (c) => {
    const principal = principalOf(c)
    if (bearerToken(c.req.raw))
      throw new HTTPException(401, { message: 'tokens cannot change tokens; sign in instead' })
    const input: UpdateMcpTokenInput = await readBody(c, updateTokenSchema)
    if (!(await tokensOf().setReporting(principal, c.req.param('id'), input.secretReports)))
      throw new HTTPException(404, { message: 'no such token' })
    return c.body(null, 204)
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
    const user = person.id === self.id ? undefined : await store.users?.getUser(person.id)
    const principal: Principal | undefined =
      person.id === self.id
        ? self
        : user && {
            id: user.id,
            name: user.id,
            provider: self.provider,
            grants: user.grants,
            ...(user.email ? { email: user.email } : {}),
          }
    const [teams, activeTokens] = await Promise.all([
      principal ? homeTeamsOf(deps, principal) : [],
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

  const asks = askService({
    config,
    settings: store.settings,
    aiUsage: store.aiUsage,
    ...(store.kv && { kv: store.kv }),
    ...(deps.askAgentFor && { agentFor: deps.askAgentFor }),
    homeTeams: (principal) => homeTeamsOf(deps, principal),
    canReadRepo: (principal, repo) => canReadRepo(config, principal, repo),
    canReadTeam: (principal, team) =>
      (['repos:read', 'knowledge:read'] as const).every((action) =>
        can(principal, action, { kind: 'scope', scope: { teams: [team] } }),
      ),
    canReadRules: (principal, target) =>
      can(principal, 'knowledge:read', { kind: 'repo', repo: target }),
    now: deps.now,
  })

  const resolveRepo = repoArgResolver(() => deps.config)
  const knownRepo = knownRepoChecker({
    analyses: store.analyses,
    configured: (forge) => config.forges[forge] !== undefined,
    forgeOf: (forge) => forgeFor(config, forge),
    now: deps.now,
  })
  /**
   * The existence check for one caller, limited to repositories their own grants cover: anything
   * else falls through to the tools' own "may not read" answers, so the check never tells which
   * repositories exist out of the caller's reach.
   */
  const repoExistsFor =
    (principal: Principal) =>
    async (value: string): Promise<string | undefined> => {
      const repo = parseRepo(value)
      if (!repo) return value
      if (!config.forges[repo.forge]) return undefined
      return canSee(principal, 'repos:read', repoTarget(config, repo)) ? knownRepo(value) : value
    }

  const fromToken = new WeakMap<Principal, string>()
  const reportingOf = new WeakMap<Principal, SecretReportingMode>()
  const toolsetsOf = new WeakMap<Principal, readonly McpToolsetName[]>()
  const anonymousReports: ReadonlySet<string> = new Set([REPORT_TOOL])

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
    const knowledge = knowledgeContext(principal)
    // Signed-in browsers (the tool reference) have no token and see the default choice.
    const reporting = reportingOf.get(principal) ?? DEFAULT_REPORTING_MODE
    const reports = secretReports?.accessFor(principal, reporting)
    // Signed-in browsers (the tool reference) see every toolset.
    const toolsets = toolsetsOf.get(principal)
    const ask = !toolsets || toolsets.includes('ask') ? await asks.accessFor(principal) : undefined
    return handleMcpRequest(c.req.raw, {
      ...(toolsets && { toolsets }),
      ...(ask && { ask }),
      resolveRepo,
      repoExists: repoExistsFor(principal),
      ...(!toolsets || toolsets.includes('qa') ? { qa: qaToolsAccess(deps, principal) } : {}),
      ...(reports && { secretReports: reports }),
      ...(reports?.mode === 'anonymous' && { unrecorded: anonymousReports }),
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
        channel: 'mcp',
      }),
      reviews: reviewToolsAccess(
        {
          store,
          config,
          ...(deps.readOnly && { readOnly: deps.readOnly }),
          onQueued: (job) => noteReviewJob(deps, job),
          now: deps.now,
        },
        (target) => canSee(principal, 'analyses:read', target),
      ),
      assets: storedAssetTools(store, {
        targetOf: (repo) => repoTarget(config, repo),
        canRead: (target) => canSee(principal, 'analyses:read', target),
        canReadScope: (entryScope) =>
          can(principal, 'settings:read', { kind: 'scope', scope: entryScope }),
        teamLabel,
      }),
      principal,
      canRead: scope.catalog,
      canReadSnippets: scope.snippets,
      ownerOf,
      stack: storedStackTools(store.analyses, {
        canRead: scope.catalog,
        canDetail: analysesOf(principal),
        teamsOf,
        teamLabel,
      }),
      ...(store.kv ? { latest: latestVersions(store.kv) } : {}),
      canReadAnalyses: analysesOf(principal),
      canReadAudits: (repo) => canSee(principal, 'audits:read', repoTarget(config, repo)),
      auditOff: () => analyzerOffFilter(store, (repo) => repoTarget(config, repo), 'audit'),
      bundleOff: () => analyzerOffFilter(store, (repo) => repoTarget(config, repo), 'bundle'),
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
    // Team grants are added here rather than by the app middleware so the principal remembered
    // for the token is the very object handlers see.
    const principal = withTeams(deps.config, found.principal)
    fromToken.set(principal, found.token)
    reportingOf.set(principal, found.secretReports)
    toolsetsOf.set(principal, found.toolsets)
    return principal
  }

  return { routes, mcp, tokenPrincipal, secretReports, flush: usage.flush }
}
