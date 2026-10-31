import type { DatabaseQueries, DatabaseSessionsView, DatabaseView } from '@holtkeeper/api'
import type { DatabaseQuerySort } from '@holtkeeper/store'
import { tableDomain } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { type Env, type ServerDeps, authorize, limitParam } from '../context.ts'
import { annotateIndexes, databaseAdvice, databaseHistory, domainTotals } from '../database.ts'

const sorts: readonly DatabaseQuerySort[] = ['total', 'mean', 'calls']

const isSort = (value: string): value is DatabaseQuerySort => sorts.some((sort) => sort === value)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The database page: size, tables, indexes, growth and advice in one read; statement statistics
 * and live sessions on their own routes, since the page refreshes them more often.
 */
export function databaseRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const inspector = () => {
    const database = deps.store.database
    if (!database)
      throw new HTTPException(404, { message: 'this store has no database to inspect' })
    return database
  }

  app.get('/database', async (c) => {
    authorize(c, 'settings:read', { kind: 'global' })
    const database = deps.store.database
    if (!database)
      return c.json<DatabaseView>({
        available: false,
        reason: 'The in-memory store keeps no database',
      })
    try {
      const [overview, tables, rawIndexes, migrations, history, queries] = await Promise.all([
        database.overview(),
        database.tables(),
        database.indexes(),
        database.migrations(),
        databaseHistory(deps.store.kv),
        database.queries({ limit: 1 }),
      ])
      const indexes = annotateIndexes(rawIndexes)
      const now = deps.now()
      return c.json<DatabaseView>({
        available: true,
        overview,
        tables: tables.map((table) => ({ ...table, domain: tableDomain(table.name) })),
        indexes,
        domains: domainTotals(tables, history, now),
        history,
        advice: databaseAdvice({ overview, tables, indexes, queries, now }),
        migrations,
        resettable: database.resetQueries !== undefined && queries.available && queries.resettable,
      })
    } catch (error) {
      return c.json<DatabaseView>({ available: false, reason: message(error) })
    }
  })

  app.get('/database/queries', async (c) => {
    authorize(c, 'settings:read', { kind: 'global' })
    const sort = c.req.query('sort') ?? 'total'
    if (!isSort(sort))
      throw new HTTPException(400, { message: `sort must be one of ${sorts.join(', ')}` })
    return c.json<DatabaseQueries>(
      await inspector().queries({
        sort,
        limit: Math.min(200, limitParam(c.req.query('limit'))),
      }),
    )
  })

  app.post('/database/queries/reset', async (c) => {
    const principal = authorize(c, 'settings:write', { kind: 'global' })
    const database = inspector()
    if (!database.resetQueries)
      throw new HTTPException(409, { message: 'this database keeps no statement statistics' })
    try {
      await database.resetQueries()
    } catch (error) {
      throw new HTTPException(400, { message: message(error) })
    }
    await deps.store.activity.append({
      at: deps.now().toISOString(),
      actor: principal.id,
      action: 'database.queries-reset',
    })
    return c.json({ ok: true })
  })

  app.get('/database/sessions', async (c) => {
    authorize(c, 'settings:read', { kind: 'global' })
    return c.json<DatabaseSessionsView>({ sessions: await inspector().sessions() })
  })

  return app
}
