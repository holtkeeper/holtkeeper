import type {
  GroupMatch,
  StackComponentKind,
  StackConventionResult,
  StackConventionStatus,
  StackCycle,
  StackGroupView,
  StackLag,
  StackSupport,
  StackUse,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import { type ScopeCounts, type ScopeView, scopeList } from './home-scope.ts'
import { searchEntry, searchEnum, searchList, searchText } from './search-params.ts'

/** The views of the Stack page: the repository × tool matrix, or the conventions grid. */
export type StackTab = 'runtimes' | 'conventions'

const stackTabs: readonly StackTab[] = ['runtimes', 'conventions']

/** A known Stack view, else `runtimes`. */
export const parseStackTab = (value: unknown): StackTab =>
  stackTabs.find((tab) => tab === value) ?? 'runtimes'

const componentKinds: readonly StackComponentKind[] = [
  'runtime',
  'package-manager',
  'service',
  'os',
  'image',
  'tool',
]

/** The support segment of the matrix: cells ending soon, or already at end of life. */
export type StackSegment = Extract<StackSupport, 'eol' | 'eol-soon'>

/** Tabs of the version line sheet. */
export type StackPane = 'where' | 'cell'

/** Search parameters of `/supply/stack`; omitted keys are the defaults. */
export interface StackSearch {
  tab?: string
  /** Support segment; every cell when omitted. */
  segment?: StackSegment
  kind?: StackComponentKind[]
  /** The version line open in the sheet, as `lineKey` writes it. */
  line?: string
  /** `forge:path` of the selected matrix cell's repository. */
  repo?: string
  /** Tab of the sheet; Selected cell when a repository is selected, else Where declared. */
  pane?: StackPane
}

/** Reads `/supply/stack` search parameters, dropping unknown values and defaults. */
export const parseStackSearch = (search: Record<string, unknown>): StackSearch => ({
  ...searchEntry('tab', searchText(search.tab)),
  ...searchEntry('segment', searchEnum(search.segment, ['eol', 'eol-soon'] as const)),
  ...searchEntry('kind', searchList(search.kind, componentKinds)),
  ...searchEntry('line', searchText(search.line)),
  ...searchEntry('repo', searchText(search.repo)),
  ...searchEntry('pane', searchEnum(search.pane, ['where', 'cell'] as const)),
})

const keyOf = (forge: string, path: string) => `${forge}:${path}`

/** The groups as a scope position shows them: each limited to the repositories it keeps. */
export interface ScopedStack {
  groups: StackGroupView[]
  counts: ScopeCounts
}

function narrowGroup(
  group: StackGroupView,
  keep: (repo: string) => boolean,
  keepTool: (kind: StackComponentKind) => boolean = () => true,
): StackGroupView {
  return {
    ...group,
    repos: group.repos.filter((repo) => keep(repo.path)),
    tools: group.tools
      .filter((tool) => keepTool(tool.kind))
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
  }
}

/**
 * The groups limited to tools of `filter.kind`, or to one repository (`forge:path`); an empty
 * filter keeps everything.
 */
export function narrowStack(
  groups: readonly StackGroupView[],
  filter: { kind?: readonly StackComponentKind[]; repo?: string },
): StackGroupView[] {
  const kinds = filter.kind?.length ? new Set(filter.kind) : undefined
  return groups
    .map((group) => {
      const inGroups = new Set(
        group.repos
          .filter((repo) => !filter.repo || keyOf(group.forge, repo.path) === filter.repo)
          .map((repo) => repo.path),
      )
      return narrowGroup(
        group,
        (path) => inGroups.has(path),
        (kind) => !kinds || kinds.has(kind),
      )
    })
    .filter((group) => group.repos.length > 0)
}

const supportRank: Record<StackSupport, number> = {
  eol: 4,
  'eol-soon': 3,
  active: 2,
  lts: 2,
  unknown: 1,
}

const lagRank: Record<StackLag, number> = {
  major: 3,
  minor: 2,
  patch: 1,
  current: 0,
  ahead: 0,
  floating: 0,
  unknown: 0,
}

const worseSupport = (a: StackSupport, b: StackSupport): StackSupport =>
  supportRank[b] > supportRank[a] ? b : a

/** Tone of a support state: ended red, ending amber, unknown muted, supported green. */
export const supportTone = (support: StackSupport): StatusTone =>
  support === 'eol'
    ? 'danger'
    : support === 'eol-soon'
      ? 'warning'
      : support === 'unknown'
        ? 'default'
        : 'success'

/** A support state in words. */
export const supportLabel: Record<StackSupport, string> = {
  eol: 'End of life',
  'eol-soon': 'Ends soon',
  lts: 'LTS',
  active: 'Supported',
  unknown: 'No lifecycle',
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Apr 2027` for `2027-04-30`; the same text in every locale. */
export function monthYear(date: string): string {
  const [year, month] = date.split('-')
  const name = months[Number(month) - 1]
  return name && year ? `${name} ${year}` : date
}

/** What a matrix cell or version line says about its support, in words, with its tone. */
export interface CellStatus {
  label: string
  tone: StatusTone
}

/**
 * The status of a version in use: ended or ending lines by their date, supported lines behind
 * the latest release by how far, else LTS, Latest or Supported; no lifecycle when unknown.
 */
export function cellStatus(use: Pick<StackUse, 'support' | 'lag' | 'eolDate'>): CellStatus {
  if (use.support === 'eol') return { label: 'End of life', tone: 'danger' }
  if (use.support === 'eol-soon')
    return { label: use.eolDate ? `Ends ${monthYear(use.eolDate)}` : 'Ends soon', tone: 'warning' }
  if (use.support === 'unknown') return { label: 'No lifecycle', tone: 'default' }
  if (use.lag === 'major') return { label: 'Major behind', tone: 'info' }
  if (use.lag === 'minor') return { label: 'Minor behind', tone: 'info' }
  if (use.support === 'lts') return { label: 'LTS', tone: 'success' }
  return { label: use.lag === 'current' ? 'Latest' : 'Supported', tone: 'success' }
}

/** The legend under the matrix: every tone `cellStatus` uses, named. */
export const supportLegend: readonly { tone: StatusTone; label: string }[] = [
  { tone: 'danger', label: 'End of life' },
  { tone: 'warning', label: 'Ends within the warning window' },
  { tone: 'success', label: 'LTS, supported or latest' },
  { tone: 'info', label: 'Behind latest, still supported' },
  { tone: 'default', label: 'No published lifecycle' },
]

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
  /** End of life of the line when known. */
  eolDate?: string
  /** `forge:path`, sorted. */
  repos: string[]
  uses: PlacedUse[]
}

/** One tool across the shown groups, with each version line in use. */
export interface ToolRow {
  id: string
  name: string
  kind: StackComponentKind
  latest?: string
  latestLts?: string
  /** Release lines of the product, when the lifecycle source knows them. */
  cycles?: StackCycle[]
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
export function versionLines(groups: readonly StackGroupView[]): ToolRow[] {
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
      if (!row.cycles?.length && tool.cycles?.length) row.cycles = tool.cycles
      for (const use of tool.uses) {
        const line = versionLine(use)
        const cell: VersionCell = row.cells.get(line) ?? {
          version: line,
          support: use.support,
          repos: [],
          uses: [],
        }
        const key = keyOf(group.forge, use.repo)
        cell.support = worseSupport(cell.support, use.support)
        if (!cell.eolDate && use.eolDate) cell.eolDate = use.eolDate
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

/** One tool in one repository: the most worrying of its uses there. */
export interface MatrixCell {
  toolId: string
  /** The version line, as `versionLines` names it. */
  line: string
  /** The comparable version, else the version as written. */
  version: string
  support: StackSupport
  status: CellStatus
  eolDate?: string
  /** Every use of the tool in the repository, the shown one first. */
  uses: StackUse[]
}

/** A repository row of the matrix. */
export interface MatrixRow {
  /** `forge:path`. */
  key: string
  forge: string
  repo: string
  /** Config groups of the repository, for folding other teams. */
  groups: string[]
  webUrl?: string
  error?: string
  /** By tool id; a tool the repository does not use has no cell. */
  cells: Record<string, MatrixCell>
  /** The most worrying support of its cells. */
  worst?: StackSupport
}

/** A tool column of the matrix. */
export interface MatrixTool {
  id: string
  name: string
  kind: StackComponentKind
  latest?: string
  latestLts?: string
}

/** Repositories × tools: one cell per tool a repository uses. */
export interface RepoMatrix {
  tools: MatrixTool[]
  rows: MatrixRow[]
}

const useRank = (use: StackUse) => supportRank[use.support] * 10 + lagRank[use.lag]

/**
 * The repository × tool matrix of the groups: tool columns in `versionLines` order, repositories
 * worst support first. With `segment` only cells in it count, and repositories and tools without
 * such a cell are left out.
 */
export function repoMatrix(groups: readonly StackGroupView[], segment?: StackSegment): RepoMatrix {
  const rows = new Map<string, MatrixRow>()
  for (const group of groups)
    for (const repo of group.repos) {
      const key = keyOf(group.forge, repo.path)
      const row = rows.get(key) ?? {
        key,
        forge: group.forge,
        repo: repo.path,
        groups: [],
        cells: {},
        ...(repo.webUrl ? { webUrl: repo.webUrl } : {}),
        ...(repo.error ? { error: repo.error } : {}),
      }
      for (const name of repo.groups) if (!row.groups.includes(name)) row.groups.push(name)
      rows.set(key, row)
    }
  const uses = new Map<string, StackUse[]>()
  for (const group of groups)
    for (const tool of group.tools)
      for (const use of tool.uses) {
        const id = `${keyOf(group.forge, use.repo)}\0${tool.id}`
        uses.set(id, [...(uses.get(id) ?? []), use])
      }
  for (const [id, list] of uses) {
    const [key = '', toolId = ''] = id.split('\0')
    const row = rows.get(key)
    if (!row) continue
    const sorted = list.toSorted((a, b) => useRank(b) - useRank(a))
    const shown = sorted[0]!
    if (segment && shown.support !== segment) continue
    row.cells[toolId] = {
      toolId,
      line: versionLine(shown),
      version: shown.version ?? shown.declared,
      support: shown.support,
      status: cellStatus(shown),
      ...(shown.eolDate ? { eolDate: shown.eolDate } : {}),
      uses: sorted,
    }
    row.worst = row.worst ? worseSupport(row.worst, shown.support) : shown.support
  }
  const used = new Set([...rows.values()].flatMap((row) => Object.keys(row.cells)))
  const tools = versionLines(groups)
    .filter((tool) => used.has(tool.id))
    .map(({ id, name, kind, latest, latestLts }) => ({
      id,
      name,
      kind,
      ...(latest ? { latest } : {}),
      ...(latestLts ? { latestLts } : {}),
    }))
  return {
    tools,
    rows: [...rows.values()]
      .filter((row) => !segment || Object.keys(row.cells).length > 0)
      .toSorted(
        (a, b) =>
          (b.worst ? supportRank[b.worst] : 0) - (a.worst ? supportRank[a.worst] : 0) ||
          a.key.localeCompare(b.key),
      ),
  }
}

/** Figures of a matrix for its summary strip and the support segment. */
export interface MatrixCounts {
  /** Repositories with at least one cell. */
  repos: number
  cells: number
  eol: number
  eolRepos: number
  eolSoon: number
}

/** Cells and repositories of the matrix in total and at or near end of life. */
export function matrixCounts(matrix: RepoMatrix): MatrixCounts {
  const counts: MatrixCounts = { repos: 0, cells: 0, eol: 0, eolRepos: 0, eolSoon: 0 }
  for (const row of matrix.rows) {
    const cells = Object.values(row.cells)
    if (cells.length) counts.repos += 1
    counts.cells += cells.length
    const eol = cells.filter((cell) => cell.support === 'eol').length
    counts.eol += eol
    if (eol) counts.eolRepos += 1
    counts.eolSoon += cells.filter((cell) => cell.support === 'eol-soon').length
  }
  return counts
}

/** The line of `target` with as many parts as `line`: `24.11.0` for line `18` is `24`. */
const lineOf = (target: string, line: string) =>
  target
    .replace(/^v/, '')
    .split('.')
    .slice(0, Math.max(1, line === 'floating' ? 1 : line.split('.').length))
    .join('.')

/** Support of a release line at `now`: ended, ending within `soonDays`, LTS or active. */
export function cycleSupport(cycle: StackCycle, now: Date, soonDays: number): StackSupport {
  if (cycle.eol === true) return 'eol'
  if (typeof cycle.eol === 'string') {
    const ends = new Date(cycle.eol).getTime()
    if (ends <= now.getTime()) return 'eol'
    if (ends <= now.getTime() + soonDays * 86_400_000) return 'eol-soon'
  }
  const lts = cycle.lts === true || (typeof cycle.lts === 'string' && new Date(cycle.lts) <= now)
  return lts ? 'lts' : 'active'
}

const endOf = (cycle: StackCycle) => (typeof cycle.eol === 'string' ? cycle.eol : undefined)

/** A newer release a version line can move to. */
export interface SuggestedStep {
  /** `suggested`: the newest LTS or latest release; `smaller`: the nearest newer supported line. */
  kind: 'suggested' | 'smaller'
  line: string
  version: string
  support: StackSupport
  eolDate?: string
}

/**
 * Where `line` of `tool` can move: the newest LTS release (else the latest), and, when the release
 * lines are known, the nearest newer line that has not ended (only LTS lines when the product has
 * them) as a smaller step. Empty when the line is already the newest or nothing newer is known.
 */
export function suggestedSteps(
  tool: Pick<ToolRow, 'latest' | 'latestLts' | 'cycles'>,
  line: string,
  now: Date,
  soonDays = 180,
): SuggestedStep[] {
  const target = tool.latestLts ?? tool.latest
  if (!target) return []
  const targetLine = lineOf(target, line)
  if (line !== 'floating' && compareLines(targetLine, line) <= 0) return []
  const cycles = tool.cycles ?? []
  const supportOf = (cycle: StackCycle) => cycleSupport(cycle, now, soonDays)
  const targetCycle = cycles.find((cycle) => cycle.cycle === targetLine)
  const targetEnd = targetCycle ? endOf(targetCycle) : undefined
  const steps: SuggestedStep[] = [
    {
      kind: 'suggested',
      line: targetLine,
      version: target,
      support: targetCycle ? supportOf(targetCycle) : tool.latestLts ? 'lts' : 'active',
      ...(targetEnd ? { eolDate: targetEnd } : {}),
    },
  ]
  if (line === 'floating') return steps
  const withLts = cycles.some((cycle) => cycle.lts)
  const smaller = cycles
    .filter(
      (cycle) =>
        compareLines(cycle.cycle, line) > 0 &&
        compareLines(cycle.cycle, targetLine) < 0 &&
        (!withLts || cycle.lts) &&
        supportOf(cycle) !== 'eol',
    )
    .toSorted((a, b) => compareLines(a.cycle, b.cycle))[0]
  if (smaller) {
    const end = endOf(smaller)
    steps.push({
      kind: 'smaller',
      line: smaller.cycle,
      version: smaller.latest ?? smaller.cycle,
      support: supportOf(smaller),
      ...(end ? { eolDate: end } : {}),
    })
  }
  return steps
}

/** One convention result with where it comes from, for the side sheet and merge requests. */
export interface PlacedConvention extends StackConventionResult {
  /** `forge:path`. */
  key: string
  group: string
  analysisId: string
}

/**
 * The convention result of the repository `key` (`forge:path`) for one of `files`, drifting or
 * missing ones first: the convention a version line's file is checked against.
 */
export function matchingConvention(
  groups: readonly StackGroupView[],
  key: string,
  files: readonly string[],
): PlacedConvention | undefined {
  const order: Record<StackConventionStatus, number> = {
    drifts: 0,
    missing: 1,
    error: 2,
    matches: 3,
  }
  return groups
    .flatMap((group) =>
      group.conventions
        .filter((result) => keyOf(group.forge, result.repo) === key && files.includes(result.file))
        .map((result) => ({ ...result, key, group: group.group, analysisId: group.analysisId })),
    )
    .toSorted((a, b) => order[a.status] - order[b.status])[0]
}

/** One repository's row of the conventions grid. */
export interface ConventionRow {
  /** `forge:path`. */
  key: string
  repo: string
  /** Config groups of the repository, for folding other teams. */
  groups: string[]
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
      const row = rows.get(key) ?? {
        key,
        repo: result.repo,
        groups: group.repos.find((repo) => repo.path === result.repo)?.groups ?? [group.group],
        cells: {},
      }
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

/** Tone of a convention status: matches green, drifts amber, missing red. */
export const conventionTone = (status: StackConventionStatus): StatusTone =>
  status === 'matches'
    ? 'success'
    : status === 'drifts'
      ? 'warning'
      : status === 'missing'
        ? 'danger'
        : 'default'

/** A convention status in words. */
export const conventionLabel: Record<StackConventionStatus, string> = {
  matches: 'Matches',
  drifts: 'Drifts',
  missing: 'Missing',
  error: 'Not compared',
}

/** Key of a convention check, unique within a grid. */
export const conventionKey = (result: Pick<PlacedConvention, 'key' | 'file'>): string =>
  `${result.key}\0${result.file}`

/** The checks a grid shows, row by row and file by file: the order J and K step through. */
export const conventionItems = (grid: ConventionGrid): PlacedConvention[] =>
  grid.rows.flatMap((row) => grid.files.flatMap((file) => row.cells[file] ?? []))

/** How the `line` search parameter names a version line of a tool. */
export const lineKey = (toolId: string, line: string): string => `${toolId}:${line}`

/** Reads `lineKey` back; tool ids may contain `:`, lines never do. */
export function parseLineKey(
  value: string | undefined,
): { toolId: string; line: string } | undefined {
  const at = value?.lastIndexOf(':') ?? -1
  if (!value || at <= 0 || at === value.length - 1) return undefined
  return { toolId: value.slice(0, at), line: value.slice(at + 1) }
}

/** What the line sheet shows: a version line, and the matrix cell's repository when one was picked. */
export interface StackSheetItem {
  line: string
  /** `forge:path`. */
  repo?: string
}

/** Key of a sheet item, for stepping with J and K. */
export const sheetKey = (item: StackSheetItem): string => `${item.line}\0${item.repo ?? ''}`

/**
 * Everything the line sheet steps through: from the matrix (`byCell`), every cell row by row and
 * left to right; from the version lines table, every line top to bottom.
 */
export function sheetItems(
  matrix: RepoMatrix,
  lines: readonly ToolRow[],
  byCell: boolean,
): StackSheetItem[] {
  if (!byCell)
    return lines.flatMap((tool) =>
      tool.versions.map((cell) => ({ line: lineKey(tool.id, cell.version) })),
    )
  return matrix.rows.flatMap((row) =>
    matrix.tools.flatMap((tool) => {
      const cell = row.cells[tool.id]
      return cell ? [{ line: lineKey(tool.id, cell.line), repo: row.key }] : []
    }),
  )
}

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
