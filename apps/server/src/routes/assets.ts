import { can } from '@holtkeeper/access'
import type { AssetsOverview, RepoAssetsView } from '@holtkeeper/api'
import { assetKinds, assetProblemRules } from '@holtkeeper/assets'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { latestHeadsWithMetrics } from '../analyses.ts'
import { ASSETS_PAGE_DEFAULT, assetsPage, assetsTable, repoAssetsView } from '../assets.ts'
import {
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  readQuery,
  repoKey,
  repoTarget,
} from '../context.ts'
import { createFleetCache } from '../fleet-cache.ts'
import { analyzerOffFilter } from '../repo-analyzers.ts'
import { canSee } from '../visibility.ts'

const overviewQuery = z.object({
  group: z.string().max(200).optional(),
  repo: z.string().max(500).optional(),
  status: z.enum(['policy', 'saving', 'any']).optional(),
  kind: z.enum(assetKinds).optional(),
  problem: z.enum(assetProblemRules).optional(),
  format: z.string().max(20).optional(),
  sort: z.enum(['severity', 'saving', 'size']).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,9}$/, 'cursor must come from nextCursor')
    .optional(),
  limit: z.coerce.number().int().positive().optional(),
})

/**
 * `GET /assets`: the fleet Assets table over the newest `assets` record of every repository the
 * caller may read (`analyses:read`) and whose `assets` analyzer `repo.analyzers` does not turn
 * off, from stored metrics only, one page at a time.
 * `GET /assets/repo?repo=forge:path`: a repository's effective asset policy, the newest `assets`
 * record as a summary and the trend of recent records. Needs `analyses:read` on the repository;
 * the policy's entry is named only with `settings:read` on its scope.
 */
export function assetsRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const cache = createFleetCache()
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))

  app.get('/assets', async (c) => {
    const { group, repo: repoParam, cursor, limit, ...filters } = readQuery(c, overviewQuery)
    const principal = principalOf(c)
    const repo = parseRepo(repoParam)
    const [heads, off] = await Promise.all([
      latestHeadsWithMetrics(store.analyses, kinds, {
        kind: 'assets',
        ...(repo ? { repo } : {}),
      }),
      analyzerOffFilter(store, (each) => repoTarget(config, each), 'assets'),
    ])
    const newest = heads
      .map((head) => ({ head, target: repoTarget(config, head.repo) }))
      .filter(
        ({ head, target }) =>
          canSee(principal, 'analyses:read', target) &&
          (group === undefined || target.groups.includes(group)) &&
          !off(head.repo),
      )
    const table = await cache.read(
      {
        endpoint: `assets?${JSON.stringify([group, repoParam, filters])}`,
        analysisIds: newest.map(({ head }) => head.id),
        repos: newest.map(({ head }) => repoKey(head.repo)),
      },
      async () => assetsTable(newest, filters),
    )
    return c.json<AssetsOverview>(
      assetsPage(table, Number(cursor ?? 0), limit ?? ASSETS_PAGE_DEFAULT),
    )
  })

  app.get('/assets/repo', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    const target = repoTarget(config, repo)
    const principal = authorize(c, 'analyses:read', { kind: 'repo', repo: target })
    return c.json<RepoAssetsView>(
      await repoAssetsView(store, repo, target, (scope) =>
        can(principal, 'settings:read', { kind: 'scope', scope }),
      ),
    )
  })

  return app
}
