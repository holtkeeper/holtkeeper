import { type Issue, type Metric, type Report, type Tone, formatBytes } from '@holtkeeper/report'

import type { Notification } from './types.ts'

const toneRank: Record<Tone, number> = { good: 0, neutral: 1, info: 2, warning: 3, bad: 4 }

const round = (value: number) => Math.round(value * 10) / 10

/** A metric value as people read it: `1.5 kB`, `42%`, `1,204`, `350 ms`. */
export function formatMetricValue(value: number | string, unit: Metric['unit'] = 'count'): string {
  if (typeof value === 'string') return value
  switch (unit) {
    case 'bytes':
      return formatBytes(value)
    case 'percent':
      return `${round(value)}%`
    case 'ms':
      return value >= 1000 ? `${round(value / 1000)} s` : `${Math.round(value)} ms`
    default:
      return round(value).toLocaleString('en-US')
  }
}

/** A signed change in the metric's unit, e.g. `+12 kB`, `-3`; empty for no change. */
export function formatDelta(delta: number, unit: Metric['unit'] = 'count'): string {
  if (delta === 0) return ''
  const sign = delta > 0 ? '+' : '-'
  return `${sign}${formatMetricValue(Math.abs(delta), unit)}`
}

const metricText = (metric: Metric) => {
  const value = formatMetricValue(metric.value, metric.unit)
  const delta = metric.delta === undefined ? '' : formatDelta(metric.delta, metric.unit)
  return delta ? `${value} (${delta})` : value
}

function absolute(href: string, base: string | undefined): string | undefined {
  try {
    return new URL(href, base).toString()
  } catch {
    return undefined
  }
}

const issuesOf = (report: Report): Issue[] =>
  report.sections.flatMap((section) =>
    section.blocks.flatMap((block) => (block.type === 'issues' ? block.items : [])),
  )

export interface ReportNotificationOptions {
  /** Metrics shown as fields. Default 6. */
  metrics?: number
  /** Issues listed in the text, most severe first. Default 5. */
  issues?: number
}

/**
 * A notification for a report: title with repository and ref, the top metrics with their changes
 * as fields, the most severe issues as a list and the worst tone among them. Relative issue links
 * are resolved against `url`, the report page.
 */
export function reportNotification(
  report: Report,
  url?: string,
  options: ReportNotificationOptions = {},
): Notification {
  const { metrics = 6, issues = 5 } = options
  const subject = [report.subject?.repo?.path, report.subject?.ref].filter(Boolean).join(' ')
  const ranked = issuesOf(report)
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => toneRank[issue.tone] >= toneRank.info)
    .toSorted((a, b) => toneRank[b.issue.tone] - toneRank[a.issue.tone] || a.index - b.index)
    .map(({ issue }) => issue)
  const lines = ranked.slice(0, issues).map((issue) => {
    const href = issue.href ? absolute(issue.href, url) : undefined
    const title = href ? `[${issue.title}](${href})` : `**${issue.title}**`
    return `- ${title}${issue.detail ? `: ${issue.detail}` : ''}`
  })
  if (ranked.length > issues) lines.push(`- ...and ${ranked.length - issues} more`)

  const tones = [
    ...report.metrics.map((metric) => metric.tone),
    ...ranked.map((issue) => issue.tone),
  ]
  const tone = tones.reduce<Tone>(
    (worst, next) => (next && toneRank[next] > toneRank[worst] ? next : worst),
    'neutral',
  )
  return {
    title: subject ? `${report.title}: ${subject}` : report.title,
    text: [
      ...(report.subtitle && report.subtitle !== report.subject?.ref ? [report.subtitle] : []),
      ...(report.subject?.compareTo ? [`Compared with ${report.subject.compareTo}.`] : []),
      ...(lines.length > 0 ? [lines.join('\n')] : []),
    ].join('\n\n'),
    ...(url ? { url } : {}),
    tone,
    fields: report.metrics.slice(0, metrics).map((metric) => ({
      label: metric.label,
      value: metricText(metric),
    })),
  }
}
