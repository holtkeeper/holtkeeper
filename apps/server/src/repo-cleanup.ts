import type { RepoRef } from '@holtkeeper/forge'
import { SYSTEM_ACTOR } from '@holtkeeper/store'

import { appendAudit } from './audit.ts'
import type { ServerDeps } from './context.ts'
import { type LeaderDuty, periodicDuty } from './leader.ts'
import { knownRepos } from './new-repos.ts'

/** How long a repository must be missing from every fleet listing before its records go. */
export const REPO_CLEANUP_GRACE_MS = 7 * 86_400_000
const INTERVAL_MS = 6 * 3_600_000
const STATE_KEY = 'repo-cleanup:missing'

type CleanupDeps = Pick<ServerDeps, 'config' | 'store' | 'analyzers' | 'now'>

/** What one cleanup run saw and did. */
export interface RepoCleanupSummary {
  /** Repositories with records that the fleet listings do not have, removed ones included. */
  missing: string[]
  /** Repositories whose records were deleted, with how many. */
  removed: { repo: string; records: number }[]
  /** Forges left alone this run, with the reason. */
  skipped: string[]
}

const repoKey = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/**
 * Deletes the analysis records of repositories that left the fleet: deleted, moved or renamed on
 * the forge, or no longer included. A repository counts as gone once every fleet listing of its
 * forge has missed it for `REPO_CLEANUP_GRACE_MS`; the time it was first missed is kept in
 * `Store.kv`, and a repository that shows up again is forgotten. A forge whose listing fails, or
 * lists nothing while records of it exist, is left alone that run, so a forge outage or a broken
 * token never deletes anything. Records of group-scope analyzers (stored under a team key) are
 * never candidates. Each removal is logged as the audit event `repo.forget`.
 */
export async function runRepoCleanup(
  deps: CleanupDeps,
  options: {
    listFleet?: () => Promise<{ repos: RepoRef[]; failed: string[] }>
    log?: (line: string) => void
  } = {},
): Promise<RepoCleanupSummary | undefined> {
  const { config, store } = deps
  const kv = store.kv
  if (!kv) return undefined
  const summary: RepoCleanupSummary = { missing: [], removed: [], skipped: [] }
  const groupKinds = new Set(
    (deps.analyzers ?? []).filter((each) => each.scope === 'group').map((each) => each.kind),
  )
  const teams = new Set(Object.keys(config.teams))
  const stored = new Map<string, RepoRef>()
  for (const head of await store.analyses.latestHeads())
    if (!groupKinds.has(head.kind) && !teams.has(head.repo.path))
      stored.set(repoKey(head.repo), head.repo)

  const listing = await (options.listFleet ?? (() => knownRepos(config)))()
  const failed = new Set(listing.failed.map((line) => line.slice(0, line.indexOf(':'))))
  const listed = new Set(listing.repos.map(repoKey))
  const listedForges = new Set(listing.repos.map((repo) => repo.forge))
  const usable = (forge: string) => {
    if (!(forge in config.forges)) return 'not configured'
    if (failed.has(forge)) return 'listing failed'
    if (!listedForges.has(forge)) return 'listing is empty'
    return undefined
  }

  const previous = await kv.get(STATE_KEY)
  const since: Record<string, string> =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? Object.fromEntries(
          Object.entries(previous).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {}
  const next: Record<string, string> = {}
  const now = deps.now()
  const skippedForges = new Set<string>()
  for (const [key, repo] of stored) {
    if (listed.has(key)) continue
    const reason = usable(repo.forge)
    if (reason) {
      if (since[key]) next[key] = since[key]
      if (!skippedForges.has(repo.forge)) summary.skipped.push(`${repo.forge}: ${reason}`)
      skippedForges.add(repo.forge)
      continue
    }
    summary.missing.push(key)
    const first = since[key] ?? now.toISOString()
    if (now.getTime() - Date.parse(first) < REPO_CLEANUP_GRACE_MS) {
      next[key] = first
      continue
    }
    // oxlint-disable-next-line no-await-in-loop -- one repository after another
    const records = await store.analyses.removeRepo(repo)
    summary.removed.push({ repo: key, records })
    // oxlint-disable-next-line no-await-in-loop
    await appendAudit(store, {
      at: now.toISOString(),
      actor: SYSTEM_ACTOR,
      via: 'system',
      action: 'repo.forget',
      target: { type: 'repo', repo: key },
      outcome: 'ok',
      details: { records, missingSince: first },
    })
  }
  await kv.set(STATE_KEY, next)
  if (summary.removed.length || summary.missing.length || summary.skipped.length)
    options.log?.(
      `repo cleanup: ${summary.missing.length} repositor${summary.missing.length === 1 ? 'y' : 'ies'} missing from the fleet, ` +
        `${summary.removed.length} removed${summary.removed.length ? ` (${summary.removed.map((each) => `${each.repo}: ${each.records} records`).join(', ')})` : ''}` +
        (summary.skipped.length ? `; skipped ${summary.skipped.join(', ')}` : ''),
    )
  return summary
}

/** The leader duty of `runRepoCleanup`: once at start, then every six hours. */
export function repoCleanupDuty(deps: CleanupDeps, log?: (line: string) => void): LeaderDuty {
  return periodicDuty('repo cleanup', () => runRepoCleanup(deps, { ...(log && { log }) }), {
    intervalMs: INTERVAL_MS,
    ...(log && { log }),
  })
}
