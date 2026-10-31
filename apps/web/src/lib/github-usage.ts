import type {
  GitHubLimitView,
  GitHubRequestCounts,
  GitHubTokenUsage,
  GitHubTokenView,
} from '@holtkeeper/api'

/** Day ranges the GitHub token card offers, in display order. */
export const githubRanges = [7, 30, 90] as const
export type GitHubRange = (typeof githubRanges)[number]

/** Range used when the URL names none. */
export const defaultGitHubRange: GitHubRange = 30

/** `7`, `30` or `90` from a URL value (number or string); anything else is `undefined`. */
export const parseGitHubRange = (value: unknown): GitHubRange | undefined => {
  const days = typeof value === 'string' ? Number(value) : value
  return githubRanges.find((range) => range === days)
}

/** Key of requests sent without a token in `days[].byToken`. */
const anonymousKey = 'anonymous'

const resourceOrder = ['core', 'search', 'graphql']

/** Resource names with `core`, `search`, `graphql` first and the rest alphabetical. */
export const sortResources = (names: Iterable<string>): string[] =>
  [...new Set(names)].toSorted((a, b) => {
    const left = resourceOrder.indexOf(a)
    const right = resourceOrder.indexOf(b)
    if (left !== right) return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right)
    return a.localeCompare(b)
  })

/** Entries of a by-resource record in resource order. */
export const byResource = <T>(record: Record<string, T> | undefined): [string, T][] => {
  const order = sortResources(Object.keys(record ?? {}))
  return Object.entries(record ?? {}).toSorted(([a], [b]) => order.indexOf(a) - order.indexOf(b))
}

/** Share of a limit used, 0–100 rounded; a zero limit is 0 unless something was used. */
export const utilization = (limit: Pick<GitHubLimitView, 'limit' | 'used'>): number => {
  if (limit.limit <= 0) return limit.used > 0 ? 100 : 0
  return Math.min(100, Math.max(0, Math.round((limit.used / limit.limit) * 100)))
}

/** Bar color of a utilization: accent below 70 %, warning below 90 %, danger above. */
export const utilizationColor = (percent: number): string =>
  percent >= 90 ? 'var(--danger)' : percent >= 70 ? 'var(--warning)' : 'var(--accent)'

const emptyCounts = (): GitHubRequestCounts => ({
  requests: 0,
  notModified: 0,
  limited: 0,
  waits: 0,
  waitMs: 0,
})

/** Counts added up over every resource of a record. */
export const sumCounts = (
  record: Record<string, GitHubRequestCounts> | undefined,
): GitHubRequestCounts =>
  Object.values(record ?? {}).reduce(
    (sum, counts) => ({
      requests: sum.requests + counts.requests,
      notModified: sum.notModified + counts.notModified,
      limited: sum.limited + counts.limited,
      waits: sum.waits + counts.waits,
      waitMs: sum.waitMs + counts.waitMs,
    }),
    emptyCounts(),
  )

/** Share of requests GitHub answered `304` from the cache, 0–100 rounded; `undefined` without requests. */
export const savedShare = (counts: Pick<GitHubRequestCounts, 'requests' | 'notModified'>) =>
  counts.requests > 0 ? Math.round((counts.notModified / counts.requests) * 100) : undefined

const counter = new Intl.NumberFormat('en')

/** `12,345`. */
export const formatCount = (value: number): string => counter.format(value)

/** `1,234 / 5,000`. */
export const formatLimit = (limit: Pick<GitHubLimitView, 'limit' | 'used'>): string =>
  `${formatCount(limit.used)} / ${formatCount(limit.limit)}`

/** Name of the token with credential id `id`, or the id when the token is not listed. */
export const tokenName = (tokens: readonly GitHubTokenView[], id: string): string =>
  tokens.find((token) => token.credentialId === id)?.name ?? id

/** Short UTC day label, `Oct 3`. */
const dayLabel = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

/** A stacked bar chart of requests per day and token, ready for the report chart block. */
export interface GitHubDailyChart {
  series: { key: string; label: string }[]
  data: Record<string, string | number>[]
}

/**
 * Requests per day by token: one series per listed token, then tokens no longer listed, then
 * anonymous requests; series without a request in the range are left out. Series keys are
 * positional so credential ids never reach the chart as property paths.
 */
export function dailyChart(usage: Pick<GitHubTokenUsage, 'tokens' | 'days'>): GitHubDailyChart {
  const seen = new Set(usage.days.flatMap((day) => Object.keys(day.byToken)))
  const listed = usage.tokens.map((token) => token.credentialId)
  const ids = [
    ...listed,
    ...[...seen].filter((id) => id !== anonymousKey && !listed.includes(id)).toSorted(),
    anonymousKey,
  ].filter((id) => usage.days.some((day) => (day.byToken[id] ?? 0) > 0))
  const series = ids.map((id, index) => ({
    id,
    key: `s${index}`,
    label: id === anonymousKey ? 'Anonymous' : tokenName(usage.tokens, id),
  }))
  return {
    series: series.map(({ key, label }) => ({ key, label })),
    data: usage.days.map((day) => ({
      day: dayLabel(day.day),
      ...Object.fromEntries(series.map((s) => [s.key, day.byToken[s.id] ?? 0])),
    })),
  }
}
