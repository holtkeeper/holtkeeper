import type {
  ReleaseAcceptInput,
  ReleaseBackfillInput,
  ReleaseBackfillResult,
  ReleaseBackfillStarted,
  ReleaseBatchInput,
  ReleaseBatchResult,
  ReleaseBoardView,
  ReleaseDeployInput,
  ReleaseEditsInput,
  ReleaseGateError,
  ReleaseRepoView,
  ReleaseStepInput,
  ReleaseStepResult,
  ReleaseSummaryInput,
  DeployState,
} from '@holtkeeper/api'
import { releaseTarget } from '@holtkeeper/changelog'
import { type GitForge, type RepoRef, ReadOnlyRepositoryError } from '@holtkeeper/forge'
import { type JobRequest, enqueueUnique, groupRepositories } from '@holtkeeper/jobs'
import {
  DeployError,
  GateError,
  UnsupportedForgeError,
  releaseEditsSchema,
} from '@holtkeeper/release'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { releaseServiceFor } from '../releases.ts'

const GLOBAL = { kind: 'global' } as const

/** Monorepos tag every package a release publishes; enough tags to still find `limit` releases. */
const TAGS_PER_RELEASE = 10
const MAX_TAGS = 1000

type ListTags = NonNullable<GitForge['listTags']>

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const emptySnapshot = z.object({ packages: z.array(z.unknown()).length(0) })

/** Snapshots the extractor once read empty; a backfill retakes them instead of skipping. */
const settled: Record<string, (data: unknown) => boolean> = {
  'api-surface': (data) => !emptySnapshot.safeParse(data).success,
}

const releasesOf = (tags: { name: string; sha: string }[]) => [...new Set(tags.map(releaseTarget))]

/**
 * The newest `limit` releases. Lists `limit` tags first and lists more only when they hold fewer
 * releases because commits carry several package tags, so plain repositories cost one call.
 */
async function newestReleases(listTags: ListTags, repo: string, limit: number) {
  const first = await listTags(repo, { limit })
  const releases = releasesOf(first)
  if (first.length < limit || releases.length >= limit) return releases.slice(0, limit)
  const more = await listTags(repo, { limit: Math.min(limit * TAGS_PER_RELEASE, MAX_TAGS) })
  return releasesOf(more).slice(0, limit)
}

const backfillSchema = z.object({
  repo: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  risk: z.boolean().default(false),
  api: z.boolean().default(false),
  bundle: z.boolean().default(false),
})

const step = z.enum(['propose', 'version'])

const editsSchema = z.object({
  repo: z.string().min(1),
  step,
  edits: releaseEditsSchema.omit({ updatedAt: true, updatedBy: true }).nullable(),
})
const summarySchema = z.object({ repo: z.string().min(1), step })
const stepSchema = z.object({ repo: z.string().min(1), force: z.boolean().optional() })
const acceptSchema = z.object({ repo: z.string().min(1), note: z.string().max(500).optional() })
const deploySchema = z.object({
  repo: z.string().min(1),
  tag: z.string().min(1),
  environment: z.string().min(1),
  redeploy: z.boolean().optional(),
  force: z.boolean().optional(),
})
const batchSchema = z.object({
  repos: z.array(z.string().min(1)).min(1).max(100),
  step,
  force: z.boolean().optional(),
})

const requireRepo = (value: string | undefined) => {
  const repo = parseRepo(value)
  if (!repo) throw new HTTPException(400, { message: 'repo is required' })
  return repo
}

/** Answers refused steps with 409 and their gates, other step failures with 409 or 403. */
function stepError(c: AppContext, error: unknown) {
  if (error instanceof HTTPException) throw error
  if (error instanceof GateError)
    return c.json<ReleaseGateError>({ error: error.message, gates: error.gates }, 409)
  if (error instanceof ReadOnlyRepositoryError)
    return c.json<ReleaseGateError>({ error: error.message }, 403)
  if (
    error instanceof DeployError ||
    error instanceof UnsupportedForgeError ||
    error instanceof Error
  )
    return c.json<ReleaseGateError>({ error: error.message }, 409)
  throw error
}

interface BackfillRun {
  repo?: RepoRef | undefined
  group?: string | undefined
  limit: number
  analyzers: string[]
  actor: string
  at: string
}

