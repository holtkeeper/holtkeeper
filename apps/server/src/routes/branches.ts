import type { BranchesOverview } from '@holtkeeper/api'
import { Hono } from 'hono'

import { branchesOverview } from '../branches.ts'
import { type Env, type ServerDeps, principalOf, repoTarget } from '../context.ts'
import { createFleetCache } from '../fleet-cache.ts'
import { canSee } from '../visibility.ts'

/**
 * Quality › Branches: `GET /branches` answers `BranchesOverview` over the newest `branches` record
 * of every repository the caller may read analyses of, with the change against the run before it
 * and branches to clean up per author. Reads stored metrics only and keeps answers in a fleet
 * cache keyed on the newest records and the caller's readable repositories.
 */
export function branchRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const source = {
    analyses: store.analyses,
    kinds: new Map(deps.analyses.map((kind) => [kind.kind, kind])),
    targetOf: (repo: { forge: string; path: string }) => repoTarget(config, repo),
    cache: createFleetCache(),
  }
  const app = new Hono<Env>()

  app.get('/branches', async (c) => {
    const principal = principalOf(c)
    return c.json<BranchesOverview>(
      await branchesOverview(source, (target) => canSee(principal, 'analyses:read', target)),
    )
  })

  return app
}
