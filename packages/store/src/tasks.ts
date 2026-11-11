import type {
  AgentTask,
  AgentTaskFilter,
  AgentTaskGroup,
  AgentTaskGroupFilter,
  AgentTaskStatus,
  AgentTaskStore,
} from './types.ts'

const clone = <T>(value: T): T => structuredClone(value)

const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Newest `updatedAt` first, then by id. */
export const byTaskUpdate = (
  a: { updatedAt: string; id: string },
  b: { updatedAt: string; id: string },
) => binary(b.updatedAt, a.updatedAt) || binary(a.id, b.id)

/** Whether `task` passes every field of `filter` but `limit`. */
export const matchesAgentTaskFilter = (task: AgentTask, filter: AgentTaskFilter = {}) =>
  (!filter.groupIds || filter.groupIds.includes(task.groupId)) &&
  (!filter.repos || filter.repos.includes(task.repo)) &&
  (!filter.status || filter.status.includes(task.status)) &&
  (filter.requester === undefined || filter.requester === task.requester)

/** Whether `group` passes every field of `filter` but `limit`. */
export const matchesAgentGroupFilter = (group: AgentTaskGroup, filter: AgentTaskGroupFilter = {}) =>
  (filter.sourceType === undefined || group.source.type === filter.sourceType) &&
  (!filter.repos || group.repos.some((repo) => filter.repos!.includes(repo))) &&
  (filter.proposedBy === undefined || group.proposedBy === filter.proposedBy)

/** The first `limit` items, or all without one. */
export const limited = <T>(items: T[], limit: number | undefined) =>
  limit === undefined ? items : items.slice(0, Math.max(0, limit))

/** Statuses after which a task never changes again. */
export const finalTaskStatuses: readonly AgentTaskStatus[] = ['done', 'failed', 'cancelled']

/**
 * The status of a group from its tasks: `proposed` while any task waits for approval; the most
 * advanced active status (`running` before `queued` before `approved`) while any task works;
 * then `mr-open` while any merge request is open; `cancelled` when every task was cancelled;
 * `failed` when any of the rest failed, else `done`.
 */
export function agentGroupStatus(tasks: readonly Pick<AgentTask, 'status'>[]): AgentTaskStatus {
  const statuses = new Set(tasks.map((task) => task.status))
  for (const status of ['proposed', 'running', 'queued', 'approved', 'mr-open'] as const)
    if (statuses.has(status)) return status
  statuses.delete('cancelled')
  if (statuses.size === 0) return 'cancelled'
  return statuses.has('failed') ? 'failed' : 'done'
}

/** The in-memory `AgentTaskStore`. */
export function memoryTasks(): AgentTaskStore {
  const tasks = new Map<string, AgentTask>()
  const groups = new Map<string, AgentTaskGroup>()
  return {
    get: async (id) => clone(tasks.get(id)),
    list: async (filter) =>
      limited(
        [...tasks.values()]
          .filter((task) => matchesAgentTaskFilter(task, filter))
          .toSorted(byTaskUpdate),
        filter?.limit,
      ).map(clone),
    async put(task) {
      tasks.set(task.id, clone(task))
    },
    async transition(task, from) {
      const current = tasks.get(task.id)
      if (!current || !from.includes(current.status)) return false
      tasks.set(task.id, clone(task))
      return true
    },
    getGroup: async (id) => clone(groups.get(id)),
    listGroups: async (filter) =>
      limited(
        [...groups.values()]
          .filter((group) => matchesAgentGroupFilter(group, filter))
          .toSorted(byTaskUpdate),
        filter?.limit,
      ).map(clone),
    async putGroup(group) {
      groups.set(group.id, clone(group))
    },
  }
}
