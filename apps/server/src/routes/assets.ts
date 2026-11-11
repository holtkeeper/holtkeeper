import { can } from '@holtkeeper/access'
import type { RepoAssetsView } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import { repoAssetsView } from '../assets.ts'
import { type Env, type ServerDeps, authorize, parseRepo, repoTarget } from '../context.ts'

/**
 * `GET /assets/repo?repo=forge:path`: a repository's effective asset policy, the newest `assets`
 * record as a summary and the trend of recent records. Needs `analyses:read` on the repository;
 * the policy's entry is named only with `settings:read` on its scope.
 */
export function assetsRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

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
