import type { PortData, PortOutcome } from './types.ts'

/** Human label of each outcome, shared by the source comment and the report. */
export const outcomeLabels: Record<PortOutcome, string> = {
  'ported-clean': 'Ported (applied cleanly)',
  'ported-remapped': 'Ported (paths remapped)',
  'ported-adapted': 'Ported (adapted by agent)',
  'already-present': 'Already present',
  'not-applicable': 'Not applicable',
  failed: 'Failed',
  error: 'Error',
}

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

/** Markdown comment for the source merge request: one row per target with its outcome and merge request. */
export function sourceComment(data: PortData): string {
  const rows = data.targets.map((target) => {
    const mr = target.mergeRequest
      ? `[!${target.mergeRequest.id}](${target.mergeRequest.url})${target.mergeRequest.draft ? ' (draft)' : ''}`
      : '—'
    const reason = target.reason ?? target.error ?? ''
    return `| \`${cell(target.repo)}\` | ${outcomeLabels[target.outcome]}${reason ? ` — ${cell(reason.slice(0, 160))}` : ''} | ${mr} |`
  })
  const ported = data.targets.filter((target) => target.outcome.startsWith('ported-')).length
  return [
    `**Holtkeeper port**: ${ported} of ${data.targets.length} repositories ported to \`${data.branch}\`.`,
    '',
    '| Repository | Status | Merge request |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
}
