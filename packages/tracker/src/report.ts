import { changeDiff } from '@holtkeeper/changes'
import {
  type Block,
  type Cell,
  type Column,
  defineAnalysis,
  type Issue,
  type Metric,
  metric,
  type Report,
  type Section,
  type Tone,
} from '@holtkeeper/report'

import { entityField, sortFindings } from './outputs/template.ts'
import { listPlaces } from './rules/types.ts'
import { trackerDataSchema } from './schema.ts'
import type { Entity, Finding, Severity, TrackerData } from './types.ts'

const severityTones: Record<Severity, Tone> = { error: 'bad', warning: 'warning', info: 'info' }

/** Matrix columns at most; the entities table lists everything. */
const matrixColumns = 30

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

const warn = (value: number, entry: Metric, tone: Tone = 'warning'): Metric =>
  value > 0 ? { ...entry, tone } : entry

const prev = (value: number | undefined) => (value === undefined ? {} : { previous: value })

/** Finding counts by rule id. */
export function findingsByRule(findings: readonly Finding[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const finding of findings) counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1)
  return counts
}

function metricsOf(data: TrackerData, previous?: TrackerData): Metric[] {
  const label = data.tracker.label
  const errors = data.findings.filter((finding) => finding.severity === 'error').length
  const metrics: Metric[] = [
    metric('entities', `${label}s`, data.entities.length, prev(previous?.entities.length)),
    warn(
      data.findings.length,
      metric('findings', 'Findings', data.findings.length, {
        ...prev(previous?.findings.length),
        better: 'down',
      }),
      errors ? 'bad' : 'warning',
    ),
  ]
  const before = previous ? findingsByRule(previous.findings) : undefined
  const now = findingsByRule(data.findings)
  const rules = [...new Set([...now.keys(), ...(before?.keys() ?? [])])].toSorted()
  for (const rule of rules) {
    const count = now.get(rule) ?? 0
    metrics.push(
      warn(
        count,
        metric(`rule:${rule}`, rule, count, {
          ...(before ? { previous: before.get(rule) ?? 0 } : {}),
          better: 'down',
        }),
      ),
    )
  }
  metrics.push(
    metric('sources', 'Sources read', data.sourcesRead.length, prev(previous?.sourcesRead.length)),
  )
  if (data.errors.length || previous?.errors.length)
    metrics.push(
      warn(
        data.errors.length,
        metric('errors', 'Read errors', data.errors.length, {
          ...prev(previous?.errors.length),
          better: 'down',
        }),
      ),
    )
  return metrics
}

