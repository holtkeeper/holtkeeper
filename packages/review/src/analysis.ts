import { type CodeChange, changeDiff } from '@holtkeeper/changes'
import {
  type Block,
  type Issue,
  type Metric,
  type Section,
  type Tone,
  defineAnalysis,
  metric,
} from '@holtkeeper/report'
import type { AnalysisRecord } from '@holtkeeper/store'

import { countBySeverity, walkthroughTable } from './format.ts'
import {
  type ReviewData,
  type ReviewFinding,
  type ReviewSeverity,
  reviewDataSchema,
} from './schema.ts'

const tones: Record<ReviewSeverity, Tone> = {
  critical: 'bad',
  major: 'bad',
  minor: 'warning',
  info: 'info',
}

const posted = (data: ReviewData) => data.comments.filter((c) => c.posted)

/** A finding's suggestion as a change, for rendering only; it is applied in the forge. */
export function suggestionChange(finding: ReviewFinding): CodeChange | undefined {
  if (!finding.suggestion?.original) return undefined
  const start = finding.startLine ?? finding.line
  return {
    id: finding.id,
    title: finding.title,
    confidence: 'review',
    source: finding.source,
    edits: [
      {
        kind: 'replace',
        file: finding.path,
        range: { start: { line: start, column: 1 }, end: { line: finding.line + 1, column: 1 } },
        oldText: `${finding.suggestion.original}\n`,
        newText: `${finding.suggestion.replacement}\n`,
      },
    ],
  }
}

/** Earlier data of the same merge request, or nothing. */
const sameMr = (current: ReviewData, previous?: AnalysisRecord<ReviewData>) =>
  previous && previous.data.mergeRequest.id === current.mergeRequest.id ? previous.data : undefined

const serious = (list: ReviewFinding[]) =>
  list.filter((c) => c.severity === 'critical' || c.severity === 'major').length
const prev = (value: number | undefined) => (value === undefined ? {} : { previous: value })

function metricsOf(data: ReviewData, previous?: ReviewData): Metric[] {
  const now = posted(data)
  const before = previous ? posted(previous) : undefined
  const list: Metric[] = [
    {
      id: 'verdict',
      label: 'Verdict',
      value: data.verdict,
      unit: 'text',
      tone:
        data.verdict === 'needs-changes'
          ? 'bad'
          : data.verdict === 'looks-good'
            ? 'good'
            : 'neutral',
    },
    metric('comments', 'Comments', now.length, { ...prev(before?.length), better: 'down' }),
    {
      ...metric('serious', 'Major and critical', serious(now), {
        ...prev(before ? serious(before) : undefined),
        better: 'down',
      }),
      ...(serious(now) ? { tone: 'bad' as const } : {}),
    },
    metric('suggestions', 'Suggestions', now.filter((c) => c.suggestion).length),
    metric(
      'resolved',
      'Threads resolved',
      data.threads.filter((t) => t.action === 'resolved').length,
      { better: 'up' },
    ),
    metric('files', 'Files reviewed', data.stats.files),
  ]
  if (data.usage?.costUsd !== undefined)
    list.push({
      id: 'cost',
      label: 'Cost',
      value: `$${data.usage.costUsd.toFixed(2)}`,
      unit: 'text',
      hint: `${data.usage.turns} agent turns`,
    })
  return list
}

function findingsSection(data: ReviewData, previous?: ReviewData): Section {
  const before = new Set(previous ? posted(previous).map((c) => c.id) : [])
  const blocks: Block[] = [
    {
      type: 'table',
      title: 'By severity',
      columns: [
        { key: 'severity', label: 'Severity' },
        { key: 'count', label: 'Findings', align: 'end' },
      ],
      rows: countBySeverity(posted(data)).map(({ severity, count }) => ({
        severity: { text: severity, tone: tones[severity] },
        count,
      })),
    },
  ]
  const items: Issue[] = data.comments.map((finding) => ({
    id: finding.id,
    tone: finding.posted ? tones[finding.severity] : 'neutral',
    title: finding.title,
    detail: `${finding.path}:${finding.startLine ? `${finding.startLine}-` : ''}${finding.line}\n\n${finding.body}${finding.error ? `\n\nNot posted: ${finding.error}` : ''}`,
    ...(finding.href ? { href: finding.href } : {}),
    tags: [
      finding.severity,
      finding.category,
      finding.source,
      ...(finding.suggestion ? ['suggestion'] : []),
      ...(finding.posted && previous && !before.has(finding.id) ? ['new'] : []),
      ...(finding.posted ? [] : ['rejected']),
    ],
  }))
  if (items.length) blocks.push({ type: 'issues', title: 'Comments', items })
  if (previous) {
    const now = new Set(posted(data).map((c) => c.id))
    const gone = posted(previous).filter((c) => !now.has(c.id))
    if (gone.length && data.mode === 'full')
      blocks.push({
        type: 'issues',
        title: 'No longer reported',
        items: gone.map((c) => ({
          id: c.id,
          tone: 'good',
          title: c.title,
          detail: `${c.path}:${c.line}`,
          tags: [c.severity, c.category],
        })),
      })
  }
  return { id: 'findings', title: 'Findings', blocks }
}

