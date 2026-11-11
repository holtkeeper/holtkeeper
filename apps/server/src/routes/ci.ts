import type { CiOverview, CiRepoCard, CiRepoView } from '@holtkeeper/api'
import { jobProblems, problemJobs, readCiJobs } from '@holtkeeper/ci-jobs'
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
import { canSee } from '../visibility.ts'

/** Repositories whose newest CI run is older than this drop off the overview. */
const ACTIVE_DAYS = 30

/** The CI pages: one card per active repository and one repository's newest `ci-jobs` record. */
export function ciRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()

  app.get('/ci', async (c) => {
    const principal = principalOf(c)
    const since = new Date(deps.now().getTime() - ACTIVE_DAYS * 86_400_000).toISOString()
    const records = await store.analyses.latest({ kind: 'ci-jobs' })
    const repos = records.flatMap((record): CiRepoCard[] => {
      if (!canSee(principal, 'analyses:read', repoTarget(config, record.repo))) return []
      const data = readCiJobs(record.data)
      if (!data?.lastRunAt || data.lastRunAt < since) return []
      const { pipelines } = data
      return [
        {
          repo: record.repo,
          analysisId: record.id,
          createdAt: record.createdAt,
          ...(pipelines.ref ? { ref: pipelines.ref } : {}),
          lastRunAt: data.lastRunAt,
          pipelines: pipelines.count,
          ...(pipelines.duration.median === undefined ? {} : { median: pipelines.duration.median }),
          ...(pipelines.duration.p90 === undefined ? {} : { p90: pipelines.duration.p90 }),
          ...(pipelines.successRate === undefined ? {} : { successRate: pipelines.successRate }),
          ...(pipelines.change === undefined ? {} : { change: pipelines.change }),
          weeks: data.weeks.map((week) => week.median ?? null),
          problems: problemJobs(data).length,
        },
      ]
    })
    return c.json<CiOverview>({
      repos: repos.toSorted((a, b) =>
        `${a.repo.forge}:${a.repo.path}`.localeCompare(`${b.repo.forge}:${b.repo.path}`),
      ),
    })
  })

  app.get('/ci/repo', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    authorize(c, 'analyses:read', { kind: 'repo', repo: repoTarget(config, repo) })
    const [record] = await store.analyses.latest({ repo, kind: 'ci-jobs' })
    const data = record ? readCiJobs(record.data) : undefined
    return c.json<CiRepoView>({
      repo,
      ...(record ? { analysisId: record.id, createdAt: record.createdAt } : {}),
      ...(data ? { data } : {}),
      problems: data ? problemJobs(data) : [],
      flags: Object.fromEntries(
        (data?.jobs ?? []).flatMap((job) => {
          const kinds = jobProblems(job)
          return kinds.length ? [[job.name, kinds]] : []
        }),
      ),
    })
  })

  return app
}
