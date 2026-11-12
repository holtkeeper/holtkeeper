import type { AnalyzerHealthView, JobAnalyzerView, SettingView } from '@holtkeeper/api'

import { ALL_LANE, type AutomationRule, describeRefresh, laneFreshness } from './automation-flow.ts'

/** Groups of Settings › Analyzers, by the workspace their records feed. */
export type AnalyzerArea = 'supply' | 'quality' | 'releases' | 'other'

/** Each group's title and the pages it feeds, in display order. */
export const analyzerAreas: readonly { id: AnalyzerArea; label: string; feeds: string }[] = [
  {
    id: 'supply',
    label: 'Supply chain',
    feeds: 'Libraries, Security, Licenses, Stack, Public API',
  },
  { id: 'quality', label: 'Quality', feeds: 'Coverage, Bundles, Assets, CI, Branches, Reviews' },
  { id: 'releases', label: 'Releases and knowledge', feeds: 'Releases, Guide, Learnings' },
  { id: 'other', label: 'Other', feeds: 'Analyses' },
]

const areas: Readonly<Record<string, AnalyzerArea>> = {
  depgraph: 'supply',
  renovate: 'supply',
  audit: 'supply',
  licenses: 'supply',
  stack: 'supply',
  browserslist: 'supply',
  'api-surface': 'supply',
  usages: 'supply',
  coverage: 'quality',
  bundle: 'quality',
  assets: 'quality',
  'ci-jobs': 'quality',
  branches: 'quality',
  review: 'quality',
  testids: 'quality',
  release: 'releases',
  guide: 'releases',
  tracker: 'releases',
  propagate: 'releases',
  'write-task': 'releases',
}

/** The group an analyzer is listed under; analyzers the panel does not know go to Other. */
export const analyzerArea = (kind: string): AnalyzerArea => areas[kind] ?? 'other'

/**
 * Whether an analyzer runs on its own, read from Automation: `on` when freshness or an enabled
 * rule covers every repository, `some` when enabled rules cover some groups only, `off` when it
 * runs only when someone starts it. There is no separate switch.
 */
export type AnalyzerState = 'on' | 'some' | 'off'

/** Words of a state. */
export const analyzerStateLabel: Readonly<Record<AnalyzerState, string>> = {
  on: 'On',
  some: 'Some repositories',
  off: 'Off',
}

/** One analyzer as Settings › Analyzers lists it. */
export interface AnalyzerRow {
  kind: string
  label: string
  area: AnalyzerArea
  scope: JobAnalyzerView['scope']
  /** It may call an LLM. */
  ai: boolean
  state: AnalyzerState
  /** Where it runs on its own: "Every repository", the groups, or "Only when started". */
  where: string
  /** What makes it run: freshness and the titles of the rules that queue it. */
  when: string[]
  /** Entries of `analyzers.<kind>` narrower than the organization's. */
  overrides: number
  health?: AnalyzerHealthView
}

/** The key of an analyzer's options. */
export const analyzerSettingKey = (kind: string): string => `analyzers.${kind}`

/** Whether an entry applies to fewer repositories than every one. */
export const isOverride = (entry: Pick<SettingView, 'scope'>): boolean => entry.scope.all !== true

/**
 * Every analyzer with its state, scope and triggers from `rules` (`automationRules` over the
 * stored triggers, schedules and policies), its override count from `settings` and its health,
 * grouped by area in `analyzerAreas` order and by label within a group. Rules that only run on new
 * repositories do not make an analyzer `on`.
 */
