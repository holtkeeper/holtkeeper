import type { AiFeatureSpend, AiUsageBucket } from '@holtkeeper/api'

/** Product areas spend is reported by, derived from a run's task kind. */
export type AiFeature = 'reviews' | 'tasks' | 'chat' | 'knowledge' | 'releases' | 'other'

/** Display name of each feature. */
export const featureLabel: Record<AiFeature, string> = {
  reviews: 'Reviews',
  tasks: 'Agent tasks',
  chat: 'Chat',
  knowledge: 'Guide and learnings',
  releases: 'Release notes',
  other: 'Other',
}

const featureKinds: readonly (readonly [AiFeature, readonly string[]])[] = [
  ['reviews', ['review', 'triage']],
  ['tasks', ['write-task', 'fix', 'port', 'propagate', 'upgrade', 'propagate-fix', 'tests']],
  ['chat', ['chat', 'chat-summary']],
  ['knowledge', ['guide', 'learning', 'library-digest']],
  ['releases', ['release-notes']],
]

/** The feature a run of `taskKind` belongs to; unknown and empty kinds are `other`. */
export function featureOf(taskKind: string): AiFeature {
  return featureKinds.find(([, kinds]) => kinds.includes(taskKind))?.[0] ?? 'other'
}

/** One feature's share of a period's spend. */
export interface FeatureShare {
  feature: AiFeature
  label: string
  costUsd: number
  runs: number
  /** Runs whose cost is unknown. */
  unknownCost: number
  /** Share of the total cost, 0 to 1; 0 when nothing was spent. */
  share: number
  /** Task kinds summed into it, in the order they came. */
  kinds: string[]
}

const byCost = (a: FeatureShare, b: FeatureShare) =>
  (a.feature === 'other' ? 1 : 0) - (b.feature === 'other' ? 1 : 0) ||
  b.costUsd - a.costUsd ||
  b.runs - a.runs

function shares(
  rows: readonly { kind: string; costUsd: number; runs: number; unknownCost: number }[],
): FeatureShare[] {
  const sums = new Map<AiFeature, FeatureShare>()
  for (const row of rows) {
    const feature = featureOf(row.kind)
    const item = sums.get(feature) ?? {
      feature,
      label: featureLabel[feature],
      costUsd: 0,
      runs: 0,
      unknownCost: 0,
      share: 0,
      kinds: [],
    }
    item.costUsd += row.costUsd
    item.runs += row.runs
    item.unknownCost += row.unknownCost
    if (!item.kinds.includes(row.kind)) item.kinds.push(row.kind)
    sums.set(feature, item)
  }
  const total = [...sums.values()].reduce((sum, item) => sum + item.costUsd, 0)
  return [...sums.values()]
    .map((item) => ({ ...item, share: total > 0 ? item.costUsd / total : 0 }))
    .toSorted(byCost)
}

/**
 * Spend per task kind (`AiBudgetOverview.byFeature`) summed per feature, most expensive first with
 * Other always last; features without runs are left out.
 */
export const featureBreakdown = (byFeature: readonly AiFeatureSpend[]): FeatureShare[] =>
  shares(
    byFeature.map((entry) => ({
      kind: entry.feature === 'other' ? '' : entry.feature,
      costUsd: entry.costUsd,
      runs: entry.runs,
      unknownCost: 0,
    })),
  )

/** Usage buckets grouped by `taskKind` summed per feature, ordered as `featureBreakdown`. */
export const featureItems = (buckets: readonly AiUsageBucket[]): FeatureShare[] =>
  shares(
    buckets.map((bucket) => ({
      kind: bucket.key.taskKind ?? '',
      costUsd: bucket.costUsd,
      runs: bucket.runs,
      unknownCost: bucket.unknownCost,
    })),
  )

/** Monochrome shades of the budget meter's feature segments, darkest first. */
const segmentShades = [88, 66, 48, 32, 20] as const

/** The meter color of the feature at `index` of a breakdown; Other is always the lightest. */
export function featureColor(feature: AiFeature, index: number): string {
  const shade = feature === 'other' ? 12 : segmentShades[Math.min(index, segmentShades.length - 1)]!
  return `color-mix(in oklab, var(--fg) ${shade}%, var(--raise))`
}

/**
 * Where the warning and stop lines sit on a budget meter, in percent of its full width, which is
 * the weekly limit or this week's spend when that went over it.
 */
export function budgetMarks(budget: { weeklyUsd: number; warnPercent: number; spentUsd: number }): {
  warnUsd: number
  warn: number
  stop: number
  scaleUsd: number
} {
  const warnUsd = (budget.weeklyUsd * budget.warnPercent) / 100
  const scaleUsd = Math.max(budget.weeklyUsd, budget.spentUsd)
  const at = (usd: number) => (scaleUsd > 0 ? (usd / scaleUsd) * 100 : 0)
  return { warnUsd, warn: at(warnUsd), stop: at(budget.weeklyUsd), scaleUsd }
}

/** Where a scoped cap stands this week, in words with the tone that says the same. */
export function capStatus(cap: { percent: number; warnPercent: number }): {
  tone: 'success' | 'warning' | 'danger'
  label: string
} {
  if (cap.percent >= 100) return { tone: 'danger', label: 'Limit reached' }
  if (cap.percent >= cap.warnPercent) return { tone: 'warning', label: 'Close to the limit' }
  return { tone: 'success', label: 'Within budget' }
}

/** Who gets a registry tool, as the Used by column names them. */
export function toolUsers(usedBy: readonly string[]): string {
  const names: Record<string, string> = {
    review: 'Reviews',
    chat: 'Chat',
    'write-task': 'Agent tasks',
    mcp: 'MCP clients',
  }
  return usedBy.map((user) => names[user] ?? user).join(', ')
}
