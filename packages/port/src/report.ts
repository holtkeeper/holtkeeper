import { trimText } from '@holtkeeper/propagate'
import {
  type Block,
  type Cell,
  defineAnalysis,
  type Issue,
  type Metric,
  metric,
  type Report,
  type Section,
  type Tone,
} from '@holtkeeper/report'

import { outcomeLabels } from './comment.ts'
import { sourceLabel } from './describe.ts'
import { fileDiff } from './patch.ts'
import { portDataSchema } from './schema.ts'
import type { PortData, PortOutcome, TargetOutcome } from './types.ts'

const outcomeOrder: PortOutcome[] = [
  'ported-clean',
  'ported-remapped',
  'ported-adapted',
  'failed',
  'error',
  'already-present',
  'not-applicable',
]

/** Tone of each outcome, shared by tables and charts. */
export const outcomeTones: Record<PortOutcome, Tone> = {
  'ported-clean': 'good',
  'ported-remapped': 'good',
  'ported-adapted': 'info',
  failed: 'bad',
  error: 'warning',
  'already-present': 'neutral',
  'not-applicable': 'neutral',
}

/** Targets per outcome group. */
export function portTotals(data: PortData) {
  const count = (...outcomes: PortOutcome[]) =>
    data.targets.filter((target) => outcomes.includes(target.outcome)).length
  return {
    targets: data.targets.length,
    ported: count('ported-clean', 'ported-remapped', 'ported-adapted'),
    clean: count('ported-clean'),
    remapped: count('ported-remapped'),
    adapted: count('ported-adapted'),
    skipped: count('already-present', 'not-applicable'),
    failed: count('failed', 'error'),
    mergeRequests: data.targets.filter((target) => target.mergeRequest).length,
  }
}

/** Identity of the ported change, so runs of the same source compare. */
export const sourceKey = (data: PortData) =>
  [
    data.source.repo,
    data.source.kind,
    data.source.mergeRequest ?? '',
    (data.source.commits ?? []).join(','),
    data.source.range ? `${data.source.range.from}..${data.source.range.to}` : '',
  ].join('\0')

const prev = (value: number | undefined) => (value === undefined ? {} : { previous: value })

const toned = (value: number, entry: Metric, tone: Tone): Metric =>
  value > 0 ? { ...entry, tone } : entry

function metricsOf(data: PortData, previous?: PortData): Metric[] {
  const now = portTotals(data)
  const before =
    previous && sourceKey(previous) === sourceKey(data) ? portTotals(previous) : undefined
  return [
    metric('targets', 'Targets', now.targets, prev(before?.targets)),
    toned(
      now.ported,
      metric('ported', 'Ported', now.ported, { ...prev(before?.ported), better: 'up' }),
      'good',
    ),
    metric('clean', 'Applied cleanly', now.clean, prev(before?.clean)),
    metric('remapped', 'Paths remapped', now.remapped, prev(before?.remapped)),
    metric('adapted', 'Adapted by agent', now.adapted, prev(before?.adapted)),
    metric('skipped', 'Skipped', now.skipped, {
      ...prev(before?.skipped),
      hint: 'already present or not applicable',
    }),
    toned(
      now.failed,
      metric('failed', 'Failed', now.failed, { ...prev(before?.failed), better: 'down' }),
      'bad',
    ),
    metric('merge-requests', 'Merge requests', now.mergeRequests, prev(before?.mergeRequests)),
  ]
}

const repoCell = (target: TargetOutcome): Cell =>
  target.webUrl ? { text: target.repo, href: target.webUrl } : target.repo

const outcomeCell = (outcome: PortOutcome): Cell => ({
  text: outcomeLabels[outcome],
  tone: outcomeTones[outcome],
})

