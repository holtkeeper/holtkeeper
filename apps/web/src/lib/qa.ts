import type {
  QaChangeCounts,
  QaChangeKind,
  QaChangeView,
  QaStaleness,
  QaTaskRow,
  RepoRef,
  TestIdFileChange,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { repoKey } from './repo.ts'

/** Periods of Releases › QA, in days. */
export const qaPeriods = [7, 30, 90] as const
export type QaPeriod = (typeof qaPeriods)[number]

/** A stored or linked period; anything else is the default, 30 days. */
export const parseQaPeriod = (value: unknown): QaPeriod =>
  qaPeriods.find((days) => String(days) === String(value)) ?? 30

/** How a change reached its branch, as people read it. */
export const changeKinds: Record<QaChangeKind, { label: string; tone: StatusTone; hint: string }> =
  {
    'merge-request': { label: 'Merged', tone: 'success', hint: 'A merged merge request' },
    'open-merge-request': {
      label: 'Open',
      tone: 'accent',
      hint: 'A merge request not merged yet: it can be tested before the merge',
    },
    commit: {
      label: 'Direct commit',
      tone: 'warning',
      hint: 'Pushed to the branch without a merge request: nobody reviewed it',
    },
    merge: {
      label: 'Local merge',
      tone: 'warning',
      hint: 'A merge made outside the forge, without a merge request: nobody reviewed it',
    },
  }

/** Whether a change landed without a review. */
export const unreviewed = (kind: QaChangeKind) => kind === 'commit' || kind === 'merge'

/** `2 merged · 1 open · 3 direct`, leaving out zeros; `—` without changes. */
export function countsText(counts: QaChangeCounts): string {
  const parts = [
    counts.merged ? `${counts.merged} merged` : '',
    counts.open ? `${counts.open} open` : '',
    counts.direct ? `${counts.direct} direct` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}

/** Rows whose key, title, repository or author contains `query`, case-insensitively. */
export function filterTasks(rows: readonly QaTaskRow[], query: string): QaTaskRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) =>
    [row.key, row.title, ...row.repos.map((repo) => repo.path), ...row.authors].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  )
}

/** Changes grouped by repository, in the order their repositories first appear (newest first). */
export function changesByRepo(
  changes: readonly QaChangeView[],
): { repo: RepoRef; changes: QaChangeView[] }[] {
  const groups = new Map<string, { repo: RepoRef; changes: QaChangeView[] }>()
  for (const change of changes) {
    const key = repoKey(change.repo)
    const group = groups.get(key) ?? { repo: change.repo, changes: [] }
    group.changes.push(change)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Test attribute changes of all `changes`, merged by file; values both added and removed drop out. */
export function testIdSummary(changes: readonly QaChangeView[]): TestIdFileChange[] {
  const files = new Map<
    string,
    {
      added: Map<string, TestIdFileChange['added'][number]>
      removed: Map<string, TestIdFileChange['removed'][number]>
    }
  >()
  // Oldest first, so a later change undoes an earlier one.
  for (const change of changes.toReversed())
    for (const file of change.detail?.testIds ?? []) {
      const entry = files.get(file.file) ?? { added: new Map(), removed: new Map() }
      for (const ref of file.added) {
        const id = `${ref.attribute}=${ref.value}`
        if (entry.removed.has(id)) entry.removed.delete(id)
        else entry.added.set(id, ref)
      }
      for (const ref of file.removed) {
        const id = `${ref.attribute}=${ref.value}`
        if (entry.added.has(id)) entry.added.delete(id)
        else entry.removed.set(id, ref)
      }
      files.set(file.file, entry)
    }
  return [...files]
    .map(([file, entry]) => ({
      file,
      added: [...entry.added.values()],
      removed: [...entry.removed.values()],
    }))
    .filter((file) => file.added.length || file.removed.length)
}

/** `work:group/app!12` as `group/app !12`, `work:group/app@abc1234` as `group/app abc1234`. */
export function changeLabel(identity: string): string {
  const path = identity.slice(identity.indexOf(':') + 1)
  const bang = path.lastIndexOf('!')
  const at = path.lastIndexOf('@')
  const cut = Math.max(bang, at)
  if (cut <= 0) return path
  return `${path.slice(0, cut)} ${path[cut] === '!' ? path.slice(cut) : path.slice(cut + 1)}`
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** One sentence on what changed since a summary: `2 new changes, 1 updated`. */
export function stalenessText(stale: QaStaleness): string {
  return [
    stale.added.length ? plural(stale.added.length, 'new change') : '',
    stale.updated.length ? `${stale.updated.length} updated` : '',
    stale.removed.length ? `${stale.removed.length} gone` : '',
  ]
    .filter(Boolean)
    .join(', ')
}
