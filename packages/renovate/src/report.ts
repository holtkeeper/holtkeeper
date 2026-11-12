import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Cell, Metric, Report, Section, Tone } from '@holtkeeper/report'

import {
  type RenovateData,
  type RenovateMergeRequest,
  type RenovateUpdateType,
  awaitsReview,
  isBroken,
  renovateDataSchema,
} from './model.ts'

const typeLabels: Record<RenovateUpdateType, string> = {
  major: 'major',
  minor: 'minor',
  patch: 'patch',
  pin: 'pin',
  digest: 'digest',
  pinDigest: 'pin digest',
  lockFileMaintenance: 'lockfile',
  rollback: 'rollback',
  bump: 'bump',
  replacement: 'replacement',
}

const typeTones: Partial<Record<RenovateUpdateType, Tone>> = {
  major: 'bad',
  minor: 'warning',
  patch: 'good',
  rollback: 'bad',
  replacement: 'warning',
}

const typeOrder: RenovateUpdateType[] = [
  'major',
  'minor',
  'patch',
  'digest',
  'pin',
  'pinDigest',
  'replacement',
  'rollback',
  'bump',
  'lockFileMaintenance',
]

const pipelineTones: Record<NonNullable<RenovateMergeRequest['pipeline']>, Tone> = {
  success: 'good',
  failed: 'bad',
  running: 'info',
  pending: 'info',
  manual: 'neutral',
  canceled: 'neutral',
  skipped: 'neutral',
}

/** One word for where a merge request stands, with the tone renderers color it by. */
export function mergeRequestStatus(mr: RenovateMergeRequest): { text: string; tone: Tone } {
  if (mr.state === 'merged') return { text: 'merged', tone: 'good' }
  if (mr.state === 'closed') return { text: 'closed', tone: 'neutral' }
  if (isBroken(mr)) return { text: 'broken', tone: 'bad' }
  if (mr.draft) return { text: 'draft', tone: 'neutral' }
  if (mr.pipeline === 'running' || mr.pipeline === 'pending')
    return { text: 'checking', tone: 'info' }
  return { text: 'awaiting review', tone: 'warning' }
}

const count = <T>(items: T[], test: (item: T) => boolean) => items.filter(test).length

const open = (d: RenovateData) => count(d.mergeRequests, (mr) => mr.state === 'open')
const broken = (d: RenovateData) => count(d.mergeRequests, isBroken)
const ofType = (d: RenovateData, type: RenovateUpdateType) =>
  count(d.updates, (u) => u.type === type)
const majors = (d: RenovateData) => ofType(d, 'major')
const security = (d: RenovateData) => count(d.updates, (u) => u.vulnerability)

/** Stored headline numbers of one `renovate` record. */
export interface RenovateMetrics {
  status: RenovateData['status']
  /** Dependencies Renovate looked up, and how many of them have an update. */
  dependencies: number
  outdated: number
  /** Available updates that are major, and those that fix a known vulnerability. */
  major: number
  security: number
  /** Available minor and patch updates; absent on records stored before they were counted. */
  minor?: number
  patch?: number
  /** Open merge requests, and those of them that are broken. */
  open: number
  broken: number
  /**
   * Dependencies touched by an open merge request, by `manager:dependency`: `broken` when one of
   * those merge requests is broken. Absent on records stored before it was kept.
   */
  pending?: Record<string, 'open' | 'broken'>
}

function pending(data: RenovateData): Record<string, 'open' | 'broken'> {
  const found: Record<string, 'open' | 'broken'> = {}
  for (const mr of data.mergeRequests) {
    if (mr.state !== 'open') continue
    const state = isBroken(mr) ? 'broken' : 'open'
    for (const update of data.updates) {
      if (update.mergeRequest !== mr.id) continue
      const key = `${update.manager}:${update.dependency}`
      if (found[key] !== 'broken') found[key] = state
    }
  }
  return found
}

/** `RenovateMetrics` of `data`. */
export function renovateMetrics(data: RenovateData): RenovateMetrics {
  return {
    status: data.status,
    dependencies: data.dependencies,
    outdated: data.outdated,
    major: majors(data),
    security: security(data),
    minor: ofType(data, 'minor'),
    patch: ofType(data, 'patch'),
    open: open(data),
    broken: broken(data),
    pending: pending(data),
  }
}

