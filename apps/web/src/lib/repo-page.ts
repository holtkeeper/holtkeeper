import type {
  Action,
  AnalysisSummary,
  RepoOverview,
  RepoStackView,
  Scope,
  SettingView,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { type ScopeFocus, describeScope, namesFocus, scopeOrder } from './scope.ts'

interface PageTab<Id extends string> {
  id: Id
  label: string
  /** Any of these shows the tab; none means everyone. */
  requires?: readonly Action[]
}

/** The repository page's tabs in display order; also its `tab` search parameter. */
export const repoTabs = [
  { id: 'overview', label: 'Overview', requires: ['analyses:read'] },
  { id: 'guide', label: 'Guide', requires: ['knowledge:read'] },
  { id: 'assets', label: 'Assets', requires: ['analyses:read'] },
  { id: 'reviews', label: 'Reviews', requires: ['analyses:read'] },
  { id: 'settings', label: 'Settings', requires: ['settings:read'] },
] as const satisfies readonly PageTab<string>[]

/** The group page's tabs in display order; also its `tab` search parameter. */
export const groupTabs = [
  { id: 'repos', label: 'Repositories' },
  { id: 'guide', label: 'Guide', requires: ['knowledge:read'] },
  { id: 'stack', label: 'Stack', requires: ['analyses:read'] },
  { id: 'settings', label: 'Settings', requires: ['settings:read'] },
] as const satisfies readonly PageTab<string>[]

/** The tabs `can` lets a person see, in display order. */
export const visibleTabs = <T extends PageTab<string>>(
  tabs: readonly T[],
  can: (action: Action) => boolean,
): T[] => tabs.filter((tab) => !tab.requires || tab.requires.some((action) => can(action)))

/** The requested tab when it is visible, else the first visible one. */
export const pickTab = <Id extends string>(
  tabs: readonly { id: Id }[],
  requested: string | undefined,
): Id | undefined => (tabs.find((tab) => tab.id === requested) ?? tabs[0])?.id

/** How current a record is against the default-branch head freshness last saw. */
export type RecordFreshness = 'current' | 'behind' | 'aging' | 'stale'

const DAY = 86_400_000

/**
 * A record over a month old is stale and over a week aging; younger, it is behind when it ran on
 * another commit than the known head, else current (also when the head or its sha is unknown).
 */
export function recordFreshness(
  record: Pick<AnalysisSummary, 'sha' | 'createdAt'>,
  head: RepoOverview['head'],
  now: Date = new Date(),
): RecordFreshness {
  const age = now.getTime() - new Date(record.createdAt).getTime()
  if (age > 30 * DAY) return 'stale'
  if (age > 7 * DAY) return 'aging'
  return head && record.sha && record.sha !== head.sha ? 'behind' : 'current'
}

export const recordFreshnessTone: Record<RecordFreshness, StatusTone> = {
  current: 'success',
  behind: 'info',
  aging: 'warning',
  stale: 'danger',
}

export const recordFreshnessLabel: Record<RecordFreshness, string> = {
  current: 'current',
  behind: 'behind HEAD',
  aging: 'over a week old',
  stale: 'over a month old',
}

/** Records sorted for the freshness list: the most worrying first, then by label. */
export function freshnessRows(
  overview: Pick<RepoOverview, 'analyses' | 'head'>,
  now: Date = new Date(),
): { record: AnalysisSummary; freshness: RecordFreshness }[] {
  const rank: Record<RecordFreshness, number> = { stale: 0, aging: 1, behind: 2, current: 3 }
  return overview.analyses
    .map((record) => ({ record, freshness: recordFreshness(record, overview.head, now) }))
    .toSorted(
      (a, b) =>
        rank[a.freshness] - rank[b.freshness] || a.record.label.localeCompare(b.record.label),
    )
}

/** Uses of the stack that ended or end soon, and the status tone of the whole stack. */
export function stackHealth(stack: RepoStackView): { ending: number; tone: StatusTone } {
  const eol = stack.tools.filter((tool) => tool.support === 'eol').length
  const soon = stack.tools.filter((tool) => tool.support === 'eol-soon').length
  const failing = stack.conventions.drifts + stack.conventions.missing
  return {
    ending: eol + soon,
    tone: eol ? 'danger' : soon || failing ? 'warning' : 'success',
  }
}

/** 👍 share of all reactions, `undefined` without any. */
export const approvalShare = (reactions: { up: number; down: number }): number | undefined =>
  reactions.up + reactions.down ? reactions.up / (reactions.up + reactions.down) : undefined

const coversGroups = (scope: Scope, groups: readonly string[]) =>
  (scope.groups ?? []).some((entry) =>
    typeof entry === 'string' ? groups.includes(entry) : entry.every((g) => groups.includes(g)),
  )

/**
 * The entry of `key` the focus would fall back to without its own entries: the most specific one
 * that covers it (a group of the repository, then everything) but does not name it. Repository
 * globs are not matched, so an entry reaching the focus only through a glob is not found.
 */
export function inheritedEntry(
  entries: readonly SettingView[],
  key: string,
  focus: ScopeFocus,
  groups: readonly string[],
): SettingView | undefined {
  const reach = focus.kind === 'group' ? [focus.group] : groups
  return entries
    .filter(
      (entry) =>
        entry.key === key &&
        !namesFocus(entry.scope, focus) &&
        (entry.scope.all === true || coversGroups(entry.scope, reach)),
    )
    .toSorted((a, b) => scopeOrder(b.scope) - scopeOrder(a.scope))[0]
}

/** Where an inherited entry comes from, e.g. `group shapes` or `everything`. */
export const inheritedFrom = (entry: SettingView): string => describeScope(entry.scope)

/** Setting keys with entries naming the focus, in the order of `definitions`. */
export const overriddenKeys = (
  definitions: readonly { key: string }[],
  entries: readonly SettingView[],
  focus: ScopeFocus,
): string[] =>
  definitions
    .map((definition) => definition.key)
    .filter((key) => entries.some((entry) => entry.key === key && namesFocus(entry.scope, focus)))
