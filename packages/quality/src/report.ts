import { changeDiff } from '@holtkeeper/changes'
import {
  type Issue,
  type Metric,
  type Report,
  type Section,
  type Tone,
  defineAnalysis,
  formatRef,
  metric,
} from '@holtkeeper/report'

import { qualityDataSchema } from './schema.ts'
import type { IssueSeverity, QualityData, QualityIssue } from './types.ts'

const toneOf: Record<IssueSeverity, Tone> = { error: 'bad', warning: 'warning', info: 'info' }

const categoryLabel: Record<QualityIssue['category'], string> = {
  convention: 'Naming conventions',
  tests: 'Tests',
  complexity: 'Complexity',
  duplication: 'Duplication',
  lint: 'Lint',
  security: 'Security',
  style: 'Style',
}

const percent = (part: { covered: number; total: number } | undefined) =>
  part && part.total > 0 ? (part.covered / part.total) * 100 : undefined

/** Share of names that follow their kind's dominant style, across all conventions, 0..100. */
function consistency(data: QualityData): number | undefined {
  const total = data.conventions.reduce((sum, c) => sum + c.total, 0)
  if (total === 0) return undefined
  const outliers = data.conventions.reduce((sum, c) => sum + c.outliers, 0)
  return ((total - outliers) / total) * 100
}

const errors = (d: QualityData) => d.issues.filter((i) => i.severity === 'error').length

function headline(data: QualityData, previous?: QualityData): Metric[] {
  const linePercent = percent(data.coverage?.lines)
  const previousLinePercent = percent(previous?.coverage?.lines)
  const naming = consistency(data)
  const previousNaming = previous ? consistency(previous) : undefined
  return [
    metric('issues', 'Issues', data.issues.length, {
      previous: previous?.issues.length,
      better: 'down',
    }),
    metric('errors', 'Errors', errors(data), {
      previous: previous ? errors(previous) : undefined,
      better: 'down',
    }),
    ...(linePercent === undefined
      ? []
      : [
          metric('coverage', 'Line coverage', linePercent, {
            unit: 'percent',
            previous: previousLinePercent,
            better: 'up',
          }),
        ]),
    metric('untested', 'Worth testing', data.tests.length, {
      previous: previous?.tests.length,
      better: 'down',
    }),
    ...(naming === undefined
      ? []
      : [
          metric('naming', 'Naming consistency', naming, {
            unit: 'percent',
            previous: previousNaming,
            better: 'up',
          }),
        ]),
    ...(data.duplication
      ? [
          metric('duplication', 'Duplicated lines', data.duplication.percentage, {
            unit: 'percent',
            previous: previous?.duplication?.percentage,
            better: 'down',
          }),
        ]
      : []),
    metric('changes', 'Suggested changes', data.changes.length),
  ]
}

const location = (issue: QualityIssue): string | null =>
  issue.file ? `${issue.file}${issue.range ? `:${issue.range.start.line}` : ''}` : null

/**
 * Quality analysis: naming conventions, test gaps with example tests, linter and security
 * findings, duplication. Suggested changes can be accepted from the report.
 */
