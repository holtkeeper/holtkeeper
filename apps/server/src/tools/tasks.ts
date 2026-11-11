import { type RegistryToolset, ToolError, defineTool } from '@holtkeeper/agent-tools'
import type { AgentTaskGroupView, AgentTaskView } from '@holtkeeper/api'
import { z } from 'zod'

import { agentTaskKinds } from '../tasks.ts'

/** What the `tasks` toolset does for one caller. */
export interface TaskToolsAccess {
  /**
   * Proposes a change; with `run`, also approves it when the caller may run tasks on every
   * target. `started` says whether it was queued, `reason` why not when it was asked to run.
   */
  start(input: {
    kind: (typeof agentTaskKinds)[number]
    title: string
    prompt: string
    repos: string[]
    run: boolean
  }): Promise<{ group: AgentTaskGroupView; started: boolean; reason?: string }>
  /** A group by its id or the id of one of its tasks, when the caller may see it. */
  status(id: string): Promise<AgentTaskGroupView | undefined>
  /** Queues a review of the merge request a task opened; answers what was queued. */
  requestReview(id: string, repo?: string): Promise<string>
}

const money = (usd: number) => `$${usd.toFixed(2)}`

const taskLine = (task: AgentTaskView) => {
  const mr = task.mergeRequest
  const parts = [`- ${task.repo}: ${task.status}`]
  if (mr)
    parts.push(
      `MR !${mr.id}${mr.draft ? ' (draft)' : ''} ${mr.url}${mr.ci && mr.ci !== 'none' ? `, CI ${mr.ci}` : ''}${mr.state && mr.state !== 'open' ? `, ${mr.state}` : ''}`,
    )
  if (task.costUsd !== undefined) parts.push(`spent ${money(task.costUsd)}`)
  if (task.error) parts.push(task.error)
  return parts.join(' · ')
}

/** A group as compact text for an agent. */
function renderTaskGroup(group: AgentTaskGroupView): string {
  return [
    `Task group ${group.id} (${group.kind}): ${group.title}`,
    `Status: ${group.status}; branch ${group.tasks[0]?.branch ?? '-'}; spent ${money(group.costUsd)}.`,
    ...group.tasks.map(taskLine),
    ...(group.requests?.some((request) => request.status === 'pending')
      ? [
          `Waiting for people to decide on: ${group.requests
            .filter((request) => request.status === 'pending')
            .map((request) => request.repo)
            .join(', ')}.`,
        ]
      : []),
    ...(group.status === 'proposed'
      ? ['A person must approve it in the panel before anything runs.']
      : []),
  ].join('\n')
}

/**
 * The `tasks` toolset: `start_task` proposes a change (and queues it at once when the caller's
 * token may run tasks on every target), `task_status` reports a group with its merge requests and
 * CI, `request_review` asks Holtkeeper to review a merge request one of its tasks opened.
 */
export function tasksToolset(access: TaskToolsAccess): RegistryToolset {
  return {
    name: 'tasks',
    instructions:
      'start_task asks Holtkeeper to change code in repositories through merge requests; a person approves proposals unless your token may run tasks. Poll task_status for progress, merge requests and CI.',
    tools: [
      defineTool({
        name: 'start_task',
        description:
          'Asks Holtkeeper to change code in one or more repositories (forge:path): an agent works in each one and opens a draft merge request on a shared branch. Proposed for a person to approve unless your token has the tasks scope and its owner may run tasks there. Never merges.',
        input: z.object({
          repos: z.array(z.string().min(3)).min(1).max(20),
          title: z.string().trim().min(1).max(200).describe('one line, used for the branch and MR'),
          prompt: z.string().trim().min(1).max(20_000).describe('what to change, as a plan'),
          kind: z.enum(agentTaskKinds).default('fix'),
          run: z
            .boolean()
            .default(true)
            .describe('start right away when allowed; false always only proposes'),
        }),
        readOnly: false,
        subject: (input) => input.repos.join(','),
        async run(input) {
          const { group, started, reason } = await access.start(input)
          const text = renderTaskGroup(group)
          if (started) return `Started.\n${text}`
          return `Proposed${reason ? ` (not started: ${reason})` : ''}.\n${text}`
        },
      }),
      defineTool({
        name: 'task_status',
        description:
          'Status of a task group (or of the group of a task id): each repository with its merge request, CI and spend.',
        input: z.object({ id: z.string().min(1).describe('task group id (g…) or task id (t…)') }),
        subject: (input) => input.id,
        async run(input) {
          const group = await access.status(input.id)
          if (!group) throw new ToolError(`No task ${input.id} you may see.`)
          return renderTaskGroup(group)
        },
      }),
      defineTool({
        name: 'request_review',
        description:
          'Asks Holtkeeper to review a merge request one of its tasks opened. Pass the task id, or the group id and the repository.',
        input: z.object({
          id: z.string().min(1).describe('task id (t…) or task group id (g…)'),
          repo: z.string().min(3).optional().describe('forge:path, needed with a group id'),
        }),
        readOnly: false,
        subject: (input) => input.repo ?? input.id,
        run: (input) => access.requestReview(input.id, input.repo),
      }),
    ],
  }
}
