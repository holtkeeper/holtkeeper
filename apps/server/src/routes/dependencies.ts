import type { DependencyInventory, DependencyRepo } from '@holtkeeper/api'
import {
  type DepgraphData,
  depgraphDataSchema,
  directDependencies,
  fleetLibraries,
} from '@holtkeeper/depgraph'
import type { AnalysisRecord } from '@holtkeeper/store'
import { Hono } from 'hono'

import { type Env, type ServerDeps, principalOf, repoTarget } from '../context.ts'
import { canSee } from '../visibility.ts'

const pageSize = 100
const maxRecords = 2000

/** The dependency inventory across repositories, built from their newest `depgraph` records. */
export function dependencyRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  app.get('/dependencies', async (c) => {
    const principal = principalOf(c)
    const latest = new Map<string, { record: AnalysisRecord; data: DepgraphData }>()
    let before: string | undefined
    for (let seen = 0; seen < maxRecords; seen += pageSize) {
      const page = await store.analyses.list({
        kind: 'depgraph',
        limit: pageSize,
        ...(before ? { before } : {}),
      })
      for (const record of page) {
        const key = `${record.repo.forge}:${record.repo.path}`
        if (latest.has(key)) continue
        if (!canSee(principal, 'analyses:read', repoTarget(config, record.repo))) continue
        const parsed = depgraphDataSchema.safeParse(record.data)
        if (parsed.success) latest.set(key, { record, data: parsed.data })
      }
      if (page.length < pageSize) break
      before = page.at(-1)?.createdAt
    }

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
