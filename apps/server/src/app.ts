import type { ApiError, ForbiddenError, MeResponse } from '@holtkeeper/api'
import { CredentialInputError, CredentialNotFoundError } from '@holtkeeper/credentials'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { auditMiddleware } from './audit.ts'
import { type Env, ForbiddenException, type ServerDeps } from './context.ts'
import { createEventDispatcher } from './events.ts'
import { releaseVersion } from './health.ts'
import { inboxServiceFor } from './inbox.ts'
import { repoHooks } from './repo-hooks.ts'
import { accountRoutes } from './routes/accounts.ts'
import { aiCatalogRoutes } from './routes/ai-catalog.ts'
import { aiRoutes } from './routes/ai.ts'
import { analysisRoutes } from './routes/analyses.ts'
import { createApiSurface } from './routes/api-surface.ts'
import { artifactRoutes } from './routes/artifacts.ts'
import { assetsRoutes } from './routes/assets.ts'
import { auditLogRoutes } from './routes/audit.ts'
import { auditRoutes } from './routes/audits.ts'
import { automationRoutes } from './routes/automation.ts'
import { avatarRoutes, withAvatar } from './routes/avatars.ts'
import { backfillRoutes } from './routes/backfill.ts'
import { branchRoutes } from './routes/branches.ts'
import { bundleRoutes } from './routes/bundles.ts'
import { chatRoutes } from './routes/chat.ts'
import { ciRoutes } from './routes/ci.ts'
import { configRoutes } from './routes/config.ts'
import { coverageRoutes } from './routes/coverage.ts'
import { credentialRoutes } from './routes/credentials.ts'
import { databaseRoutes } from './routes/database.ts'
import { egressRoutes } from './routes/egress.ts'
import { guideRoutes } from './routes/guides.ts'
import { homeRoutes, invalidateHome } from './routes/home.ts'
import { inboxRoutes } from './routes/inbox.ts'
import { jobRoutes } from './routes/jobs.ts'
import { knowledgeRoutes } from './routes/knowledge.ts'
import { learningRoutes } from './routes/learnings.ts'
import { libraryIndexRoutes } from './routes/library-index.ts'
import { licensesRoutes } from './routes/licenses.ts'
import { limitRoutes } from './routes/limits.ts'
import { mediaRoutes } from './routes/media.ts'
import { preferenceRoutes } from './routes/preferences.ts'
import { releaseRoutes } from './routes/releases.ts'
import { repoAvatarRoutes } from './routes/repo-avatars.ts'
import { repoPageRoutes } from './routes/repo-page.ts'
import { reachableGroups, repoRoutes } from './routes/repos.ts'
import { reviewRoutes } from './routes/reviews.ts'
import { scheduleRoutes } from './routes/schedules.ts'
import { settingRoutes } from './routes/settings.ts'
import { slackSettingsRoutes } from './routes/slack-settings.ts'
import { snoozeRoutes } from './routes/snoozes.ts'
import { stackRoutes } from './routes/stack.ts'
import { storageRoutes } from './routes/storage.ts'
import { taskRoutes } from './routes/tasks.ts'
import { trackerRoutes } from './routes/trackers.ts'
import { updateRoutes } from './routes/updates.ts'
import { webhookRoutes } from './routes/webhooks.ts'
import { supplyToolsAccess } from './tools/repos.ts'
import { serverPoller } from './updates.ts'
import { crossTeamPolicy } from './visibility.ts'

/**
 * The HTTP application: `/api/*` for the UI and clients, `/auth/<provider>/*` for the active auth
 * provider, `/mcp` for agents. Static UI files are added by `serveWeb`.
 */
