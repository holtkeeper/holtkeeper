import type {
  ReleaseBackfillInput,
  ReleaseBackfillResult,
  ReleaseBackfillStarted,
} from '@holtkeeper/api'
import { releaseTarget } from '@holtkeeper/changelog'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import { type JobRequest, enqueueUnique, groupRepositories } from '@holtkeeper/jobs'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import {
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  readBody,
  repoTarget,
} from '../context.ts'

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