export function analyzerRows(input: {
  analyzers: readonly JobAnalyzerView[]
  rules: readonly AutomationRule[]
  settings: readonly SettingView[]
  health?: readonly AnalyzerHealthView[]
}): AnalyzerRow[] {
  const freshnessOff = laneFreshness(input.settings, undefined).mode === 'off'
  const order = analyzerAreas.map((area) => area.id)
  return input.analyzers
    .map((analyzer): AnalyzerRow => {
      const automatic = input.rules.filter(
        (rule) =>
          rule.enabled &&
          rule.analyzers.includes(analyzer.kind) &&
          rule.events.some((event) => event !== 'newRepo'),
      )
      const fresh = analyzer.refresh !== undefined && !freshnessOff
      const everywhere = fresh || automatic.some((rule) => rule.lanes.includes(ALL_LANE))
      const groups = [...new Set(automatic.flatMap((rule) => rule.lanes))].filter(
        (lane) => lane !== ALL_LANE,
      )
      const state: AnalyzerState = everywhere ? 'on' : automatic.length ? 'some' : 'off'
      const health = input.health?.find((entry) => entry.analyzer === analyzer.kind)
      const key = analyzerSettingKey(analyzer.kind)
      return {
        kind: analyzer.kind,
        label: analyzer.label,
        area: analyzerArea(analyzer.kind),
        scope: analyzer.scope,
        ai: analyzer.needs.agent !== undefined,
        state,
        where:
          state === 'on'
            ? 'Every repository'
            : state === 'some'
              ? groups.toSorted().join(', ')
              : 'Only when started',
        when: [
          ...(fresh && analyzer.refresh ? [`Freshness ${describeRefresh(analyzer.refresh)}`] : []),
          ...automatic.map((rule) => rule.title),
        ],
        overrides: input.settings.filter(
          (entry) => entry.key === key && !entry.secret && isOverride(entry),
        ).length,
        ...(health && { health }),
      }
    })
    .toSorted(
      (a, b) => order.indexOf(a.area) - order.indexOf(b.area) || a.label.localeCompare(b.label),
    )
}

/** How an analyzer did over the health window, in words, with a tone for its tag. */
export function healthSummary(health: AnalyzerHealthView | undefined): {
  text: string
  tone: 'success' | 'warning' | 'danger' | 'default'
} {
  if (!health || health.runs === 0) return { text: 'No runs', tone: 'default' }
  if (health.failed > 0)
    return {
      text: `${health.failed} of ${health.runs} failed`,
      tone: health.failed * 2 >= health.runs ? 'danger' : 'warning',
    }
  if (health.blocked > 0) return { text: `${health.blocked} stopped by budget`, tone: 'warning' }
  return { text: `${health.runs} ${health.runs === 1 ? 'run' : 'runs'}, all fine`, tone: 'success' }
}

/** Whether an analyzer needs a look: failed or budget-stopped runs in the window. */
export const needsLook = (row: Pick<AnalyzerRow, 'health'>): boolean =>
  (row.health?.failed ?? 0) + (row.health?.blocked ?? 0) > 0

/** Filters of the analyzer table; empty lists match everything. */
export interface AnalyzerFilter {
  state?: AnalyzerState
  areas?: readonly AnalyzerArea[]
  /** `yes` only analyzers that use AI, `no` only the others. */
  ai?: 'yes' | 'no'
  q?: string
}

/** The rows matching `filter`; `q` matches the label and the kind, case-insensitively. */
export function filterAnalyzerRows(
  rows: readonly AnalyzerRow[],
  filter: AnalyzerFilter,
): AnalyzerRow[] {
  const q = filter.q?.trim().toLowerCase()
  return rows.filter(
    (row) =>
      (!filter.state || row.state === filter.state) &&
      (!filter.areas?.length || filter.areas.includes(row.area)) &&
      (!filter.ai || (filter.ai === 'yes') === row.ai) &&
      (!q || row.label.toLowerCase().includes(q) || row.kind.includes(q)),
  )
}

/** Counts for the state tabs and the summary strip. */
export function analyzerCounts(rows: readonly AnalyzerRow[]) {
  return {
    all: rows.length,
    on: rows.filter((row) => row.state === 'on').length,
    some: rows.filter((row) => row.state === 'some').length,
    off: rows.filter((row) => row.state === 'off').length,
    overrides: rows.reduce((sum, row) => sum + row.overrides, 0),
    ai: rows.filter((row) => row.ai).length,
    warn: rows.filter(needsLook).length,
  }
}
