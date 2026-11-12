import type { RepoOverview } from '@holtkeeper/api'
import { groupTitle } from '@holtkeeper/core'
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
import { releaseServiceFor } from '../releases.ts'
import { principalHealthAccess } from '../repo-health.ts'
import { repoOverview } from '../repo-page.ts'

/**
 * The repository hub: `GET /repos/overview?repo=` for its header and Overview. Needs
 * `analyses:read` on the repository, reads stored records only and never asks the forge or a
 * model; parts behind another permission are left out.
 */
export function repoPageRoutes(deps: ServerDeps) {
  const { config } = deps
  const app = new Hono<Env>()

  const targetOf = (value: string | undefined) => {
    const repo = parseRepo(value)
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    return repoTarget(config, repo)
  }

  app.get('/repos/overview', async (c) => {
    const target = targetOf(c.req.query('repo'))
    authorize(c, 'analyses:read', { kind: 'repo', repo: target })
    const principal = principalOf(c)
    return c.json<RepoOverview>(
      await repoOverview(deps, target, {
        access: principalHealthAccess(principal, target),
        releases: () => releaseServiceFor(deps).snapshot(principal),
        groupsOf: (repo) => repoTarget(config, repo).groups,
        groupTitle: (group) => groupTitle(config.groups, group),
      }),
    )
  })

  return app
}