export function createApp(deps: ServerDeps) {
  const app = new Hono<Env>()
  const supply = deps.supply ?? supplyToolsAccess(deps)
  const apiSurface = createApiSurface(deps, supply)

  app.onError((error, c) => {
    if (error instanceof ForbiddenException) return c.json<ForbiddenError>(error.body(), 403)
    if (error instanceof HTTPException)
      return c.json<ApiError>({ error: error.message }, error.status)
    if (error instanceof CredentialInputError)
      return c.json<ApiError>({ error: error.message }, 400)
    if (error instanceof CredentialNotFoundError)
      return c.json<ApiError>({ error: error.message }, 404)
    console.error(error)
    return c.json<ApiError>({ error: 'internal error' }, 500)
  })

  app.use('*', async (c, next) => {
    c.set(
      'principal',
      (await deps.auth.authenticate(c.req.raw)) ??
        (await apiSurface.tokenPrincipal(c.req.raw, c.req.path)),
    )
    await next()
  })
  app.route('/api', snoozeRoutes(deps))
  app.use('*', auditMiddleware(deps))
  const inbox = inboxServiceFor(deps)
  app.use('/api/*', async (c, next) => {
    await next()
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.res.status >= 400) return
    inbox.invalidate()
    invalidateHome(deps)
  })

  app.all(`/auth/${deps.auth.name}/*`, async (c) => {
    const prefix = `/auth/${deps.auth.name}`
    const response = await deps.auth.handle?.(
      c.req.raw,
      c.req.path.slice(prefix.length) || '/',
      c.get('principal'),
    )
    return response ?? c.json<ApiError>({ error: 'not found' }, 404)
  })

  app.all('/mcp', apiSurface.mcp)

  const api = new Hono<Env>()
  const version = releaseVersion(deps.version)
  api.get('/me', async (c) => {
    const publicUrl = deps.config.server?.publicUrl?.replace(/\/+$/, '')
    const principal = c.get('principal')
    const groupTitles: Record<string, string> = {}
    if (principal) {
      const reach = await reachableGroups(deps, principal)
      for (const [key, group] of Object.entries(deps.config.groups))
        if (group.title && reach.has(key)) groupTitles[key] = group.title
    }
    return c.json<MeResponse>({
      principal: await withAvatar(deps, principal),
      auth: deps.auth.info(),
      crossTeam: await crossTeamPolicy(deps.store.settings),
      ...(version && { version }),
      ...(publicUrl && { publicUrl }),
      groupTitles,
    })
  })
  api.route('/', avatarRoutes(deps))
  api.route('/', preferenceRoutes(deps))
  api.route('/', auditLogRoutes(deps))
  api.route('/', homeRoutes(deps))
  api.route('/', inboxRoutes(deps))
  api.route('/', accountRoutes(deps))
  api.route('/', auditRoutes(deps, supply))
  api.route('/', repoRoutes(deps))
  api.route('/', analysisRoutes(deps))
  api.route('/', ciRoutes(deps))
  api.route('/', apiSurface.routes)
  api.route('/', libraryIndexRoutes(deps))
  api.route('/', stackRoutes(deps))
  api.route('/', licensesRoutes(supply))
  api.route('/', credentialRoutes(deps))
  api.route('/', limitRoutes(deps))
  api.route('/', settingRoutes(deps))
  api.route('/', jobRoutes(deps))
  api.route('/', taskRoutes(deps))
  api.route('/', scheduleRoutes(deps))
  api.route('/', automationRoutes(deps))
  api.route('/', repoAvatarRoutes(deps))
  api.route('/', releaseRoutes(deps))
  api.route('/', bundleRoutes(deps))
  api.route('/', assetsRoutes(deps))
  api.route('/', coverageRoutes(deps))
  api.route('/', reviewRoutes(deps))
  api.route('/', branchRoutes(deps))
  api.route('/', repoPageRoutes(deps))
  api.route('/', backfillRoutes(deps))
  api.route('/', guideRoutes(deps))
  api.route('/', knowledgeRoutes(deps))
  api.route('/', learningRoutes(deps))
  const dispatch = createEventDispatcher(deps)
  const hooks = deps.store.kv ? repoHooks(deps.store.kv, deps.vault) : undefined
  const poller = serverPoller(deps, dispatch)
  api.route('/', webhookRoutes(deps, { dispatch, ...(hooks && { repoHooks: hooks }) }))
  api.route(
    '/',
    updateRoutes(deps, { ...(poller && { poller }), ...(hooks && { repoHooks: hooks }) }),
  )
  api.route('/', slackSettingsRoutes(deps))
  api.route('/', chatRoutes(deps))
  api.route('/', configRoutes(deps))
  api.route('/', egressRoutes(deps))
  api.route('/', aiRoutes(deps))
  api.route('/', aiCatalogRoutes(deps))
  api.route('/', artifactRoutes(deps))
  api.route('/', mediaRoutes(deps))
  api.route('/', storageRoutes(deps))
  api.route('/', databaseRoutes(deps))
  api.route('/', trackerRoutes(deps))
  api.all('*', (c) => c.json<ApiError>({ error: 'not found' }, 404))
  app.route('/api', api)

  return app
}