/**
 * Analyses of past releases: queues a changelog (and a risk assessment, a public API snapshot,
 * bundle sizes) per existing release, a plain tag or a commit carrying package tags. Listing tags is slow on large forges, so the
 * request only validates and the repositories are walked in the background.
 */
export function releaseRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const kinds = new Set((deps.analyzers ?? []).map((analyzer) => analyzer.kind))

  const repositories = async ({ repo, group }: BackfillRun) => {
    if (repo) return [repo]
    const resolve = groupRepositories(config)
    const found = new Map<string, RepoRef>()
    for (const name of group ? [group] : Object.keys(config.groups))
      // oxlint-disable-next-line no-await-in-loop -- groups one after another keep forge limits
      for (const member of await resolve(name)) found.set(`${member.forge}:${member.path}`, member)
    return [...found.values()]
  }

  const backfillRepo = async (run: BackfillRun, target: RepoRef, result: ReleaseBackfillResult) => {
    const forge = config.forges[target.forge]?.create()
    if (!forge?.listTags) throw new Error(`forge ${target.forge} cannot list tags`)
    const releases = await newestReleases(forge.listTags.bind(forge), target.path, run.limit)
    result.tags += releases.length
    const analyzed = new Map(
      await Promise.all(
        run.analyzers.map(async (analyzer) => {
          const done = await store.analyses.list({ repo: target, kind: analyzer, limit: 500 })
          const kept = settled[analyzer]
          const refs = done.flatMap((record) =>
            record.ref && (!kept || kept(record.data)) ? [record.ref] : [],
          )
          return [analyzer, new Set(refs)] as const
        }),
      ),
    )
    const requests: JobRequest[] = releases.toReversed().flatMap((release) =>
      run.analyzers.flatMap((analyzer) => {
        if (analyzed.get(analyzer)?.has(release)) {
          result.skipped += 1
          return []
        }
        return [
          { analyzer, repo: target, ref: release, trigger: 'manual' as const, actor: run.actor },
        ]
      }),
    )
    const { enqueued, skipped } = await enqueueUnique(store.jobs, requests, run.at)
    result.queued += enqueued.length
    result.skipped += skipped.length
  }

  const backfill = async (run: BackfillRun) => {
    const result: ReleaseBackfillResult = { repos: 0, tags: 0, queued: 0, skipped: 0, errors: [] }
    try {
      const repos = await repositories(run)
      result.repos = repos.length
      for (const target of repos) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one repository at a time keeps forge limits
          await backfillRepo(run, target, result)
        } catch (error) {
          result.errors.push({ repo: target, error: messageOf(error) })
        }
      }
    } catch (error) {
      result.errors.push({ ...(run.repo ? { repo: run.repo } : {}), error: messageOf(error) })
    }
    await store.activity.append({
      at: deps.now().toISOString(),
      actor: run.actor,
      action: 'releases.backfill',
      ...(run.repo ? { subject: `${run.repo.forge}:${run.repo.path}` } : {}),
      details: {
        ...(run.group ? { group: run.group } : {}),
        limit: run.limit,
        risk: run.analyzers.includes('release-risk'),
        api: run.analyzers.includes('api-surface'),
        bundle: run.analyzers.includes('bundle'),
        repos: result.repos,
        releases: result.tags,
        queued: result.queued,
        skipped: result.skipped,
        ...(result.errors.length ? { errors: result.errors } : {}),
      },
    })
    return result
  }

  const releases = releaseServiceFor(deps)

  const runnable = async (c: AppContext, repo: RepoRef) => {
    const principal = authorize(c, 'releases:run', { kind: 'repo', repo: repoTarget(config, repo) })
    if (await releases.isReadOnly(repo))
      throw new HTTPException(403, { message: `${repo.path} is read-only for Holtkeeper` })
    return principal
  }

  app.get('/releases/board', async (c) => {
    const principal = principalOf(c)
    const repo = parseRepo(c.req.query('repo'))
    const group = c.req.query('group')
    if (group && !config.groups[group])
      throw new HTTPException(400, { message: `unknown group ${group}` })
    return c.json<ReleaseBoardView>(
      await releases.board(principal, {
        ...(repo ? { repo } : {}),
        ...(group ? { group } : {}),
        refresh: c.req.query('refresh') === '1',
      }),
    )
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
      return stepError(c, error)
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
      return stepError(c, error)
    }
  })

  app.put('/releases/edits', async (c) => {
    const input: ReleaseEditsInput = await readBody(c, editsSchema)
    const repo = requireRepo(input.repo)
    const principal = await runnable(c, repo)
    await releases.saveEdits(repo, input.step, input.edits, principal.id)
    return c.json({ ok: true })
  })

  app.post('/releases/summary', async (c) => {
    const input: ReleaseSummaryInput = await readBody(c, summarySchema)
    const repo = requireRepo(input.repo)
    const principal = await runnable(c, repo)
    try {
      return c.json({ markdown: await releases.summarize(repo, input.step, principal.id) })
    } catch (error) {
      return stepError(c, error)
    }
  })

  for (const name of ['propose', 'version'] as const)
    app.post(`/releases/${name}`, async (c) => {
      const input: ReleaseStepInput = await readBody(c, stepSchema)
      const repo = requireRepo(input.repo)
      const principal = await runnable(c, repo)
      try {
        return c.json<ReleaseStepResult>(await releases[name](repo, principal.id, input.force))
      } catch (error) {
        return stepError(c, error)
      }
    })

  app.post('/releases/accept', async (c) => {
    const input: ReleaseAcceptInput = await readBody(c, acceptSchema)
    const repo = requireRepo(input.repo)
    const principal = await runnable(c, repo)
    try {
      return c.json<ReleaseStepResult>(await releases.accept(repo, principal.id, input.note))
    } catch (error) {
      return stepError(c, error)
    }
  })

  app.delete('/releases/accept', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    const principal = await runnable(c, repo)
    await releases.withdraw(repo, principal.id)
    return c.json({ ok: true })
  })

  app.post('/releases/deploy', async (c) => {
    const input: ReleaseDeployInput = await readBody(c, deploySchema)
    const repo = requireRepo(input.repo)
    const principal = await runnable(c, repo)
    try {
      return c.json<ReleaseStepResult>(
        await releases.deploy(
          repo,
          {
            tag: input.tag,
            environment: input.environment,
            ...(input.redeploy ? { redeploy: true } : {}),
            ...(input.force ? { force: true } : {}),
          },
          principal.id,
        ),
      )
    } catch (error) {
      return stepError(c, error)
    }
  })

  app.post('/releases/batch', async (c) => {
    const input: ReleaseBatchInput = await readBody(c, batchSchema)
    const results: ReleaseBatchResult['results'] = []
    for (const key of input.repos) {
      try {
        const repo = requireRepo(key)
        // oxlint-disable-next-line no-await-in-loop -- one repository at a time keeps forge limits
        const principal = await runnable(c, repo)
        // oxlint-disable-next-line no-await-in-loop -- same
        const result = await releases[input.step](repo, principal.id, input.force)
        results.push({ repo: key, ok: true, result })
      } catch (error) {
        results.push({
          repo: key,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return c.json<ReleaseBatchResult>({ results })
  })

  app.post('/releases/backfill', async (c) => {
    if (!config.jobs)
      throw new HTTPException(409, { message: 'jobs are not enabled in the config' })
    if (!kinds.has('changelog'))
      throw new HTTPException(409, { message: 'this server has no changelog analyzer' })
    const input: ReleaseBackfillInput = await readBody(c, backfillSchema)
    const repo = parseRepo(input.repo)
    const principal = repo
      ? authorize(c, 'analyses:run', { kind: 'repo', repo: repoTarget(config, repo) })
      : authorize(c, 'analyses:run', GLOBAL)
    if (!repo && input.group && !config.groups[input.group])
      throw new HTTPException(400, { message: `unknown group ${input.group}` })

    const startedAt = deps.now().toISOString()
    const done = backfill({
      repo,
      group: repo ? undefined : input.group,
      limit: input.limit ?? 20,
      analyzers: [
        'changelog',
        ...(input.risk && kinds.has('release-risk') ? ['release-risk'] : []),
        ...(input.api && kinds.has('api-surface') ? ['api-surface'] : []),
        ...(input.bundle && kinds.has('bundle') ? ['bundle'] : []),
      ],
      actor: principal.id,
      at: startedAt,
    }).catch((error: unknown) => console.error('releases: backfill failed', error))
    deps.onBackground?.(done)
    return c.json<ReleaseBackfillStarted>({ startedAt }, 202)
  })

  return app
}
