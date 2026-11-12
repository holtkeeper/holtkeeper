import {
  type Action,
  type GroupDocumentData,
  type HealthTone,
  type RepoHealthCellKey,
  type RepoHealthStatus,
  type RepoRef,
  type RepoSummary,
  groupLineage,
  parentGroup,
} from '@holtkeeper/api'

import type { DotTone } from '../ui/Legend.tsx'
import type { StripCell } from '../ui/Strip.tsx'
import { plural } from './format.ts'
import { groupMatchesQuery, keyAsTitle, type GroupTitleOf } from './group-titles.ts'
import { healthLabels, healthOrder, repoHealth } from './home.ts'
import { type PageTab, hubSearch, pickTab, visibleTabs } from './repo-page.ts'
import type { RepoHubSearch, RepoHubTab } from './repo.ts'
import { repoKey, repoSplat, withRepos } from './repo.ts'
import { sheetCommand } from './sheet.ts'
import type { SortState, SortValue } from './table-sort.ts'

/** Columns of the repository list a person can sort by. */
export type FleetSortKey = 'repo' | 'health' | RepoHealthCellKey | 'analysed'

const fleetSortKeys: readonly FleetSortKey[] = [
  'repo',
  'health',
  'security',
  'dependencies',
  'coverage',
  'bundles',
  'jobs',
  'ci',
  'licenses',
  'release',
  'analysed',
]

/** Health cells in the column order of the repository list, with their headers. */
export const fleetCells: readonly { key: RepoHealthCellKey; label: string; mono?: boolean }[] = [
  { key: 'security', label: 'Security' },
  { key: 'dependencies', label: 'Deps' },
  { key: 'coverage', label: 'Coverage', mono: true },
  { key: 'bundles', label: 'Bundles', mono: true },
  { key: 'jobs', label: 'Jobs' },
  { key: 'ci', label: 'CI' },
  { key: 'licenses', label: 'Licenses' },
  { key: 'release', label: 'Release' },
]

/**
 * The repository list's search parameters: a text filter, chosen health states and forges, and
 * the sorted column. No sort means worst first; groups come from the scope switch.
 */
export interface ReposSearch {
  q?: string
  health?: RepoHealthStatus[]
  forge?: string[]
  sort?: FleetSortKey
  dir?: 'asc' | 'desc'
}

const strings = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [
    ...new Set(list.filter((item): item is string => typeof item === 'string' && item !== '')),
  ]
}

const isHealth = (value: string): value is RepoHealthStatus =>
  healthOrder.some((status) => status === value)

const isSortKey = (value: unknown): value is FleetSortKey =>
  fleetSortKeys.some((key) => key === value)

/** `ReposSearch` from a URL; unknown states, sort keys and empty values are dropped. */
export function parseReposSearch(search: Record<string, unknown>): ReposSearch {
  const q = typeof search.q === 'string' ? search.q : ''
  const health = strings(search.health).filter(isHealth)
  const forge = strings(search.forge)
  const sort = isSortKey(search.sort) ? search.sort : undefined
  return {
    ...(q ? { q } : {}),
    ...(health.length ? { health } : {}),
    ...(forge.length ? { forge } : {}),
    ...(sort ? { sort, dir: search.dir === 'desc' ? ('desc' as const) : ('asc' as const) } : {}),
  }
}

/** The table sort a `ReposSearch` names. */
export const reposSort = (search: ReposSearch): SortState<FleetSortKey> =>
  search.sort ? { key: search.sort, direction: search.dir ?? 'asc' } : null

/** `search` with `sort` in it; `null` clears the sort back to worst first. */
export function withReposSort(search: ReposSearch, sort: SortState<FleetSortKey>): ReposSearch {
  const { sort: _sort, dir: _dir, ...rest } = search
  return sort ? { ...rest, sort: sort.key, dir: sort.direction } : rest
}

/** Whether `summary` matches the text filter: its `forge:path` or one of its groups (key or title). */
const matchesRepoQuery = (
  summary: RepoSummary,
  query: string | undefined,
  titleOf: GroupTitleOf,
): boolean => {
  const needle = query?.trim().toLowerCase()
  return (
    !needle ||
    repoKey(summary.repo).toLowerCase().includes(needle) ||
    summary.groups.some((group) => groupMatchesQuery(group, titleOf, needle))
  )
}

