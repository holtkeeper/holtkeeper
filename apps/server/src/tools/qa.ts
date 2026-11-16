import { type RegistryToolset, defineTool } from '@holtkeeper/agent-tools'
import type { QaChangeView, QaSummaryView, QaTaskList, QaTaskView } from '@holtkeeper/api'
import type { QaChangeKind, TestIdRef } from '@holtkeeper/qa'
import { z } from 'zod'

/** What the `qa` toolset reads for one caller. */
export interface QaToolsAccess {
  /** Tasks with changes in the last `days`, as `GET /api/qa/tasks` answers the caller. */
  tasks(options: { days: 7 | 30 | 90; team?: string }): Promise<QaTaskList>
  /**
   * One task as `GET /api/qa/task` answers the caller; rejects with a `ToolError` when no change
   * the caller may read names it.
   */
  task(key: string): Promise<QaTaskView>
}

/** Rows `qa_tasks` lists at most. */
const TASKS_MAX = 100
/** Files `qa_task` names per change. */
const FILES_MAX = 15

const kindLabels: Record<QaChangeKind, string> = {
  'merge-request': 'merged MR',
  'open-merge-request': 'open MR',
  commit: 'direct commit, no review',
  merge: 'local merge, no review',
}

const repoName = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`

const refText = (ref: TestIdRef) =>
  `\`${ref.attribute}=${ref.value}\`${ref.dynamic ? ' (dynamic)' : ''}`

const counts = ({ merged, open, direct }: QaTaskList['tasks'][number]['counts']) =>
  [merged ? `${merged} merged` : '', open ? `${open} open` : '', direct ? `${direct} direct` : '']
    .filter(Boolean)
    .join(', ')

/** The Markdown answer of `qa_tasks`. */
function renderTasks(list: QaTaskList, query: string): string {
  const needle = query.trim().toLowerCase()
  const rows = list.tasks.filter(
    (task) =>
      !needle ||
      task.key.toLowerCase().includes(needle) ||
      task.title.toLowerCase().includes(needle) ||
      task.repos.some((repo) => repo.path.toLowerCase().includes(needle)),
  )
  const lines = [`## QA tasks of the last ${list.days} days (${rows.length})`]
  if (list.repos.pending)
    lines.push(
      `${list.repos.pending} of ${list.repos.listed} repositories are still being read; call again in a minute for the full list.`,
    )
  if (list.repos.failed.length)
    lines.push(`Could not read: ${list.repos.failed.map((repo) => `\`${repo}\``).join(', ')}.`)
  if (!rows.length) lines.push('', needle ? 'No task matches.' : 'No task has changes.')
  for (const task of rows.slice(0, TASKS_MAX))
    lines.push(
      `- **${task.key}** ${task.title || '(no title)'}${task.issue?.status ? ` [${task.issue.status}]` : ''} — ${task.repos.map(repoName).join(', ')} · ${counts(task.counts)} · last ${task.lastAt}${task.summary ? ` · test notes ${task.summary === 'stale' ? 'outdated' : 'current'}` : ''}`,
    )
  if (rows.length > TASKS_MAX)
    lines.push(`… and ${rows.length - TASKS_MAX} more; pass query to narrow.`)
  if (list.untracked)
    lines.push(
      '',
      `${list.untracked} changes name no task or only placeholder keys and are not listed.`,
    )
  return lines.join('\n')
}

function renderChange(change: QaChangeView): string[] {
  const mr = change.mergeRequest
  const lines = [
    `- **${change.id}** ${change.title} (${kindLabels[change.kind]}${mr?.draft ? ', draft' : ''}) · \`${mr ? `${mr.sourceBranch} → ` : ''}${change.branch}\` · ${change.authors.join(', ')} · ${change.at}${change.url ? ` · ${change.url}` : ''}`,
  ]
  const { detail } = change
  if (!detail) {
    if (change.detailError) lines.push(`  Files unknown: ${change.detailError}.`)
    return lines
  }
  const files = detail.files
    .slice(0, FILES_MAX)
    .map((file) => `\`${file.path}\` +${file.additions}/−${file.deletions}`)
  if (files.length)
    lines.push(
      `  Files (${detail.files.length}${detail.partial ? '+' : ''}): ${files.join(', ')}${detail.files.length > FILES_MAX ? ', …' : ''}`,
    )
  for (const file of detail.testIds) {
    const parts = [
      ...file.added.map((ref) => `+${refText(ref)}`),
      ...file.removed.map((ref) => `−${refText(ref)}`),
    ]
    if (parts.length) lines.push(`  Test ids in \`${file.file}\`: ${parts.join(', ')}`)
  }
  return lines
}

