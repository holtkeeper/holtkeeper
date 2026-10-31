import type { ClearStorageResult, StorageOverview, StorageProviderView } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, authorize, readBody } from '../context.ts'
import { reportedViews, requestStorageClear, workerStorageReports } from '../storage-reports.ts'

const clearSchema = z.object({ scope: z.string().min(1).max(500).optional() }).optional()

/**
 * Disk and bucket usage of every storage provider, and clearing them. Areas that workers report
 * (git mirrors, tool caches on their own disks) replace this process's measurement of the same
 * id; clearing them asks every worker to clear its copy.
 */
export function storageRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const providers = () => deps.storage ?? []
  const reported = async () =>
    deps.store.kv
      ? reportedViews(await workerStorageReports(deps.store.kv, { now: deps.now() }))
      : []

  app.get('/storage', async (c) => {
    authorize(c, 'settings:read', { kind: 'global' })
    const remote = await reported()
    const remoteIds = new Set(remote.map((view) => view.id))
    const local = await Promise.all(
      providers()
        .filter((provider) => !remoteIds.has(provider.id))
        .map(async (provider): Promise<StorageProviderView> => {
          const base = {
            id: provider.id,
            label: provider.label,
            clearable: provider.clear !== undefined,
          }
          try {
            const usage = await provider.usage()
            return {
              ...base,
              bytes: usage.bytes,
              ...(usage.count !== undefined ? { count: usage.count } : {}),
              details: usage.details ?? [],
              available: usage.available ?? true,
              ...(usage.note ? { note: usage.note } : {}),
            }
          } catch (error) {
            return {
              ...base,
              bytes: 0,
              details: [],
              available: false,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }),
    )
    const views = [...local, ...remote]
    return c.json<StorageOverview>({
      providers: views,
      totalBytes: views.reduce((sum, view) => sum + view.bytes, 0),
    })
  })

  app.post('/storage/:id/clear', async (c) => {
    const principal = authorize(c, 'settings:write', { kind: 'global' })
    const id = c.req.param('id')
    const remote = (await reported()).find((view) => view.id === id)
    if (remote && deps.store.kv) {
      if (!remote.clearable)
        throw new HTTPException(409, { message: `${remote.label} cannot be cleared` })
      const scope = (await readBody(c, clearSchema))?.scope
      const requested = await requestStorageClear(deps.store.kv, id, scope, { now: deps.now() })
      await deps.store.activity.append({
        at: deps.now().toISOString(),
        actor: principal.id,
        action: 'storage.cleared',
        subject: id,
        details: { ...(scope ? { scope } : {}), requested },
      })
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
    await deps.store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'storage.cleared',
      subject: provider.id,
      details: { ...(scope ? { scope } : {}), ...result },
    })
    return c.json<ClearStorageResult>(result)
  })

  return app
}
