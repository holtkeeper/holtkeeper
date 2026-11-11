import type {
  GroupMatch,
  StackComponentKind,
  StackConventionResult,
  StackConventionStatus,
  StackGroupView,
  StackSupport,
  StackUse,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { type ScopeView, foldOtherTeams, scopeList } from './home-scope.ts'

/** The tabs of the Stack page. */
export type StackTab = 'runtimes' | 'eol' | 'conventions'

const stackTabs: readonly StackTab[] = ['runtimes', 'eol', 'conventions']

export const parseStackTab = (value: unknown): StackTab =>
  stackTabs.find((tab) => tab === value) ?? 'runtimes'

const keyOf = (forge: string, path: string) => `${forge}:${path}`

/** The groups as a scope position shows them: each limited to the repositories it keeps. */
export interface ScopedStack {
  groups: StackGroupView[]
  counts: Record<ScopeView, number>
  /** Repositories outside the home groups and how many teams they belong to. */
  others: { repos: number; teams: number }
}

/** Keeps only the repositories `keep` accepts, in every part of a group. */
function narrowGroup(group: StackGroupView, keep: (repo: string) => boolean): StackGroupView {
  return {
    ...group,
    repos: group.repos.filter((repo) => keep(repo.path)),
    tools: group.tools
      .map((tool) => ({ ...tool, uses: tool.uses.filter((use) => keep(use.repo)) }))
      .filter((tool) => tool.uses.length > 0),
    conventions: group.conventions.filter((result) => keep(result.repo)),
  }
}

/**
 * Splits the groups' repositories by the viewer's home groups (a UI default, not a permission);
 * `only` limits everything to one config group first, as the group page does.
 */
export function scopeStack(
  groups: readonly StackGroupView[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
  only?: string,
): ScopedStack {
  const picked = only ? groups.filter((group) => group.group === only) : groups
  const repos = picked.flatMap((group) =>
    group.repos.map((repo) => ({ key: keyOf(group.forge, repo.path), groups: repo.groups })),
  )
  const unique = [...new Map(repos.map((repo) => [repo.key, repo])).values()]
  const scoped = scopeList(unique, only ? 'all' : view, homeGroups)
  const shown = new Set(scoped.shown.map((repo) => repo.key))
  return {
    groups: picked
      .map((group) => narrowGroup(group, (path) => shown.has(keyOf(group.forge, path))))
      .filter((group) => group.repos.length > 0),
    counts: scoped.counts,
    others: { repos: scoped.others.items, teams: scoped.others.teams },
  }
}

/**
 * The groups limited to repositories outside the home groups, and the teams those are in: what the
 * *My team* view folds into a collapsed "Other teams" section. Empty without home groups.
 */
export function otherTeamsStack(
  groups: readonly StackGroupView[],
  homeGroups: readonly GroupMatch[],
): { groups: StackGroupView[]; repos: number; teams: string[] } {
  if (!homeGroups.length) return { groups: [], repos: 0, teams: [] }
  const repos = groups.flatMap((group) =>
    group.repos.map((repo) => ({ key: keyOf(group.forge, repo.path), groups: repo.groups })),
  )
  const unique = [...new Map(repos.map((repo) => [repo.key, repo])).values()]
  const folded = foldOtherTeams(unique, homeGroups, (repo) => repo.groups)
  const others = new Set(folded.others.map((repo) => repo.key))
  return {
    groups: groups
      .map((group) => narrowGroup(group, (path) => others.has(keyOf(group.forge, path))))
      .filter((group) => group.repos.length > 0),
    repos: others.size,
    teams: folded.teams,
  }
}

const supportRank: Record<StackSupport, number> = {
  eol: 4,
  'eol-soon': 3,
  active: 2,
  lts: 2,
  unknown: 1,
}

/** The more worrying of two supports. */
const worseSupport = (a: StackSupport, b: StackSupport): StackSupport =>
  supportRank[b] > supportRank[a] ? b : a

export const supportTone = (support: StackSupport): StatusTone =>
  support === 'eol'
    ? 'danger'
    : support === 'eol-soon'
      ? 'warning'
      : support === 'unknown'
        ? 'default'
        : 'success'

export const supportLabel: Record<StackSupport, string> = {
  eol: 'end of life',
  'eol-soon': 'ends soon',
  lts: 'LTS',
  active: 'supported',
  unknown: 'unknown',
}

/** Where one use sits, with its repository as `forge:path`. */
interface PlacedUse extends StackUse {
  /** `forge:path`. */
  key: string
  group: string
}

/** Repositories on one version line of a tool. */
export interface VersionCell {
  /** The release line, else the major as written, else `floating`. */
  version: string
  support: StackSupport
  /** `forge:path`, sorted. */
  repos: string[]
  uses: PlacedUse[]
}

/** One tool across the shown groups, with a cell per version line in use. */
export interface ToolRow {
  id: string
  name: string
  kind: StackComponentKind
  latest?: string
  latestLts?: string
  /** Oldest line first; `floating` last. */
  versions: VersionCell[]
  repos: number
}

const kindOrder: StackComponentKind[] = [
  'runtime',
  'package-manager',
  'service',
  'os',
  'image',
  'tool',
]

/** The line a use counts under: its release line, else its major (`1.23` for `0.x`/`1.x`), else `floating`. */
export function versionLine(use: Pick<StackUse, 'cycle' | 'version'>): string {
  if (use.cycle) return use.cycle
  if (!use.version) return 'floating'
  const parts = use.version.split('.')
  return parts[0] === '0' || parts[0] === '1'
    ? parts.slice(0, 2).join('.')
    : (parts[0] ?? 'floating')
}

const compareLines = (a: string, b: string) => {
  if (a === 'floating' || b === 'floating')
    return Number(a === 'floating') - Number(b === 'floating')
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff && !Number.isNaN(diff)) return diff
  }
  return a.localeCompare(b)
}

