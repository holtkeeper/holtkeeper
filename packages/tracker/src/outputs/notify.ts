import { z } from 'zod'

import { sortFindings } from './template.ts'
import type { OutputContext, OutputProvider, OutputResult } from './types.ts'

const schema = z.object({
  kind: z.literal('notify'),
  id: z.string().min(1).optional(),
  /** First line; default the tracker name. */
  title: z.string().min(1).optional(),
  /** Findings listed at most. Default 10. */
  maxFindings: z.number().int().nonnegative().default(10),
  /** Plan nothing when there are no findings. Default false. */
  onlyWhenFindings: z.boolean().default(false),
})

/** A `notify` output as configured. */
export type NotifyConfig = z.output<typeof schema>

/** Plain-text summary of a run, e.g. for a chat message. */
export function summaryText(
  config: NotifyConfig,
  context: Pick<OutputContext, 'tracker' | 'entities' | 'findings'>,
): string {
  const { tracker, entities, findings } = context
  const byRule = new Map<string, number>()
  for (const finding of findings) byRule.set(finding.ruleId, (byRule.get(finding.ruleId) ?? 0) + 1)
  const counts = [...byRule].map(([rule, count]) => `${rule} ${count}`).join(', ')
  const lines = [
    config.title ?? tracker.name,
    `${entities.length} ${tracker.label.toLowerCase()}${entities.length === 1 ? '' : 's'} tracked, ${findings.length} finding${findings.length === 1 ? '' : 's'}${counts ? ` (${counts})` : ''}`,
  ]
  const shown = sortFindings(findings).slice(0, config.maxFindings)
  lines.push(...shown.map((finding) => `- [${finding.severity}] ${finding.message}`))
  if (findings.length > shown.length) lines.push(`… and ${findings.length - shown.length} more`)
  return `${lines.join('\n')}\n`
}

/** A notification text, planned as a publication without a provider. */
export const notifyOutput = {
  kind: 'notify',
  schema,
  async plan(config, context): Promise<OutputResult> {
    if (config.onlyWhenFindings && !context.findings.length)
      return { publications: [], changes: [], errors: [] }
    return {
      publications: [
        {
          output: context.id,
          kind: 'notify',
          format: 'text',
          content: summaryText(config, context),
          title: config.title ?? context.tracker.name,
        },
      ],
      changes: [],
      errors: [],
    }
  },
} satisfies OutputProvider<NotifyConfig>
