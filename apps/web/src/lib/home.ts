import type {
  GroupMatch,
  HealthTone,
  HomeAttentionItem,
  HomeAttentionKind,
  HomeChange,
  HomeSeverity,
  HomeSpend,
  HomeView,
  RepoHealthCellKey,
  RepoHealthStatus,
  RepoSummary,
} from '@holtkeeper/api'

import type { StatusTone } from '../ui/colors.ts'
import type { DotTone } from '../ui/Legend.tsx'
import type { Tick } from '../ui/TickStrip.tsx'
import { type AiFeature, featureLabel, featureOf } from './ai-features.ts'
import { type ScopeView, inHomeGroups } from './home-scope.ts'
import { repoKey } from './repo.ts'

/**
 * Whether a row about `refs` belongs to a scope position: rows about no repository belong to
 * every position, others when one of their repositories does.
 */
export function inScope(
  refs: readonly { groups: readonly string[] }[],
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): boolean {
  if (view === 'all' || !refs.length) return true
  return refs.some((ref) => inHomeGroups(homeGroups, ref.groups))
}

/** Needs attention and What changed narrowed to a scope position. */
export interface ScopedHome {
  attention: HomeAttentionItem[]
  changes: HomeChange[]
}

/** Narrows Home to a scope position; a UI default, the server already filtered by permission. */
export function scopeHome(
  home: Pick<HomeView, 'attention' | 'changes'>,
  view: ScopeView,
  homeGroups: readonly GroupMatch[],
): ScopedHome {
  return {
    attention: home.attention.filter((item) => inScope(item.repos, view, homeGroups)),
    changes: home.changes.filter((change) =>
      inScope(change.repo ? [change.repo] : [], view, homeGroups),
    ),
  }
}

/** Needs-attention rows in server order, snoozed ones moved after the rest. */
export const attentionRows = (items: readonly HomeAttentionItem[]): HomeAttentionItem[] => [
  ...items.filter((item) => !item.snoozed),
  ...items.filter((item) => item.snoozed),
]

/** Words per attention kind. */
export const attentionKindLabel: Record<HomeAttentionKind, string> = {
  'job-failures': 'Job failure',
  'budget-blocked': 'AI budget',
  vulnerabilities: 'Vulnerability',
  allowlist: 'Allowlist',
  'allowlist-expiring': 'Allowlist',
  release: 'Release',
  learnings: 'Learnings',
  knowledge: 'Knowledge',
  'stale-analyses': 'Stale analysis',
  'not-analysed': 'Not analysed',
}

/** How Needs attention groups its rows. */
export type AttentionGrouping = 'severity' | 'kind' | 'repo'

/** One group of Needs attention rows. */
export interface AttentionGroup {
  key: string
  label: string
  items: HomeAttentionItem[]
}

const severityOrder: readonly HomeSeverity[] = ['critical', 'high', 'medium', 'low']

const rank = (key: string) => severityOrder.findIndex((severity) => severity === key)

/**
 * Needs-attention rows grouped by severity (worst first), kind or first repository (by path,
 * rows about no repository last). Rows keep `attentionRows` order inside a group; snoozed rows are
 * left out unless `snoozed` is set.
 */