/** The repositories `search` keeps: text (groups by key or `titleOf`), health states and forges. */
export const filterRepos = (
  repos: readonly RepoSummary[],
  search: ReposSearch,
  titleOf: GroupTitleOf = keyAsTitle,
): RepoSummary[] =>
  repos.filter(
    (summary) =>
      matchesRepoQuery(summary, search.q, titleOf) &&
      (!search.health?.length || search.health.includes(summary.health)) &&
      (!search.forge?.length || search.forge.includes(summary.repo.forge)),
  )

const toneRank: Record<HealthTone, number> = { bad: 0, warn: 1, info: 2, ok: 3, none: 4 }

/**
 * What a column sorts a repository by: the path, the health state worst first, a cell's tone
 * worst first (absent cells last), or when it was last analysed.
 */
export function fleetSortValue(summary: RepoSummary, key: FleetSortKey): SortValue {
  if (key === 'repo') return repoKey(summary.repo)
  if (key === 'health') return healthOrder.indexOf(summary.health)
  if (key === 'analysed')
    return summary.lastAnalysedAt ? new Date(summary.lastAnalysedAt) : undefined
  const cell = summary.cells[key]
  return cell ? toneRank[cell.tone] : undefined
}

/** Repositories worst first, the order before anyone sorts and the tie-break after. */
export const worstFirst = (repos: readonly RepoSummary[]): RepoSummary[] =>
  repoHealth(repos).map((ranked) => ranked.summary)

/** The status legend of the repository list, worst state last as in the mockup's reading order. */
export const healthLegend: readonly { tone: DotTone; label: string }[] = [
  { tone: 'success', label: 'Healthy' },
  { tone: 'warning', label: 'With warnings' },
  { tone: 'danger', label: 'Failing' },
  { tone: 'none', label: 'No data' },
]

const cellAreas: Record<Exclude<RepoHealthCellKey, 'jobs'>, [RepoHubTab, string?]> = {
  security: ['supply', 'security'],
  dependencies: ['supply', 'libraries'],
  licenses: ['supply', 'licenses'],
  coverage: ['quality', 'coverage'],
  bundles: ['quality', 'bundles'],
  ci: ['quality', 'ci'],
  release: ['releases'],
}

/** Where a health cell of `repo` leads: the matching hub area, or the repository's runs for jobs. */
export function cellTarget(
  repo: RepoRef,
  key: RepoHealthCellKey,
):
  | { to: '/ops/runs'; search: { repo: string } }
  | { to: '/repos/$'; params: { _splat: string }; search: RepoHubSearch } {
  if (key === 'jobs') return { to: '/ops/runs', search: { repo: repoKey(repo) } }
  const [tab, section] = cellAreas[key]
  return { to: '/repos/$', params: { _splat: repoSplat(repo) }, search: hubSearch(tab, section) }
}

/** Hidden words naming a cell's tone, since the dot alone carries no meaning. */
export const cellStatusWords: Record<HealthTone, string> = {
  ok: 'healthy',
  warn: 'warning',
  bad: 'failing',
  info: 'pending',
  none: 'no data',
}

const DAY_MS = 86_400_000

/** Repositories per overall state; every state is present. */
export function countHealth(repos: readonly RepoSummary[]): Record<RepoHealthStatus, number> {
  const counts: Record<RepoHealthStatus, number> = {
    failing: 0,
    warnings: 0,
    'not-analysed': 0,
    healthy: 0,
  }
  for (const repo of repos) counts[repo.health] += 1
  return counts
}

/**
 * The summary strip above the repository list: how many there are (`noun` names the scope, e.g.
 * "in my teams"), per state, analysed in the last 7 days, with a critical or high finding, active
 * findings, and how many learn about changes by webhook or polling. Figures that need data the
 * viewer may not read are left out.
 */