/** Tools of the groups merged by id, runtimes first, then by how many repositories use them. */
export function toolRows(groups: readonly StackGroupView[]): ToolRow[] {
  const rows = new Map<string, ToolRow & { cells: Map<string, VersionCell> }>()
  for (const group of groups)
    for (const tool of group.tools) {
      const row = rows.get(tool.id) ?? {
        id: tool.id,
        name: tool.name,
        kind: tool.kind,
        versions: [],
        repos: 0,
        cells: new Map<string, VersionCell>(),
      }
      if (!row.latest && tool.latest) row.latest = tool.latest
      if (!row.latestLts && tool.latestLts) row.latestLts = tool.latestLts
      for (const use of tool.uses) {
        const line = versionLine(use)
        const cell = row.cells.get(line) ?? {
          version: line,
          support: use.support,
          repos: [],
          uses: [],
        }
        const key = keyOf(group.forge, use.repo)
        cell.support = worseSupport(cell.support, use.support)
        if (!cell.repos.includes(key)) cell.repos.push(key)
        cell.uses.push({ ...use, key, group: group.group })
        row.cells.set(line, cell)
      }
      rows.set(tool.id, row)
    }
  return [...rows.values()]
    .map(({ cells, ...row }) => {
      const versions = [...cells.values()]
        .map((cell) => ({ ...cell, repos: cell.repos.toSorted() }))
        .toSorted((a, b) => compareLines(a.version, b.version))
      return { ...row, versions, repos: new Set(versions.flatMap((cell) => cell.repos)).size }
    })
    .toSorted(
      (a, b) =>
        kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) ||
        b.repos - a.repos ||
        a.name.localeCompare(b.name),
    )
}

/** A repository on an ended or ending release line of one tool. */
export interface EolEntry {
  /** `forge:path`. */
  key: string
  repo: string
  group: string
  toolId: string
  tool: string
  cycle: string
  support: 'eol' | 'eol-soon'
  eolDate?: string
  /** Versions as written, oldest first. */
  declared: string[]
  files: string[]
  /** e.g. `node 18 → 24`, when a newer supported line is known. */
  fix?: string
}

/** The line of `target` with as many parts as `cycle`: `24.11.0` for line `18` is `24`. */
const lineOf = (target: string, cycle: string) =>
  target
    .replace(/^v/, '')
    .split('.')
    .slice(0, Math.max(1, cycle.split('.').length))
    .join('.')

