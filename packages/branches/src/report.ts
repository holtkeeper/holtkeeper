import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Cell, Metric, Report, Section, Tone } from '@holtkeeper/report'

import {
  type BranchCandidate,
  type BranchesData,
  branchesDataSchema,
  type CleanupReason,
} from './model.ts'

const limits = { branches: 200, changes: 50 }

const reasons: Record<CleanupReason, { label: string; tone: Tone; hint: string }> = {
  merged: { label: 'merged', tone: 'warning', hint: 'Its work is on the default branch' },
  closed: { label: 'closed MR', tone: 'warning', hint: 'Its merge request was closed unmerged' },
  stale: { label: 'stale', tone: 'neutral', hint: 'No commits for a long time' },
}

const count = (data: BranchesData, reason?: CleanupReason) =>
  reason ? data.candidates.filter((c) => c.reason === reason).length : data.candidates.length

function metrics(data: BranchesData, previous?: BranchesData): Metric[] {
  const down = (id: string, label: string, reason: CleanupReason | undefined, hint: string) => {
    const value = count(data, reason)
    return {
      ...metric(id, label, value, {
        previous: previous ? count(previous, reason) : undefined,
        better: 'down',
        hint,
      }),
      ...(value > 0 && reason !== 'stale' ? { tone: 'warning' as const } : {}),
    }
  }
  return [
    down('cleanup', 'Branches to clean up', undefined, 'Merged, closed or stale branches'),
    down('merged', 'Merged, not deleted', 'merged', reasons.merged.hint),
    down('closed', 'Closed merge request', 'closed', reasons.closed.hint),
    down('stale', 'Stale', 'stale', `No commits for ${data.staleDays} days or more`),
    metric('branches', 'Branches', data.total, {
      previous: previous?.total,
      hint: `Besides ${data.defaultBranch}; ${data.open} with an open merge request`,
    }),
  ]
}

const authorOf = (candidate: BranchCandidate) => candidate.author ?? 'unknown'

function candidateRow(candidate: BranchCandidate): Record<string, Cell> {
  const reason = reasons[candidate.reason]
  const mr = candidate.mergeRequest
  return {
    branch: candidate.webUrl ? { text: candidate.name, href: candidate.webUrl } : candidate.name,
    reason: { text: reason.label, tone: reason.tone, hint: reason.hint },
    committedAt: candidate.committedAt,
    age: candidate.ageDays,
    author: authorOf(candidate),
    mergeRequest: mr
      ? { text: `!${mr.id} ${mr.title}`, href: mr.webUrl, hint: `${mr.state} by ${mr.author}` }
      : null,
  }
}

function cleanupSection(data: BranchesData): Section {
  const blocks: Block[] = data.candidates.length
    ? [
        {
          type: 'table',
          columns: [
            { key: 'branch', label: 'Branch', format: 'code' },
            { key: 'reason', label: 'Why' },
            { key: 'committedAt', label: 'Last commit', format: 'date' },
            { key: 'age', label: 'Days old', unit: 'count', align: 'end' },
            { key: 'author', label: 'Author' },
            { key: 'mergeRequest', label: 'Merge request' },
          ],
          rows: data.candidates.slice(0, limits.branches).map(candidateRow),
        },
        ...(data.candidates.length > limits.branches
          ? [
              {
                type: 'markdown' as const,
                text: `…and ${data.candidates.length - limits.branches} more branches.`,
              },
            ]
          : []),
      ]
    : [{ type: 'markdown', text: 'Nothing to clean up: every branch is active or in review.' }]
  return {
    id: 'cleanup',
    title: 'To clean up',
    description: `Merged branches first, then branches of closed merge requests, then branches without commits for ${data.staleDays} days. Branches with an open merge request are left out.`,
    blocks,
  }
}

