import type { CoverageOverview, RepoCoverageView } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
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
import { coverageCards, repoCoverageView, withCoverageTargets } from '../coverage.ts'
import { createFleetCache } from '../fleet-cache.ts'
import { canSee } from '../visibility.ts'
import { jobSummary } from './analyses.ts'
import { jobTarget } from './jobs.ts'

/**
 * Quality › Coverage: `GET /coverage` lists a card per repository the caller may read
 * (`analyses:read`) that has a coverage record, from stored metrics, each with its own target
 * when its `analyzers.coverage` entry sets one; `GET /coverage/repo?repo=`
 * adds one repository's breakdown from the data of its two newest records and the job that
 * produced the newest one when the caller may read it.
 */
export function coverageRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const source = {
    store,
    kinds: new Map(deps.analyses.map((kind) => [kind.kind, kind])),
    targetOf: (repo: RepoRef) => repoTarget(config, repo),
    cache: createFleetCache(),
  }

  app.get('/coverage', async (c) => {
    const principal = principalOf(c)
    const repos = await coverageCards(source, (target) =>
      canSee(principal, 'analyses:read', target),
    )
    return c.json<CoverageOverview>({
      repos: await withCoverageTargets(store, repos, source.targetOf),
    })
  })

  app.get('/coverage/repo', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    const target = repoTarget(config, repo)
    authorize(c, 'analyses:read', { kind: 'repo', repo: target })
    const view = await repoCoverageView(store, target)
    const [job] = view.card
      ? await store.jobs.list({ analysisId: view.card.analysisId, limit: 1 })
      : []
    return c.json<RepoCoverageView>({
      ...view,
      ...(job && canSee(principalOf(c), 'analyses:read', jobTarget(config, job))
        ? { job: jobSummary(job) }
        : {}),
    })
  })

  return app
}
