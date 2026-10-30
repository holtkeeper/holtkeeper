import { describeMergeRequest, trimText } from '@holtkeeper/propagate'

import { formatPatch } from './patch.ts'
import type { PortData, PortMethod, SourceFile, TargetOutcome } from './types.ts'

/** `Port: <source title>`, capped at 200 characters. */
export const mergeRequestTitle = (title: string) => `Port: ${title}`.slice(0, 200)

const methods: Record<PortMethod, string> = {
  clean: 'The source patch applied cleanly (`git apply --3way`).',
  remapped: 'The source patch applied after remapping paths to this repository’s layout.',
  adapted:
    'The patch did not apply; an agent implemented the same change following this repository’s conventions.',
}

/** Short text naming the source with a link, e.g. `[Fix login](url) (work:games/core!12)`. */
export function sourceLabel(source: PortData['source']): string {
  const id =
    source.kind === 'merge-request'
      ? `${source.repo}!${source.mergeRequest}`
      : source.kind === 'range'
        ? `${source.repo}@${source.range?.from.slice(0, 8)}..${source.range?.to.slice(0, 8)}`
        : `${source.repo}@${(source.commits ?? []).map((sha) => sha.slice(0, 8)).join(',')}`
  return `${source.webUrl ? `[${source.title}](${source.webUrl})` : `**${source.title}**`} (\`${id}\`)`
}

/**
 * Markdown description of a port merge request: the source with its link and issues, how the
 * change got in (method, remapped paths, the agent's summary and deviations), the checks and
 * fixer report, and the source diff collapsed at the end.
 */
export function mergeRequestDescription(input: {
  source: PortData['source']
  outcome: TargetOutcome
  files: SourceFile[]
}): string {
  const { source, outcome } = input
  const how: string[] = [outcome.method ? methods[outcome.method] : 'The change was ported.']
  if (outcome.remapped.length)
    how.push(
      outcome.remapped.map((mapping) => `- \`${mapping.from}\` → \`${mapping.to}\``).join('\n'),
    )
  if (outcome.adapt) {
    how.push(outcome.adapt.summary)
    if (outcome.adapt.changes.length)
      how.push(outcome.adapt.changes.map((change) => `- ${change}`).join('\n'))
  }
  const sections = [
    {
      title: 'Source',
      body: [
        `Ports ${sourceLabel(source)}.`,
        ...(source.issues.length ? [`Issues: ${source.issues.join(', ')}`] : []),
      ].join('\n\n'),
    },
    { title: 'How it was ported', body: how.join('\n\n') },
    ...(outcome.adapt?.deviations.length
      ? [
          {
            title: 'Deviations from the source',
            body: outcome.adapt.deviations.map((deviation) => `- ${deviation}`).join('\n'),
          },
        ]
      : []),
    ...(outcome.notes.length
      ? [{ title: 'Notes', body: outcome.notes.map((note) => `- ${note}`).join('\n') }]
      : []),
  ]
  return describeMergeRequest({
    sections,
    checks: outcome.checks,
    ...(outcome.fix?.report
      ? {
          fix: {
            report: outcome.fix.report,
            attempts: outcome.fix.attempts,
            files: outcome.fix.files,
          },
        }
      : {}),
    details: [
      {
        summary: 'Source diff',
        body: `\`\`\`diff\n${trimText(formatPatch(input.files), 2800)}\n\`\`\``,
      },
    ],
  })
}
