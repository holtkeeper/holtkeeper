import type {
  AgentTaskSource,
  AuditRunSummary,
  AuditTrigger,
  FindingGroup,
  FindingRepo,
  FindingStatus,
  Scope,
  SettingView,
  Severity,
  SeverityCounts,
} from '@holtkeeper/api'

import { isoDay } from './format.ts'
import { inHomeGroups } from './home-scope.ts'
import { globMatcher } from './repos.ts'
import { searchEntry, searchEnum, searchList, searchText } from './search-params.ts'
import { severities, severityRank } from './severity.ts'

/** Views of Supply › Security; `findings` is the default and is left out of the URL. */
type SecurityView = 'findings' | 'runs' | 'allowlist'

/** Sort orders of the findings table; `severity` is the default. */
export type FindingsSort = 'severity' | 'repos' | 'seen' | 'package'

const views: readonly SecurityView[] = ['findings', 'runs', 'allowlist']
const triggers: readonly AuditTrigger[] = ['cli', 'schedule', 'freshness', 'manual', 'webhook']
const statuses: readonly FindingStatus[] = ['open', 'fixing', 'allowlisted']
const sorts: readonly FindingsSort[] = ['severity', 'repos', 'seen', 'package']

/** Search parameters of `/supply/security`; omitted keys are the defaults. */
export interface SecuritySearch {
  view?: Exclude<SecurityView, 'findings'>
  /** `forge:path` the page narrows to. */
  repo?: string
  /** Runs view: every run instead of the latest per repository. */
  runs?: 'all'
  /** Runs started by this trigger only. */
  trigger?: AuditTrigger
  /** Runs view: `open` keeps runs with active findings, `clean` runs without. */
  findings?: 'open' | 'clean'
  severity?: Severity[]
  status?: FindingStatus[]
  ecosystem?: string[]
  sort?: Exclude<FindingsSort, 'severity'>
  q?: string
  /** The finding group open in the sheet: `<advisory>:<package>`. */
  finding?: string
  /** Tab of the open finding's sheet. */
  tab?: string
}

/** Reads `/supply/security` search parameters, dropping unknown values and defaults. */
export function parseSecuritySearch(search: Record<string, unknown>): SecuritySearch {
  const view = searchEnum(search.view, views)
  const sort = searchEnum(search.sort, sorts)
  return {
    ...searchEntry('view', view === 'findings' ? undefined : view),
    ...searchEntry('repo', searchText(search.repo)),
    ...searchEntry('runs', searchEnum(search.runs, ['all'] as const)),
    ...searchEntry('trigger', searchEnum(search.trigger, triggers)),
    ...searchEntry('findings', searchEnum(search.findings, ['open', 'clean'] as const)),
    ...searchEntry('severity', searchList(search.severity, severities)),
    ...searchEntry('status', searchList(search.status, statuses)),
    ...searchEntry('ecosystem', searchList(search.ecosystem)),
    ...searchEntry('sort', sort === 'severity' ? undefined : sort),
    ...searchEntry('q', searchText(search.q)),
    ...searchEntry('finding', searchText(search.finding)),
    ...searchEntry('tab', searchText(search.tab)),
  }
}

/** Display name of what started a run. */
export const triggerLabel: Record<AuditTrigger, string> = {
  cli: 'CLI',
  schedule: 'Schedule',
  freshness: 'Freshness',
  manual: 'Manual',
  webhook: 'Webhook',
}

/** Words for a finding's status, as tables and the sheet print it. */
export const findingStatusLabel: Record<FindingStatus, string> = {
  open: 'Open',
  fixing: 'Fixing',
  allowlisted: 'Allowlisted',
}

/** Tag tone of a finding status. */
export const findingStatusTone = (status: FindingStatus): 'danger' | 'info' | 'default' =>
  status === 'open' ? 'danger' : status === 'fixing' ? 'info' : 'default'

/** The sheet key of a group: `<advisory>:<package>`. */
export const findingKey = (group: FindingGroup): string => `${group.advisory}:${group.package}`

/** A finding group as fleet tables take it: `groups` joins the groups of its repositories. */
export interface FindingGroupRow {
  key: string
  group: FindingGroup
  groups: string[]
}

