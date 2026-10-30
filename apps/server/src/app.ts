import type { ActivityList, ApiError, MeResponse } from '@holtkeeper/api'
import { CredentialInputError, CredentialNotFoundError } from '@holtkeeper/credentials'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { auditMiddleware } from './audit.ts'
import { type Env, type ServerDeps, authorize, limitParam } from './context.ts'
import { accountRoutes } from './routes/accounts.ts'
import { aiRoutes } from './routes/ai.ts'
import { analysisRoutes } from './routes/analyses.ts'
import { artifactRoutes } from './routes/artifacts.ts'
import { auditLogRoutes } from './routes/audit.ts'
import { auditRoutes } from './routes/audits.ts'
import { avatarRoutes, withAvatar } from './routes/avatars.ts'
import { configRoutes } from './routes/config.ts'
import { credentialRoutes } from './routes/credentials.ts'
import { jobRoutes } from './routes/jobs.ts'
import { knowledgeRoutes } from './routes/knowledge.ts'
import { mediaRoutes } from './routes/media.ts'
import { settingRoutes } from './routes/settings.ts'
import { storageRoutes } from './routes/storage.ts'
import { trackerRoutes } from './routes/trackers.ts'
import { webhookRoutes } from './routes/webhooks.ts'

/**
 * The HTTP application: `/api/*` for the UI and clients, `/auth/<provider>/*` for the active auth
 * provider. Static UI files are added by `serveWeb`.
 */
export function createApp(deps: ServerDeps) {
  const app = new Hono<Env>()

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
    c.set('principal', await deps.auth.authenticate(c.req.raw))
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

  const api = new Hono<Env>()
  api.get('/me', async (c) =>
    c.json<MeResponse>({
      principal: await withAvatar(deps, c.get('principal')),
      auth: deps.auth.info(),
    }),
  )
  api.route('/', avatarRoutes(deps))
  api.route('/', auditLogRoutes(deps))
  api.route('/', accountRoutes(deps))
  api.route('/', auditRoutes(deps))
  api.route('/', analysisRoutes(deps))
  api.route('/', credentialRoutes(deps))
  api.route('/', settingRoutes(deps))
  api.route('/', jobRoutes(deps))
  api.route('/', knowledgeRoutes(deps))
  api.route('/', webhookRoutes(deps))
  api.route('/', configRoutes(deps))
  api.route('/', aiRoutes(deps))
  api.route('/', artifactRoutes(deps))
  api.route('/', mediaRoutes(deps))
  api.route('/', storageRoutes(deps))
  api.route('/', trackerRoutes(deps))
  api.get('/activity', async (c) => {
    authorize(c, 'users:read', { kind: 'global' })
    const before = c.req.query('before')
    const events = await deps.store.activity.list({
      ...(before ? { before } : {}),
      limit: limitParam(c.req.query('limit')),
    })
    return c.json<ActivityList>({ events })
  })
  api.all('*', (c) => c.json<ApiError>({ error: 'not found' }, 404))
  app.route('/api', api)

  return app
}