function metrics(data: RenovateData, previous?: RenovateData): Metric[] {
  const prev = <T>(read: (d: RenovateData) => T) => (previous ? { previous: read(previous) } : {})
  return [
    ...(data.status === 'failed'
      ? [
          {
            id: 'status',
            label: 'Status',
            value: 'failed',
            unit: 'text' as const,
            tone: 'bad' as const,
            hint: data.problems.find((p) => p.level === 'fatal')?.message ?? 'Renovate failed',
          },
        ]
      : []),
    metric('outdated', 'Outdated', data.outdated, {
      better: 'down',
      hint: `Of ${data.dependencies} dependencies Renovate looked up`,
      ...(previous && { previous: previous.outdated }),
    }),
    metric('major', 'Major updates', majors(data), { better: 'down', ...prev(majors) }),
    {
      ...metric('security', 'Security fixes', security(data), {
        better: 'down',
        hint: 'Updates that fix a known vulnerability',
        ...prev(security),
      }),
      ...(security(data) > 0 && { tone: 'bad' as const }),
    },
    metric('open', 'Open merge requests', open(data), prev(open)),
    {
      ...metric('broken', 'Broken', broken(data), {
        better: 'down',
        hint: 'Open merge requests with a failed pipeline or a Renovate error',
        ...prev(broken),
      }),
      ...(broken(data) > 0 && { tone: 'bad' as const }),
    },
    ...(data.libYears !== undefined
      ? [
          metric('libyears', 'Libyears', Math.round(data.libYears * 10) / 10, {
            better: 'down',
            hint: 'Years the dependencies lag behind their newest releases, summed',
            ...(previous?.libYears !== undefined && {
              previous: Math.round(previous.libYears * 10) / 10,
            }),
          }),
        ]
      : []),
    ...(data.apiRequests !== undefined
      ? [
          metric('api-requests', 'API requests', data.apiRequests, {
            better: 'down',
            hint: 'Forge API requests Renovate made, counted against the token’s rate limits',
            ...(previous?.apiRequests !== undefined && { previous: previous.apiRequests }),
          }),
        ]
      : []),
  ]
}

const versionCell = (from?: string, to?: string): Cell => `${from ?? '?'} → ${to ?? '?'}`

function updatesSection(data: RenovateData): Section | undefined {
  if (!data.updates.length) return undefined
  const byType = typeOrder
    .map((type) => ({ type: typeLabels[type], count: count(data.updates, (u) => u.type === type) }))
    .filter((row) => row.count > 0)
  const mrs = new Map(data.mergeRequests.map((mr) => [mr.id, mr]))
  const rows = data.updates
    .toSorted(
      (a, b) =>
        Number(b.vulnerability) - Number(a.vulnerability) ||
        typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type) ||
        a.dependency.localeCompare(b.dependency),
    )
    .map((update): Record<string, Cell> => {
      const mr = update.mergeRequest !== undefined ? mrs.get(update.mergeRequest) : undefined
      return {
        dependency: update.url ? { text: update.dependency, href: update.url } : update.dependency,
        version: versionCell(update.current, update.next),
        type: {
          text: typeLabels[update.type],
          tone: typeTones[update.type] ?? 'neutral',
          value: typeOrder.indexOf(update.type),
        },
        flags: [
          ...(update.vulnerability ? ['security'] : []),
          ...(update.pending ? ['waiting for release age'] : []),
          ...(update.depType ? [update.depType] : []),
        ].join(', '),
        releasedAt: update.releasedAt ?? null,
        file: update.file,
        mergeRequest: mr
          ? {
              text: `!${mr.id}`,
              ...(mr.url && { href: mr.url }),
              tone: mergeRequestStatus(mr).tone,
            }
          : null,
      }
    })
  return {
    id: 'updates',
    title: 'Available updates',
    description: `${data.outdated} of ${data.dependencies} dependencies have a newer release.`,
    blocks: [
      {
        type: 'chart',
        title: 'By update type',
        chart: 'bar',
        x: 'type',
        series: [{ key: 'count', label: 'Updates', tone: 'info' }],
        data: byType,
      },
      {
        type: 'table',
        columns: [
          { key: 'dependency', label: 'Dependency', format: 'code' },
          { key: 'version', label: 'Version', format: 'code' },
          { key: 'type', label: 'Type' },
          { key: 'flags', label: 'Notes', format: 'tags' },
          { key: 'releasedAt', label: 'Released', format: 'date' },
          { key: 'file', label: 'File', format: 'code', path: true },
          { key: 'mergeRequest', label: 'Merge request' },
        ],
        rows,
      },
    ],
  }
}