/** Wraps groups as rows; a group belongs to every team one of its repositories belongs to. */
export const findingRows = (groups: readonly FindingGroup[]): FindingGroupRow[] =>
  groups.map((group) => ({
    key: findingKey(group),
    group,
    groups: [...new Set(group.repos.flatMap((repo) => repo.groups))].toSorted(),
  }))

const matchesText = (group: FindingGroup, q: string): boolean => {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [
    group.advisory,
    ...group.aliases,
    group.package,
    group.ecosystem,
    group.summary ?? '',
    ...group.repos.map((repo) => repo.repo),
  ].some((value) => value.toLowerCase().includes(needle))
}

/** Groups matching the search's severity, status, ecosystem, repository and text filters. */
export function filterFindings(
  groups: readonly FindingGroup[],
  search: Pick<SecuritySearch, 'severity' | 'status' | 'ecosystem' | 'repo' | 'q'>,
): FindingGroup[] {
  return groups.filter(
    (group) =>
      (!search.severity?.length || search.severity.includes(group.severity)) &&
      (!search.status?.length || search.status.includes(group.status)) &&
      (!search.ecosystem?.length || search.ecosystem.includes(group.ecosystem)) &&
      (!search.repo || group.repos.some((repo) => repo.repo === search.repo)) &&
      matchesText(group, search.q ?? ''),
  )
}

/**
 * Groups in `sort` order: `severity` worst first, then most repositories; `repos` most
 * repositories first; `seen` newest first sighting first; `package` by name. Ties keep the
 * server's order.
 */
export function sortFindings(groups: readonly FindingGroup[], sort: FindingsSort): FindingGroup[] {
  const compare: Record<FindingsSort, (a: FindingGroup, b: FindingGroup) => number> = {
    severity: (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) || b.repos.length - a.repos.length,
    repos: (a, b) => b.repos.length - a.repos.length,
    seen: (a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt),
    package: (a, b) => a.package.localeCompare(b.package, 'en', { sensitivity: 'base' }),
  }
  return groups
    .map((group, index) => ({ group, index }))
    .toSorted((a, b) => compare[sort](a.group, b.group) || a.index - b.index)
    .map((entry) => entry.group)
}

/** Totals over finding groups for the summary strip. */
export interface FindingCounts {
  groups: number
  /** Distinct repositories among the groups. */
  repos: number
  severities: SeverityCounts
  /** Groups per overall status. */
  status: Record<FindingStatus, number>
}

/** Counts groups per severity and status and the repositories they touch. */
export function findingCounts(groups: readonly FindingGroup[]): FindingCounts {
  const counts: FindingCounts = {
    groups: groups.length,
    repos: new Set(groups.flatMap((group) => group.repos.map((repo) => repo.repo))).size,
    severities: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    status: { open: 0, fixing: 0, allowlisted: 0 },
  }
  for (const group of groups) {
    counts.severities[group.severity]++
    counts.status[group.status]++
  }
  return counts
}

/** Repositories of one group per status, for the sheet's status bar. */
export function repoStatusCounts(group: FindingGroup): Record<FindingStatus, number> {
  const counts = { open: 0, fixing: 0, allowlisted: 0 }
  for (const repo of group.repos) counts[repo.status]++
  return counts
}

/** "2 open · 1 fixing" for a group that is not in one state everywhere; empty otherwise. */
export function statusNote(group: FindingGroup): string {
  const counts = repoStatusCounts(group)
  const parts = statuses.filter((status) => counts[status] > 0)
  if (parts.length < 2) return ''
  return parts.map((status) => `${counts[status]} ${status}`).join(' · ')
}

/** Distinct ecosystems among groups, sorted, for the filter menu. */
export const findingEcosystems = (groups: readonly FindingGroup[]): string[] =>
  [...new Set(groups.map((group) => group.ecosystem))].toSorted()