export function fleetStrip(
  repos: readonly RepoSummary[],
  scope: string | undefined,
  now: Date = new Date(),
): StripCell[] {
  const counts = countHealth(repos)
  const audited = repos.filter((repo) => repo.latestAudit)
  const analysable = repos.some((repo) => repo.freshness)
  const updated = repos.filter((repo) => repo.updates)
  const cells: StripCell[] = [
    {
      value: repos.length,
      label: `${repos.length === 1 ? 'repository' : 'repositories'}${scope ? ` ${scope}` : ''}`,
    },
    { value: counts.healthy, label: 'healthy', tone: 'success' },
    { value: counts.warnings, label: 'with warnings', tone: 'warning' },
    { value: counts.failing, label: 'failing', tone: 'danger' },
    { value: counts['not-analysed'], label: 'not analysed', tone: 'none' },
  ]
  if (analysable)
    cells.push({
      value: repos.filter(
        (repo) =>
          repo.lastAnalysedAt && now.getTime() - Date.parse(repo.lastAnalysedAt) <= 7 * DAY_MS,
      ).length,
      label: 'analysed this week',
    })
  if (audited.length)
    cells.push(
      {
        value: audited.filter(
          (repo) =>
            (repo.latestAudit?.severities.critical ?? 0) +
              (repo.latestAudit?.severities.high ?? 0) >
            0,
        ).length,
        label: 'with critical or high',
      },
      {
        value: audited.reduce((sum, repo) => sum + (repo.latestAudit?.active ?? 0), 0),
        label: 'active findings',
      },
    )
  if (updated.length) {
    const hooks = updated.filter((repo) => repo.updates?.via === 'webhook').length
    const polled = updated.filter((repo) => repo.updates?.via === 'polling').length
    cells.push({
      prefix: 'Updates',
      value: hooks,
      label: 'webhook',
      caption: `· ${polled} polling`,
      end: true,
    })
  }
  return cells
}

/** "38 healthy · 2 with warnings · 0 failing" for the folded other-teams row. */
export function healthSummaryText(repos: readonly RepoSummary[]): string {
  const counts = countHealth(repos)
  return [
    `${counts.healthy} healthy`,
    `${counts.warnings} with warnings`,
    `${counts.failing} failing`,
    ...(counts['not-analysed'] ? [`${counts['not-analysed']} not analysed`] : []),
  ].join(' · ')
}

