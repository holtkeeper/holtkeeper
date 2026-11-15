import {
  type Action,
  type HealthTone,
  type RepoHealthCellKey,
  type RepoHealthStatus,
  type RepoRef,
  type RepoSummary,
  type TeamConfigView,
  type TeamMember,
  patternMatches,
} from '@holtkeeper/api'

import type { DotTone } from '../ui/Legend.tsx'
import type { StripCell } from '../ui/Strip.tsx'
import { plural } from './format.ts'
import { healthLabels, healthOrder, repoHealth } from './home.ts'
import { type PageTab, hubSearch, pickTab, visibleTabs } from './repo-page.ts'
import type { RepoHubSearch, RepoHubTab } from './repo.ts'
import { repoKey, repoSplat } from './repo.ts'
import { sheetCommand } from './sheet.ts'
import type { SortState, SortValue } from './table-sort.ts'
import { type TeamTitleOf, byTeamTitle, keyAsTitle, teamMatchesQuery } from './team-titles.ts'

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
 * the sorted column, and the folder the tree on the left selects (`forge:folder`, or `forge:` for a
 * whole forge). No sort means worst first; teams come from the scope switch.
 */
export interface ReposSearch {
  q?: string
  folder?: string
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
  const folder =
    typeof search.folder === 'string' && search.folder.includes(':') ? search.folder : ''
  return {
    ...(q ? { q } : {}),
    ...(folder ? { folder } : {}),
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

/** Whether `summary` matches the text filter: its `forge:path` or one of its teams (key or title). */
const matchesRepoQuery = (
  summary: RepoSummary,
  query: string | undefined,
  titleOf: TeamTitleOf,
): boolean => {
  const needle = query?.trim().toLowerCase()
  return (
    !needle ||
    repoKey(summary.repo).toLowerCase().includes(needle) ||
    summary.teams.some((team) => teamMatchesQuery(team, titleOf, needle))
  )
}

/**
 * The repositories `search` keeps: text (teams by key or `titleOf`), health states, forges and the
 * selected folder.
 */
export const filterRepos = (
  repos: readonly RepoSummary[],
  search: ReposSearch,
  titleOf: TeamTitleOf = keyAsTitle,
): RepoSummary[] =>
  repos.filter(
    (summary) =>
      matchesRepoQuery(summary, search.q, titleOf) &&
      (!search.health?.length || search.health.includes(summary.health)) &&
      (!search.forge?.length || search.forge.includes(summary.repo.forge)) &&
      (search.folder === undefined || inFolderKey(summary.repo, search.folder)),
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

/** What a health count line says, worst first, zero states left out: `["2 failing", "5 healthy"]`. */
export const healthCountsText = (counts: Record<RepoHealthStatus, number>): string[] =>
  healthOrder
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${healthLabels[status].toLowerCase()}`)

/** Whether a team's `owns` patterns match the repository and none of its `exclude` patterns do. */
export const teamOwns = (team: Pick<TeamConfigView, 'owns' | 'exclude'>, repo: RepoRef): boolean =>
  team.owns.some((pattern) => patternMatches(pattern, repo.forge, repo.path)) &&
  !team.exclude.some((pattern) => patternMatches(pattern, repo.forge, repo.path))

/** Whether one of a team's `consumes` patterns matches the repository. */
export const teamConsumes = (team: Pick<TeamConfigView, 'consumes'>, repo: RepoRef): boolean =>
  team.consumes.some((pattern) => patternMatches(pattern, repo.forge, repo.path))

/** One row of the Teams list: a team, its definition when readable, and its fleet repositories. */
export interface TeamRow {
  id: string
  /** The team document; absent when the viewer may not read the config (only owner teams known). */
  definition?: TeamConfigView
  /** Fleet repositories the team owns that the viewer can see. */
  repos: RepoSummary[]
  /** Fleet repositories it consumes (and does not own); 0 without the definition. */
  consumed: number
  counts: Record<RepoHealthStatus, number>
  /** The team itself, so the list splits by home teams like any fleet list. */
  teams: string[]
}

/**
 * Every team the viewer can see: those in the config (when it may read it) and the owner teams of
 * its visible repositories. With a definition, what it owns and consumes is computed from its
 * patterns over `repos` (the fleet listing the server sent); without one, from `RepoSummary.teams`.
 * Sorted by title.
 */
export function teamRows(
  repos: readonly RepoSummary[],
  config: readonly { id: string; data: TeamConfigView }[] = [],
  titleOf: TeamTitleOf = keyAsTitle,
): TeamRow[] {
  const ids = [...new Set([...config.map((entry) => entry.id), ...repos.flatMap((r) => r.teams)])]
  return ids.toSorted(byTeamTitle(titleOf)).map((id) => {
    const definition = config.find((entry) => entry.id === id)?.data
    const owned = definition
      ? repos.filter((r) => teamOwns(definition, r.repo))
      : repos.filter((r) => r.teams.includes(id))
    const consumed = definition
      ? repos.filter((r) => teamConsumes(definition, r.repo) && !owned.includes(r)).length
      : 0
    return {
      id,
      ...(definition ? { definition } : {}),
      repos: owned,
      consumed,
      counts: countHealth(owned),
      teams: [id],
    }
  })
}

/** How the signed-in principal may edit a team: everything, title and members only, or nothing. */
export type TeamEditLevel = 'full' | 'members' | 'none'

const writesSettings = (actions: readonly string[]) =>
  actions.includes('*') || actions.includes('settings:write')

const distinctTrimmed = (items: readonly string[]) => [
  ...new Set(items.map((item) => item.trim()).filter(Boolean)),
]

/**
 * Global `settings:write` edits everything (patterns widen access, so only it may); a maintainer,
 * holding `*` on a grant naming the team, edits its title and members. The server checks again.
 */
export function teamEditLevel(
  grants: readonly {
    actions: readonly string[]
    scope: { all?: boolean; teams?: readonly string[] }
  }[],
  team: string | undefined,
): TeamEditLevel {
  if (grants.some((grant) => grant.scope.all && writesSettings(grant.actions))) return 'full'
  if (
    team !== undefined &&
    grants.some((grant) => grant.scope.teams?.includes(team) && grant.actions.includes('*'))
  )
    return 'members'
  return 'none'
}

/** What the team dialog edits; patterns and members as lists. */
export interface TeamDraft {
  id: string
  title: string
  owns: string[]
  exclude: string[]
  consumes: string[]
  members: TeamMember[]
}

/** A draft from a stored team, or an empty one. */
export const toTeamDraft = (id = '', data?: TeamConfigView): TeamDraft => ({
  id,
  title: data?.title ?? '',
  owns: [...(data?.owns ?? [])],
  exclude: [...(data?.exclude ?? [])],
  consumes: [...(data?.consumes ?? [])],
  members: (data?.members ?? []).map((member) => ({ ...member })),
})

/** The `PUT /api/config/teams/:id` body of a draft: trimmed, duplicates and blank members dropped. */
export function toTeamInput(draft: TeamDraft): {
  title?: string
  owns: string[]
  exclude: string[]
  consumes: string[]
  members: TeamMember[]
} {
  const list = distinctTrimmed
  const seen = new Set<string>()
  const members = draft.members.flatMap((member) => {
    const id = member.id.trim()
    if (!id || seen.has(id)) return []
    seen.add(id)
    return [{ id, role: member.role }]
  })
  const title = draft.title.trim()
  return {
    ...(title ? { title } : {}),
    owns: list(draft.owns),
    exclude: list(draft.exclude),
    consumes: list(draft.consumes),
    members,
  }
}

/** The team page's tabs in display order; also its `tab` search parameter. */
const teamPageTabs = [
  { id: 'repos', label: 'Repositories' },
  { id: 'stack', label: 'Stack & conventions', requires: ['analyses:read'] },
  { id: 'knowledge', label: 'Knowledge', requires: ['knowledge:read'] },
  { id: 'settings', label: 'Settings', requires: ['settings:read'] },
] as const satisfies readonly PageTab<string>[]

/** Id of a team page tab. */
type TeamPageTab = (typeof teamPageTabs)[number]['id']

/** The team tabs the viewer may see, and the requested one when visible, else the first. */
export function pickTeamTab(
  can: (action: Action) => boolean,
  requested: string | undefined,
): { tabs: (typeof teamPageTabs)[number][]; tab: TeamPageTab } {
  const tabs = visibleTabs<(typeof teamPageTabs)[number]>(teamPageTabs, can)
  return { tabs, tab: pickTab(tabs, requested) ?? 'repos' }
}

/**
 * The repositories of `repos` a draft owns under its patterns, compared with the saved team:
 * `joins` are owned only under the draft, `leaves` only under the saved patterns.
 */
export function ownershipChange(
  repos: readonly RepoSummary[],
  saved: Pick<TeamConfigView, 'owns' | 'exclude'> | undefined,
  draft: Pick<TeamConfigView, 'owns' | 'exclude'>,
): { owned: RepoSummary[]; joins: RepoSummary[]; leaves: RepoSummary[] } {
  const owned = repos.filter((r) => teamOwns(draft, r.repo))
  const before = saved ? repos.filter((r) => teamOwns(saved, r.repo)) : []
  return {
    owned,
    joins: owned.filter((r) => !before.includes(r)),
    leaves: before.filter((r) => !owned.includes(r)),
  }
}

/** "adds 1 repository, removes 2" for the unsaved-changes line; empty when nothing changes. */
export function ownershipChangeText(change: {
  joins: readonly unknown[]
  leaves: readonly unknown[]
}) {
  return [
    ...(change.joins.length
      ? [`adds ${plural(change.joins.length, 'repository', 'repositories')}`]
      : []),
    ...(change.leaves.length
      ? [`removes ${plural(change.leaves.length, 'repository', 'repositories')}`]
      : []),
  ].join(', ')
}

/** One folder of the repository tree: a forge root (`folder` empty) or a path prefix. */
export interface FolderNode {
  forge: string
  /** The folder path, `acme/round`; empty for the forge root. */
  folder: string
  /** The last segment, or the forge id for the root. */
  name: string
  /** Repositories anywhere below it. */
  total: number
  children: FolderNode[]
}

/** `forge:folder`, the folder's key in the tree and in `ReposSearch.folder`; `forge:` for a root. */
export const folderKey = (node: Pick<FolderNode, 'forge' | 'folder'>): string =>
  `${node.forge}:${node.folder}`

/** Whether `repo` sits below the folder of `key` (`forge:folder`, `forge:` for every repository there). */
export function inFolderKey(repo: RepoRef, key: string): boolean {
  const separator = key.indexOf(':')
  const forge = key.slice(0, separator)
  const folder = key.slice(separator + 1)
  return repo.forge === forge && (folder === '' || repo.path.startsWith(`${folder}/`))
}

/**
 * The folder tree of `repos`: every prefix of a repository path is a folder, sorted by name, each
 * with how many repositories it holds. One root per forge; with a single forge its root is left
 * out and its top folders are the roots.
 */
export function folderTree(repos: readonly RepoRef[]): FolderNode[] {
  const roots = new Map<string, FolderNode>()
  for (const repo of repos) {
    let node = roots.get(repo.forge)
    if (!node) {
      node = { forge: repo.forge, folder: '', name: repo.forge, total: 0, children: [] }
      roots.set(repo.forge, node)
    }
    node.total += 1
    const segments = repo.path.split('/').filter(Boolean)
    for (let end = 1; end < segments.length; end++) {
      const folder = segments.slice(0, end).join('/')
      let child: FolderNode | undefined = node.children.find((c) => c.folder === folder)
      if (!child) {
        child = { forge: repo.forge, folder, name: segments[end - 1] ?? '', total: 0, children: [] }
        node.children.push(child)
      }
      child.total += 1
      node = child
    }
  }
  const sort = (nodes: FolderNode[]): FolderNode[] =>
    nodes
      .map((node) => ({ ...node, children: sort(node.children) }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  const tree = sort([...roots.values()])
  return tree.length === 1 ? (tree[0]?.children ?? []) : tree
}

/** The keys of the folders holding `key`, outermost first, the forge root included. */
export function folderAncestors(key: string): string[] {
  const separator = key.indexOf(':')
  const forge = key.slice(0, separator)
  const segments = key
    .slice(separator + 1)
    .split('/')
    .filter(Boolean)
  return [
    `${forge}:`,
    ...segments
      .slice(0, -1)
      .map((_, index) => `${forge}:${segments.slice(0, index + 1).join('/')}`),
  ]
}

/** A folder key in words: `acme/round`, or `forge work` for a forge root. */
export const folderLabel = (key: string): string => {
  const separator = key.indexOf(':')
  const folder = key.slice(separator + 1)
  return folder || `forge ${key.slice(0, separator)}`
}