function overview(data: PortData, previous?: PortData): Section {
  const before = new Map(
    (previous && sourceKey(previous) === sourceKey(data) ? previous.targets : []).map((target) => [
      target.repo,
      target.outcome,
    ]),
  )
  const datum: Record<string, string | number> = { source: data.source.title }
  for (const outcome of outcomeOrder)
    datum[outcome] = data.targets.filter((target) => target.outcome === outcome).length
  const rows = data.targets
    .toSorted(
      (a, b) =>
        outcomeOrder.indexOf(a.outcome) - outcomeOrder.indexOf(b.outcome) ||
        a.repo.localeCompare(b.repo),
    )
    .map((target) => {
      const was = before.get(target.repo)
      const failing = target.checks.filter((check) => !check.ok).map((check) => check.name)
      return {
        repo: repoCell(target),
        outcome: outcomeCell(target.outcome),
        previous: was ? outcomeCell(was) : null,
        method: target.method ?? null,
        checks: failing.length
          ? { text: `failing: ${failing.join(', ')}`, tone: 'bad' as const }
          : target.checks.length
            ? { text: 'passing', tone: 'good' as const }
            : null,
        diff: target.diffStat.files
          ? `${target.diffStat.files} files, +${target.diffStat.additions} −${target.diffStat.deletions}`
          : null,
        mergeRequest: target.mergeRequest
          ? {
              text: `!${target.mergeRequest.id}${target.mergeRequest.draft ? ' (draft)' : ''}`,
              href: target.mergeRequest.url,
              tone: target.mergeRequest.draft ? ('warning' as const) : ('good' as const),
            }
          : null,
      } satisfies Record<string, Cell>
    })
  const blocks: Block[] = [
    {
      type: 'chart',
      title: 'Targets by outcome',
      chart: 'stacked-bar',
      x: 'source',
      series: outcomeOrder.map((outcome) => ({
        key: outcome,
        label: outcomeLabels[outcome],
        tone: outcomeTones[outcome],
      })),
      data: [datum],
    },
    {
      type: 'table',
      columns: [
        { key: 'repo', label: 'Repository' },
        { key: 'outcome', label: 'Outcome' },
        ...(before.size ? [{ key: 'previous', label: 'Previous run' }] : []),
        { key: 'method', label: 'Method' },
        { key: 'checks', label: 'Checks' },
        { key: 'diff', label: 'Diff' },
        { key: 'mergeRequest', label: 'Merge request' },
      ],
      rows,
    },
  ]
  return {
    id: 'overview',
    title: 'Overview',
    description: `Branch \`${data.branch}\`${data.dryRun ? ' — dry run, nothing published' : ''}`,
    blocks,
  }
}

