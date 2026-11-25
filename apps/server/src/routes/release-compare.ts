import { type Principal, can } from '@holtkeeper/access'
import { ToolError } from '@holtkeeper/agent-tools'
import type { ReleaseCompareApi, ReleaseComparePackage } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import type { UsageIndex } from '../api-surface/usages.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  repoKey,
  repoTarget,
} from '../context.ts'
import { snapshotJobs } from '../release-api.ts'
import { releaseServiceFor } from '../releases.ts'
import { type PackageToolsContext, packageChanges } from '../tools/packages.ts'
import type { CatalogReach } from '../visibility.ts'
import { RUN_ONLY_ANALYZERS } from './jobs.ts'

const refArg = z.string().trim().min(1).max(255).optional()
const rangeSchema = z.object({ from: refArg, to: refArg })
const packageSchema = z.object({
  package: z.string().trim().min(1).max(500),
  ecosystem: z.enum(['npm', 'Go']).optional(),
  from: refArg,
  to: refArg,
})

/** What `releaseCompareRoutes` reads beyond the server's deps, shared with the API catalog. */
export interface ReleaseCompareRoutesOptions {
  usages: UsageIndex
  reach: (principal: Principal) => Promise<CatalogReach>
  /** The `packages` tools context of one caller, as the MCP endpoint builds it. */
  packageContext: (principal: Principal) => Promise<PackageToolsContext>
}

const requireRepo = (value: string | undefined) => {
  const repo = parseRepo(value)
  if (!repo) throw new HTTPException(400, { message: 'repo is required' })
  return repo
}

const failed = (c: AppContext, error: unknown) => {
  if (error instanceof HTTPException) throw error
  if (error instanceof Error) return c.json({ error: error.message }, 409)
  throw error
}

/**
 * The comparison page's "will the upgrade break something" reads: the public API diff of the
 * repository's own packages with the snapshot jobs of the ends it lacks
 * (`GET /releases/compare/api`) and what changed in one dependency between two versions
 * (`GET /releases/compare/package`). Both need `releases:read` on the repository; what they read
 * is limited to the caller's catalog and snippet reach, and the API diff answers 403 without
 * catalog reach to the repository. Snapshot jobs are listed only to callers who may read the
 * repository's analyses.
 */
export function releaseCompareRoutes(deps: ServerDeps, options: ReleaseCompareRoutesOptions) {
  const { config } = deps
  const app = new Hono<Env>()
  const releases = releaseServiceFor(deps)
  const backfills = (deps.analyzers ?? []).some(
    (analyzer) =>
      analyzer.kind === 'api-surface' &&
      analyzer.scope === 'repo' &&
      !RUN_ONLY_ANALYZERS.has(analyzer.kind),
  )

  const readable = (c: AppContext, repo: RepoRef) =>
    authorize(c, 'releases:read', { kind: 'repo', repo: repoTarget(config, repo) })

  app.get('/releases/compare/api', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    const principal = readable(c, repo)
    const range = rangeSchema.safeParse({
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
    })
    if (!range.success) throw new HTTPException(400, { message: 'from or to is invalid' })
    const reach = await options.reach(principal)
    if (!reach.catalog(repo))
      throw new HTTPException(403, {
        message: `you cannot read the API catalog of ${repo.path}`,
      })
    try {
      const {
        api: found,
        refs,
        branch,
      } = await releases.compareApi(
        repo,
        {
          ...(range.data.from ? { from: range.data.from } : {}),
          ...(range.data.to ? { to: range.data.to } : {}),
        },
        { usages: options.usages, filter: reach.snippets },
      )
      const lacking = !found.recorded || found.missing.length > 0
      const allowed =
        backfills &&
        can(principal, 'analyses:run', { kind: 'repo', repo: repoTarget(config, repo) })
      const jobsVisible = can(principal, 'analyses:read', {
        kind: 'repo',
        repo: repoTarget(config, repo),
      })
      const snapshots =
        lacking && jobsVisible
          ? await snapshotJobs(
              deps.store.jobs,
              repo,
              { refs, ...(branch ? { branch } : {}), any: !found.recorded && !refs.length },
              deps.now(),
            )
          : []
      return c.json<ReleaseCompareApi>({
        ...found,
        ...(lacking ? { backfill: { allowed, ...(refs.length ? { refs } : {}) } } : {}),
        ...(snapshots.length ? { snapshots } : {}),
      })
    } catch (error) {
      return failed(c, error)
    }
  })

  app.get('/releases/compare/package', async (c) => {
    const repo = requireRepo(c.req.query('repo'))
    const principal = readable(c, repo)
    const input = packageSchema.safeParse({
      package: c.req.query('package'),
      ecosystem: c.req.query('ecosystem') || undefined,
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
    })
    if (!input.success)
      throw new HTTPException(400, { message: 'package is required; ecosystem is npm or Go' })
    const context = await options.packageContext(principal)
    try {
      const markdown = await packageChanges(context, {
        package: input.data.package,
        ...(input.data.ecosystem ? { ecosystem: input.data.ecosystem } : {}),
        ...(input.data.from ? { from: input.data.from } : {}),
        ...(input.data.to ? { to: input.data.to } : {}),
        repo: repoKey(repo),
      })
      return c.json<ReleaseComparePackage>({ markdown, found: true })
    } catch (error) {
      if (error instanceof ToolError)
        return c.json<ReleaseComparePackage>({ markdown: error.message, found: false })
      return failed(c, error)
    }
  })

  return app
}
