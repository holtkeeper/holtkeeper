import type { CoverageOverview, RepoCoverageView } from '@holtkeeper/api'
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
import { coverageCards, repoCoverageView } from '../coverage.ts'
import { canSee } from '../visibility.ts'

/**
 * The Coverage page: `GET /coverage` lists a card per repository the caller may read
 * (`analyses:read`) that has a coverage record; `GET /coverage/repo?repo=` adds one repository's
 * breakdown. Both read stored records only.
 */
export function coverageRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  app.get('/coverage', async (c) => {
    const principal = principalOf(c)
    const targets = (await store.analyses.latestHeads({ kind: 'coverage' }))
      .map((head) => repoTarget(config, head.repo))
      .filter((target) => canSee(principal, 'analyses:read', target))
    return c.json<CoverageOverview>({ repos: await coverageCards(store, targets) })
  })

  app.get('/coverage/repo', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    const target = repoTarget(config, repo)
    authorize(c, 'analyses:read', { kind: 'repo', repo: target })
    return c.json<RepoCoverageView>(await repoCoverageView(store, target))
  })

  return app
}
