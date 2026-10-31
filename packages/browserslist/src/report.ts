import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Metric, Report, Tone } from '@holtkeeper/report'

import { type BrowserslistData, browserslistDataSchema, targetChanges } from './model.ts'

const statusText: Record<BrowserslistData['status'], { text: string; tone: Tone; hint: string }> = {
  'not-applicable': {
    text: 'not used',
    tone: 'neutral',
    hint: 'No root lockfile resolves caniuse-lite',
  },
  'up-to-date': { text: 'up to date', tone: 'good', hint: 'The database is current' },
  updated: { text: 'updated', tone: 'warning', hint: 'A newer database is proposed' },
  failed: { text: 'failed', tone: 'bad', hint: 'The update command failed' },
}

function metrics(data: BrowserslistData): Metric[] {
  const status = statusText[data.status]
  const changed = data.targets.reduce((sum, targets) => {
    const { added, removed } = targetChanges(targets)
    return sum + added.length + removed.length
  }, 0)
  return [
    {
      id: 'status',
      label: 'Status',
      value: status.text,
      unit: 'text',
      tone: status.tone,
      hint: status.hint,
    },
    ...(data.after.length
      ? [
          {
            id: 'caniuse',
            label: 'caniuse-lite',
            value: data.after.join(', '),
            unit: 'text' as const,
          },
        ]
      : []),
    ...(data.status === 'updated'
      ? [
          metric('browsers', 'Browser changes', changed, {
            hint: 'Browsers added to or removed from the targets',
          }),
        ]
      : []),
  ]
}

const autoMergeNote = {
  off: '',
  set: ', merges once its checks pass',
  failed: ', auto-merge could not be set',
}

function blocks(data: BrowserslistData): Block[] {
  const result: Block[] = []
  if (data.mergeRequest)
    result.push({
      type: 'markdown',
      text: `[Merge request !${data.mergeRequest.id}](${data.mergeRequest.url})${data.mergeRequest.draft ? ' (draft)' : ''}${autoMergeNote[data.mergeRequest.autoMerge ?? 'off']}`,
    })
  if (data.lockfile)
    result.push({
      type: 'markdown',
      text: `\`${data.lockfile}\` (${data.packageManager ?? 'unknown manager'}): caniuse-lite \`${data.before.join(', ') || 'none'}\` → \`${data.after.join(', ') || 'none'}\`${data.dryRun ? ', dry run' : ''}.`,
    })
  const rows = data.targets.flatMap((targets) => {
    const { added, removed } = targetChanges(targets)
    return [
      ...added.map((browser) => ({
        dir: targets.dir,
        browser,
        change: { text: 'added', tone: 'good' as const },
      })),
      ...removed.map((browser) => ({
        dir: targets.dir,
        browser,
        change: { text: 'removed', tone: 'bad' as const },
      })),
    ]
  })
  if (rows.length)
    result.push({
      type: 'table',
      title: 'Browser changes',
      columns: [
        { key: 'dir', label: 'Directory', format: 'code', path: true },
        { key: 'browser', label: 'Browser', format: 'code' },
        { key: 'change', label: 'Change' },
      ],
      rows,
    })
  if (data.output) result.push({ type: 'markdown', text: `\`\`\`text\n${data.output}\n\`\`\`` })
  return result
}

/** Turns `BrowserslistData` into a report. Exported for tests and for clients that render locally. */
export function browserslistReport(data: BrowserslistData, ref?: string): Omit<Report, 'subject'> {
  return {
    kind: 'browserslist',
    title: 'Browserslist database',
    ...(ref ? { subtitle: ref } : {}),
    generatedAt: data.startedAt,
    metrics: metrics(data),
    sections: [{ id: 'update', title: 'Update', blocks: blocks(data) }],
  }
}

/** The `browserslist` analysis kind: database versions, browser target changes and the merge request. */
export const browserslistAnalysis = defineAnalysis<BrowserslistData>({
  kind: 'browserslist',
  label: 'Browserslist database',
  schema: browserslistDataSchema,
  summarize: (data) => metrics(data),
  toReport(current) {
    return {
      ...browserslistReport(current.data, current.ref),
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
    }
  },
})
