import {
  type Block,
  type Issue,
  type Metric,
  type Section,
  type Tone,
  defineAnalysis,
  metric,
} from '@holtkeeper/report'

import {
  UPGRADE_CHECK_KIND,
  type UpgradeCheckData,
  type UpgradeSeverity,
  type UpgradeVerdict,
  upgradeCheckDataSchema,
  upgradeSeverities,
} from './schema.ts'

const severityTone: Record<UpgradeSeverity, Tone> = {
  breaking: 'bad',
  risky: 'warning',
  info: 'info',
}

const verdictTone: Record<UpgradeVerdict, Tone> = {
  safe: 'good',
  review: 'warning',
  breaking: 'bad',
}

const severityTitle: Record<UpgradeSeverity, string> = {
  breaking: 'Breaking',
  risky: 'Risky',
  info: 'Worth knowing',
}

const pointLabel = (point: UpgradeCheckData['from']) => point.label ?? point.ref

const count = (data: UpgradeCheckData, severity: UpgradeSeverity) =>
  data.findings.filter((finding) => finding.severity === severity).length

function metricsOf(data: UpgradeCheckData): Metric[] {
  const list: Metric[] = [
    {
      id: 'verdict',
      label: 'Verdict',
      value: data.verdict,
      unit: 'text',
      tone: verdictTone[data.verdict],
    },
    {
      ...metric('breaking', 'Breaking', count(data, 'breaking'), { better: 'down' }),
      ...(count(data, 'breaking') ? { tone: 'bad' as const } : {}),
    },
    {
      ...metric('risky', 'Risky', count(data, 'risky'), { better: 'down' }),
      ...(count(data, 'risky') ? { tone: 'warning' as const } : {}),
    },
    metric(
      'files',
      'Files checked',
      data.areas.reduce((sum, area) => sum + area.files, 0),
    ),
    metric('areas', 'Areas', data.areas.length),
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

const fileText = (file: { path: string; line?: number | undefined }) =>
  file.line === undefined ? file.path : `${file.path}:${file.line}`

function findingBlocks(data: UpgradeCheckData): Block[] {
  return upgradeSeverities.flatMap((severity): Block[] => {
    const items: Issue[] = data.findings
      .filter((finding) => finding.severity === severity)
      .map((finding) => ({
        id: finding.id,
        tone: severityTone[severity],
        title: finding.title,
        detail: [
          finding.detail,
          finding.affects ? `**Affects:** ${finding.affects}` : '',
          finding.files.length
            ? `**Files:** ${finding.files.map((file) => `\`${fileText(file)}\``).join(', ')}`
            : '',
          finding.check ? `**How to check:** ${finding.check}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        tags: [finding.category],
      }))
    return items.length ? [{ type: 'issues', title: severityTitle[severity], items }] : []
  })
}

/**
 * The `upgrade-check` analysis: the verdict, breaking and risky counts, files and areas checked
 * and cost as metrics; a report with the summary, findings grouped by severity (with files,
 * who is affected and how to check), the areas and what was not checked.
 */
export const upgradeCheckAnalysis = defineAnalysis<UpgradeCheckData>({
  kind: UPGRADE_CHECK_KIND,
  label: 'Breaking-change check',
  schema: upgradeCheckDataSchema,
  summarize: metricsOf,
  toReport(current) {
    const data = current.data
    const findings = findingBlocks(data)
    const sections: Section[] = [
      { id: 'summary', title: 'Summary', blocks: [{ type: 'markdown', text: data.summary }] },
      {
        id: 'findings',
        title: 'Findings',
        blocks: findings.length ? findings : [{ type: 'markdown', text: 'No findings.' }],
      },
      {
        id: 'areas',
        title: 'Areas',
        blocks: data.areas.length
          ? [
              {
                type: 'table',
                columns: [
                  { key: 'name', label: 'Area' },
                  { key: 'files', label: 'Files', align: 'end' },
                  { key: 'summary', label: 'Summary' },
                ],
                rows: data.areas.map((area) => ({ ...area })),
              },
            ]
          : [{ type: 'markdown', text: 'No areas were checked.' }],
      },
      {
        id: 'not-checked',
        title: 'Not checked',
        blocks: data.skipped.length
          ? [
              {
                type: 'table',
                columns: [
                  { key: 'files', label: 'Files', align: 'end' },
                  { key: 'reason', label: 'Why' },
                ],
                rows: data.skipped.map((entry) => ({ ...entry })),
              },
              ...(data.capped
                ? [
                    {
                      type: 'markdown' as const,
                      text: 'Size limits left part of the change unread.',
                    },
                  ]
                : []),
            ]
          : [{ type: 'markdown', text: 'Every changed file was checked.' }],
      },
    ]
    return {
      kind: UPGRADE_CHECK_KIND,
      title: `Breaking-change check ${pointLabel(data.from)} → ${pointLabel(data.to)}`,
      subtitle: `${data.from.sha.slice(0, 8)}..${data.to.sha.slice(0, 8)}`,
      subject: { repo: current.repo, ref: data.to.sha, compareTo: data.from.sha },
      generatedAt: current.createdAt,
      metrics: metricsOf(data),
      sections,
    }
  },
})