export const qualityAnalysis = defineAnalysis<QualityData>({
  kind: 'quality',
  label: 'Code quality',
  schema: qualityDataSchema,
  summarize: (data) => headline(data),
  changes: (data) => data.changes,
  toReport(current, previous): Report {
    const data = current.data
    const changes = new Map(data.changes.map((change) => [change.id, change]))
    const previousIds = new Set(previous?.data.issues.map((i) => i.id))
    const byCategory = Map.groupBy(data.issues, (issue) => issue.category)

    const changeItems = (ids: (string | undefined)[], tags: string[] = []) =>
      ids
        .flatMap((id) => (id && changes.has(id) ? [changes.get(id)!] : []))
        .map((change) => ({
          change,
          diff: changeDiff(change),
          tags: [change.source, change.confidence, ...tags],
        }))

    const issueItems = (issues: QualityIssue[]): Issue[] =>
      issues.slice(0, 200).map((issue) => ({
        id: issue.id,
        tone: toneOf[issue.severity],
        title: issue.message,
        detail: [location(issue), issue.help].filter(Boolean).join(' — '),
        ...(issue.url ? { href: issue.url } : {}),
        tags: [issue.tool, issue.rule, ...(previous && !previousIds.has(issue.id) ? ['new'] : [])],
      }))

    const sections: Section[] = []

    if (data.conventions.length) {
      const conventionIssues = byCategory.get('convention') ?? []
      sections.push({
        id: 'conventions',
        title: 'Naming conventions',
        description: 'The style most names of each kind follow, and the names that do not.',
        blocks: [
          {
            type: 'table' as const,
            columns: [
              { key: 'language', label: 'Language' },
              { key: 'kind', label: 'Kind' },
              { key: 'dominant', label: 'Convention', format: 'code' as const },
              { key: 'share', label: 'Follow it', unit: 'percent' as const, align: 'end' as const },
              { key: 'outliers', label: 'Outliers', align: 'end' as const },
            ],
            rows: data.conventions.map((c) => ({
              language: c.language,
              kind: c.kind,
              dominant: c.dominant,
              share: {
                text: `${(c.share * 100).toFixed(0)}%`,
                tone: c.share >= 0.95 ? 'good' : c.share >= 0.8 ? 'warning' : 'bad',
              },
              outliers: c.outliers,
            })),
          },
          ...(conventionIssues.length
            ? [{ type: 'issues' as const, items: issueItems(conventionIssues) }]
            : []),
          ...(conventionIssues.some((i) => i.changeId)
            ? [
                {
                  type: 'changes' as const,
                  title: 'Renames',
                  items: changeItems(conventionIssues.map((i) => i.changeId)),
                  applicable: true,
                },
              ]
            : []),
        ],
      })
    }

    if (data.tests.length || data.coverage) {
      sections.push({
        id: 'tests',
        title: 'Tests',
        description:
          'Code that is untested or barely tested, ranked by risk, with example tests in the project’s style.',
        blocks: [
          {
            type: 'table' as const,
            columns: [
              { key: 'symbol', label: 'What', format: 'code' as const },
              { key: 'file', label: 'File', format: 'code' as const },
              { key: 'coverage', label: 'Covered lines', align: 'end' as const },
              { key: 'complexity', label: 'Complexity', align: 'end' as const },
              { key: 'churn', label: 'Recent changes', align: 'end' as const },
              { key: 'reason', label: 'Why' },
            ],
            rows: data.tests.map((t) => ({
              symbol: t.symbol,
              file: t.file,
              coverage: t.coverage ? `${t.coverage.covered}/${t.coverage.total}` : null,
              complexity: t.complexity ?? null,
              churn: t.churn ?? null,
              reason: t.reason,
            })),
          },
          ...(data.tests.some((t) => t.changeId)
            ? [
                {
                  type: 'changes' as const,
                  title: 'Suggested tests',
                  items: changeItems(data.tests.map((t) => t.changeId)),
                  applicable: true,
                },
              ]
            : []),
        ],
      })
    }

    for (const category of [
      'security',
      'lint',
      'complexity',
      'style',
      'duplication',
      'tests',
    ] as const) {
      const issues = byCategory.get(category)
      if (!issues?.length) continue
      const byTool = Map.groupBy(issues, (issue) => issue.tool)
      sections.push({
        id: `issues-${category}`,
        title: categoryLabel[category],
        blocks: [
          {
            type: 'chart' as const,
            chart: 'bar' as const,
            x: 'rule',
            series: [{ key: 'count', label: 'Findings' }],
            data: [...Map.groupBy(issues, (i) => i.rule)]
              .map(([rule, list]) => ({ rule, count: list.length }))
              .toSorted((a, b) => b.count - a.count)
              .slice(0, 15),
          },
          ...[...byTool].map(([tool, list]) => ({
            type: 'issues' as const,
            title: tool,
            items: issueItems(list),
          })),
          ...(issues.some((i) => i.changeId)
            ? [
                {
                  type: 'changes' as const,
                  title: 'Fixes',
                  items: changeItems(issues.map((i) => i.changeId)),
                  applicable: true,
                },
              ]
            : []),
        ],
      })
    }

    sections.push({
      id: 'tools',
      title: 'Tools',
      blocks: [
        {
          type: 'table' as const,
          columns: [
            { key: 'name', label: 'Check' },
            { key: 'version', label: 'Version', format: 'code' as const },
            { key: 'status', label: 'Status' },
            { key: 'duration', label: 'Time', unit: 'ms' as const, align: 'end' as const },
          ],
          rows: data.tools.map((tool) => ({
            name: tool.name,
            version: tool.version ?? null,
            status: tool.ok
              ? { text: 'ok', tone: 'good' }
              : { text: tool.error ?? 'failed', tone: 'bad' },
            duration: tool.durationMs ?? null,
          })),
        },
      ],
    })

    return {
      kind: 'quality',
      title: `Code quality${current.ref ? ` of ${formatRef(current.ref)}` : ''}`,
      subtitle: `${data.issues.length} issues, ${data.tests.length} places worth testing, ${data.changes.length} suggested changes`,
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
      generatedAt: current.createdAt,
      metrics: headline(data, previous?.data),
      sections,
    }
  },
})
