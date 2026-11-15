import { findingMarker, MARKER_PREFIX, markerOf } from './dedupe.ts'
import { type ReviewMessageKey, type ReviewMessages, englishReviewMessages } from './messages.ts'
import {
  type ReviewCategory,
  type ReviewData,
  type ReviewFinding,
  type ReviewSeverity,
  type ReviewSize,
  type ReviewWalkthrough,
  type SkippedFile,
  type ThreadAction,
  categories,
  severities,
} from './schema.ts'
import { formatDuration } from './size.ts'

const severityLabel: Record<ReviewSeverity, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  info: 'Info',
}

const skipLabel: Record<SkippedFile['reason'], ReviewMessageKey> = {
  ignored: 'notReviewed.ignored',
  binary: 'notReviewed.binary',
  collapsed: 'notReviewed.collapsed',
  deleted: 'notReviewed.deleted',
  unchanged: 'notReviewed.unchanged',
  'too-large': 'notReviewed.tooLarge',
}

/** The note body of one inline finding, with the marker later runs recognize. */
export function commentBody(
  finding: Pick<ReviewFinding, 'id' | 'severity' | 'category' | 'title' | 'body' | 'source'>,
): string {
  const source = finding.source === 'agent' ? '' : ` · ${finding.source}`
  return [
    `**${severityLabel[finding.severity]}** · ${finding.category}${source} — **${finding.title}**`,
    finding.body.trim(),
    findingMarker(finding.id),
  ].join('\n\n')
}

/**
 * The category and finding id of an inline comment `commentBody` wrote; `undefined` for other
 * notes, ours or not.
 */
export function commentFinding(
  body: string,
): { category: ReviewCategory; findingId: string } | undefined {
  const findingId = markerOf(body)
  if (!findingId) return undefined
  const match = /^\*\*\w+\*\* · (\w+)/.exec(body.trimStart())
  const category = categories.find((name) => name === match?.[1])
  return category ? { category, findingId } : undefined
}

/** The marker of the summary note; carries the reviewed head. */
export const summaryMarker = (head: string) => `<!-- ${MARKER_PREFIX} summary head=${head} -->`

const SUMMARY_HEADING = '### Holtkeeper review:'

/** Whether `body` is a summary note `summaryNote` wrote: its heading first and its marker. */
export const isSummaryNote = (body: string) =>
  body.trimStart().startsWith(SUMMARY_HEADING) &&
  body.includes(`<!-- ${MARKER_PREFIX} summary head=`)

const cell = (text: string) => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()

/** The walkthrough as a Markdown table: files of each logical change and what changed. */
export function walkthroughTable(
  walkthrough: ReviewWalkthrough,
  messages: ReviewMessages = englishReviewMessages,
): string {
  const rows = walkthrough.map(
    (step) =>
      `| ${step.files.map((file) => `\`${cell(file)}\``).join('<br>')} | ${cell(step.change)} |`,
  )
  return `| ${cell(messages.t('walkthrough.files'))} | ${cell(messages.t('walkthrough.change'))} |\n| --- | --- |\n${rows.join('\n')}`
}

/** Counts of posted findings per severity, most severe first. */
export function countBySeverity(findings: readonly Pick<ReviewFinding, 'severity'>[]) {
  return severities.toReversed().map((severity) => ({
    severity,
    count: findings.filter((f) => f.severity === severity).length,
  }))
}

const MAX_PART_FILES = 5

/**
 * The advice to split a large merge request: the estimate, the advice, the proposed parts and the
 * note for code an AI agent writes; `''` without advice. When the agent found that splitting would
 * not help, only the estimate and its reason.
 */
export function sizeAdviceBlock(size: ReviewSize | undefined): string {
  const advice = size?.advice
  if (!advice) return ''
  const { texts } = advice
  const lead = `**${[texts.estimate, texts.limit].filter(Boolean).join(' ')}**`
  if (!advice.splittable) return [lead, advice.reason ?? ''].filter(Boolean).join('\n\n')
  const parts = advice.parts?.map((part, index) => {
    const shown = part.files.slice(0, MAX_PART_FILES).map((file) => `\`${file}\``)
    const more = part.files.length - shown.length
    return `${index + 1}. **${part.title}**: ${shown.join(', ')}${more > 0 ? ` (+${more})` : ''}`
  })
  return [
    `${lead} ${texts.split}`,
    parts?.length
      ? [advice.reason ?? '', `${texts.parts}\n\n${parts.join('\n')}`].filter(Boolean).join('\n\n')
      : '',
    `_${texts.ai}_`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The summary note: verdict, the agent's summary, the estimated review time (or the advice to
 * split the merge request), a table of findings by severity, what happened to earlier threads,
 * what was not reviewed and, after a review, the request to answer wrong comments. Fixed texts
 * come from `messages` (English by default); the heading, severity labels and markers never change.
 */
