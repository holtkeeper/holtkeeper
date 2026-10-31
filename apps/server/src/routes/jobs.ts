import type { RepoTarget } from '@holtkeeper/access'
import type { Job, JobAnalyzerList, JobAnalyzerView, JobList, JobSummary } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  limitParam,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { canSee } from '../visibility.ts'

const statusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']).optional()

const createSchema = z.object({
  analyzer: z.string().min(1),
  repo: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
})

const summary = ({ log: _log, ...job }: Job): JobSummary => job

/** The repository a job's permissions are checked on; group jobs count as their group. */
export const jobTarget = (
  config: ServerDeps['config'],
  job: { repo: RepoRef; group?: string },
): RepoTarget =>
  job.group !== undefined ? { ...job.repo, groups: [job.group] } : repoTarget(config, job.repo)

/** Background analysis jobs: list, inspect, queue and cancel. */
export function jobRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const analyzers = new Map((deps.analyzers ?? []).map((analyzer) => [analyzer.kind, analyzer]))
  const analyzerViews: JobAnalyzerView[] = [...analyzers.values()].map((analyzer) => ({
    kind: analyzer.kind,
    label: analyzer.analysis?.label ?? analyzer.kind,
    scope: analyzer.scope,
    needs: analyzer.needs ?? {},
    schema: z.toJSONSchema(analyzer.options, { unrepresentable: 'any', io: 'input' }),
    ...(analyzer.presets?.length && {
      presets: analyzer.presets.map(({ options, ...preset }) => ({ ...preset, value: options })),
    }),
  }))
  const app = new Hono<Env>()

  const readable = async (c: AppContext, id: string) => {
    const job = await store.jobs.get(id)
    if (!job) throw new HTTPException(404, { message: 'job not found' })
    authorize(c, 'analyses:read', { kind: 'repo', repo: jobTarget(config, job) })
    return job
  }

  app.get('/jobs', async (c) => {
    const principal = principalOf(c)
    const parsedStatus = statusSchema.safeParse(c.req.query('status') || undefined)
    if (!parsedStatus.success) {
      throw new HTTPException(400, {
        message: `status must be one of ${statusSchema.unwrap().options.join(', ')}`,
      })
    }
    const status = parsedStatus.data
    const repo = parseRepo(c.req.query('repo'))
    const before = c.req.query('before')
    const schedule = c.req.query('schedule')
    const analyzer = c.req.query('analyzer')
    const jobs = await store.jobs.list({
      ...(analyzer ? { analyzer } : {}),
      ...(status ? { status } : {}),
      ...(repo ? { repo } : {}),
      ...(schedule ? { schedule } : {}),
      ...(before ? { before } : {}),
      limit: limitParam(c.req.query('limit')),
    })
    const visible = jobs.filter((job) => canSee(principal, 'analyses:read', jobTarget(config, job)))
    return c.json<JobList>({ jobs: visible.map(summary) })
  })

  app.get('/jobs/analyzers', (c) => {
    principalOf(c)
    return c.json<JobAnalyzerList>({ enabled: config.jobs !== undefined, analyzers: analyzerViews })
  })

  app.get('/jobs/:id', async (c) => c.json<Job>(await readable(c, c.req.param('id'))))

  app.post('/jobs', async (c) => {
    if (!config.jobs)
      throw new HTTPException(409, { message: 'jobs are not enabled in the config' })
    const input = await readBody(c, createSchema)
    const analyzer = analyzers.get(input.analyzer)
    if (!analyzer) throw new HTTPException(400, { message: `unknown analyzer ${input.analyzer}` })

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
    await store.activity.append({
      at: now,
      actor: principal.id,
      action: 'job.created',
      subject: `${job.repo.forge}:${job.repo.path}`,
      details: { id: job.id, analyzer: job.analyzer, ...(job.ref ? { ref: job.ref } : {}) },
    })
    return c.json<Job>(job, 201)
  })

  app.post('/jobs/:id/cancel', async (c) => {
    const existing = await readable(c, c.req.param('id'))
    const principal = authorize(c, 'analyses:run', {
      kind: 'repo',
      repo: jobTarget(config, existing),
    })
    if (existing.status !== 'queued' && existing.status !== 'running') {
      throw new HTTPException(409, { message: `job is already ${existing.status}` })
    }
    const now = deps.now().toISOString()
    const job = await store.jobs.cancel(existing.id, now)
    if (!job) throw new HTTPException(404, { message: 'job not found' })
    await store.activity.append({
      at: now,
      actor: principal.id,
      action: 'job.canceled',
      subject: `${job.repo.forge}:${job.repo.path}`,
      details: { id: job.id, analyzer: job.analyzer },
    })
    return c.json<Job>(job)
  })

  return app
}
