import { can } from '@holtkeeper/access'
import type { FreshnessOverview } from '@holtkeeper/api'
import { Hono } from 'hono'

import { type Env, type ServerDeps, principalOf } from '../context.ts'
import { freshnessSummary } from '../freshness.ts'
import { canSee } from '../visibility.ts'
import { jobTarget } from './jobs.ts'

/** Read-only state behind the Automation page that the config and settings APIs do not cover. */
export function automationRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  app.get('/automation/freshness', async (c) => {
    const principal = principalOf(c)
    const everything = can(principal, 'analyses:read', { kind: 'global' })
    const overview = await freshnessSummary(
      deps,
      (target) => everything || canSee(principal, 'analyses:read', jobTarget(deps.config, target)),
    )
    return c.json<FreshnessOverview>(overview)
  })

  return app
}