function entitiesSection(
  data: TrackerData,
  previous: TrackerData | undefined,
  compareTo: string | undefined,
): Section {
  const before = previous ? new Set(previous.entities.map((entity) => entity.key)) : undefined
  const columns: Column[] = [
    { key: 'key', label: data.tracker.label, format: 'code' },
    { key: 'label', label: 'Label / description' },
    { key: 'definedIn', label: 'Defined in' },
    { key: 'usedIn', label: 'Used in', format: 'tags' },
    { key: 'environments', label: 'Environments' },
    { key: 'documented', label: 'Documented' },
    { key: 'findings', label: 'Findings', format: 'tags' },
  ]
  const rows = data.entities.map((entity): Record<string, Cell> => {
    const isNew = before && !before.has(entity.key)
    const description = entity.attrs.description?.value
    const label = entity.attrs.label?.value
    const documented = entityField(entity, 'documented') === 'yes'
    return {
      key: isNew
        ? { text: entity.key, tone: 'info', hint: 'new since the previous run' }
        : entity.key,
      label:
        [label, description].filter(Boolean).join(' — ') ||
        (entity.labels.length > 1 ? entity.labels.join(', ') : ''),
      definedIn: entityField(entity, 'definedIn'),
      usedIn: entityField(entity, 'usedIn'),
      environments: entityField(entity, 'environments'),
      documented: { text: documented ? 'yes' : 'no', tone: documented ? 'good' : 'neutral' },
      findings: entityField(entity, 'findings', data.findings),
    }
  })
  const blocks: Block[] = rows.length
    ? [{ type: 'table', columns, rows }]
    : [
        {
          type: 'markdown',
          text: `No ${data.tracker.label.toLowerCase()}s were found in the sources.`,
        },
      ]
  if (previous) {
    const current = new Set(data.entities.map((entity) => entity.key))
    const removed = previous.entities.filter((entity) => !current.has(entity.key))
    if (removed.length)
      blocks.push({
        type: 'markdown',
        text: `Gone since ${compareTo ?? 'the previous run'}: ${removed.map((entity) => `\`${entity.key}\``).join(', ')}`,
      })
  }
  return {
    id: 'entities',
    title: 'Entities',
    description: `Every ${data.tracker.label.toLowerCase()} the sources mention, merged by normalized key.`,
    blocks,
  }
}

function findingsSection(data: TrackerData, previous: TrackerData | undefined): Section {
  const before = previous ? new Set(previous.findings.map((finding) => finding.id)) : undefined
  const byRule = new Map<string, Issue[]>()
  for (const finding of sortFindings(data.findings)) {
    const isNew = before && !before.has(finding.id)
    const issue: Issue = {
      id: finding.id,
      tone: severityTones[finding.severity],
      title: finding.message,
      detail: listPlaces(finding.occurrences, 5),
      tags: [
        finding.severity,
        ...(finding.environment ? [finding.environment] : []),
        ...(isNew ? ['new'] : []),
      ],
    }
    byRule.set(finding.ruleId, [...(byRule.get(finding.ruleId) ?? []), issue])
  }
  const current = new Set(data.findings.map((finding) => finding.id))
  const resolved = (previous?.findings ?? []).filter((finding) => !current.has(finding.id))
  const blocks: Block[] = [...byRule].map(([rule, items]) => ({
    type: 'issues',
    title: `${rule} (${items.length})`,
    items,
  }))
  if (resolved.length)
    blocks.push({
      type: 'issues',
      title: `Resolved (${resolved.length})`,
      items: resolved.map((finding) => ({
        id: `resolved:${finding.id}`,
        tone: 'good',
        title: finding.message,
        tags: [finding.ruleId, 'resolved'],
      })),
    })
  if (!blocks.length) blocks.push({ type: 'markdown', text: 'No rule found anything.' })
  return {
    id: 'findings',
    title: 'Findings',
    description: 'What the rules found, grouped by rule.',
    blocks,
  }
}

const roleShort = (role: string) =>
  role === 'definition' ? 'def' : role === 'documentation' ? 'doc' : role

function cellOf(entity: Entity, repo: string): Cell {
  const counts = new Map<string, number>()
  for (const occurrence of entity.occurrences)
    if (occurrence.repo === repo && !occurrence.environment)
      counts.set(occurrence.role, (counts.get(occurrence.role) ?? 0) + 1)
  if (!counts.size) return null
  return [...counts]
    .map(([role, count]) => (count > 1 ? `${roleShort(role)}×${count}` : roleShort(role)))
    .join(' ')
}

function matrixSection(data: TrackerData): Section | undefined {
  const repos = [
    ...new Set(
      data.entities.flatMap((entity) =>
        entity.occurrences.flatMap((occurrence) =>
          occurrence.repo && !occurrence.environment ? [occurrence.repo] : [],
        ),
      ),
    ),
  ].toSorted()
  const environments = [
    ...new Set(data.entities.flatMap((entity) => Object.keys(entity.environments))),
  ].toSorted()
  if (!repos.length && !environments.length) return undefined
  const repoColumns = repos.slice(0, matrixColumns)
  const envColumns = environments.slice(0, Math.max(0, matrixColumns - repoColumns.length))
  const columns: Column[] = [
    { key: 'key', label: data.tracker.label, format: 'code' },
    ...repoColumns.map((repo) => ({ key: `repo:${repo}`, label: repo })),
    ...envColumns.map((environment) => ({
      key: `env:${environment}`,
      label: `env: ${environment}`,
    })),
  ]
  const rows = data.entities.map((entity) => ({
    key: entity.key,
    ...Object.fromEntries(repoColumns.map((repo) => [`repo:${repo}`, cellOf(entity, repo)])),
    ...Object.fromEntries(
      envColumns.map((environment) => [
        `env:${environment}`,
        entityField(entity, `env:${environment}`) || null,
      ]),
    ),
  }))
  const hidden = repos.length + environments.length - repoColumns.length - envColumns.length
  return {
    id: 'matrix',
    title: 'Matrix',
    description: `Where each ${data.tracker.label.toLowerCase()} appears per repository (def, usage, config, doc with counts) and its value per environment.${hidden > 0 ? ` ${plural(hidden, 'column')} left out.` : ''}`,
    blocks: [{ type: 'table', columns, rows }],
  }
}

function fence(text: string, language: string): string {
  const ticks = text.includes('```') ? '````' : '```'
  return `${ticks}${language}\n${text.trimEnd()}\n${ticks}`
}

function publicationsSection(data: TrackerData, analysisId: string): Section | undefined {
  if (!data.publications.length) return undefined
  const blocks: Block[] = data.publications.map((publication) => {
    const target = publication.provider
      ? `${publication.provider} \`${publication.ref}\`${publication.markerId ? `, between markers \`${publication.markerId}\`` : ', whole page'}${publication.expectedVersion === undefined ? '' : ` (expects version ${publication.expectedVersion})`}`
      : 'notification'
    const preview =
      publication.format === 'markdown'
        ? publication.content
        : fence(publication.content, publication.format === 'text' ? 'text' : 'html')
    return { type: 'markdown', text: `**${publication.output}** → ${target}\n\n${preview}` }
  })
  const documents = data.publications.filter((publication) => publication.provider).length
  if (documents)
    blocks.push({
      type: 'markdown',
      text: `Nothing has been written yet. Publish with \`POST /api/trackers/${analysisId}/publish\`; a document edited since this analysis is reported as a conflict and left untouched.`,
    })
  return {
    id: 'publications',
    title: 'Publications',
    description: 'What the outputs would write.',
    blocks,
  }
}

