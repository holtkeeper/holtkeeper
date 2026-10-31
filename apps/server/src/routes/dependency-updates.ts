import type { DependencyUpdatesOverview } from '@holtkeeper/api'
import { Hono } from 'hono'

import { type Env, type ServerDeps, principalOf, repoTarget } from '../context.ts'
import { dependencyUpdatesOverview } from '../dependency-updates.ts'
import { canSee } from '../visibility.ts'

/** Dependency updates across repositories, from their newest update records. */
export function dependencyUpdateRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  app.get('/dependency-updates', async (c) => {
    const principal = principalOf(c)
    const records = (
      await Promise.all(
        ['renovate', 'browserslist', 'propagation'].map((kind) => store.analyses.latest({ kind })),
      )
    ).flat()
    return c.json<DependencyUpdatesOverview>(
      dependencyUpdatesOverview({
        records,
        visible: (repo) => canSee(principal, 'analyses:read', repoTarget(config, repo)),
      }),
    )
  })

  return app
}
