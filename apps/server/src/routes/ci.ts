import { metricsOf } from '@holtkeeper/analyzer'
import type {
  CiFleetJobRow,
  CiFleetJobSort,
  CiFleetJobsView,
  CiJobsView,
  CiOverview,
  CiRepoCard,
  CiRepoView,
} from '@holtkeeper/api'
import {
  ciJobTable,
  ciJobsAnalysis,
  jobProblems,
  problemJobs,
  readCiJobs,
} from '@holtkeeper/ci-jobs'
import type { RepoRef } from '@holtkeeper/forge'
import { releaseSettings, releaseSettingsKey } from '@holtkeeper/release'
import { resolveSetting } from '@holtkeeper/settings'
import type { AnalysisHead } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { latestHeadsWithMetrics } from '../analyses.ts'
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
import { withCurrentMetrics } from '../fleet-metrics.ts'
import { canSee } from '../visibility.ts'

const KIND = 'ci-jobs'

/** Repositories whose newest CI run is older than this drop off the overview. */
const ACTIVE_DAYS = 30

const CI_JOBS_DEFAULT = 50

/** The most rows `GET /ci/jobs` answers, whatever `limit` asks for. */
export const CI_JOBS_MAX = 200

/** Newest records whose data `GET /ci/jobs` keeps in memory. */
const JOBS_CACHED = 20

const isCurrent = (metrics: object) => 'weeks' in metrics

const jobsQuery = z.object({ limit: z.coerce.number().int().min(1).optional() })

const fleetJobsQuery = jobsQuery.extend({
  sort: z.enum(['slowest', 'unreliable', 'slower']).optional(),
})

const name = (a: CiFleetJobRow, b: CiFleetJobRow) =>
  repoKey(a.repo).localeCompare(repoKey(b.repo)) || a.name.localeCompare(b.name)

/** Rows `GET /ci/jobs/fleet` keeps for `sort`, ranked worst first. */
function rankFleetJobs(rows: readonly CiFleetJobRow[], sort: CiFleetJobSort): CiFleetJobRow[] {
  if (sort === 'unreliable')
    return rows
      .filter((row) => (row.failureRate ?? 0) > 0 || row.flaky > 0)
      .toSorted(
        (a, b) => (b.failureRate ?? 0) - (a.failureRate ?? 0) || b.flaky - a.flaky || name(a, b),
      )
  if (sort === 'slower')
    return rows
      .filter((row) => (row.change ?? 0) > 0)
      .toSorted((a, b) => (b.change ?? 0) - (a.change ?? 0) || name(a, b))
  return rows
    .filter((row) => row.median !== undefined)
    .toSorted((a, b) => (b.median ?? 0) - (a.median ?? 0) || name(a, b))
}

/**
 * The CI pages: `GET /ci` gives a card per active repository from stored metrics, `GET /ci/repo`
 * one repository's newest `ci-jobs` record, `GET /ci/jobs` its jobs as table rows, capped, and
 * `GET /ci/jobs/fleet` the worst jobs across every readable repository, cached per set of heads.
 */
