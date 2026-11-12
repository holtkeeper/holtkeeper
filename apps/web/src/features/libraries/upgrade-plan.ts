import type { DependencyDetail } from '@holtkeeper/api'
import { useState } from 'react'

import { useDependencyUpgrade } from '../../api/queries.ts'
import { narrowImpact, upgradeVersions } from '../../lib/dependencies.ts'
import { repoKey } from '../../lib/repo.ts'
import { upgradePrompt } from '../../lib/upgrade-prompt.ts'
import { useScope } from '../shell/scope.ts'

type User = DependencyDetail['usedBy'][number]

/** Repositories the scope switch keeps, and how many of other teams are folded away. */
export function useFoldedUsers(usedBy: readonly User[]) {
  const { view, scope } = useScope()
  const [expanded, setExpanded] = useState(false)
  const scoped = scope(usedBy)
  const folding = view === 'mine' && scoped.others.items > 0
  return {
    shown: folding && !expanded ? scoped.shown : [...usedBy],
    folded: folding ? scoped.others : undefined,
    expanded,
    toggle: () => setExpanded(!expanded),
    accept: (repo: string) =>
      !folding || expanded || scoped.shown.some((user) => repoKey(user.repo) === repo),
  }
}

/** The two ends of an upgrade; absent ends fall back to the oldest version in use and the latest. */
export interface UpgradeEnds {
  from?: string
  to?: string
}

/**
 * Everything an upgrade of the library needs, loaded only while `enabled`: the picked ends, the
 * upgrade readiness from the server, the affected uses narrowed to the scope, the repositories in
 * scope that are not on the target yet and the "Copy as prompt" plan.
 */
export function useUpgradePlan(detail: DependencyDetail, ends: UpgradeEnds, enabled = true) {
  const options = upgradeVersions(detail)
  const from = ends.from ?? options.from[0]
  const to = ends.to ?? detail.latest ?? options.to[0]
  const users = useFoldedUsers(detail.usedBy)
  const upgrade = useDependencyUpgrade(
    {
      ecosystem: detail.ecosystem,
      name: detail.name,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
    enabled && (from !== undefined || to !== undefined),
  )
  const data = upgrade.data
  const impact = data?.impact ? narrowImpact(data.impact, users.accept) : undefined
  const repos = users.shown
    .filter((user) => !to || !user.versions.includes(to))
    .map((user) => ({ repo: repoKey(user.repo), versions: user.versions }))
  const prompt = () =>
    upgradePrompt({
      name: detail.name,
      ecosystem: detail.ecosystem,
      ...(data?.from ? { from: data.from } : {}),
      ...(data?.to ? { to: data.to } : {}),
      repos,
      ...(impact ? { impact } : {}),
      ...(data?.api ? { api: data.api } : {}),
      ...(data?.changes ? { changes: data.changes } : {}),
      notes: data?.notes ?? [],
    })
  return { options, from, to, users, upgrade, data, impact, repos, prompt }
}
