import type { Agent, AgentResult, AgentTask } from '@holtkeeper/agent'

/**
 * Which pass over a merge request an agent run belongs to, kept on usage records as `phase`:
 * `initial` is the first review, `update` a review after new commits, `recheck` the check of
 * earlier threads against new commits, `reply` an answer in a thread.
 */
export type ReviewPhase = 'initial' | 'update' | 'recheck' | 'reply'

/** Every `ReviewPhase`, in the order a merge request goes through them. */
export const reviewPhases: readonly ReviewPhase[] = ['initial', 'update', 'recheck', 'reply']

/** `agent` with `phase` on every task that names none; tasks that name one keep it. */
export function withPhase(agent: Agent, phase: ReviewPhase): Agent {
  return {
    name: agent.name,
    run: <Output>(task: AgentTask<Output>): Promise<AgentResult<Output>> =>
      agent.run({ ...task, phase: task.phase ?? phase }),
  }
}