const list = (title: string, items: readonly string[]) =>
  items.length ? ['', `#### ${title}`, ...items.map((item) => `- ${item}`)] : []

function renderSummary(summary: QaSummaryView): string[] {
  const { sections } = summary
  const lines = [
    '',
    `### Test notes (${summary.at}, by ${summary.by.name}, from ${summary.changes} changes)`,
  ]
  if (summary.stale) {
    const { added, removed, updated } = summary.stale
    lines.push(
      `**Outdated:** ${added.length} new, ${updated.length} updated, ${removed.length} gone since they were written.`,
    )
  }
  lines.push(
    '',
    sections.overview,
    '',
    `**Testing:** ${sections.verdict} — ${sections.verdictReason}`,
    ...list('Changes', sections.changes),
    ...list(
      'Test cases',
      sections.testCases.map(
        (test) =>
          `**${test.title}** (${test.priority}): ${test.steps.join('; ')} → ${test.expected}`,
      ),
    ),
    ...list(
      'Kinds of testing',
      sections.testing.map((kind) => `${kind.kind}: ${kind.ideas.join(' ')}`),
    ),
    ...list(
      'Autotests',
      sections.autotests.map(
        (test) =>
          `${test.level}: ${test.idea}${test.testIds.length ? ` (${test.testIds.map((id) => `\`${id}\``).join(', ')})` : ''}`,
      ),
    ),
    ...list('Risks', sections.risks),
    ...list('Questions', sections.questions),
  )
  return lines
}

/** The Markdown answer of `qa_task`. */
function renderTask(task: QaTaskView): string {
  const lines = [
    `## ${task.key} ${task.title}`,
    [
      task.issue?.type,
      task.issue?.status,
      task.url,
      `${task.changes.length} changes in ${task.repos.map(repoName).join(', ')}`,
    ]
      .filter(Boolean)
      .join(' · '),
  ]
  if (task.pending)
    lines.push(`${task.pending} repositories are still being read; the task may have more changes.`)
  for (const repo of task.repos) {
    const key = repoName(repo)
    lines.push('', `### ${key}`)
    for (const change of task.changes.filter((item) => repoName(item.repo) === key))
      lines.push(...renderChange(change))
  }
  if (task.summary) lines.push(...renderSummary(task.summary))
  else
    lines.push(
      '',
      'No test notes yet. People write them with Summarize on the task page in Releases › QA.',
    )
  return lines.join('\n')
}

/**
 * The `qa` toolset: `qa_tasks` lists the tasks (ticket keys) with changes in the caller's
 * repositories, `qa_task` shows one task's merge requests and direct commits per repository with
 * their files, test attribute changes and the newest stored test notes. Read-only: test notes are
 * written on request in the web panel, never by these tools, so agents spend no AI tokens here.
 */
export function qaToolset(access: QaToolsAccess): RegistryToolset {
  return {
    name: 'qa',
    instructions:
      'For testing a task, call qa_tasks to find it and qa_task for its changes, test ids and test notes.',
    tools: [
      defineTool({
        name: 'qa_tasks',
        description:
          'Tasks (ticket keys) with merge requests or direct commits in the last days, newest first: title, repositories, how many changes are merged, open or pushed without review, and whether test notes exist and are current.',
        input: z.object({
          days: z
            .union([z.literal(7), z.literal(30), z.literal(90)])
            .default(30)
            .describe('Period in days: 7, 30 or 90'),
          query: z.string().max(100).optional().describe('Filter by key, title or repository path'),
          team: z.string().min(1).optional().describe('Only repositories of this owner team'),
        }),
        run: async ({ days, query, team }) =>
          renderTasks(await access.tasks({ days, ...(team ? { team } : {}) }), query ?? ''),
        subject: ({ query }) => query || undefined,
      }),
      defineTool({
        name: 'qa_task',
        description:
          'One task by key: its merge requests (merged and open) and direct commits per repository with branches, authors, files and test attribute changes, and the newest stored test notes (overview, test cases, ideas per kind of testing, autotests, risks) with whether they are outdated.',
        input: z.object({
          key: z.string().trim().min(1).max(100).describe('Ticket key, e.g. ABC-123'),
        }),
        run: async ({ key }) => renderTask(await access.task(key)),
        subject: ({ key }) => key,
      }),
    ],
  }
}