const attentionOrder = (mr: RenovateMergeRequest) =>
  isBroken(mr) ? 0 : awaitsReview(mr) ? 1 : mr.state === 'open' ? 2 : 3

function mergeRequestsSection(data: RenovateData): Section | undefined {
  if (!data.mergeRequests.length) return undefined
  return {
    id: 'merge-requests',
    title: 'Merge requests',
    description: 'Open Renovate merge requests and those merged or closed in the last 30 days.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'mergeRequest', label: 'Merge request' },
          { key: 'title', label: 'Title' },
          { key: 'status', label: 'Status' },
          { key: 'pipeline', label: 'Pipeline' },
          { key: 'types', label: 'Updates', format: 'tags' },
          { key: 'mergedAt', label: 'Merged', format: 'date' },
        ],
        rows: data.mergeRequests
          .toSorted((a, b) => attentionOrder(a) - attentionOrder(b) || b.id - a.id)
          .map((mr) => ({
            mergeRequest: { text: `!${mr.id}`, ...(mr.url && { href: mr.url }) },
            title: mr.title,
            status: mergeRequestStatus(mr),
            pipeline: mr.pipeline ? { text: mr.pipeline, tone: pipelineTones[mr.pipeline] } : null,
            types: mr.types.map((type) => typeLabels[type]).join(', '),
            mergedAt: mr.mergedAt ?? null,
          })),
      },
    ],
  }
}

function healthSection(data: RenovateData): Section | undefined {
  const blocks: Block[] = []
  if (data.deprecated.length)
    blocks.push({
      type: 'issues',
      title: 'Deprecated and abandoned',
      items: data.deprecated.map((dep, index) => ({
        id: `deprecated-${index}`,
        tone: dep.message ? 'bad' : 'warning',
        title: `${dep.dependency} ${dep.message ? 'is deprecated' : 'looks abandoned'}`,
        detail: dep.message ?? `No release for a long time. Declared in \`${dep.file}\`.`,
        tags: [dep.manager, dep.file],
      })),
    })
  if (data.problems.length)
    blocks.push({
      type: 'issues',
      title: 'Problems Renovate reported',
      items: data.problems.map((problem, index) => ({
        id: `problem-${index}`,
        tone: problem.level === 'warning' ? 'warning' : 'bad',
        title: problem.message,
        tags: [problem.level],
      })),
    })
  if (data.managers.length)
    blocks.push({
      type: 'table',
      title: 'What Renovate found',
      columns: [
        { key: 'manager', label: 'Manager', format: 'code' },
        { key: 'files', label: 'Files', unit: 'count', align: 'end' },
        { key: 'dependencies', label: 'Dependencies', unit: 'count', align: 'end' },
      ],
      rows: data.managers.map((m) => ({ ...m })),
    })
  if (data.output && (data.status === 'failed' || !data.managers.length))
    blocks.push({ type: 'markdown', text: `\`\`\`text\n${data.output}\n\`\`\`` })
  return blocks.length ? { id: 'health', title: 'Dependency health', blocks } : undefined
}

/** Turns `RenovateData` into a report. Exported for tests and for clients that render locally. */
export function renovateReport(
  data: RenovateData,
  previous?: RenovateData,
): Omit<Report, 'subject'> {
  const mode =
    data.mode === 'report'
      ? data.readOnly
        ? 'report only (read-only repository)'
        : 'report only'
      : 'merge requests'
  return {
    kind: 'renovate',
    title: 'Dependency updates',
    subtitle: `Renovate ${data.renovateVersion} · ${mode}`,
    generatedAt: data.startedAt,
    metrics: metrics(data, previous),
    sections: [updatesSection(data), mergeRequestsSection(data), healthSection(data)].filter(
      (section): section is Section => section !== undefined,
    ),
  }
}

/** The `renovate` analysis kind: outdated dependencies, Renovate merge requests and their health. */
export const renovateAnalysis = defineAnalysis<RenovateData, RenovateMetrics>({
  kind: 'renovate',
  label: 'Renovate',
  schema: renovateDataSchema,
  metrics: renovateMetrics,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...renovateReport(current.data, previous?.data),
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
    }
  },
})
