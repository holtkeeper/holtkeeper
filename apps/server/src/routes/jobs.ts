import { type Principal, type RepoTarget, can, groupLineage } from '@holtkeeper/access'
import type {
  AgentTranscriptView,
  AnalyzerHealthList,
  Job,
  JobAnalyzerList,
  JobAnalyzerView,
  JobCountView,
  JobFailureList,
  JobList,
  JobLog,
  JobRunList,
  JobStats,
  JobTargetList,
  JobWhy,
} from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { readJobLog } from '@holtkeeper/jobs'
import type { JobSearch } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  authorizeRecord,
  limitParam,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { type CostReader, analyzerHealth, jobCosts, jobStats, waitHints } from '../job-stats.ts'
import { explainJob } from '../job-why.ts'
import { readTranscript } from '../transcripts.ts'
import { canSee } from '../visibility.ts'
import { peopleOf } from './avatars.ts'

const statusSchema = z
  .enum(['queued', 'running', 'succeeded', 'failed', 'blocked', 'canceled'])
  .optional()

const triggerSchema = z
  .enum([
    'schedule',
    'manual',
    'command',
    'webhook',
    'tag',
    'push',
    'poll',
    'new-repo',
    'freshness',
  ])
  .optional()

const MAX_SEARCH = 200

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/** `repos=forge:path,…` as refs; `undefined` when absent, 400 when an entry is malformed. */
function reposParam(value: string | undefined): RepoRef[] | undefined {
  if (value === undefined) return undefined
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const repo = parseRepo(entry)
      if (!repo) throw new HTTPException(400, { message: `repos: ${entry} is not forge:path` })
      return repo
    })
}

/** The requested repositories narrowed to the visible ones; `undefined` means no restriction. */
function narrowRepos(
  requested: RepoRef[] | undefined,
  visible: RepoRef[] | undefined,
): RepoRef[] | undefined {
  if (!visible) return requested
  if (!requested) return visible
  const keys = new Set(visible.map(keyOf))
  return requested.filter((repo) => keys.has(keyOf(repo)))
}

const createSchema = z.object({
  analyzer: z.string().min(1),
  repo: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
})

const DAY_MS = 86_400_000
const HEALTH_DAYS = 7

/** A non-negative integer query parameter; `undefined` when absent, 400 when malformed. */
function countParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new HTTPException(400, { message: `${name} must be a non-negative integer` })
  return parsed
}

/** Where jobs of each run-only analyzer are queued. */
const RUN_ONLY_ENDPOINTS: Record<string, string> = {
  guide: 'POST /api/guide/regenerate',
  'write-task': 'POST /api/task-groups',
}

/**
 * Analyzers whose options only their own endpoint sets for one run (`guide`: `/api/guide/regenerate`,
 * `write-task`: `/api/task-groups`), so they get no `analyzers.<kind>` setting and `POST /api/jobs`
 * refuses them.
 */
export const RUN_ONLY_ANALYZERS: ReadonlySet<string> = new Set(Object.keys(RUN_ONLY_ENDPOINTS))

/** The repository a job's permissions are checked on; group jobs count as their group. */
export const jobTarget = (
  config: ServerDeps['config'],
  job: { repo: RepoRef; group?: string },
): RepoTarget =>
  job.group !== undefined
    ? { ...job.repo, groups: groupLineage(job.group) }
    : repoTarget(config, job.repo)

/** The jobs whose agent cost `principal` may read: `ai:read` or `ai:admin` on the job's target. */
export function costReaderOf(config: ServerDeps['config'], principal: Principal): CostReader {
  const readsAi = principal.grants.some((grant) =>
    grant.actions.some((action) => action === '*' || action === 'ai:read' || action === 'ai:admin'),
  )
  if (!readsAi) return undefined
  return (job) => {
    const target = { kind: 'repo', repo: jobTarget(config, job) } as const
    return can(principal, 'ai:read', target) || can(principal, 'ai:admin', target)
  }
}

