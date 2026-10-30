import type { LifecycleCycle, StackComponent, StackData, StackUsage } from './types.ts'
import {
  compareVersionText,
  type Lag,
  lagOf,
  majorsBehind,
  parseVersion,
  sortVersions,
} from './version.ts'

/** Support of a release line at analysis time. */
export type Support = 'lts' | 'active' | 'eol-soon' | 'eol' | 'unknown'

/** How one usage stands: lag behind the latest release and support of its release line. */
export interface UsageStatus {
  /** `floating` when the usage names no version (`latest`, `lts`, a missing tag). */
  lag: Lag | 'floating'
  support: Support
  cycle?: LifecycleCycle
  /** End of life of the release line, when it has a date. */
  eolDate?: string
  majorsBehind?: number
  /** Newest release of the usage's line when the usage pins an older one. */
  cycleLatest?: string
}

/**
 * The release line a version belongs to: the longest cycle that prefixes it (`22.11.0` → `22`,
 * `1.23.4` → `1.23`), else the newest cycle it prefixes (a floating `3` → the newest `3.x`).
 */
export function matchCycle(version: string, cycles: LifecycleCycle[]): LifecycleCycle | undefined {
  const parts = parseVersion(version)?.parts
  if (!parts) return undefined
  let best: { cycle: LifecycleCycle; length: number } | undefined
  let floating: LifecycleCycle | undefined
  for (const cycle of cycles) {
    const cycleParts = parseVersion(cycle.cycle)?.parts
    if (!cycleParts) continue
    const shared = Math.min(parts.length, cycleParts.length)
    if (cycleParts.slice(0, shared).some((part, index) => part !== parts[index])) continue
    if (cycleParts.length <= parts.length) {
      if (!best || cycleParts.length > best.length) best = { cycle, length: cycleParts.length }
    } else if (!floating || compareVersionText(cycle.cycle, floating.cycle) > 0) floating = cycle
  }
  return best?.cycle ?? floating
}

/** Whether a release line has ended at `at`. */
export const hasEnded = (cycle: LifecycleCycle, at: Date) =>
  cycle.eol === true || (typeof cycle.eol === 'string' && new Date(cycle.eol) <= at)

/** Whether a release line is in long-term support at `at`. */
export const isLts = (cycle: LifecycleCycle, at: Date) =>
  cycle.lts === true || (typeof cycle.lts === 'string' && new Date(cycle.lts) <= at)

const day = 86_400_000

/** Support of a release line at `at`; ends within `soonDays` count as `eol-soon`. */
export function supportOf(cycle: LifecycleCycle | undefined, at: Date, soonDays: number): Support {
  if (!cycle) return 'unknown'
  if (hasEnded(cycle, at)) return 'eol'
  if (
    typeof cycle.eol === 'string' &&
    new Date(cycle.eol).getTime() - at.getTime() <= soonDays * day
  )
    return 'eol-soon'
  if (isLts(cycle, at)) return 'lts'
  return 'active'
}

/** Lag and support of one usage of `component`, judged at `at`. */
export function assessUsage(
  component: Pick<StackComponent, 'latest' | 'cycles'>,
  usage: StackUsage,
  at: Date,
  soonDays: number,
): UsageStatus {
  if (!usage.version) return { lag: 'floating', support: 'unknown' }
  const cycle = component.cycles ? matchCycle(usage.version, component.cycles) : undefined
  const behind = majorsBehind(usage.version, component.latest)
  const pinnedOlder =
    cycle?.latest &&
    lagOf(usage.version, cycle.latest) !== 'current' &&
    lagOf(usage.version, cycle.latest) !== 'ahead'
  return {
    lag: lagOf(usage.version, component.latest),
    support: supportOf(cycle, at, soonDays),
    ...(cycle ? { cycle } : {}),
    ...(cycle && typeof cycle.eol === 'string' ? { eolDate: cycle.eol } : {}),
    ...(behind !== undefined ? { majorsBehind: behind } : {}),
    ...(pinnedOlder && cycle.latest ? { cycleLatest: cycle.latest } : {}),
  }
}

/** Orders versions by the newest release each admits, so a floating `22` sorts after a pinned `22.3`. */
function compareNewest(a: string | undefined, b: string | undefined): number {
  const left = a ? parseVersion(a)?.parts : undefined
  const right = b ? parseVersion(b)?.parts : undefined
  if (!left || !right) return left ? -1 : right ? 1 : 0
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? Infinity) - (right[index] ?? Infinity)
    if (diff !== 0 && !Number.isNaN(diff)) return diff
  }
  return 0
}