function authorsSection(data: BranchesData): Section {
  const byAuthor = new Map<string, BranchCandidate[]>()
  for (const candidate of data.candidates)
    byAuthor.set(authorOf(candidate), [...(byAuthor.get(authorOf(candidate)) ?? []), candidate])
  const rows = [...byAuthor]
    .map(([author, list]) => ({
      author,
      total: list.length,
      merged: list.filter((c) => c.reason === 'merged').length,
      closed: list.filter((c) => c.reason === 'closed').length,
      stale: list.filter((c) => c.reason === 'stale').length,
      oldest: Math.max(...list.map((c) => c.ageDays)),
    }))
    .toSorted((a, b) => b.total - a.total || a.author.localeCompare(b.author))
  return {
    id: 'authors',
    title: 'By author',
    description:
      'Who last committed to each branch: the person most likely to know whether it can go.',
    blocks: [
      {
        type: 'table',
        columns: [
          { key: 'author', label: 'Author' },
          { key: 'total', label: 'Branches', unit: 'count', align: 'end' },
          { key: 'merged', label: 'Merged', unit: 'count', align: 'end' },
          { key: 'closed', label: 'Closed MR', unit: 'count', align: 'end' },
          { key: 'stale', label: 'Stale', unit: 'count', align: 'end' },
          { key: 'oldest', label: 'Oldest, days', unit: 'count', align: 'end' },
        ],
        rows,
      },
    ],
  }
}

function changesSection(data: BranchesData, previous: BranchesData, compareTo?: string): Section {
  const now = new Set(data.candidates.map((c) => c.name))
  const before = new Set(previous.candidates.map((c) => c.name))
  const rows: Record<string, Cell>[] = [
    ...previous.candidates
      .filter((c) => !now.has(c.name))
      .map((c) => ({
        branch: c.name,
        change: { text: 'cleaned up', tone: 'good' as const },
        author: authorOf(c),
      })),
    ...data.candidates
      .filter((c) => !before.has(c.name))
      .map((c) => ({
        branch: c.name,
        change: { text: `new, ${reasons[c.reason].label}`, tone: 'warning' as const },
        author: authorOf(c),
      })),
  ]
  const since = compareTo ?? 'the previous analysis'
  return {
    id: 'changes',
    title: 'Changes',
    blocks: rows.length
      ? [
          {
            type: 'table',
            title: `Since ${since}`,
            columns: [
              { key: 'branch', label: 'Branch', format: 'code' },
              { key: 'change', label: 'Change' },
              { key: 'author', label: 'Author' },
            ],
            rows: rows.slice(0, limits.changes),
          },
        ]
      : [{ type: 'markdown', text: `No branch to clean up came or went since ${since}.` }],
  }
}

/** Turns `BranchesData` into a report. Exported for tests and for clients that render locally. */
export function branchesReport(
  data: BranchesData,
  options: { previous?: BranchesData; ref?: string; compareTo?: string } = {},
): Omit<Report, 'subject'> {
  const { previous, compareTo } = options
  return {
    kind: 'branches',
    title: 'Branches',
    subtitle: options.ref ?? data.defaultBranch,
    generatedAt: data.checkedAt,
    metrics: metrics(data, previous),
    sections: [
      cleanupSection(data),
      ...(data.candidates.length ? [authorsSection(data)] : []),
      ...(previous ? [changesSection(data, previous, compareTo)] : []),
    ],
  }
}

/**
 * The `branches` analysis kind: branches a repository could delete (merged, closed unmerged or
 * stale), per author, and what came or went since the previous record. Counts carry
 * `better: 'down'`.
 */
export const branchesAnalysis = defineAnalysis<BranchesData>({
  kind: 'branches',
  label: 'Branches',
  schema: branchesDataSchema,
  summarize: (data) => metrics(data),
  toReport(current, previous) {
    return {
      ...branchesReport(current.data, {
        previous: previous?.data,
        ref: current.ref,
        compareTo: previous?.ref,
      }),
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(previous?.ref ? { compareTo: previous.ref } : {}),
      },
    }
  },
})