/**
 * Background analysis jobs: list (also the jobs that produced an analysis, `analysisId=`, with
 * wait hints for queued rows and agent cost per row), count, queue stats, group failures, health
 * per analyzer over seven days (`/jobs/analyzers/health`), inspect (log with steps, why it ran or
 * waits, agent runs), queue and cancel.
 * Lists, counts and stats only cover repositories (and groups) the caller may read; stats list
 * workers only for callers with `analyses:read` over everything. A job's agent runs
 * and transcripts (`/jobs/:id/runs`, `/jobs/:id/transcripts/:ref`) are readable by whoever may
 * read the job, and only transcripts its own runs recorded. Agent cost in lists and stats needs
 * `ai:read` or `ai:admin` on the job's target as well.
 */
export function jobRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const analyzers = new Map((deps.analyzers ?? []).map((analyzer) => [analyzer.kind, analyzer]))
  const analyzerViews: JobAnalyzerView[] = [...analyzers.values()].map((analyzer) => ({
    kind: analyzer.kind,
    label: analyzer.analysis?.label ?? analyzer.kind,
    scope: analyzer.scope,
    needs: analyzer.needs ?? {},
    ...(analyzer.exclusive && { exclusive: true }),
    ...(analyzer.refresh && { refresh: analyzer.refresh }),
    schema: z.toJSONSchema(analyzer.options, { unrepresentable: 'any', io: 'input' }),
    ...(analyzer.presets?.length && {
      presets: analyzer.presets.map(({ options, ...preset }) => ({ ...preset, value: options })),
    }),
  }))
  const app = new Hono<Env>()

  /** Repositories whose jobs the principal may read; `undefined` when it may read every job. */
  const visibleRepos = async (principal: Principal): Promise<RepoRef[] | undefined> => {
    if (can(principal, 'analyses:read', { kind: 'global' })) return undefined
    return (await store.jobs.targets())
      .filter((target) => canSee(principal, 'analyses:read', jobTarget(config, target)))
      .map((target) => target.repo)
  }

  const readable = async (c: AppContext, id: string) => {
    const job = await store.jobs.get(id)
    if (!job) throw new HTTPException(404, { message: 'job not found' })
    authorizeRecord(c, 'analyses:read', { kind: 'repo', repo: jobTarget(config, job) })
    return job
  }

  /** `q` as a job search that also matches analyzers whose label contains it. */
  const searchOf = (q: string | undefined): JobSearch | undefined => {
    const text = q?.trim()
    if (!text) return undefined
    if (text.length > MAX_SEARCH)
      throw new HTTPException(400, { message: `q must be at most ${MAX_SEARCH} characters` })
    const needle = text.toLowerCase()
    return {
      text,
      analyzers: analyzerViews
        .filter((view) => view.label.toLowerCase().includes(needle))
        .map((view) => view.kind),
    }
  }

  /** The filters `GET /jobs` and `GET /jobs/count` share, narrowed to what the caller may read. */
  const queryOf = async (c: AppContext) => {
    const parsedStatus = statusSchema.safeParse(c.req.query('status') || undefined)
    if (!parsedStatus.success) {
      throw new HTTPException(400, {
        message: `status must be one of ${statusSchema.unwrap().options.join(', ')}`,
      })
    }
    const status = parsedStatus.data
    const parsedTrigger = triggerSchema.safeParse(c.req.query('trigger') || undefined)
    if (!parsedTrigger.success)
      throw new HTTPException(400, {
        message: `trigger must be one of ${triggerSchema.unwrap().options.join(', ')}`,
      })
    const trigger = parsedTrigger.data
    const repo = parseRepo(c.req.query('repo'))
    const schedule = c.req.query('schedule')
    const analyzer = c.req.query('analyzer')
    const signature = c.req.query('signature')
    const analysisId = c.req.query('analysisId')
    const search = searchOf(c.req.query('q'))
    const repos = narrowRepos(reposParam(c.req.query('repos')), await visibleRepos(principalOf(c)))
    return {
      ...(analyzer ? { analyzer } : {}),
      ...(status ? { status } : {}),
      ...(trigger ? { trigger } : {}),
      ...(repo ? { repo } : {}),
      ...(schedule ? { schedule } : {}),
      ...(signature ? { errorSignature: signature } : {}),
      ...(analysisId ? { analysisId } : {}),
      ...(search && { search }),
      ...(repos && { repos }),
    }
  }

  app.get('/jobs', async (c) => {
    const before = c.req.query('before')
    const jobs = await store.jobs.list({
      ...(await queryOf(c)),
      ...(before ? { before } : {}),
      limit: limitParam(c.req.query('limit')),
    })
    const [people, hints, costs] = await Promise.all([
      peopleOf(
        deps,
        jobs.flatMap((job) => (job.actor ? [job.actor] : [])),
      ),
      waitHints(deps, jobs),
      jobCosts(deps, jobs, costReaderOf(config, principalOf(c))),
    ])
    return c.json<JobList>({ jobs, people, waitHints: hints, costs })
  })

  app.get('/jobs/stats', async (c) => {
    const principal = principalOf(c)
    const global = can(principal, 'analyses:read', { kind: 'global' })
    const repos = narrowRepos(reposParam(c.req.query('repos')), await visibleRepos(principal))
    return c.json<JobStats>(await jobStats(deps, repos, global, costReaderOf(config, principal)))
  })

  app.get('/jobs/count', async (c) => {
    const since = c.req.query('since')
    const at = since ? Date.parse(since) : undefined
    if (at !== undefined && Number.isNaN(at))
      throw new HTTPException(400, { message: 'since must be a date' })
    const counts = await store.jobs.count({
      ...(await queryOf(c)),
      ...(at !== undefined && { since: new Date(at).toISOString() }),
    })
    return c.json<JobCountView>(counts)
  })

  app.get('/jobs/targets', async (c) => {
    const principal = principalOf(c)
    const all = can(principal, 'analyses:read', { kind: 'global' })
    const targets = (await store.jobs.targets()).flatMap((target) => {
      const scoped = jobTarget(config, target)
      if (!all && !canSee(principal, 'analyses:read', scoped)) return []
      return [
        {
          repo: keyOf(target.repo),
          ...(target.group !== undefined && { group: target.group }),
          groups: scoped.groups,
        },
      ]
    })
    targets.sort((a, b) => a.repo.localeCompare(b.repo))
    return c.json<JobTargetList>({ targets })
  })

  app.get('/jobs/failures', async (c) => {
    const principal = principalOf(c)
    const days = Math.min(countParam(c.req.query('days'), 'days') ?? 7, 90)
    const analyzer = c.req.query('analyzer')
    const repos = narrowRepos(reposParam(c.req.query('repos')), await visibleRepos(principal))
    const failures = await store.jobs.failures({
      since: new Date(deps.now().getTime() - days * DAY_MS).toISOString(),
      ...(analyzer ? { analyzer } : {}),
      ...(repos && { repos }),
      limit: limitParam(c.req.query('limit')),
    })
    return c.json<JobFailureList>({ failures })
  })

  app.get('/jobs/analyzers', (c) => {
    principalOf(c)
    return c.json<JobAnalyzerList>({ analyzers: analyzerViews })
  })

  app.get('/jobs/analyzers/health', async (c) => {
    const principal = principalOf(c)
    const repos = await visibleRepos(principal)
    return c.json<AnalyzerHealthList>(
      await analyzerHealth(deps, [...analyzers.keys()], repos, HEALTH_DAYS),
    )
  })

  app.get('/jobs/:id', async (c) => c.json<Job>(await readable(c, c.req.param('id'))))

  app.get('/jobs/:id/log', async (c) => {
    const job = await readable(c, c.req.param('id'))
    const attempt = countParam(c.req.query('attempt'), 'attempt') ?? job.attempts
    if (attempt > job.attempts || (attempt === 0 && job.attempts > 0))
      throw new HTTPException(404, { message: `job has no attempt ${attempt}` })
    const offset = countParam(c.req.query('offset'), 'offset')
    const limit = countParam(c.req.query('limit'), 'limit')
    const tail = countParam(c.req.query('tail'), 'tail')
    const page =
      attempt && deps.artifacts
        ? await readJobLog(deps.artifacts, job.id, attempt, {
            ...(offset !== undefined && { offset }),
            ...(limit !== undefined && { limit }),
            ...(tail !== undefined && { tail }),
          })
        : { total: 0, offset: 0, lines: [], complete: false, steps: [] }
    return c.json<JobLog>({ ...page, attempt, attempts: job.attempts })
  })

  app.get('/jobs/:id/why', async (c) => {
    const job = await readable(c, c.req.param('id'))
    const why = await explainJob(deps, job)
    return c.json<JobWhy>({
      ...why,
      people: job.actor ? await peopleOf(deps, [job.actor]) : {},
    })
  })

  const jobRuns = (jobId: string) => store.aiUsage.list({ jobId, limit: 200 })

  app.get('/jobs/:id/runs', async (c) => {
    const job = await readable(c, c.req.param('id'))
    const runs = await jobRuns(job.id)
    return c.json<JobRunList>({
      runs,
      costUsd: runs.reduce((sum, run) => sum + run.costUsd, 0),
    })
  })

  app.get('/jobs/:id/transcripts/:ref', async (c) => {
    const job = await readable(c, c.req.param('id'))
    const ref = c.req.param('ref')
    const owned = (await jobRuns(job.id)).some((run) => run.transcriptRef === ref)
    const lines = owned && deps.artifacts ? await readTranscript(deps.artifacts, ref) : undefined
    if (!lines) throw new HTTPException(404, { message: 'transcript not found' })
    return c.json<AgentTranscriptView>({ ref, lines })
  })

  app.post('/jobs', async (c) => {
    const input = await readBody(c, createSchema)
    const analyzer = analyzers.get(input.analyzer)
    if (!analyzer) throw new HTTPException(400, { message: `unknown analyzer ${input.analyzer}` })
    if (RUN_ONLY_ANALYZERS.has(analyzer.kind))
      throw new HTTPException(400, {
        message: `${analyzer.kind} jobs are queued through ${RUN_ONLY_ENDPOINTS[analyzer.kind]}`,
      })

    let target: { repo: RepoRef; group?: string }
    if (analyzer.scope === 'group') {
      if (!input.group || input.repo)
        throw new HTTPException(400, {
          message: `${analyzer.kind} runs on a group: pass group, not repo`,
        })
      const group = config.groups[input.group]
      if (!group) throw new HTTPException(400, { message: `unknown group ${input.group}` })
      target = { repo: { forge: group.forge, path: input.group }, group: input.group }
    } else {
      if (!input.repo || input.group)
        throw new HTTPException(400, {
          message: `${analyzer.kind} runs on a repository: pass repo, not group`,
        })
      const repo = parseRepo(input.repo)
      if (!repo) throw new HTTPException(400, { message: 'repo is required' })
      target = { repo }
    }
    if (!(target.repo.forge in config.forges)) {
      throw new HTTPException(400, { message: `forge ${target.repo.forge} is not configured` })
    }
    const principal = authorize(c, 'analyses:run', {
      kind: 'repo',
      repo: jobTarget(config, target),
    })
    const parsed = analyzer.options.safeParse(input.options ?? {})
    if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) })

    const now = deps.now().toISOString()
    const job = await store.jobs.enqueue({
      analyzer: analyzer.kind,
      ...target,
      ...(input.ref ? { ref: input.ref } : {}),
      options: input.options ?? {},
      trigger: 'manual',
      createdAt: now,
      actor: principal.id,
    })
    c.set('audit', {
      action: 'job.create',
      target: { type: 'job', id: job.id, repo: `${job.repo.forge}:${job.repo.path}` },
      details: { analyzer: job.analyzer, ...(job.ref ? { ref: job.ref } : {}) },
    })
    return c.json<Job>(job, 201)
  })

  app.post('/jobs/:id/cancel', async (c) => {
    const existing = await readable(c, c.req.param('id'))
    authorizeRecord(c, 'analyses:run', {
      kind: 'repo',
      repo: jobTarget(config, existing),
    })
    if (existing.status !== 'queued' && existing.status !== 'running') {
      throw new HTTPException(409, { message: `job is already ${existing.status}` })
    }
    const now = deps.now().toISOString()
    const job = await store.jobs.cancel(existing.id, now)
    if (!job) throw new HTTPException(404, { message: 'job not found' })
    c.set('audit', {
      action: 'job.cancel',
      target: { type: 'job', id: job.id, repo: `${job.repo.forge}:${job.repo.path}` },
      details: { analyzer: job.analyzer },
    })
    return c.json<Job>(job)
  })

  return app
}