/** Repositories on ended or ending lines, ended first, then by end date and repository. */
export function eolEntries(groups: readonly StackGroupView[]): EolEntry[] {
  const entries = new Map<string, EolEntry>()
  for (const group of groups)
    for (const tool of group.tools)
      for (const use of tool.uses) {
        if (use.support !== 'eol' && use.support !== 'eol-soon') continue
        const cycle = use.cycle ?? versionLine(use)
        const key = keyOf(group.forge, use.repo)
        const id = `${key}\0${tool.id}\0${cycle}`
        const target = tool.latestLts ?? tool.latest
        const line = target ? lineOf(target, cycle) : undefined
        const entry = entries.get(id) ?? {
          key,
          repo: use.repo,
          group: group.group,
          toolId: tool.id,
          tool: tool.name,
          cycle,
          support: use.support,
          ...(use.eolDate ? { eolDate: use.eolDate } : {}),
          declared: [],
          files: [],
          ...(line && line !== cycle ? { fix: `${tool.name} ${cycle} → ${line}` } : {}),
        }
        if (!entry.declared.includes(use.declared)) entry.declared.push(use.declared)
        if (!entry.files.includes(use.file)) entry.files.push(use.file)
        entries.set(id, entry)
      }
  return [...entries.values()].toSorted(
    (a, b) =>
      Number(a.support === 'eol-soon') - Number(b.support === 'eol-soon') ||
      (a.eolDate ?? '').localeCompare(b.eolDate ?? '') ||
      a.key.localeCompare(b.key) ||
      a.tool.localeCompare(b.tool),
  )
}

/** One convention result with where it comes from, for the side sheet and merge requests. */
export interface PlacedConvention extends StackConventionResult {
  /** `forge:path`. */
  key: string
  group: string
  analysisId: string
}

/** One repository's row of the conventions grid. */
interface ConventionRow {
  key: string
  group: string
  cells: Record<string, PlacedConvention | undefined>
}

/** The conventions grid: one column per convention file, one row per repository checked. */
export interface ConventionGrid {
  files: string[]
  rows: ConventionRow[]
  counts: Record<StackConventionStatus, number>
}

/** Repositories × convention files, drifting and missing repositories first. */
export function conventionGrid(groups: readonly StackGroupView[]): ConventionGrid {
  const files = new Set<string>()
  const rows = new Map<string, ConventionRow>()
  const counts: Record<StackConventionStatus, number> = {
    matches: 0,
    drifts: 0,
    missing: 0,
    error: 0,
  }
  for (const group of groups)
    for (const result of group.conventions) {
      const key = keyOf(group.forge, result.repo)
      files.add(result.file)
      counts[result.status] += 1
      const row = rows.get(key) ?? { key, group: group.group, cells: {} }
      row.cells[result.file] = { ...result, key, group: group.group, analysisId: group.analysisId }
      rows.set(key, row)
    }
  const failing = (row: ConventionRow) =>
    Object.values(row.cells).filter(
      (cell) => cell && (cell.status === 'drifts' || cell.status === 'missing'),
    ).length
  return {
    files: [...files].toSorted(),
    rows: [...rows.values()].toSorted(
      (a, b) => failing(b) - failing(a) || a.key.localeCompare(b.key),
    ),
    counts,
  }
}

export const conventionTone = (status: StackConventionStatus): StatusTone =>
  status === 'matches'
    ? 'success'
    : status === 'drifts'
      ? 'warning'
      : status === 'missing'
        ? 'danger'
        : 'default'

/** Since-last-week changes summed over the groups; `undefined` when no group has an earlier record. */
export function weeklyChanges(groups: readonly StackGroupView[]) {
  const withChanges = groups.flatMap((group) => (group.changes ? [group.changes] : []))
  if (!withChanges.length) return undefined
  const sum = (pick: (changes: NonNullable<StackGroupView['changes']>) => number) =>
    withChanges.reduce((total, changes) => total + pick(changes), 0)
  return {
    since: withChanges.map((changes) => changes.since).toSorted()[0] ?? '',
    newEol: sum((changes) => changes.newEol),
    resolvedEol: sum((changes) => changes.resolvedEol),
    newDrifts: sum((changes) => changes.newDrifts),
    resolvedDrifts: sum((changes) => changes.resolvedDrifts),
  }
}