/** How a repository learns about changes, in a few words, e.g. "Polling · 5m". */
export function updatesText(updates: RepoSummary['updates']): { text: string; tone: DotTone } {
  if (!updates) return { text: '—', tone: 'none' }
  if (updates.lastError) return { text: 'Poll failed', tone: 'danger' }
  if (updates.via === 'webhook') return { text: 'Webhook', tone: 'success' }
  if (updates.via === 'off') return { text: 'Not tracked', tone: 'none' }
  const minutes = updates.intervalMs ? Math.round(updates.intervalMs / 60_000) : undefined
  return {
    text: minutes
      ? `Polling · ${minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`}`
      : 'Polling',
    tone: 'none',
  }
}

/** "6 of 7 current" or "no records" from a repository's freshness. */
export function freshnessText(freshness: RepoSummary['freshness']): string | undefined {
  if (!freshness) return undefined
  if (!freshness.total) return 'no records'
  return `${freshness.current} of ${freshness.total} current`
}

/** The key next to `current` in `keys` after J (`next`) or K (`previous`), clamped to the ends. */
export function stepKey(
  keys: readonly string[],
  current: string | undefined,
  command: 'next' | 'previous',
): string | undefined {
  if (!keys.length) return undefined
  const index = current === undefined ? -1 : keys.indexOf(current)
  if (index < 0) return command === 'next' ? keys[0] : keys.at(-1)
  const next = command === 'next' ? Math.min(index + 1, keys.length - 1) : Math.max(index - 1, 0)
  return keys[next]
}

/**
 * What a key press does in a fleet table: J next row, K previous row, Enter opens the selected one.
 * Nothing while typing in a field, with a modifier, or inside a dialog.
 */
export function fleetKeyCommand(
  event: Parameters<typeof sheetCommand>[0] & { inDialog?: boolean },
): 'next' | 'previous' | 'open' | undefined {
  if (event.inDialog || event.editable || event.altKey || event.ctrlKey || event.metaKey)
    return undefined
  if (event.key === 'Enter') return 'open'
  const command = sheetCommand(event)
  return command === 'next' || command === 'previous' ? command : undefined
}

/** One row of the group list: a group with its patterns (when readable) and its visible members. */
export interface GroupRow {
  id: string
  /** The parent group of a subgroup row. */
  parent?: string
  /** Subgroup rows of a root group, sorted by id; empty for a subgroup. */
  subgroups: GroupRow[]
  forge?: string
  include?: string[]
  exclude?: string[]
  members: RepoSummary[]
  counts: Record<RepoHealthStatus, number>
  /** The group and its parent, so the group list splits by home groups like any fleet list. */
  groups: string[]
}

/**
 * Every group the viewer can see as a tree: those in the panel config (when it may read it) and
 * those its visible repositories are in, each with its members and their states. Root groups come
 * sorted by id, each holding its subgroups; a subgroup whose parent is unknown stands as a root.
 */
export function groupRows(
  repos: readonly RepoSummary[],
  config: readonly { id: string; data: GroupDocumentData }[] = [],
): GroupRow[] {
  const ids = [...new Set([...config.map((entry) => entry.id), ...repos.flatMap((r) => r.groups)])]
  const rows = new Map(
    ids.toSorted().map((id): [string, GroupRow] => {
      const entry = config.find((candidate) => candidate.id === id)
      const members = repos.filter((repo) => repo.groups.includes(id))
      const parent = parentGroup(id)
      return [
        id,
        {
          id,
          ...(parent !== undefined && { parent }),
          subgroups: [],
          ...(entry
            ? { forge: entry.data.forge, include: entry.data.include, exclude: entry.data.exclude }
            : members[0]
              ? { forge: members[0].repo.forge }
              : {}),
          members,
          counts: countHealth(members),
          groups: groupLineage(id),
        },
      ]
    }),
  )
  const roots: GroupRow[] = []
  for (const row of rows.values()) {
    const parent = row.parent === undefined ? undefined : rows.get(row.parent)
    if (parent) parent.subgroups.push(row)
    else roots.push(row)
  }
  return roots
}

/**
 * The group tree as list rows: each root, then its subgroups when it is in `open`. With `matches`
 * (a filter people typed), a root stays when it or a subgroup matches, and its matching subgroups
 * show whether it is open or not. `order` sorts the roots and each root's subgroups.
 */
export function groupTreeRows(
  tree: readonly GroupRow[],
  open: ReadonlySet<string>,
  matches?: (row: GroupRow) => boolean,
  order: (rows: readonly GroupRow[]) => GroupRow[] = (rows) => [...rows],
): GroupRow[] {
  const rows: GroupRow[] = []
  for (const root of order(tree)) {
    const subgroups = matches
      ? root.subgroups.filter(matches)
      : open.has(root.id)
        ? root.subgroups
        : []
    if (matches && !matches(root) && !subgroups.length) continue
    rows.push(root)
    rows.push(...order(subgroups))
  }
  return rows
}

/**
 * Members of `parent` that sit in more than one of its subgroups, by `forge:path`, with those
 * subgroups sorted. Sibling subgroups may overlap; the group page warns about these.
 */
export function siblingOverlaps(
  members: readonly RepoSummary[],
  parent: string,
): Map<string, string[]> {
  const overlaps = new Map<string, string[]>()
  for (const member of members) {
    const siblings = member.groups.filter((group) => parentGroup(group) === parent).toSorted()
    if (siblings.length > 1) overlaps.set(repoKey(member.repo), siblings)
  }
  return overlaps
}

/** What a group list row says about its members' states, worst first, zero states left out. */
export const groupHealthText = (counts: Record<RepoHealthStatus, number>): string[] =>
  healthOrder
    .filter((status) => counts[status] > 0)
    .map((status) => {
      const label = healthLabels[status].toLowerCase()
      return `${counts[status]} ${label}`
    })

/** The group page's tabs in display order; also its `tab` search parameter. */
const groupPageTabs = [
  { id: 'repos', label: 'Repositories' },
  { id: 'subgroups', label: 'Subgroups', root: true },
  { id: 'stack', label: 'Stack & conventions', requires: ['analyses:read'] },
  { id: 'knowledge', label: 'Knowledge', requires: ['knowledge:read'] },
  { id: 'settings', label: 'Settings', requires: ['settings:read'] },
  { id: 'membership', label: 'Membership', requires: ['settings:read'], global: true },
] as const satisfies readonly (PageTab<string> & { global?: true; root?: true })[]

/** Id of a group page tab. */
type GroupPageTab = (typeof groupPageTabs)[number]['id']

/**
 * The group tabs the viewer may see, and the requested one when visible, else the first. A tab
 * marked `global` (Membership, which reads the group patterns) needs its action on every
 * repository (`canGlobal`), the others anywhere (`can`). Subgroups is a root group's tab only.
 */
export function pickGroupTab(
  can: (action: Action) => boolean,
  requested: string | undefined,
  canGlobal: (action: Action) => boolean = can,
  group?: string,
): { tabs: (typeof groupPageTabs)[number][]; tab: GroupPageTab } {
  const subgroup = group !== undefined && parentGroup(group) !== undefined
  const tabs = visibleTabs<(typeof groupPageTabs)[number]>(groupPageTabs, can).filter(
    (tab) => (!('global' in tab) || tab.requires.some(canGlobal)) && !('root' in tab && subgroup),
  )
  return { tabs, tab: pickTab(tabs, requested) ?? 'repos' }
}

const globSpecial = /[*?[\]{}]/

/** Whether `pattern` names one path exactly, without glob syntax. */
export const isExactPattern = (pattern: string): boolean => !globSpecial.test(pattern)

const escapeRegExp = (text: string) => text.replace(/[.+^$()|\\/]/g, '\\$&')

/**
 * A matcher for a group pattern as the server reads it: `*` and `?` stay inside one path segment,
 * `**` crosses segments, `[abc]` is a class and `{a,b}` alternatives.
 */
export function globMatcher(pattern: string): (path: string) => boolean {
  let source = ''
  let braces = 0
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? ''
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        } else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end < 0) source += '\\['
      else {
        const body = pattern.slice(index + 1, end).replace(/^!/, '^')
        source += `[${body.replaceAll('\\', '\\\\')}]`
        index = end
      }
    } else if (char === '{') {
      braces++
      source += '(?:'
    } else if (char === '}' && braces > 0) {
      braces--
      source += ')'
    } else if (char === ',' && braces > 0) source += '|'
    else source += escapeRegExp(char)
  }
  const regex = new RegExp(`^${source}${')'.repeat(braces)}$`)
  return (path) => regex.test(path)
}

/**
 * The paths of `paths` that an exclude pattern of `group` still keeps out once `withRepos` adds
 * them, each with the pattern: `withRepos` lifts only exact-path excludes, never globs.
 */
export function excludedByPattern(
  group: GroupDocumentData | undefined,
  forge: string,
  paths: readonly string[],
): { path: string; pattern: string }[] {
  const { exclude } = withRepos(group, forge, paths)
  return paths.flatMap((path) => {
    const pattern = exclude.find((candidate) => globMatcher(candidate)(path))
    return pattern === undefined ? [] : [{ path, pattern }]
  })
}

const matchesAny = (patterns: readonly string[], path: string) =>
  patterns.some((pattern) => globMatcher(pattern)(path))

/** Where a repository stands with a group's patterns. */
export type MembershipState = 'member' | 'excluded' | 'joins' | 'leaves'

/** One repository on the Membership tab. */
interface MembershipRow {
  repo: RepoRef
  state: MembershipState
  /** The include pattern that matched (for `excluded`, the exclude pattern that keeps it out). */
  pattern?: string
  /** `exact` when an exact include path lists it, `listed` when the forge listing found it. */
  source: 'exact' | 'listed'
}

/** Counts per pattern, for the pattern lists. */
interface PatternCounts {
  /** Members each include pattern matches and how many of those an exclude pattern keeps out. */
  include: Record<string, { members: number; excluded: number }>
  /** Repositories each exclude pattern keeps out. */
  exclude: Record<string, number>
}

/** The Membership tab's rows and figures for `draft` patterns against the `saved` ones. */
export interface Membership {
  rows: MembershipRow[]
  counts: PatternCounts
  members: number
  excluded: number
  /** Repositories the draft adds or removes compared with the saved patterns. */
  joins: number
  leaves: number
}

const stateOrder: Record<MembershipState, number> = { joins: 0, leaves: 1, member: 2, excluded: 3 }

/**
 * Membership of `forge`'s repositories under `draft` patterns, judged on `matched` (what include
 * patterns matched in the last listing, before excludes) plus exact include paths, which list a
 * repository before any listing. Compared with `saved`, a member only under the draft `joins` and
 * one only under the saved patterns `leaves`. Unsaved patterns are previewed on the last listing,
 * so repositories the forge never listed cannot appear. Without `exactPaths` (a subgroup, whose
 * `matched` are its parent's members) only `matched` counts, so an exact path outside the parent
 * matches nothing.
 */
export function groupMembership(
  forge: string,
  matched: readonly RepoRef[],
  saved: Pick<GroupDocumentData, 'include' | 'exclude'>,
  draft: Pick<GroupDocumentData, 'include' | 'exclude'> = saved,
  exactPaths = true,
): Membership {
  const paths = new Map<string, RepoRef>()
  for (const repo of matched) if (repo.forge === forge) paths.set(repo.path, repo)
  if (exactPaths)
    for (const pattern of [...saved.include, ...draft.include])
      if (isExactPattern(pattern) && !paths.has(pattern))
        paths.set(pattern, { forge, path: pattern })
  const counts: PatternCounts = {
    include: Object.fromEntries(draft.include.map((p) => [p, { members: 0, excluded: 0 }])),
    exclude: Object.fromEntries(draft.exclude.map((p) => [p, 0])),
  }
  const rows: MembershipRow[] = []
  for (const repo of paths.values()) {
    const including = draft.include.filter((pattern) => globMatcher(pattern)(repo.path))
    const excluding = draft.exclude.find((pattern) => globMatcher(pattern)(repo.path))
    const now = including.length > 0 && !excluding
    const before = matchesAny(saved.include, repo.path) && !matchesAny(saved.exclude, repo.path)
    for (const pattern of including) {
      const entry = counts.include[pattern]
      if (entry) entry[excluding ? 'excluded' : 'members'] += 1
    }
    if (including.length && excluding)
      counts.exclude[excluding] = (counts.exclude[excluding] ?? 0) + 1
    const pattern = including.find(isExactPattern) ?? including[0]
    const source = pattern !== undefined && isExactPattern(pattern) ? 'exact' : 'listed'
    if (now)
      rows.push({
        repo,
        state: before ? 'member' : 'joins',
        ...(pattern ? { pattern } : {}),
        source,
      })
    else if (before) {
      const kept = saved.include.find((p) => globMatcher(p)(repo.path))
      rows.push({
        repo,
        state: 'leaves',
        ...(kept ? { pattern: kept } : {}),
        source: kept !== undefined && isExactPattern(kept) ? 'exact' : 'listed',
      })
    } else if (including.length && excluding)
      rows.push({ repo, state: 'excluded', pattern: excluding, source })
  }
  rows.sort(
    (a, b) => stateOrder[a.state] - stateOrder[b.state] || a.repo.path.localeCompare(b.repo.path),
  )
  return {
    rows,
    counts,
    members: rows.filter((row) => row.state === 'member' || row.state === 'joins').length,
    excluded: rows.filter((row) => row.state === 'excluded').length,
    joins: rows.filter((row) => row.state === 'joins').length,
    leaves: rows.filter((row) => row.state === 'leaves').length,
  }
}

/** Words and tag tone for a membership state. */
export const membershipLabels: Record<MembershipState, { label: string; tone: DotTone }> = {
  member: { label: 'Member', tone: 'success' },
  excluded: { label: 'Excluded', tone: 'none' },
  joins: { label: 'Joins on save', tone: 'info' },
  leaves: { label: 'Leaves on save', tone: 'warning' },
}

/** "acme/payout-* adds 1 repository, removes 2" for the unsaved-changes bar. */
export function membershipChangeText(membership: Pick<Membership, 'joins' | 'leaves'>): string {
  const parts = [
    ...(membership.joins ? [`adds ${plural(membership.joins, 'repository', 'repositories')}`] : []),
    ...(membership.leaves
      ? [`removes ${plural(membership.leaves, 'repository', 'repositories')}`]
      : []),
  ]
  return parts.length ? parts.join(', ') : 'changes no membership in the last listing'
}

const diff = (a: readonly string[], b: readonly string[]) =>
  a.filter((item) => !b.includes(item)).length + b.filter((item) => !a.includes(item)).length

/** How many patterns differ between `saved` and `draft`, counted per added or removed pattern. */
export function patternChanges(
  saved: Pick<GroupDocumentData, 'include' | 'exclude'>,
  draft: Pick<GroupDocumentData, 'include' | 'exclude'>,
): number {
  return diff(saved.include, draft.include) + diff(saved.exclude, draft.exclude)
}

/**
 * The group whose include patterns match most of `paths`, for the add wizard's suggestion; none
 * when no group matches any.
 */
export function suggestGroup(
  paths: readonly string[],
  groups: readonly { id: string; data: GroupDocumentData }[],
): string | undefined {
  let best: { id: string; hits: number } | undefined
  for (const group of groups) {
    const hits = paths.filter(
      (path) =>
        group.data.include.some((p) => !isExactPattern(p) && globMatcher(p)(path)) ||
        group.data.include.some((p) => isExactPattern(p) && sameNamespace(p, path)),
    ).length
    if (hits && (!best || hits > best.hits)) best = { id: group.id, hits }
  }
  return best?.id
}

const namespaceOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0))

const sameNamespace = (a: string, b: string) =>
  namespaceOf(a) !== '' && namespaceOf(a) === namespaceOf(b)
