import { type Principal, type RepoTarget, can } from '@holtkeeper/access'
import type { CoverageOverview, RepoCoverageTests, RepoCoverageView } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { repoTests, resolveRepoTests, settingCascade } from '@holtkeeper/settings'
import type { SettingEntry } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'

import {
  type Env,
  type ServerDeps,
  authorize,
  parseRepo,
  principalOf,
  repoKey,
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
 * adds one repository's breakdown from the data of its two newest records, the job that
 * produced the newest one when the caller may read it, and how `repo.tests` applies.
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
    const principal = principalOf(c)
    const [view, entries] = await Promise.all([
      repoCoverageView(store, target),
      store.settings.list(repoTests.key),
    ])
    const [job] = view.card
      ? await store.jobs.list({ analysisId: view.card.analysisId, limit: 1 })
      : []
    const tests = coverageTests(entries, target, principal)
    return c.json<RepoCoverageView>({
      ...view,
      ...(job && canSee(principal, 'analyses:read', jobTarget(config, job))
        ? { job: jobSummary(job) }
        : {}),
      ...(tests && { tests }),
    })
  })

  return app
}

/**
 * `repo.tests` as the coverage view shows it; absent when tests are expected and nobody may change
 * it. The deciding scope is shown only with `settings:read` on it; the repository's own entry
 * (scoped to exactly `forge:path`) and what applies without it only to callers who may write it.
 */
function coverageTests(
  entries: readonly SettingEntry[],
  repo: RepoTarget,
  principal: Principal,
): RepoCoverageTests | undefined {
  const resolved = resolveRepoTests(entries, repo)
  const key = repoKey(repo)
  const exact = { repos: [key] }
  const own = settingCascade(entries, repoTests.key, repo).find(
    ({ scope }) =>
      !scope.all && !scope.groups?.length && scope.repos?.length === 1 && scope.repos[0] === key,
  )
  const configurable =
    can(principal, 'settings:write', { kind: 'scope', scope: exact }) &&
    (!own || can(principal, 'settings:write', { kind: 'scope', scope: own.scope }))
  if (resolved.expected && !configurable) return undefined
  const { entry } = resolved
  const readable = entry && can(principal, 'settings:read', { kind: 'scope', scope: entry.scope })
  return {
    expected: resolved.expected,
    ...(resolved.reason !== undefined && { reason: resolved.reason }),
    ...(readable && { scope: entry.scope }),
    ...(configurable &&
      own && {
        entryId: own.id,
        inherited: resolveRepoTests(
          entries.filter((other) => other.id !== own.id),
          repo,
        ).expected,
      }),
    ...(configurable && { configurable: true as const }),
  }
}
