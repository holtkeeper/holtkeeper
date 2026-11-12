import type {
  ReleaseAcceptInput,
  ReleaseDeployInput,
  ReleaseDetectView,
  ReleaseDismissInput,
  ReleaseEditsInput,
  ReleaseGateError,
  ReleaseOverview,
  ReleaseRepoView,
  ReleaseStepInput,
  ReleaseStepResult,
  ReleaseSummaryInput,
  ReleaseTimelineView,
  ReleaseVersionDetailView,
  DeployState,
} from '@holtkeeper/api'
import { type RepoRef, ReadOnlyRepositoryError } from '@holtkeeper/forge'
import {
  DeployError,
  GateError,
  UnsupportedForgeError,
  type ReleaseActor,
  releaseEditsSchema,
} from '@holtkeeper/release'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { viaOf } from '../audit.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
  ForbiddenException,
  repoKey,
} from '../context.ts'
import { releaseServiceFor } from '../releases.ts'

const step = z.enum(['propose', 'version'])

const editsSchema = z.object({
  repo: z.string().min(1),
  step,
  edits: releaseEditsSchema.omit({ updatedAt: true, updatedBy: true }).nullable(),
})
const summarySchema = z.object({ repo: z.string().min(1), step })
const stepSchema = z.object({
  repo: z.string().min(1),
  force: z.boolean().optional(),
  writeNotes: z.boolean().optional(),
})
const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(30).optional(),
})
const acceptSchema = z.object({ repo: z.string().min(1), note: z.string().max(500).optional() })
const dismissSchema = z.object({
  repo: z.string().min(1).max(600),
  sha: z.string().min(1).max(64),
})
const deploySchema = z.object({
  repo: z.string().min(1),
  tag: z.string().min(1),
  environment: z.string().min(1),
  redeploy: z.boolean().optional(),
  force: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
})
const requireRepo = (value: string | undefined) => {
  const repo = parseRepo(value)
  if (!repo) throw new HTTPException(400, { message: 'repo is required' })
  return repo
}

/**
 * Answers refused steps with 409 and their gates, writes to a read-only repository with a 403
 * `ForbiddenError` and other step failures with 409.
 */
function stepError(c: AppContext, error: unknown, repo: RepoRef) {
  if (error instanceof HTTPException) throw error
  if (error instanceof GateError)
    return c.json<ReleaseGateError>({ error: error.message, gates: error.gates }, 409)
  if (error instanceof ReadOnlyRepositoryError)
    throw new ForbiddenException('releases:run', repoKey(repo), error.message)
  if (
    error instanceof DeployError ||
    error instanceof UnsupportedForgeError ||
    error instanceof Error
  )
    return c.json<ReleaseGateError>({ error: error.message }, 409)
  throw error
}

/**
 * The release assistant: the overview, each repository's version timeline and next-version plans,
 * the flow suggested for a repository (read on demand), and the steps that act on them. Reads need
 * `releases:read` on the repository, steps
 * `releases:run` and a repository Holtkeeper may write to. Dismissing a waiting release needs
 * `releases:run` only, since it writes nothing to the forge.
 */
