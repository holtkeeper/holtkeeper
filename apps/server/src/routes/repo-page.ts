import type { RepoOverview, RepoReviewList } from '@holtkeeper/api'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import {
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  repoTarget,
} from '../context.ts'
import { repoOverview, repoReviews } from '../repo-page.ts'
import { canSee } from '../visibility.ts'

/**
 * The repository page: `GET /repos/overview?repo=` for its Overview cards and `GET
 * /repos/reviews?repo=` for its Reviews tab. Both need `analyses:read` on the repository, read
 * stored records only and never ask the forge or a model.
 */
export function repoPageRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  const targetOf = (value: string | undefined) => {
    const repo = parseRepo(value)
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    return repoTarget(config, repo)
  }

  app.get('/repos/overview', async (c) => {
    const target = targetOf(c.req.query('repo'))
    authorize(c, 'analyses:read', { kind: 'repo', repo: target })
    return c.json<RepoOverview>(
      await repoOverview(deps, target, {
        audits: canSee(principalOf(c), 'audits:read', target),
        groupsOf: (repo) => repoTarget(config, repo).groups,
      }),
    )
  })

  app.get('/repos/reviews', async (c) => {
    const target = targetOf(c.req.query('repo'))
    authorize(c, 'analyses:read', { kind: 'repo', repo: target })
    return c.json<RepoReviewList>(
      await repoReviews(store, { forge: target.forge, path: target.path }),
    )
  })

  return app
}