function adaptations(data: PortData): Section | undefined {
  const adapted = data.targets.filter(
    (target) => target.adapt || target.remapped.length || target.fix,
  )
  if (adapted.length === 0) return undefined
  const text = adapted
    .map((target) => {
      const lines = [`### ${target.repo} — ${outcomeLabels[target.outcome]}`]
      if (target.remapped.length)
        lines.push(
          '',
          'Remapped paths:',
          ...target.remapped.map((m) => `- \`${m.from}\` → \`${m.to}\``),
        )
      if (target.adapt) {
        lines.push('', target.adapt.summary)
        if (target.adapt.changes.length)
          lines.push('', ...target.adapt.changes.map((change) => `- ${change}`))
        if (target.adapt.deviations.length)
          lines.push(
            '',
            '**Deviations:**',
            ...target.adapt.deviations.map((deviation) => `- ${deviation}`),
          )
      }
      if (target.fix?.report)
        lines.push(
          '',
          `**Check fixes (${target.fix.attempts} attempt${target.fix.attempts === 1 ? '' : 's'}):** ${target.fix.report.summary}`,
        )
      if (target.diffStat.files)
        lines.push(
          '',
          `Diff: ${target.diffStat.files} files, +${target.diffStat.additions} −${target.diffStat.deletions}` +
            (target.changedFiles.length
              ? ` (${target.changedFiles.map((file) => `\`${file}\``).join(', ')})`
              : ''),
        )
      return lines.join('\n')
    })
    .join('\n\n')
  return { id: 'adaptations', title: 'Adaptations', blocks: [{ type: 'markdown', text }] }
}

function skipped(data: PortData): Section | undefined {
  const rows = data.targets
    .filter((target) => target.outcome === 'already-present' || target.outcome === 'not-applicable')
    .map((target) => ({
      repo: repoCell(target),
      outcome: outcomeCell(target.outcome),
      reason: target.reason ?? null,
      by: target.adapt ? 'agent (adapt)' : (target.triage?.by ?? null),
    }))
  if (rows.length === 0) return undefined
  return {
    id: 'skipped',
    title: 'Skipped',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'repo', label: 'Repository' },
          { key: 'outcome', label: 'Outcome' },
          { key: 'reason', label: 'Reason' },
          { key: 'by', label: 'Decided by' },
        ],
        rows,
      },
    ],
  }
}

function failures(data: PortData): Section | undefined {
  const items: Issue[] = []
  for (const target of data.targets) {
    const href = target.mergeRequest?.url ?? target.webUrl
    if (target.outcome === 'error')
      items.push({
        id: `${target.repo}:error`,
        tone: 'warning',
        title: `${target.repo}: ${target.error ?? 'error'}`,
        ...(href ? { href } : {}),
        tags: ['error'],
      })
    if (target.outcome !== 'failed') continue
    const failing = target.checks.filter((check) => !check.ok)
    if (failing.length === 0)
      items.push({
        id: `${target.repo}:port`,
        tone: 'bad',
        title: `${target.repo}: ${target.reason ?? 'port failed'}`,
        ...(target.adapt ? { detail: target.adapt.summary } : {}),
        ...(href ? { href } : {}),
        tags: [target.method ?? 'not ported'],
      })
    for (const check of failing)
      items.push({
        id: `${target.repo}:${check.name}`,
        tone: 'bad',
        title: `${target.repo}: ${check.name} fails (exit ${check.exitCode})`,
        detail: `\`${check.command}\`\n\n${trimText(check.output.split('\n').slice(-30).join('\n'), 3000)}`,
        ...(href ? { href } : {}),
        tags: [
          check.name,
          ...(target.method ? [target.method] : []),
          ...(target.fix ? [`${target.fix.attempts} fix attempts`] : []),
        ],
      })
  }
  return items.length
    ? { id: 'failures', title: 'Failures', blocks: [{ type: 'issues', items }] }
    : undefined
}

function sourceSection(data: PortData): Section {
  const { source } = data
  const text = [
    `Ports ${sourceLabel(source)}.`,
    ...(source.issues.length ? [`Issues: ${source.issues.join(', ')}`] : []),
    ...(data.sourceComment && !data.sourceComment.posted
      ? [
          `The summary comment on the source could not be posted: ${data.sourceComment.error ?? 'unknown error'}`,
        ]
      : []),
    '```text',
    source.intent,
    '```',
  ].join('\n\n')
  const blocks: Block[] = [{ type: 'markdown', text }]
  const diffs = source.files.filter((file) => !file.binary).map(fileDiff)
  if (diffs.length)
    blocks.push({
      type: 'changes',
      title: 'Source diff',
      applicable: false,
      items: [
        {
          change: {
            id: `port:${sourceKey(data).replaceAll('\0', ':')}`,
            title: source.title,
            confidence: 'review',
            source: 'port',
            edits: [],
          },
          diff: diffs,
        },
      ],
    })
  return { id: 'source', title: 'Source change', blocks }
}

/** The `port` analysis: one change ported from a repository to its siblings. */
export const portAnalysis = defineAnalysis<PortData>({
  kind: 'port',
  label: 'Change port',
  schema: portDataSchema,
  summarize: (data) => metricsOf(data),
  toReport(current, previous): Report {
    const data = current.data
    const sections = [
      overview(data, previous?.data),
      adaptations(data),
      skipped(data),
      failures(data),
      sourceSection(data),
    ].filter((section) => section !== undefined)
    return {
      kind: 'port',
      title: `Port of ${data.source.title}`,
      subtitle: data.group,
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
      generatedAt: current.createdAt,
      metrics: metricsOf(data, previous?.data),
      sections,
    }
  },
})
