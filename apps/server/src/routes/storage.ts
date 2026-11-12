import type { ClearStorageResult, StorageOverview, SystemHealth } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, authorize, readBody } from '../context.ts'
import { releaseVersion, systemHealth } from '../health.ts'
import { reportedViews, requestStorageClear, workerStorageReports } from '../storage-reports.ts'
import { storageOverview } from '../storage.ts'

const clearSchema = z.object({ scope: z.string().min(1).max(500).optional() }).optional()

const GLOBAL = { kind: 'global' } as const

/**
 * Disk and bucket usage of every storage provider, clearing them, and `GET /system/health` (all
 * global `settings:read`, clearing `settings:write`). Areas that workers report (git mirrors,
 * tool caches on their own disks) replace this process's measurement of the same id; clearing
 * them asks every worker to clear its copy.
 */
export function storageRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const startedAt = deps.now().toISOString()
  const providers = () => deps.storage ?? []
  const reported = async () =>
    deps.store.kv
      ? reportedViews(await workerStorageReports(deps.store.kv, { now: deps.now() }))
      : []

  app.get('/storage', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    return c.json<StorageOverview>(
      await storageOverview({ providers: providers(), kv: deps.store.kv, now: deps.now() }),
    )
  })

  app.get('/system/health', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const version = releaseVersion(deps.version)
    return c.json<SystemHealth>(
      await systemHealth({ ...deps, ...(version && { version }) }, { startedAt }),
    )
  })

  app.post('/storage/:id/clear', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const id = c.req.param('id')
    const remote = (await reported()).find((view) => view.id === id)
    if (remote && deps.store.kv) {
      if (!remote.clearable)
        throw new HTTPException(409, { message: `${remote.label} cannot be cleared` })
      const scope = (await readBody(c, clearSchema))?.scope
      const requested = await requestStorageClear(deps.store.kv, id, scope, { now: deps.now() })
      c.set('audit', { details: { ...(scope ? { scope } : {}), requested } })
      return c.json<ClearStorageResult>({ requested })
    }
    const provider = providers().find((entry) => entry.id === id)
    if (!provider) throw new HTTPException(404, { message: 'storage not found' })
    if (!provider.clear)
      throw new HTTPException(409, { message: `${provider.label} cannot be cleared` })
    const scope = (await readBody(c, clearSchema))?.scope
    let result: ClearStorageResult
    try {
      result = await provider.clear(scope)
    } catch (error) {
      throw new HTTPException(400, {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    c.set('audit', { details: { ...(scope ? { scope } : {}), ...result } })
    return c.json<ClearStorageResult>(result)
  })

  return app
}