export function groupAttention(
  items: readonly HomeAttentionItem[],
  by: AttentionGrouping,
  snoozed = false,
): AttentionGroup[] {
  const rows = attentionRows(items).filter((item) => snoozed || !item.snoozed)
  const groups = new Map<string, AttentionGroup>()
  for (const item of rows) {
    const first = item.repos[0]?.repo
    const [key, label] =
      by === 'severity'
        ? [item.severity, severityLabel[item.severity]]
        : by === 'kind'
          ? [attentionKindLabel[item.kind], attentionKindLabel[item.kind]]
          : first
            ? [first, first.slice(first.indexOf(':') + 1)]
            : ['', 'No repository']
    const group = groups.get(key) ?? { key, label, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  const list = [...groups.values()]
  if (by === 'severity') return list.toSorted((a, b) => rank(a.key) - rank(b.key))
  if (by === 'repo')
    return list.toSorted(
      (a, b) => Number(!a.key) - Number(!b.key) || a.label.localeCompare(b.label),
    )
  return list
}

/** Dot tone per severity: critical and high are danger, medium warning, low plain. */
export const severityTone: Record<HomeSeverity, StatusTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'default',
}

/** Words per severity. */
export const severityLabel: Record<HomeSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

/** Words for a repository's overall health. */
export const healthLabels: Record<RepoHealthStatus, string> = {
  failing: 'Failing',
  warnings: 'With warnings',
  'not-analysed': 'Not analysed',
  healthy: 'Healthy',
}

/** Dot tone of a repository's overall health. */
export const healthTones: Record<RepoHealthStatus, DotTone> = {
  failing: 'danger',
  warnings: 'warning',
  'not-analysed': 'none',
  healthy: 'success',
}

/** Dot tone of one health cell. */
export const cellTones: Record<HealthTone, DotTone> = {
  bad: 'danger',
  warn: 'warning',
  info: 'info',
  ok: 'success',
  none: 'none',
}

/** Tag tone of a health tone. */
export const healthTagTone: Record<HealthTone, StatusTone> = {
  ok: 'success',
  warn: 'warning',
  bad: 'danger',
  info: 'info',
  none: 'default',
}

/** Tag tone of a dot tone: no data reads as a plain tag. */
export const dotToTagTone = (tone: DotTone): StatusTone => (tone === 'none' ? 'default' : tone)

/** Health cells in table order, with their column names. */
export const healthCells: readonly { key: RepoHealthCellKey; label: string }[] = [
  { key: 'jobs', label: 'Jobs' },
  { key: 'security', label: 'Security' },
  { key: 'release', label: 'Release' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'bundles', label: 'Bundle' },
  { key: 'ci', label: 'CI' },
  { key: 'licenses', label: 'Licenses' },
  { key: 'dependencies', label: 'Libraries' },
]

/** Health statuses worst first, the order of the fleet strip, its legend and the ranking. */
export const healthOrder: readonly RepoHealthStatus[] = [
  'failing',
  'warnings',
  'not-analysed',
  'healthy',
]

/** A repository placed in the worst-first ranking. */
export interface RankedRepo {
  summary: RepoSummary
  /** `forge:path` */
  key: string
  /** 10 per `bad` cell plus 1 per `warn` cell; higher is worse. */
  score: number
}

const cellScore: Record<HealthTone, number> = { bad: 10, warn: 1, info: 0, ok: 0, none: 0 }

/**
 * Repositories worst first: by overall health (failing, with warnings, not analysed, healthy),
 * then by the score of their cells, then by `forge:path`.
 */
export function repoHealth(repos: readonly RepoSummary[]): RankedRepo[] {
  return repos
    .map((summary) => ({
      summary,
      key: repoKey(summary.repo),
      score: Object.values(summary.cells).reduce((sum, cell) => sum + cellScore[cell.tone], 0),
    }))
    .toSorted(
      (a, b) =>
        healthOrder.indexOf(a.summary.health) - healthOrder.indexOf(b.summary.health) ||
        b.score - a.score ||
        a.key.localeCompare(b.key),
    )
}

/** Fleet totals: repositories per health status and records that are no longer current. */
export interface FleetCounts {
  repos: number
  byStatus: Record<RepoHealthStatus, number>
  /** Sum of `total - current` over the repositories' freshness the caller may read. */
  staleAnalyses: number
}

/** Totals of `repos`; every status is present, zero when no repository has it. */
export function fleetCounts(repos: readonly RepoSummary[]): FleetCounts {
  const byStatus: Record<RepoHealthStatus, number> = {
    failing: 0,
    warnings: 0,
    'not-analysed': 0,
    healthy: 0,
  }
  let staleAnalyses = 0
  for (const repo of repos) {
    byStatus[repo.health] += 1
    if (repo.freshness) staleAnalyses += Math.max(repo.freshness.total - repo.freshness.current, 0)
  }
  return { repos: repos.length, byStatus, staleAnalyses }
}

const tickTones: Record<RepoHealthStatus, Tick['tone']> = {
  failing: 'danger',
  warnings: 'warning',
  'not-analysed': 'skipped',
  healthy: 'success',
}

/** One tick per ranked repository, worst first, labelled with its path and health. */
export const fleetTicks = (ranked: readonly RankedRepo[]): Tick[] =>
  ranked.map(({ summary }) => ({
    tone: tickTones[summary.health],
    label: `${summary.repo.path}: ${healthLabels[summary.health]}`,
  }))

/** One feature on the spend meter, colored on a monochrome scale. */
export interface SpendSegment {
  label: string
  costUsd: number
  runs: number
  color: string
}

const spendShades = [88, 64, 44, 28] as const

const shade = (percent: number) => `color-mix(in oklab, var(--fg) ${percent}%, var(--raise))`

/**
 * The spend meter: spend summed per product feature (`featureOf`), the `top` largest (at most
 * four) darkest first, then the rest and spend no feature claims as one lightest Other segment.
 */
export function spendSegments(spend: Pick<HomeSpend, 'byFeature'>, top = 4): SpendSegment[] {
  const sums = new Map<AiFeature, { costUsd: number; runs: number }>()
  for (const entry of spend.byFeature) {
    const feature = featureOf(entry.feature)
    const sum = sums.get(feature) ?? { costUsd: 0, runs: 0 }
    sum.costUsd += entry.costUsd
    sum.runs += entry.runs
    sums.set(feature, sum)
  }
  const ranked = [...sums]
    .filter(([feature]) => feature !== 'other')
    .toSorted(([, a], [, b]) => b.costUsd - a.costUsd || b.runs - a.runs)
  const count = Math.min(top, spendShades.length)
  const head = ranked.slice(0, count).map(([feature, sum], index) => ({
    label: featureLabel[feature],
    costUsd: sum.costUsd,
    runs: sum.runs,
    color: shade(spendShades[index]!),
  }))
  const rest = [
    ...ranked.slice(count).map(([, sum]) => sum),
    ...(sums.has('other') ? [sums.get('other')!] : []),
  ]
  const restCost = rest.reduce((sum, entry) => sum + entry.costUsd, 0)
  if (restCost <= 0) return head
  return [
    ...head,
    {
      label: featureLabel.other,
      costUsd: restCost,
      runs: rest.reduce((sum, entry) => sum + entry.runs, 0),
      color: shade(14),
    },
  ]
}