const severity = (status: UsageStatus) =>
  status.support === 'eol'
    ? 6
    : status.support === 'eol-soon'
      ? 5
      : status.lag === 'major'
        ? 4
        : status.lag === 'minor'
          ? 3
          : status.lag === 'patch'
            ? 2
            : status.lag === 'floating'
              ? 1
              : 0

/** What one repository uses of one component: its most worrying usage and every version it names. */
export interface StackCell {
  usage: StackUsage
  status: UsageStatus
  /** Distinct versions (or declared values when floating), oldest first. */
  versions: string[]
  files: string[]
}

/** A release line in use, with the repositories on it. */
export interface CycleInUse {
  cycle: LifecycleCycle
  support: Support
  repos: string[]
}

/** How one component is spread across the fleet. */
export interface ComponentSummary {
  component: StackComponent
  /** Cells by repository path; repositories without the component are absent. */
  cells: Map<string, StackCell>
  /** Distinct pinned versions, oldest first. */
  versions: string[]
  /** Distinct majors in use, ascending. */
  majors: string[]
  cycles: CycleInUse[]
  eolRepos: string[]
  soonRepos: string[]
  behindMajorRepos: string[]
  floatingRepos: string[]
}

/** Per-repository cells and fleet-wide spread of one component, judged at `at`. */
export function summarizeComponent(
  component: StackComponent,
  at: Date,
  soonDays: number,
): ComponentSummary {
  const cells = new Map<string, StackCell>()
  const cycles = new Map<string, CycleInUse>()
  for (const [repo, usages] of Map.groupBy(component.usages, (usage) => usage.repo)) {
    const assessed = usages.map((usage) => ({
      usage,
      status: assessUsage(component, usage, at, soonDays),
    }))
    const worst = assessed.toSorted(
      (a, b) =>
        severity(b.status) - severity(a.status) || compareNewest(a.usage.version, b.usage.version),
    )[0]
    if (!worst) continue
    cells.set(repo, {
      ...worst,
      versions: sortVersions(usages.map((usage) => usage.version ?? usage.declared)),
      files: [...new Set(usages.map((usage) => usage.file))],
    })
    for (const { status } of assessed) {
      if (!status.cycle) continue
      const entry = cycles.get(status.cycle.cycle) ?? {
        cycle: status.cycle,
        support: status.support,
        repos: [],
      }
      if (!entry.repos.includes(repo)) entry.repos.push(repo)
      cycles.set(status.cycle.cycle, entry)
    }
  }
  const versions = sortVersions(
    component.usages.map((usage) => usage.version).filter((version) => version !== undefined),
  )
  const majors = sortVersions(versions.map((version) => String(parseVersion(version)?.parts[0])))
  const reposWhere = (test: (cell: StackCell) => boolean) =>
    [...cells]
      .filter(([, cell]) => test(cell))
      .map(([repo]) => repo)
      .toSorted()
  return {
    component,
    cells,
    versions,
    majors,
    cycles: [...cycles.values()].toSorted((a, b) =>
      compareVersionText(a.cycle.cycle, b.cycle.cycle),
    ),
    eolRepos: reposWhere((cell) => cell.status.support === 'eol'),
    soonRepos: reposWhere((cell) => cell.status.support === 'eol-soon'),
    behindMajorRepos: reposWhere((cell) => cell.status.lag === 'major'),
    floatingRepos: reposWhere((cell) => cell.status.lag === 'floating'),
  }
}

/** Summaries of every component of a record, judged at its `checkedAt`. */
export const summarizeStack = (data: StackData) =>
  data.components.map((component) =>
    summarizeComponent(component, new Date(data.checkedAt), data.soonDays),
  )

/** Headline numbers of a stack analysis. */
export interface StackTotals {
  repos: number
  components: number
  reposOnEol: number
  reposEolSoon: number
  reposBehindMajor: number
  multiMajor: number
  floating: number
}

export function stackTotals(data: StackData, summaries = summarizeStack(data)): StackTotals {
  const union = (pick: (summary: ComponentSummary) => string[]) =>
    new Set(summaries.flatMap(pick)).size
  return {
    repos: data.repos.filter((repo) => !repo.error && !repo.archived).length,
    components: data.components.length,
    reposOnEol: union((summary) => summary.eolRepos),
    reposEolSoon: union((summary) => summary.soonRepos),
    reposBehindMajor: union((summary) => summary.behindMajorRepos),
    multiMajor: summaries.filter((summary) => summary.majors.length > 1).length,
    floating: summaries.reduce((sum, summary) => sum + summary.floatingRepos.length, 0),
  }
}
