import type { RepoRef } from '@holtkeeper/forge'
import type { Issue } from '@holtkeeper/issues'

import type { QaChange, QaTask } from './model.ts'

const repoId = (repo: RepoRef) => `${repo.forge}:${repo.path}`

/** What `groupTasks` found: the tasks and how many changes named no real task. */
export interface QaTaskGroups {
  /** Newest change first. */
  tasks: QaTask[]
  /** Changes without a ticket key, or with placeholder keys only; left out of `tasks`. */
  untracked: number
}

/**
 * Groups changes of any number of repositories by their ticket keys: a change naming two keys is
 * part of both tasks. Keys `isCatchAll` matches are ignored, so a change with only such keys
 * counts as untracked. `issues` (by key) give titles; tasks without one take theirs from
 * `taskTitle`.
 */
export function groupTasks(
  changes: readonly QaChange[],
  options: {
    isCatchAll?: (key: string, repo: RepoRef) => boolean
    issues?: Readonly<Record<string, Issue>>
  } = {},
): QaTaskGroups {
  const byKey = new Map<string, QaChange[]>()
  let untracked = 0
  for (const change of changes) {
    const keys = change.keys.filter((key) => !options.isCatchAll?.(key, change.repo))
    if (keys.length === 0) untracked++
    for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), change])
  }
  const tasks = [...byKey].map(([key, list]): QaTask => {
    const sorted = list.toSorted((a, b) => b.at.localeCompare(a.at))
    const repos = new Map<string, RepoRef>()
    for (const change of sorted) repos.set(repoId(change.repo), change.repo)
    const issue = options.issues?.[key]
    return {
      key,
      title: issue?.title || taskTitle(sorted),
      ...(issue ? { issue } : {}),
      changes: sorted,
      repos: [...repos.values()],
      lastAt: sorted[0]?.at ?? '',
    }
  })
  return {
    tasks: tasks.toSorted((a, b) => b.lastAt.localeCompare(a.lastAt) || a.key.localeCompare(b.key)),
    untracked,
  }
}

/**
 * A title for a task without a tracker: the title of its newest merge request, else the title
 * its commits repeat most (the newest among equals), else empty.
 */
export function taskTitle(changes: readonly QaChange[]): string {
  const newest = changes.toSorted((a, b) => b.at.localeCompare(a.at))
  const mr = newest.find((change) => change.mergeRequest && change.title)
  if (mr) return mr.title
  const counts = new Map<string, number>()
  for (const change of newest)
    if (change.title) counts.set(change.title, (counts.get(change.title) ?? 0) + 1)
  let best = ''
  let most = 0
  for (const [title, count] of counts)
    if (count > most) {
      best = title
      most = count
    }
  return best
}

/**
 * Changes within the period: landed (or, for open merge requests, updated) at or after `since`.
 */
export const changesSince = (changes: readonly QaChange[], since: string) =>
  changes.filter((change) => change.at >= since)