export function ciRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))
  const kind = kinds.get(KIND) ?? ciJobsAnalysis
  const cache = createFleetCache()
  const records = createFleetCache({ maxEntries: JOBS_CACHED })
  const fleetJobs = createFleetCache({ maxEntries: JOBS_CACHED })
  const targetOf = (repo: RepoRef) => repoTarget(config, repo)

  const cardOf = (head: AnalysisHead, since: string): CiRepoCard | undefined => {
    const metrics = metricsOf(ciJobsAnalysis, head)
    if (!metrics?.lastRunAt || metrics.lastRunAt < since) return undefined
    return {
      repo: head.repo,
      analysisId: head.id,
      createdAt: head.createdAt,
      ...(metrics.ref ? { ref: metrics.ref } : {}),
      lastRunAt: metrics.lastRunAt,
      pipelines: metrics.pipelines,
      ...(metrics.median === undefined ? {} : { median: metrics.median }),
      ...(metrics.p90 === undefined ? {} : { p90: metrics.p90 }),
      ...(metrics.successRate === undefined ? {} : { successRate: metrics.successRate }),
      ...(metrics.change === undefined ? {} : { change: metrics.change }),
      weeks: metrics.weeks ?? [],
      problems: metrics.problems ?? 0,
      groups: [...targetOf(head.repo).groups],
      status: metrics.status,
      flakyJobs: metrics.flaky,
      ...(metrics.queue === undefined ? {} : { queueMedian: metrics.queue }),
    }
  }

  app.get('/ci', async (c) => {
    const principal = principalOf(c)
    const since = new Date(deps.now().getTime() - ACTIVE_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10)
    const heads = (await latestHeadsWithMetrics(store.analyses, kinds, { kind: KIND })).filter(
      (head) => canSee(principal, 'analyses:read', targetOf(head.repo)),
    )
    const cards = await cache.read(
      {
        endpoint: `ci?since=${since}`,
        analysisIds: heads.map((head) => head.id),
        repos: heads.map((head) => repoKey(head.repo)),
      },
      async () =>
        (await withCurrentMetrics(store.analyses, kind, heads, isCurrent))
          .flatMap((head) => cardOf(head, since) ?? [])
          .toSorted((a, b) => repoKey(a.repo).localeCompare(repoKey(b.repo))),
    )
    const gated = cards.filter((card) => canSee(principal, 'releases:read', targetOf(card.repo)))
    const entries = gated.length ? await store.settings.list(releaseSettingsKey) : []
    const gates = new Map(
      gated.flatMap((card) => {
        const settings = releaseSettings(
          resolveSetting(entries, releaseSettingsKey, targetOf(card.repo))?.value,
        )
        const branch = settings.flow.target ?? card.ref
        return settings.enabled && branch
          ? [[card.analysisId, { pipeline: settings.gates.pipeline, branch }]]
          : []
      }),
    )
    return c.json<CiOverview>({
      repos: cards.map((card) => {
        const gate = gates.get(card.analysisId)
        return gate ? { ...card, releaseGate: gate } : card
      }),
    })
  })

  app.get('/ci/repo', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    authorize(c, 'analyses:read', { kind: 'repo', repo: targetOf(repo) })
    const [record] = await store.analyses.latest({ repo, kind: KIND })
    const data = record ? readCiJobs(record.data) : undefined
    return c.json<CiRepoView>({
      repo,
      ...(record ? { analysisId: record.id, createdAt: record.createdAt } : {}),
      ...(data ? { data } : {}),
      problems: data ? problemJobs(data) : [],
      flags: Object.fromEntries(
        (data?.jobs ?? []).flatMap((job) => {
          const problems = jobProblems(job)
          return problems.length ? [[job.name, problems]] : []
        }),
      ),
    })
  })

  app.get('/ci/jobs/fleet', async (c) => {
    const principal = principalOf(c)
    const query = readQuery(c, fleetJobsQuery)
    const sort = query.sort ?? 'slowest'
    const limit = Math.min(query.limit ?? CI_JOBS_DEFAULT, CI_JOBS_MAX)
    const heads = (await latestHeadsWithMetrics(store.analyses, kinds, { kind: KIND })).filter(
      (head) => canSee(principal, 'analyses:read', targetOf(head.repo)),
    )
    const rows = await fleetJobs.read(
      {
        endpoint: 'ci/jobs/fleet',
        analysisIds: heads.map((head) => head.id),
        repos: heads.map((head) => repoKey(head.repo)),
      },
      async () => {
        const all: CiFleetJobRow[] = []
        for (const head of heads) {
          // oxlint-disable-next-line no-await-in-loop -- one record at a time keeps memory flat
          const data = readCiJobs((await store.analyses.get(head.id))?.data)
          if (!data) continue
          for (const row of ciJobTable(data, Number.POSITIVE_INFINITY).rows)
            all.push({ ...row, repo: head.repo })
        }
        return all
      },
    )
    const ranked = rankFleetJobs(rows, sort)
    return c.json<CiFleetJobsView>({
      sort,
      jobs: ranked.slice(0, limit),
      total: ranked.length,
      repos: heads.length,
    })
  })

  app.get('/ci/jobs', async (c) => {
    const repo = parseRepo(c.req.query('repo'))
    if (!repo) throw new HTTPException(400, { message: 'repo is required' })
    authorize(c, 'analyses:read', { kind: 'repo', repo: targetOf(repo) })
    const query = readQuery(c, jobsQuery)
    const limit = Math.min(query.limit ?? CI_JOBS_DEFAULT, CI_JOBS_MAX)
    const [head] = await store.analyses.latestHeads({ repo, kind: KIND })
    const data = head
      ? await records.read(
          { endpoint: `ci/jobs?repo=${repoKey(repo)}`, analysisIds: [head.id], repos: [] },
          async () => readCiJobs((await store.analyses.get(head.id))?.data),
        )
      : undefined
    if (!data) throw new HTTPException(404, { message: 'no CI record in the current format' })
    const table = ciJobTable(data, limit)
    return c.json<CiJobsView>({
      repo,
      range: { from: data.window.from, to: data.window.to },
      ...(data.options.branch ? { ref: data.options.branch } : {}),
      jobs: table.rows,
      total: table.total,
      outcomes: table.outcomes,
    })
  })

  return app
}
