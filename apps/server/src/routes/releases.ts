import type { ReleaseBackfillInput, ReleaseBackfillResult } from '@holtkeeper/api'
import { releaseTarget } from '@holtkeeper/changelog'
import type { RepoRef } from '@holtkeeper/forge'
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

const backfillSchema = z.object({
  repo: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  risk: z.boolean().default(false),
})

/**
 * Analyses of past releases: queues a changelog (and a risk assessment) per existing release, a
 * plain tag or a commit carrying package tags.
 */
export function releaseRoutes(deps: ServerDeps) {
  const { store, config } = deps
  const app = new Hono<Env>()
  const kinds = new Set((deps.analyzers ?? []).map((analyzer) => analyzer.kind))

  app.post('/releases/backfill', async (c) => {
    if (!config.jobs)
      throw new HTTPException(409, { message: 'jobs are not enabled in the config' })
    if (!kinds.has('changelog'))
      throw new HTTPException(409, { message: 'this server has no changelog analyzer' })
    const input: ReleaseBackfillInput = await readBody(c, backfillSchema)
    const limit = input.limit ?? 20
    const repo = parseRepo(input.repo)
    const principal = repo
      ? authorize(c, 'analyses:run', { kind: 'repo', repo: repoTarget(config, repo) })
      : authorize(c, 'analyses:run', GLOBAL)

    let repos: RepoRef[]
    if (repo) repos = [repo]
    else {
      const groups = input.group ? [input.group] : Object.keys(config.groups)
      if (input.group && !config.groups[input.group])
        throw new HTTPException(400, { message: `unknown group ${input.group}` })
      const resolve = groupRepositories(config)
      const found = new Map<string, RepoRef>()
      for (const group of groups)
        // oxlint-disable-next-line no-await-in-loop -- groups one after another keep forge limits
        for (const member of await resolve(group))
          found.set(`${member.forge}:${member.path}`, member)
      repos = [...found.values()]
    }

    const analyzers = [
      'changelog',
      ...(input.risk && kinds.has('release-risk') ? ['release-risk'] : []),
    ]
    const result: ReleaseBackfillResult = {
      repos: repos.length,
      tags: 0,
      queued: 0,
      skipped: 0,
      errors: [],
    }
    const at = deps.now().toISOString()
    for (const target of repos) {
      try {
        const forge = config.forges[target.forge]?.create()
        if (!forge?.listTags) throw new Error(`forge ${target.forge} cannot list tags`)
        // oxlint-disable-next-line no-await-in-loop -- one repository at a time keeps forge limits
        const tags = await forge.listTags(target.path, {
          limit: Math.min(limit * TAGS_PER_RELEASE, MAX_TAGS),
        })
        const releases = [...new Set(tags.map(releaseTarget))].slice(0, limit)
        // oxlint-disable-next-line no-await-in-loop -- see above
        const done = await store.analyses.list({ repo: target, kind: 'changelog', limit: 500 })
        const analyzed = new Set(done.flatMap((record) => (record.ref ? [record.ref] : [])))
        result.tags += releases.length
        const requests: JobRequest[] = releases
          .toReversed()
          .filter((release) => {
            if (!analyzed.has(release)) return true
            result.skipped += 1
            return false
          })
          .flatMap((release) =>
            analyzers.map((analyzer) => ({
              analyzer,
              repo: target,
              ref: release,
              trigger: 'manual' as const,
              actor: principal.id,
            })),
          )
        // oxlint-disable-next-line no-await-in-loop -- see above
        const { enqueued, skipped } = await enqueueUnique(store.jobs, requests, at)
        result.queued += enqueued.length
        result.skipped += skipped.filter((request) => request.analyzer === 'changelog').length
      } catch (error) {
        result.errors.push({
          repo: target,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    await store.activity.append({
      at,
      actor: principal.id,
      action: 'releases.backfill',
      ...(repo ? { subject: `${repo.forge}:${repo.path}` } : {}),
      details: {
        ...(input.group ? { group: input.group } : {}),
        limit,
        risk: analyzers.includes('release-risk'),
        repos: result.repos,
        queued: result.queued,
        skipped: result.skipped,
      },
    })
    return c.json<ReleaseBackfillResult>(result, 201)
  })

  return app
}
