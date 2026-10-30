import { findingMarker, MARKER_PREFIX } from './dedupe.ts'
import {
  type ReviewData,
  type ReviewFinding,
  type ReviewSeverity,
  type ReviewWalkthrough,
  type SkippedFile,
  type ThreadAction,
  severities,
} from './schema.ts'

const severityLabel: Record<ReviewSeverity, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  info: 'Info',
}

const skipLabel: Record<SkippedFile['reason'], string> = {
  ignored: 'ignored path',
  binary: 'binary',
  collapsed: 'diff too large for the forge',
  deleted: 'deleted',
  unchanged: 'no new lines to review',
  'too-large': 'merge request over the size limit',
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

/** The marker of the summary note; carries the reviewed head. */
export const summaryMarker = (head: string) => `<!-- ${MARKER_PREFIX} summary head=${head} -->`

const cell = (text: string) => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()

/** The walkthrough as a Markdown table: files of each logical change and what changed. */
export function walkthroughTable(walkthrough: ReviewWalkthrough): string {
  const rows = walkthrough.map(
    (step) =>
      `| ${step.files.map((file) => `\`${cell(file)}\``).join('<br>')} | ${cell(step.change)} |`,
  )
  return `| Files | Change |\n| --- | --- |\n${rows.join('\n')}`
}

/** Counts of posted findings per severity, most severe first. */
export function countBySeverity(findings: readonly Pick<ReviewFinding, 'severity'>[]) {
  return severities.toReversed().map((severity) => ({
    severity,
    count: findings.filter((f) => f.severity === severity).length,
  }))
}

/**
 * The summary note: verdict, the agent's summary, a table of findings by severity, what happened to
 * earlier threads and what was not reviewed.
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
    | 'comments'
    | 'threads'
    | 'skipped'
    | 'stats'
    | 'checks'
  >,
): string {
  const posted = data.comments.filter((c) => c.posted)
  const verdict =
    data.verdict === 'needs-changes'
      ? 'Needs changes'
      : data.verdict === 'looks-good'
        ? 'Looks good'
        : 'Not reviewed'
  const scope =
    data.mode === 'incremental'
      ? `Reviewed the changes from \`${data.previousHead?.slice(0, 8)}\` to \`${data.head.slice(0, 8)}\``
      : `Reviewed \`${data.head.slice(0, 8)}\``
  const lines = [
    `### Holtkeeper review: ${verdict}`,
    data.summary.trim(),
    `${scope}: ${data.stats.files} file(s), ${data.stats.changedLines} changed line(s).${data.effort ? ` Review effort: ${data.effort}/5.` : ''}`,
  ]
  if (data.walkthrough?.length)
    lines.push(
      `<details><summary>Walkthrough</summary>\n\n${walkthroughTable(data.walkthrough)}\n\n</details>`,
    )
  if (data.mode !== 'skipped') {
    lines.push(
      [
        '| Severity | Findings |',
        '| --- | ---: |',
        ...countBySeverity(posted).map(
          ({ severity, count }) => `| ${severityLabel[severity]} | ${count} |`,
        ),
      ].join('\n'),
    )
  }

  const resolved = data.threads.filter((t) => t.action === 'resolved').length
  const replied = data.threads.filter((t) => t.action === 'replied').length
  if (resolved || replied)
    lines.push(`Earlier threads: ${resolved} resolved, ${replied} still relevant.`)

  const notReviewed: string[] = data.skipped
    .filter((s) => s.reason !== 'unchanged')
    .map((s) => `- \`${s.path}\` — ${skipLabel[s.reason]}`)
  const { belowSeverity, overLimit } = data.stats.dropped
  if (belowSeverity) notReviewed.push(`- ${belowSeverity} finding(s) below the severity threshold`)
  if (overLimit) notReviewed.push(`- ${overLimit} finding(s) over the comment limit`)
  for (const check of data.checks.filter((c) => !c.ok))
    notReviewed.push(`- check ${check.name} failed: ${check.error ?? 'unknown error'}`)
  const failed = data.comments.filter((c) => !c.posted).length
  if (failed) notReviewed.push(`- ${failed} comment(s) the forge rejected`)
  if (notReviewed.length)
    lines.push(
      `<details><summary>Not reviewed</summary>\n\n${notReviewed.join('\n')}\n\n</details>`,
    )

  lines.push(summaryMarker(data.head))
  return lines.filter(Boolean).join('\n\n')
}

/** Body of a reply to a thread, with our marker so it is not answered again. */
export const replyBody = (text: string) => `${text.trim()}\n\n<!-- ${MARKER_PREFIX} reply -->`

/** Reply text for a thread we resolve or keep. */
export const threadNote = (action: ThreadAction['action'], note: string, head: string) =>
  replyBody(
    action === 'resolved'
      ? `Resolved at \`${head.slice(0, 8)}\`: ${note}`
      : `Still applies at \`${head.slice(0, 8)}\`: ${note}`,
  )
