import {
  type Issue,
  type Metric,
  type Report,
  type Section,
  type Tone,
  defineAnalysis,
} from '@holtkeeper/report'

import { type ReleaseRiskData, type RiskLevel, releaseRiskDataSchema } from './schema.ts'

const levelTone: Record<RiskLevel, Tone> = {
  low: 'good',
  medium: 'info',
  high: 'warning',
  critical: 'bad',
}

function metrics(data: ReleaseRiskData, previous?: ReleaseRiskData): Metric[] {
  const scored = data.factors.filter((factor) => factor.points > 0).length
  return [
    {
      id: 'score',
      label: 'Risk score',
      value: data.score,
      unit: 'count',
      better: 'down',
      tone: levelTone[data.level],
      hint: 'Sum of factor points, 0 to 100',
      ...(previous ? { delta: data.score - previous.score } : {}),
    },
    {
      id: 'level',
      label: 'Risk level',
      value: data.level,
      unit: 'text',
      tone: levelTone[data.level],
    },
    {
      id: 'confidence',
      label: 'Confidence',
      value: Math.round(data.confidence * 100),
      unit: 'percent',
      better: 'up',
      tone: data.confidence >= 0.7 ? 'good' : data.confidence >= 0.4 ? 'warning' : 'bad',
      hint: 'Share of the underlying analyses that were available',
      ...(previous
        ? { delta: Math.round(data.confidence * 100) - Math.round(previous.confidence * 100) }
        : {}),
    },
    {
      id: 'factors',
      label: 'Risk factors',
      value: scored,
      unit: 'count',
      better: 'down',
      ...(previous
        ? { delta: scored - previous.factors.filter((factor) => factor.points > 0).length }
        : {}),
    },
  ]
}

function factorsSection(data: ReleaseRiskData, previous?: ReleaseRiskData): Section {
  const before = new Map(previous?.factors.map((factor) => [factor.id, factor.points]))
  const issues: Issue[] = data.factors
    .filter((factor) => factor.points > 0)
    .toSorted((a, b) => b.points - a.points)
    .map((factor) => {
      const evidence = factor.evidence.find((item) => item.href)
      return {
        id: factor.id,
        tone: factor.tone,
        title: `${factor.label}: +${factor.points}`,
        detail: factor.detail,
        ...(evidence?.href ? { href: evidence.href } : {}),
        tags: [`${factor.points}/${factor.max}`],
      }
    })
  return {
    id: 'factors',
    title: 'Risk factors',
    description:
      'Each factor adds up to its weight in points; the score is their sum, at most 100.',
    blocks: [
      ...(issues.length > 0 ? [{ type: 'issues' as const, items: issues }] : []),
      {
        type: 'table',
        columns: [
          { key: 'factor', label: 'Factor' },
          { key: 'points', label: 'Points', unit: 'count', align: 'end' },
          { key: 'max', label: 'Weight', unit: 'count', align: 'end' },
          ...(previous
            ? [
                {
                  key: 'delta',
                  label: 'Change',
                  format: 'delta' as const,
                  better: 'down' as const,
                  align: 'end' as const,
                },
              ]
            : []),
          { key: 'detail', label: 'Why' },
          { key: 'evidence', label: 'Evidence' },
        ],
        rows: data.factors.map((factor) => {
          const link = factor.evidence.find((item) => item.href)
          return {
            factor: { text: factor.label, tone: factor.tone },
            points: factor.known ? factor.points : { text: 'unknown', tone: 'neutral' },
            max: factor.max,
            ...(previous ? { delta: factor.points - (before.get(factor.id) ?? 0) } : {}),
            detail: factor.detail,
            evidence: link?.href
              ? {
                  text:
                    factor.evidence.length > 1
                      ? `${link.label} (+${factor.evidence.length - 1})`
                      : link.label,
                  href: link.href,
                }
              : null,
          }
        }),
      },
    ],
  }
}

function testSection(data: ReleaseRiskData): Section {
  return {
    id: 'test',
    title: 'What to test',
    description: 'Changed areas, riskiest first.',
    blocks: [
      data.testAreas.length > 0
        ? {
            type: 'issues',
            items: data.testAreas.map((area, index) => ({
              id: `area-${index}`,
              tone: area.tone,
              title: area.area,
              detail: area.reasons.join('; '),
              ...(area.commits > 0 ? { tags: [`${area.commits} commits`] } : {}),
            })),
          }
        : { type: 'markdown', text: 'No specific areas; run the usual smoke tests.' },
    ],
  }
}

function sourcesSection(data: ReleaseRiskData): Section {
  return {
    id: 'sources',
    title: 'Underlying analyses',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'kind', label: 'Analysis' },
          { key: 'ref', label: 'Ref', format: 'code' },
          { key: 'createdAt', label: 'Created', format: 'date' },
        ],
        rows: data.sources.map((source) => ({
          kind: { text: source.kind, href: source.href },
          ref: source.ref ?? null,
          createdAt: source.createdAt,
        })),
      },
      ...(data.missing.length > 0
        ? [
            {
              type: 'issues' as const,
              title: 'Missing inputs',
              items: data.missing.map((item) => ({
                id: `missing-${item.input}`,
                tone: 'neutral' as const,
                title: item.input,
                detail: item.reason,
              })),
            },
          ]
        : []),
    ],
  }
}

/** Turns `ReleaseRiskData` into a report. Exported for tests and clients that render locally. */
export function releaseRiskReport(
  data: ReleaseRiskData,
  options: { previous?: ReleaseRiskData; generatedAt?: string } = {},
): Omit<Report, 'subject'> {
  const { previous } = options
  return {
    kind: 'release-risk',
    title: 'Release risk',
    ...(data.ref ? { subtitle: data.ref } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    metrics: metrics(data, previous),
    sections: [
      {
        id: 'summary',
        title: 'Summary',
        ...(data.summary.source === 'agent'
          ? { description: `Written by ${data.summary.agent ?? 'an agent'}.` }
          : {}),
        blocks: [{ type: 'markdown', text: data.summary.markdown }],
      },
      factorsSection(data, previous),
      testSection(data),
      sourcesSection(data),
    ],
  }
}

/**
 * The `release-risk` analysis kind: a 0–100 score with level, the factors behind it, what to test
 * and a plain-language summary. Compares score and factor points with the previous assessment.
 */
export const releaseRiskAnalysis = defineAnalysis<ReleaseRiskData>({
  kind: 'release-risk',
  label: 'Release risk',
  schema: releaseRiskDataSchema,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...releaseRiskReport(current.data, previous ? { previous: previous.data } : {}),
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
    }
  },
})
