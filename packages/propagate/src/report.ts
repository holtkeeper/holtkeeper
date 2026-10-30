import {
  type Block,
  type Cell,
  defineAnalysis,
  type Issue,
  type Metric,
  metric,
  type Report,
  type Section,
  type Tone,
} from '@holtkeeper/report'

import { trimText } from './notes.ts'
import { propagationDataSchema } from './schema.ts'
import type { PropagationData, RepoOutcome, RepoStatus } from './types.ts'

const statusOrder: RepoStatus[] = ['updated', 'fixed', 'failed', 'error', 'unchanged', 'skipped']

const statusLabels: Record<RepoStatus, string> = {
  updated: 'Updated cleanly',
  fixed: 'Fixed by agent',
  failed: 'Checks failing',
  error: 'Error',
  unchanged: 'Already on target',
  skipped: 'Not using the packages',
}

/** Tone of each repository status, shared by tables and charts. */
export const statusTones: Record<RepoStatus, Tone> = {
  updated: 'good',
  fixed: 'info',
  failed: 'bad',
  error: 'warning',
  unchanged: 'neutral',
  skipped: 'neutral',
}

/** Repositories per status; `targeted` counts every repository the wave looked at. */
export function waveTotals(data: PropagationData) {
  const count = (status: RepoStatus) => data.repos.filter((repo) => repo.status === status).length
  return {
    targeted: data.repos.length,
    updated: count('updated'),
    fixed: count('fixed'),
    failed: count('failed') + count('error'),
    skipped: count('skipped') + count('unchanged'),
    mergeRequests: data.repos.filter((repo) => repo.mergeRequest).length,
  }
}

const waveName = (data: PropagationData) =>
  data.packages.map((target) => `${target.name}@${target.version}`).join(', ')

/** Whether two waves roll out the same package names, so their numbers compare. */
export const sameWave = (a: PropagationData, b: PropagationData) =>
  a.packages
    .map((target) => target.name)
    .toSorted()
    .join('\0') ===
  b.packages
    .map((target) => target.name)
    .toSorted()
    .join('\0')

const prev = (value: number | undefined) => (value === undefined ? {} : { previous: value })

const tone = (value: number, entry: Metric, color: Tone): Metric =>
  value > 0 ? { ...entry, tone: color } : entry

function metricsOf(data: PropagationData, previous?: PropagationData): Metric[] {
  const now = waveTotals(data)
  const before = previous && sameWave(data, previous) ? waveTotals(previous) : undefined
  return [
    metric('targeted', 'Repositories targeted', now.targeted, prev(before?.targeted)),
    tone(
      now.updated,
      metric('updated', 'Updated cleanly', now.updated, { ...prev(before?.updated), better: 'up' }),
      'good',
    ),
    tone(
      now.fixed,
      metric('fixed', 'Fixed by agent', now.fixed, { ...prev(before?.fixed), better: 'up' }),
      'info',
    ),
    tone(
      now.failed,
      metric('failed', 'Failed', now.failed, { ...prev(before?.failed), better: 'down' }),
      'bad',
    ),
    metric('skipped', 'Skipped or unchanged', now.skipped, prev(before?.skipped)),
    metric('merge-requests', 'Merge requests', now.mergeRequests, prev(before?.mergeRequests)),
  ]
}

const link = (outcome: RepoOutcome): Cell =>
  outcome.webUrl ? { text: outcome.repo, href: outcome.webUrl } : outcome.repo

function overview(data: PropagationData, previous?: PropagationData): Section {
  const before = new Map(
    (previous && sameWave(data, previous) ? previous.repos : []).map((repo) => [
      repo.repo,
      repo.status,
    ]),
  )
  const datum: Record<string, string | number> = { wave: waveName(data) }
  for (const status of statusOrder)
    datum[status] = data.repos.filter((repo) => repo.status === status).length
  const rows = data.repos
    .toSorted(
      (a, b) =>
        statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) ||
        a.repo.localeCompare(b.repo),
    )
    .map((outcome) => {
      const was = before.get(outcome.repo)
      const failing = outcome.checks.filter((check) => !check.ok).map((check) => check.name)
      return {
        repo: link(outcome),
        status: { text: outcome.status, tone: statusTones[outcome.status] },
        previous: was ? { text: was, tone: statusTones[was] } : null,
        bumps:
          outcome.bumps.map((bump) => `${bump.package} ${bump.from} → ${bump.to}`).join(', ') ||
          null,
        checks: failing.length
          ? { text: `failing: ${failing.join(', ')}`, tone: 'bad' as const }
          : outcome.checks.length
            ? { text: 'passing', tone: 'good' as const }
            : null,
        attempts: outcome.attempts,
        mergeRequest: outcome.mergeRequest
          ? {
              text: `!${outcome.mergeRequest.id}${outcome.mergeRequest.draft ? ' (draft)' : ''}`,
              href: outcome.mergeRequest.url,
              tone: outcome.mergeRequest.draft ? ('warning' as const) : ('good' as const),
            }
          : null,
      } satisfies Record<string, Cell>
    })
  const blocks: Block[] = [
    {
      type: 'chart',
      title: 'Repositories by status',
      chart: 'stacked-bar',
      x: 'wave',
      series: statusOrder.map((status) => ({
        key: status,
        label: statusLabels[status],
        tone: statusTones[status],
      })),
      data: [datum],
    },
    {
      type: 'table',
      columns: [
        { key: 'repo', label: 'Repository' },
        { key: 'status', label: 'Status' },
        ...(before.size ? [{ key: 'previous', label: 'Previous wave' }] : []),
        { key: 'bumps', label: 'Bumps', format: 'code' as const },
        { key: 'checks', label: 'Checks' },
        { key: 'attempts', label: 'Fix attempts', align: 'end' as const },
        { key: 'mergeRequest', label: 'Merge request' },
      ],
      rows,
    },
  ]
  return {
    id: 'overview',
    title: 'Wave overview',
    description: `${waveName(data)}${data.dryRun ? ' — dry run, nothing published' : ''}`,
    blocks,
  }
}

