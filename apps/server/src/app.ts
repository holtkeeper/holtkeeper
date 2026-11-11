import type { ApiError, MeResponse } from '@holtkeeper/api'
import { CredentialInputError, CredentialNotFoundError } from '@holtkeeper/credentials'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { auditMiddleware } from './audit.ts'
import type { Env, ServerDeps } from './context.ts'
import { createEventDispatcher } from './events.ts'
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
import { bundleRoutes } from './routes/bundles.ts'
import { chatRoutes } from './routes/chat.ts'
import { ciRoutes } from './routes/ci.ts'
import { configRoutes } from './routes/config.ts'
import { coverageRoutes } from './routes/coverage.ts'
import { credentialRoutes } from './routes/credentials.ts'
import { databaseRoutes } from './routes/database.ts'
import { egressRoutes } from './routes/egress.ts'
import { guideRoutes } from './routes/guides.ts'
import { homeRoutes } from './routes/home.ts'
import { jobRoutes } from './routes/jobs.ts'
import { knowledgeRoutes } from './routes/knowledge.ts'
import { learningRoutes } from './routes/learnings.ts'
import { libraryIndexRoutes } from './routes/library-index.ts'
import { mediaRoutes } from './routes/media.ts'
import { preferenceRoutes } from './routes/preferences.ts'
import { releaseRoutes } from './routes/releases.ts'
import { repoAvatarRoutes } from './routes/repo-avatars.ts'
import { repoPageRoutes } from './routes/repo-page.ts'
import { scheduleRoutes } from './routes/schedules.ts'
import { settingRoutes } from './routes/settings.ts'
import { slackSettingsRoutes } from './routes/slack-settings.ts'
import { stackRoutes } from './routes/stack.ts'
import { storageRoutes } from './routes/storage.ts'
import { taskRoutes } from './routes/tasks.ts'
import { trackerRoutes } from './routes/trackers.ts'
import { updateRoutes } from './routes/updates.ts'
import { webhookRoutes } from './routes/webhooks.ts'
import { serverPoller } from './updates.ts'
import { crossTeamPolicy } from './visibility.ts'

/**
 * The HTTP application: `/api/*` for the UI and clients, `/auth/<provider>/*` for the active auth
 * provider, `/mcp` for agents. Static UI files are added by `serveWeb`.
 */
export function createApp(deps: ServerDeps) {
  const app = new Hono<Env>()
  const apiSurface = createApiSurface(deps)

  app.onError((error, c) => {
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
  app.use('*', auditMiddleware(deps))

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
  api.get('/me', async (c) =>
    c.json<MeResponse>({
      principal: await withAvatar(deps, c.get('principal')),
      auth: deps.auth.info(),
      crossTeam: await crossTeamPolicy(deps.store.settings),
    }),
  )
  api.route('/', avatarRoutes(deps))
  api.route('/', preferenceRoutes(deps))
  api.route('/', auditLogRoutes(deps))
  api.route('/', homeRoutes(deps))
  api.route('/', accountRoutes(deps))
  api.route('/', auditRoutes(deps))
  api.route('/', analysisRoutes(deps))
  api.route('/', ciRoutes(deps))
  api.route('/', apiSurface.routes)
  api.route('/', libraryIndexRoutes(deps))
  api.route('/', stackRoutes(deps))
  api.route('/', credentialRoutes(deps))
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
  api.route('/', repoPageRoutes(deps))
  api.route('/', backfillRoutes(deps))
  api.route('/', knowledgeRoutes(deps))
  api.route('/', guideRoutes(deps))
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