export function summaryNote(
  data: Pick<
    ReviewData,
    | 'head'
    | 'previousHead'
    | 'mode'
    | 'verdict'
    | 'summary'
    | 'walkthrough'
    | 'effort'
    | 'size'
    | 'comments'
    | 'threads'
    | 'skipped'
    | 'stats'
    | 'checks'
  >,
  messages: ReviewMessages = englishReviewMessages,
): string {
  const { t } = messages
  const posted = data.comments.filter((c) => c.posted)
  const verdict =
    data.verdict === 'needs-changes'
      ? t('verdict.needsChanges')
      : data.verdict === 'looks-good'
        ? t('verdict.looksGood')
        : t('verdict.notReviewed')
  const scope =
    data.mode === 'incremental'
      ? t('scope.incremental', {
          from: data.previousHead?.slice(0, 8) ?? '',
          to: data.head.slice(0, 8),
        })
      : t('scope.full', { head: data.head.slice(0, 8) })
  const stats = [
    t('scope.stats', { scope, files: data.stats.files, lines: data.stats.changedLines }),
    data.effort ? t('scope.effort', { effort: data.effort }) : '',
    data.size && !data.size.advice && data.size.minutes
      ? t('scope.time', { time: formatDuration(data.size.minutes) })
      : '',
  ]
  const lines = [
    `${SUMMARY_HEADING} ${verdict}`,
    data.summary.trim(),
    stats.filter(Boolean).join(' '),
    sizeAdviceBlock(data.size),
  ]
  if (data.walkthrough?.length)
    lines.push(
      `<details><summary>Walkthrough</summary>\n\n${walkthroughTable(data.walkthrough, messages)}\n\n</details>`,
    )
  if (data.mode !== 'skipped') {
    lines.push(
      [
        `| Severity | ${cell(t('findings.count'))} |`,
        '| --- | ---: |',
        ...countBySeverity(posted).map(
          ({ severity, count }) => `| ${severityLabel[severity]} | ${count} |`,
        ),
      ].join('\n'),
    )
  }

  const resolved = data.threads.filter((thread) => thread.action === 'resolved').length
  const replied = data.threads.filter((thread) => thread.action === 'replied').length
  if (resolved || replied) lines.push(t('threads.earlier', { resolved, replied }))

  const notReviewed: string[] = data.skipped
    .filter((s) => s.reason !== 'unchanged')
    .map((s) => `- \`${s.path}\` — ${t(skipLabel[s.reason])}`)
  const { belowSeverity, overLimit } = data.stats.dropped
  if (belowSeverity)
    notReviewed.push(`- ${t('notReviewed.belowSeverity', { count: belowSeverity })}`)
  if (overLimit) notReviewed.push(`- ${t('notReviewed.overLimit', { count: overLimit })}`)
  for (const check of data.checks.filter((c) => !c.ok))
    notReviewed.push(
      `- ${t('notReviewed.checkFailed', { name: check.name, error: check.error ?? 'unknown error' })}`,
    )
  const failed = data.comments.filter((c) => !c.posted).length
  if (failed) notReviewed.push(`- ${t('notReviewed.rejected', { count: failed })}`)
  if (notReviewed.length)
    lines.push(
      `<details><summary>${t('notReviewed.title')}</summary>\n\n${notReviewed.join('\n')}\n\n</details>`,
    )

  if (data.mode !== 'skipped') lines.push(t('summary.feedback'))
  lines.push(summaryMarker(data.head))
  return lines.filter(Boolean).join('\n\n')
}

/** Body of a reply to a thread, with our marker so it is not answered again. */
export const replyBody = (text: string) => `${text.trim()}\n\n<!-- ${MARKER_PREFIX} reply -->`

/** Reply text for a thread we resolve or keep. */
export const threadNote = (
  action: ThreadAction['action'],
  note: string,
  head: string,
  messages: ReviewMessages = englishReviewMessages,
) =>
  replyBody(
    messages.t(action === 'resolved' ? 'thread.resolved' : 'thread.stillApplies', {
      head: head.slice(0, 8),
      note,
    }),
  )
