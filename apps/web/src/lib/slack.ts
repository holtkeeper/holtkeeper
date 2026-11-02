import type { Action, RepoSummary, Scope, SlackChannelBinding } from '@holtkeeper/api'

import { repoKey } from './repo.ts'

/** What each action lets a channel do, in words. */
export const channelActionLabels: Record<string, { label: string; description: string }> = {
  'releases:read': { label: 'See releases', description: 'release status, versions and deploys' },
  'releases:run': {
    label: 'Run releases',
    description: 'open candidates, accept, create versions, deploy',
  },
  'analyses:read': { label: 'Read analyses', description: 'reports of the repositories' },
  'audits:read': { label: 'Read audits', description: 'vulnerability audits' },
}

/** The label of an action a channel may be allowed. */
export const channelActionLabel = (action: Action) => channelActionLabels[action]?.label ?? action

/** A scope in words: `All repositories`, `games, tools`. */
export function scopeSummary(scope: Scope): string {
  if (scope.all) return 'All repositories'
  const parts = [
    ...(scope.groups ?? []).map((group) => (Array.isArray(group) ? group.join(' & ') : group)),
    ...(scope.repos ?? []),
  ]
  return parts.length ? parts.join(', ') : 'No repositories'
}

/** Repositories a scope picked in the panel (everything, or some groups) covers. */
export function reposInScope(repos: readonly RepoSummary[], scope: Scope): RepoSummary[] {
  if (scope.all) return [...repos]
  const groups = (scope.groups ?? []).filter((group) => typeof group === 'string')
  return repos.filter((repo) => repo.groups.some((group) => groups.includes(group)))
}

/** A new binding for a channel: everything it may see, read-only. */
export const newBinding = (channel: string, name: string): SlackChannelBinding => ({
  channel,
  name,
  scope: { all: true },
  actions: ['releases:read'],
})

/**
 * The binding as it will be saved: a default repository outside the scope is dropped, so changing
 * the groups never leaves a channel pointing elsewhere.
 */
export function cleanBinding(
  binding: SlackChannelBinding,
  repos: readonly RepoSummary[],
): SlackChannelBinding {
  const inScope = new Set(reposInScope(repos, binding.scope).map((repo) => repoKey(repo.repo)))
  const { defaultRepo, ...rest } = binding
  return defaultRepo && (inScope.has(defaultRepo) || repos.length === 0)
    ? { ...rest, defaultRepo }
    : rest
}

/** Bindings with one replaced (or added) by channel id, in name order. */
export const withBinding = (
  bindings: readonly SlackChannelBinding[],
  binding: SlackChannelBinding,
): SlackChannelBinding[] =>
  [...bindings.filter((entry) => entry.channel !== binding.channel), binding].toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )
