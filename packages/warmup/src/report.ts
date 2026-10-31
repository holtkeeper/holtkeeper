import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Metric, Report } from '@holtkeeper/report'

import { type WarmupData, warmupDataSchema } from './model.ts'

function metrics(data: WarmupData, previous?: WarmupData): Metric[] {
  const ok = data.exitCode === 0
  return [
    {
      id: 'status',
      label: 'Status',
      value: ok ? 'ok' : data.timedOut ? 'timed out' : 'failed',
      unit: 'text',
      tone: ok ? 'good' : 'bad',
      hint: ok ? 'The command succeeded' : `Exit code ${data.exitCode}`,
    },
    metric('duration', 'Duration', data.durationMs, {
      unit: 'ms',
      previous: previous?.durationMs,
      better: 'down',
      hint: 'How long the command ran; a warm cache makes it shorter',
    }),
    ...(data.branch
      ? [{ id: 'branch', label: 'Branch', value: data.branch, unit: 'text' as const }]
      : []),
  ]
}

/** Turns `WarmupData` into a report. Exported for tests and for clients that render locally. */
export function warmupReport(
  data: WarmupData,
  options: { previous?: WarmupData; ref?: string } = {},
): Omit<Report, 'subject'> {
  const where = data.cwd === '.' ? '' : ` in \`${data.cwd}\``
  return {
    kind: 'warmup',
    title: 'Build warm-up',
    subtitle: [data.branch, options.ref].filter(Boolean).join(' · ') || data.command,
    generatedAt: data.startedAt,
    metrics: metrics(data, options.previous),
    sections: [
      {
        id: 'command',
        title: 'Command',
        blocks: [
          {
            type: 'markdown',
            text: `\`${data.command}\`${where} exited with code ${data.exitCode}.`,
          },
          {
            type: 'markdown',
            text: data.output
              ? `\`\`\`text\n${data.output}\n\`\`\``
              : 'The command printed nothing.',
          },
        ],
      },
    ],
  }
}

/** The `warmup` analysis kind: exit code, duration against the previous run, and output tail. */
export const warmupAnalysis = defineAnalysis<WarmupData>({
  kind: 'warmup',
  label: 'Build warm-up',
  schema: warmupDataSchema,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...warmupReport(current.data, { previous: previous?.data, ref: current.ref }),
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
    }
  },
})