function fixedSection(data: PropagationData): Section | undefined {
  const fixed = data.repos.filter((repo) => repo.agent)
  if (fixed.length === 0) return undefined
  const text = fixed
    .map((repo) => {
      const agent = repo.agent!
      const lines = [`### ${repo.repo} — ${repo.status}`, '', agent.summary]
      if (agent.changes.length) lines.push('', ...agent.changes.map((change) => `- ${change}`))
      if (repo.fixedFiles.length)
        lines.push('', `Files: ${repo.fixedFiles.map((file) => `\`${file}\``).join(', ')}`)
      if (agent.remainingProblems.length)
        lines.push(
          '',
          '**Remaining problems:**',
          ...agent.remainingProblems.map((problem) => `- ${problem}`),
        )
      return lines.join('\n')
    })
    .join('\n\n')
  return { id: 'fixed', title: 'Breaking changes fixed', blocks: [{ type: 'markdown', text }] }
}

function failures(data: PropagationData): Section | undefined {
  const items: Issue[] = []
  for (const repo of data.repos) {
    if (repo.status === 'error')
      items.push({
        id: `${repo.repo}:error`,
        tone: 'warning',
        title: `${repo.repo}: ${repo.error ?? 'error'}`,
        ...(repo.webUrl ? { href: repo.webUrl } : {}),
        tags: ['error'],
      })
    if (repo.status !== 'failed') continue
    for (const check of repo.checks.filter((candidate) => !candidate.ok))
      items.push({
        id: `${repo.repo}:${check.name}`,
        tone: 'bad',
        title: `${repo.repo}: ${check.name} fails (exit ${check.exitCode})`,
        detail: `\`${check.command}\`\n\n${trimText(check.output.split('\n').slice(-30).join('\n'), 3000)}`,
        ...(repo.mergeRequest
          ? { href: repo.mergeRequest.url }
          : repo.webUrl
            ? { href: repo.webUrl }
            : {}),
        tags: [check.name, ...(repo.attempts ? [`${repo.attempts} fix attempts`] : [])],
      })
  }
  return items.length
    ? { id: 'failures', title: 'Failures', blocks: [{ type: 'issues', items }] }
    : undefined
}

function releaseNotesSection(data: PropagationData): Section | undefined {
  if (data.releaseNotes.length === 0) return undefined
  return {
    id: 'release-notes',
    title: 'Release notes used',
    blocks: data.releaseNotes.map((note) => ({
      type: 'markdown' as const,
      text: `### ${note.package} ${note.from ?? ''} → ${note.to}\n\n_${note.source}_\n\n${trimText(note.text, 4000)}`,
    })),
  }
}

function planSection(data: PropagationData): Section | undefined {
  const rows = data.repos.flatMap((repo) =>
    repo.usages.map((usage) => ({
      repo: link(repo),
      package: usage.package,
      manifest: usage.manifest,
      location: usage.path.join('.'),
      kind: usage.kind,
      declared: usage.declared,
      next: usage.next
        ? { text: usage.next, tone: 'info' as const }
        : usage.note
          ? { text: usage.note, tone: 'neutral' as const }
          : 'on target',
    })),
  )
  if (rows.length === 0) return undefined
  return {
    id: 'plan',
    title: 'Plan',
    description: 'Every declaration of the packages found through the forge',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'repo', label: 'Repository' },
          { key: 'package', label: 'Package', format: 'code' },
          { key: 'manifest', label: 'Manifest', format: 'code' },
          { key: 'location', label: 'Key', format: 'code' },
          { key: 'kind', label: 'Kind' },
          { key: 'declared', label: 'Declared', format: 'code' },
          { key: 'next', label: 'Bumped to' },
        ],
        rows,
        groupBy: 'repo',
      },
    ],
  }
}

/** The `propagation` analysis: one wave of package updates across a group. */
export const propagationAnalysis = defineAnalysis<PropagationData>({
  kind: 'propagation',
  label: 'Package rollout',
  schema: propagationDataSchema,
  summarize: (data) => metricsOf(data),
  toReport(current, previous): Report {
    const data = current.data
    const sections = [
      overview(data, previous?.data),
      fixedSection(data),
      failures(data),
      releaseNotesSection(data),
      planSection(data),
    ].filter((section) => section !== undefined)
    return {
      kind: 'propagation',
      title: `Rollout of ${waveName(data)}`,
      subtitle: data.group,
      subject: { repo: current.repo, ...(current.ref ? { ref: current.ref } : {}) },
      generatedAt: current.createdAt,
      metrics: metricsOf(data, previous?.data),
      sections,
    }
  },
})
