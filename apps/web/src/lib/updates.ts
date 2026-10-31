import type {
  DependencyUpdatesOverview,
  RepoUpdates,
  UpdateMergeRequest,
  UpdateSource,
  UpdateState,
} from '@holtkeeper/api'

import type { Tone } from '../ui/Chip.tsx'
import { repoKey } from './repo.ts'

/** Update states worst first, as the overview orders repositories. */
export const updateStates = ['broken', 'review', 'outdated', 'current', 'unknown'] as const

/** How each update state is named, colored and explained. */
export const stateMeta: Record<
  UpdateState,
  { label: string; tone: Tone; color: string; hint: string }
> = {
  broken: {
    label: 'Broken',
    tone: 'danger',
    color: 'var(--danger)',
    hint: 'An update run failed or a merge request has a failed pipeline',
  },
  review: {
    label: 'Awaiting review',
    tone: 'warning',
    color: 'var(--warning)',
    hint: 'Update merge requests are open',
  },
  outdated: {
    label: 'Outdated',
    tone: 'accent',
    color: 'var(--accent)',
    hint: 'Updates exist, no merge request proposes them',
  },
  current: {
    label: 'Up to date',
    tone: 'success',
    color: 'var(--success)',
    hint: 'Every dependency is on its newest release',
  },
  unknown: {
    label: 'Not checked',
    tone: 'default',
    color: 'var(--muted)',
    hint: 'Renovate has not run on the repository yet',
  },
}

/** Names of the automations that open update merge requests. */
export const sourceLabel: Record<UpdateSource, string> = {
  renovate: 'Renovate',
  browserslist: 'Browserslist',
  propagate: 'Propagation',
}

/** Chip tone of a merge request status. */
export const mergeRequestTone: Record<UpdateMergeRequest['status'], Tone> = {
  broken: 'danger',
  review: 'warning',
  checking: 'accent',
  draft: 'default',
  merged: 'success',
  closed: 'default',
}

/** Open merge requests first (broken ones leading), then recent merges. */
export function orderedMergeRequests(repo: RepoUpdates): UpdateMergeRequest[] {
  const rank: Record<UpdateMergeRequest['status'], number> = {
    broken: 0,
    review: 1,
    checking: 2,
    draft: 3,
    merged: 4,
    closed: 5,
  }
  return repo.mergeRequests.toSorted((a, b) => rank[a.status] - rank[b.status] || b.id - a.id)
}

export type StateFilter = UpdateState | 'all'

/** Repositories in `state` (or every one) whose `forge:path` contains `query`, case-insensitively. */
export function filterRepos(
  repos: readonly RepoUpdates[],
  { state = 'all', query = '' }: { state?: StateFilter; query?: string },
): RepoUpdates[] {
  const needle = query.trim().toLowerCase()
  return repos.filter(
    (repo) =>
      (state === 'all' || repo.state === state) &&
      (!needle || repoKey(repo.repo).toLowerCase().includes(needle)),
  )
}

/** Share of repositories per state, for the overview bar; states without repositories are left out. */
export function stateBreakdown(
  totals: DependencyUpdatesOverview['totals'],
): { state: UpdateState; count: number; share: number }[] {
  if (!totals.repos) return []
  return updateStates
    .map((state) => ({ state, count: totals[state], share: totals[state] / totals.repos }))
    .filter((entry) => entry.count > 0)
}

/** Repositories whose Renovate only reports, so their updates wait for someone to switch it on. */
export const reportOnly = (repos: readonly RepoUpdates[]) =>
  repos.filter((repo) => repo.renovate?.mode === 'report').length
