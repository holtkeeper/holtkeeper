import type { DependencyInventory, DependencyRepo } from '@holtkeeper/api'
import { directDependencies, fleetLibraries, latestDepgraphs } from '@holtkeeper/depgraph'
import { Hono } from 'hono'

import { type Env, type ServerDeps, principalOf, repoTarget } from '../context.ts'
import { canSee } from '../visibility.ts'

/** The dependency inventory across repositories, built from their newest `depgraph` records. */
export function dependencyRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  app.get('/dependencies', async (c) => {
    const principal = principalOf(c)
    const latest = await latestDepgraphs(store.analyses, {
      accept: (record) => canSee(principal, 'analyses:read', repoTarget(config, record.repo)),
    })

    const entries = [...latest].map(([origin, { data }]) => ({ origin, data }))
    const repos = [...latest.values()]
      .map(({ record, data }): DependencyRepo => ({
        repo: record.repo,
        analysisId: record.id,
        ...(record.ref ? { ref: record.ref } : {}),
        createdAt: record.createdAt,
        dependencies: directDependencies(data).length,
      }))
      .toSorted((a, b) =>
        `${a.repo.forge}:${a.repo.path}`.localeCompare(`${b.repo.forge}:${b.repo.path}`),
      )
    return c.json<DependencyInventory>({ repos, libraries: fleetLibraries(entries) })
  })

  return app
}