function changesSection(data: TrackerData): Section | undefined {
  if (!data.changes.length) return undefined
  return {
    id: 'changes',
    title: 'Changes',
    description:
      'Repository files the outputs keep up to date. Accepting opens one merge request per repository.',
    blocks: [
      {
        type: 'changes',
        items: data.changes.map((change) => ({
          change,
          diff: changeDiff(change),
          tags: change.target ? [change.target.path] : [],
        })),
        applicable: true,
      },
    ],
  }
}

function errorsSection(data: TrackerData): Section | undefined {
  if (!data.errors.length) return undefined
  return {
    id: 'errors',
    title: 'Errors',
    description: 'Problems that did not stop the run; what they affect is missing above.',
    blocks: [
      {
        type: 'issues',
        items: data.errors.map((error, index) => ({
          id: `error:${index}`,
          tone: 'warning',
          title: [
            error.repo && error.file ? `${error.repo}/${error.file}` : (error.repo ?? error.file),
            error.document,
            error.message,
          ]
            .filter(Boolean)
            .join(': '),
          tags: [error.source ?? error.output ?? 'tracker'],
        })),
      },
    ],
  }
}

/** The `tracker` analysis: entities across repositories and documents, rule findings and planned publications. */
export const trackerAnalysis = defineAnalysis<TrackerData>({
  kind: 'tracker',
  label: 'Tracker',
  schema: trackerDataSchema,
  summarize: (data) => metricsOf(data),
  toReport(current, previous): Report {
    const data = current.data
    const before =
      previous && previous.data.tracker.id === data.tracker.id ? previous.data : undefined
    const compareTo =
      before && previous ? (previous.ref ?? previous.createdAt.slice(0, 10)) : undefined
    const optional = [
      matrixSection(data),
      publicationsSection(data, current.id),
      changesSection(data),
      errorsSection(data),
    ]
    return {
      kind: 'tracker',
      title: data.tracker.name,
      subtitle: `${plural(data.entities.length, data.tracker.label.toLowerCase())}, ${plural(data.findings.length, 'finding')}, ${plural(data.sourcesRead.length, 'source read', 'sources read')}`,
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(compareTo ? { compareTo } : {}),
      },
      generatedAt: current.createdAt,
      metrics: metricsOf(data, before),
      sections: [
        entitiesSection(data, before, compareTo),
        findingsSection(data, before),
        ...optional.filter((section): section is Section => section !== undefined),
      ],
    }
  },
  changes: (data) => data.changes,
})