export function releaseRoutes(deps: ServerDeps) {
  const { config } = deps
  const app = new Hono<Env>()

  const releases = releaseServiceFor(deps)

  const runnable = async (c: AppContext, repo: RepoRef): Promise<ReleaseActor> => {
    const principal = authorize(c, 'releases:run', { kind: 'repo', repo: repoTarget(config, repo) })
    if (await releases.isReadOnly(repo))
      throw new ForbiddenException(
        'releases:run',
        repoKey(repo),
        `${repo.path} is read-only for Holtkeeper`,
      )
    return { id: principal.id, name: principal.name, channel: viaOf(c, c.req.path) }
  }

  app.get('/releases/overview', async (c) => {
    const principal = principalOf(c)
    const group = c.req.query('group')
    if (group && !config.groups[group])
      throw new HTTPException(400, { message: `unknown group ${group}` })
    const filter = c.req.query('filter') ?? 'all'
    if (filter !== 'all' && filter !== 'action')
      throw new HTTPException(400, { message: 'filter is action or all' })
    return c.json<ReleaseOverview>(
      await releases.overview(principal, {
        ...(group ? { group } : {}),
        refresh: c.req.query('refresh') === '1',
        action: filter === 'action',
      }),
    )
  })

  app.get('/releases/timeline', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    const principal = authorize(c, 'releases:read', {
      kind: 'repo',
      repo: repoTarget(config, repo),
    })
    const page = pageSchema.safeParse({
      offset: c.req.query('offset'),
      limit: c.req.query('limit'),
    })
    if (!page.success) throw new HTTPException(400, { message: 'offset or limit is invalid' })
    try {
      return c.json<ReleaseTimelineView>(
        await releases.timeline(principal, repo, {
          ...(page.data.offset !== undefined ? { offset: page.data.offset } : {}),
          ...(page.data.limit !== undefined ? { limit: page.data.limit } : {}),
        }),
      )
    } catch (error) {
      return stepError(c, error, repo)
    }
  })

  app.get('/releases/version', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    authorize(c, 'releases:read', { kind: 'repo', repo: repoTarget(config, repo) })
    const tag = c.req.query('tag')
    if (!tag) throw new HTTPException(400, { message: 'tag is required' })
    let detail: ReleaseVersionDetailView | undefined
    try {
      detail = await releases.versionOf(repo, tag)
    } catch (error) {
      return stepError(c, error, repo)
    }
    if (!detail)
      throw new HTTPException(404, { message: `${tag} is not a version of ${repo.path}` })
    return c.json<ReleaseVersionDetailView>(detail)
  })

  app.get('/releases/repo', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    const principal = authorize(c, 'releases:read', {
      kind: 'repo',
      repo: repoTarget(config, repo),
    })
    try {
      return c.json<ReleaseRepoView>(await releases.view(principal, repo))
    } catch (error) {
      return stepError(c, error, repo)
    }
  })

  app.get('/releases/detect', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    authorize(c, 'releases:read', { kind: 'repo', repo: repoTarget(config, repo) })
    if (!config.forges[repo.forge])
      throw new HTTPException(404, { message: `forge ${repo.forge} is not configured` })
    try {
      return c.json<ReleaseDetectView>(await releases.detect(repo))
    } catch (error) {
      return stepError(c, error, repo)
    }
  })

  app.get('/releases/deploy', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    authorize(c, 'releases:read', { kind: 'repo', repo: repoTarget(config, repo) })
    const tag = c.req.query('tag')
    if (!tag) throw new HTTPException(400, { message: 'tag is required' })
    try {
      return c.json<DeployState>(await releases.deployOf(repo, tag))
    } catch (error) {
      return stepError(c, error, repo)
    }
  })

  app.put('/releases/edits', async (c) => {
    const input: ReleaseEditsInput = await readBody(c, editsSchema)
    const repo = requireRepo(input.repo)
    const actor = await runnable(c, repo)
    await releases.saveEdits(repo, input.step, input.edits, actor)
    return c.json({ ok: true })
  })

  app.post('/releases/summary', async (c) => {
    const input: ReleaseSummaryInput = await readBody(c, summarySchema)
    const repo = requireRepo(input.repo)
    const actor = await runnable(c, repo)
    try {
      return c.json({ markdown: await releases.summarize(repo, input.step, actor) })
    } catch (error) {
      return stepError(c, error, repo)
    }
  })

  for (const name of ['propose', 'version'] as const)
    app.post(`/releases/${name}`, async (c) => {
      const input: ReleaseStepInput = await readBody(c, stepSchema)
      const repo = requireRepo(input.repo)
      const actor = await runnable(c, repo)
      try {
        return c.json<ReleaseStepResult>(
          name === 'propose'
            ? await releases.propose(repo, actor, input.force, input.writeNotes)
            : await releases.version(repo, actor, input.force),
        )
      } catch (error) {
        return stepError(c, error, repo)
      }
    })

  app.post('/releases/accept', async (c) => {
    const input: ReleaseAcceptInput = await readBody(c, acceptSchema)
    const repo = requireRepo(input.repo)
    const actor = await runnable(c, repo)
    try {
      return c.json<ReleaseStepResult>(await releases.accept(repo, actor, input.note))
    } catch (error) {
      return stepError(c, error, repo)
    }
  })

  app.delete('/releases/accept', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    await runnable(c, repo)
    await releases.withdraw(repo)
    return c.json({ ok: true })
  })

  app.post('/releases/dismiss', async (c) => {
    const input: ReleaseDismissInput = await readBody(c, dismissSchema)
    const repo = requireRepo(input.repo)
    const principal = authorize(c, 'releases:run', {
      kind: 'repo',
      repo: repoTarget(config, repo),
    })
    const result = await releases.dismiss(repo, input.sha, principal.id)
    if (result.kind === 'moved')
      return c.json(
        {
          error: result.head
            ? `${repo.path} moved to ${result.head.slice(0, 8)} since`
            : `nothing waits in ${repo.path}`,
        },
        409,
      )
    c.set('audit', {
      action: 'release.dismiss',
      target: { type: 'release', repo: repoKey(repo) },
      details: { sha: input.sha },
    })
    return c.json({ ok: true })
  })

  app.post('/releases/deploy', async (c) => {
    const input: ReleaseDeployInput = await readBody(c, deploySchema)
    const repo = requireRepo(input.repo)
    const actor = await runnable(c, repo)
    try {
      return c.json<ReleaseStepResult>(
        await releases.deploy(
          repo,
          {
            tag: input.tag,
            environment: input.environment,
            ...(input.redeploy ? { redeploy: true } : {}),
            ...(input.force ? { force: true } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          },
          actor,
        ),
      )
    } catch (error) {
      return stepError(c, error, repo)
    }
  })

  return app
}
