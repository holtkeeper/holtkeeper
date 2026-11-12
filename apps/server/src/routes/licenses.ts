import type { Principal } from '@holtkeeper/access'
import type { LicensesOverview } from '@holtkeeper/api'
import { Hono } from 'hono'

import { type Env, principalOf } from '../context.ts'
import type { SupplyToolsAccess } from '../tools/repos.ts'

/**
 * Supply › Licenses: `GET /licenses` answers `LicensesOverview` over the newest license scan of
 * every repository the caller may read analyses of (`analyses:read`), from `supplyFor`, which MCP
 * and chat share. Reads stored metrics only.
 */
export function licensesRoutes(supplyFor: (principal: Principal) => SupplyToolsAccess) {
  const app = new Hono<Env>()

  app.get('/licenses', async (c) =>
    c.json<LicensesOverview>(await supplyFor(principalOf(c)).licenses()),
  )

  return app
}