/** Versions installed across the group's repositories, distinct and sorted. */
export const installedVersions = (group: FindingGroup): string[] =>
  [...new Set(group.repos.flatMap((repo) => repo.versions))].toSorted((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  )

/** Repositories where an agent fix applies: the group is open there. */
export const fixTargets = (group: FindingGroup): string[] =>
  group.repos.filter((repo) => repo.status === 'open').map((repo) => repo.repo)

/**
 * The source of a "Fix with agent" task: a dependency upgrade to the first fixed version, which the
 * findings join reads to mark the group `fixing`. Undefined while no fixed version is published.
 */
export function fixSource(
  group: FindingGroup,
): Extract<AgentTaskSource, { type: 'dependency-upgrade' }> | undefined {
  const to = group.fixedIn[0]
  return to
    ? { type: 'dependency-upgrade', ecosystem: group.ecosystem, package: group.package, to }
    : undefined
}

/** The prompt of a "Fix with agent" task for one finding group. */
export function fixPrompt(group: FindingGroup): string {
  const fix = group.fixedIn[0]
  return [
    `Fix advisory ${group.advisory}${group.aliases.length ? ` (${group.aliases.join(', ')})` : ''} in the ${group.ecosystem} package ${group.package}.`,
    group.summary ? `Advisory: ${group.summary}` : '',
    fix
      ? `Upgrade ${group.package} to ${fix} or later (also fixed in: ${group.fixedIn.join(', ')}), directly or through the dependency that pulls it in, and update the lockfile.`
      : `No fixed version is published; remove or replace the dependency, or stop and explain why that is not possible.`,
    'Keep the change minimal and make sure the build and tests pass.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Runs matching the runs view's trigger and findings filters. */
export function filterRuns(
  runs: readonly AuditRunSummary[],
  search: Pick<SecuritySearch, 'trigger' | 'findings'>,
): AuditRunSummary[] {
  return runs.filter(
    (run) =>
      (!search.trigger || run.trigger === search.trigger) &&
      (!search.findings || (search.findings === 'open') === run.active > 0),
  )
}

/** One `audit.allowlist` entry as stored in a setting value. */
export interface AllowlistEntryValue {
  id: string
  reason: string
  author?: string
  expires?: string
  package?: string
  paths?: string[]
  when?: Record<string, string | number | boolean>
}

const isEntry = (value: unknown): value is AllowlistEntryValue =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  typeof (value as { reason?: unknown }).reason === 'string'

/** The entries of an `audit.allowlist` setting value; anything malformed is skipped. */
const allowlistEntries = (value: unknown): AllowlistEntryValue[] =>
  Array.isArray(value) ? value.filter(isEntry) : []

/** Where an allowlist entry stands today: `expiring` ends within 14 days, `permanent` never. */
export type AllowlistState = 'expired' | 'expiring' | 'active' | 'permanent'

/** Words of an allowlist state. */
export const allowlistStateLabel: Record<AllowlistState, string> = {
  expired: 'Expired',
  expiring: 'Expires soon',
  active: 'Active',
  permanent: 'No expiry',
}

const dayMs = 24 * 3600 * 1000

/** The day `days` from `now`, as `YYYY-MM-DD`. */
export const inDays = (days: number, now: Date = new Date()): string =>
  isoDay(new Date(now.getTime() + days * dayMs))

/** Whether `value` is a `YYYY-MM-DD` day from `today` on. */
export const isFutureDay = (value: string, today: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= today

/** State of an entry with last day `expires` (`YYYY-MM-DD`) on `today`. */
export function allowlistState(expires: string | undefined, today: string): AllowlistState {
  if (!expires) return 'permanent'
  if (expires < today) return 'expired'
  const days = (Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs
  return days < 14 ? 'expiring' : 'active'
}

/** One row of the Allowlist view: an entry with the setting it lives in. */
export interface AllowlistRow {
  key: string
  settingId: string
  scope: Scope
  entry: AllowlistEntryValue
  state: AllowlistState
  /** Repositories whose finding of this advisory it hides now. */
  covers: string[]
}

const entryMatches = (entry: AllowlistEntryValue, group: FindingGroup): boolean =>
  (entry.id === group.advisory || group.aliases.includes(entry.id)) &&
  (!entry.package || entry.package === group.package)

/**
 * Every entry of the `audit.allowlist` settings, expired first, then soonest last day, then
 * advisory. `covers` lists the repositories where a matching finding is allowlisted now.
 */
export function allowlistRows(
  settings: readonly SettingView[],
  groups: readonly FindingGroup[],
  now: Date = new Date(),
): AllowlistRow[] {
  const today = isoDay(now)
  const order: Record<AllowlistState, number> = { expired: 0, expiring: 1, active: 2, permanent: 3 }
  return settings
    .filter((setting) => setting.key === 'audit.allowlist')
    .flatMap((setting) =>
      allowlistEntries(setting.value).map((entry, index) => {
        const state = allowlistState(entry.expires, today)
        const covers =
          state === 'expired'
            ? []
            : [
                ...new Set(
                  groups
                    .filter((group) => entryMatches(entry, group))
                    .flatMap((group) =>
                      group.repos
                        .filter(
                          (repo) =>
                            repo.status === 'allowlisted' && scopeCovers(setting.scope, repo),
                        )
                        .map((repo) => repo.repo),
                    ),
                ),
              ].toSorted()
        return {
          key: `${setting.id}#${index}`,
          settingId: setting.id,
          scope: setting.scope,
          entry,
          state,
          covers,
        }
      }),
    )
    .toSorted(
      (a, b) =>
        order[a.state] - order[b.state] ||
        (a.entry.expires ?? '').localeCompare(b.entry.expires ?? '') ||
        a.entry.id.localeCompare(b.entry.id),
    )
}

/** Whether a setting scope reaches a repository (`forge:path` with its groups). */
export function scopeCovers(scope: Scope, repo: Pick<FindingRepo, 'repo' | 'groups'>): boolean {
  if (scope.all) return true
  if (scope.groups?.length && inHomeGroups(scope.groups, repo.groups)) return true
  const separator = repo.repo.indexOf(':')
  const forge = repo.repo.slice(0, separator)
  const path = repo.repo.slice(separator + 1)
  return (scope.repos ?? []).some((pattern) => {
    const split = pattern.indexOf(':')
    if (split > 0)
      return pattern.slice(0, split) === forge && globMatcher(pattern.slice(split + 1))(path)
    return globMatcher(pattern)(path)
  })
}

/** A place a new allowlist entry can go: an existing setting entry, or a new one. */
interface AllowlistTarget {
  /** Setting entry id; absent for a new entry scoped to the repositories. */
  settingId?: string
  scope: Scope
  /** Existing entries in that setting value. */
  entries: AllowlistEntryValue[]
  /** Repositories where that setting entry is the one that applies, so the new entry counts there. */
  reaches: string[]
}

/** Where an allowlist entry can go, and the repositories it cannot reach for this caller. */
export interface AllowlistTargets {
  targets: AllowlistTarget[]
  /**
   * Repositories whose applying entry the caller cannot read (or whose resolution is unknown):
   * writing a narrower entry there would replace that list, so nothing is offered for them.
   */
  blocked: string[]
}

/**
 * Where an entry hiding a finding in `repos` can be written without changing which setting entry
 * applies anywhere. `winners` maps a repository to the `audit.allowlist` entry the settings resolver
 * says applies there, or `null` when none does; `visible` is what the caller may read. Each applying
 * entry the caller can see is offered with the repositories it applies to, most first. A new entry
 * scoped to the repositories without any applying entry is offered last.
 */
export function allowlistTargets(
  repos: readonly string[],
  winners: ReadonlyMap<string, SettingView | null>,
  visible: readonly SettingView[],
): AllowlistTargets {
  const readable = new Set(visible.map((setting) => setting.id))
  const byId = new Map<string, AllowlistTarget>()
  const uncovered: string[] = []
  const blocked: string[] = []
  for (const repo of repos) {
    const winner = winners.get(repo)
    if (winner === null) {
      uncovered.push(repo)
      continue
    }
    if (!winner || !readable.has(winner.id)) {
      blocked.push(repo)
      continue
    }
    const target = byId.get(winner.id) ?? {
      settingId: winner.id,
      scope: winner.scope,
      entries: allowlistEntries(winner.value),
      reaches: [],
    }
    target.reaches.push(repo)
    byId.set(winner.id, target)
  }
  const targets = [...byId.values()].toSorted((a, b) => b.reaches.length - a.reaches.length)
  return {
    targets: uncovered.length
      ? [...targets, { scope: { repos: uncovered }, entries: [], reaches: uncovered }]
      : targets,
    blocked,
  }
}

/**
 * The value with `entry` added; an entry for the same advisory and package is replaced, so
 * allowlisting twice updates the reason and last day.
 */
export function withAllowlistEntry(
  entries: readonly AllowlistEntryValue[],
  entry: AllowlistEntryValue,
): AllowlistEntryValue[] {
  const same = (other: AllowlistEntryValue) =>
    other.id === entry.id && (other.package ?? '') === (entry.package ?? '')
  return [...entries.filter((other) => !same(other)), entry]
}