export const reviewAnalysis = defineAnalysis<ReviewData>({
  kind: 'review',
  label: 'Code review',
  schema: reviewDataSchema,
  summarize: (data) => metricsOf(data),
  toReport(current, previousRecord) {
    const data = current.data
    const previous = sameMr(data, previousRecord)
    const summary = [
      data.summary.trim(),
      data.mode === 'incremental' && data.previousHead
        ? `Incremental review from \`${data.previousHead.slice(0, 8)}\` to \`${data.head.slice(0, 8)}\`.`
        : `Mode: ${data.mode}, head \`${data.head.slice(0, 8)}\`.`,
      data.effort ? `Review effort: ${data.effort}/5.` : '',
      data.approved ? 'The merge request was approved.' : '',
      data.walkthrough?.length ? `#### Walkthrough\n\n${walkthroughTable(data.walkthrough)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const changes = posted(data).flatMap((finding) => {
      const change = suggestionChange(finding)
      return change
        ? [
            {
              change,
              diff: changeDiff(change),
              tone: tones[finding.severity],
              tags: [finding.severity, finding.category],
            },
          ]
        : []
    })
    const notReviewed = [
      ...data.skipped.map((s) => ({ item: s.path, reason: s.reason })),
      ...(data.stats.dropped.belowSeverity
        ? [
            {
              item: `${data.stats.dropped.belowSeverity} finding(s)`,
              reason: 'below severity threshold',
            },
          ]
        : []),
      ...(data.stats.dropped.overLimit
        ? [{ item: `${data.stats.dropped.overLimit} finding(s)`, reason: 'over comment limit' }]
        : []),
      ...(data.stats.dropped.duplicates
        ? [
            {
              item: `${data.stats.dropped.duplicates} finding(s)`,
              reason: 'duplicates of open threads or other findings',
            },
          ]
        : []),
      ...(data.stats.dropped.invalid
        ? [
            {
              item: `${data.stats.dropped.invalid} finding(s)`,
              reason: 'not on a line of the diff',
            },
          ]
        : []),
      ...data.checks
        .filter((c) => !c.ok)
        .map((c) => ({ item: `check ${c.name}`, reason: c.error ?? 'failed' })),
    ]

    const sections: Section[] = [
      { id: 'summary', title: 'Summary', blocks: [{ type: 'markdown', text: summary }] },
      findingsSection(data, previous),
      {
        id: 'suggestions',
        title: 'Suggestions',
        description: 'Apply suggestions in the merge request; they are shown here for reference.',
        blocks: changes.length
          ? [{ type: 'changes', items: changes, applicable: false }]
          : [{ type: 'markdown', text: 'No suggestions.' }],
      },
      {
        id: 'threads',
        title: 'Threads',
        blocks: data.threads.length
          ? [
              {
                type: 'table',
                columns: [
                  { key: 'thread', label: 'Thread', format: 'code' },
                  { key: 'action', label: 'Action' },
                  { key: 'reason', label: 'Why' },
                ],
                rows: data.threads.map((t) => ({
                  thread: t.path ? `${t.path}:${t.line ?? ''}` : t.discussionId,
                  action: {
                    text: t.action,
                    tone:
                      t.action === 'resolved'
                        ? 'good'
                        : t.action === 'replied'
                          ? 'warning'
                          : 'neutral',
                  },
                  reason: t.learning
                    ? `${t.reason}; ${'error' in t.learning ? `knowledge proposal failed: ${t.learning.error}` : `knowledge entry ${t.learning.duplicateOf ?? t.learning.id}`}`
                    : t.reason,
                })),
              },
            ]
          : [{ type: 'markdown', text: 'No earlier threads were touched.' }],
      },
      {
        id: 'not-reviewed',
        title: 'Not reviewed',
        blocks: notReviewed.length
          ? [
              {
                type: 'table',
                columns: [
                  { key: 'item', label: 'What', format: 'code' },
                  { key: 'reason', label: 'Why' },
                ],
                rows: notReviewed,
              },
            ]
          : [{ type: 'markdown', text: 'Everything in scope was reviewed.' }],
      },
    ]

    return {
      kind: 'review',
      title: `Review of !${data.mergeRequest.id} ${data.mergeRequest.title}`,
      subtitle: `${data.mergeRequest.sourceBranch} → ${data.mergeRequest.targetBranch} by ${data.mergeRequest.author}`,
      subject: {
        repo: current.repo,
        ref: data.head,
        ...(previous ? { compareTo: previous.head } : {}),
      },
      generatedAt: current.createdAt,
      metrics: metricsOf(data, previous),
      sections,
    }
  },
})
