import type { AgentTaskView } from '@holtkeeper/api'

import { formatUsd } from '../../lib/ai-usage.ts'
import { taskCancellable } from '../../lib/tasks.ts'

/**
 * Caption of a task group's progress bar: how many of its repositories no longer work or wait,
 * then the spend, against `cap` when it is known, e.g. "2 of 5 repositories finished · $1.20 of $10.00".
 */
export function taskGroupProgressLabel(
  tasks: readonly Pick<AgentTaskView, 'status'>[],
  costUsd: number,
  cap?: number,
): string {
  const finished = tasks.filter((task) => !taskCancellable(task.status)).length
  const noun = tasks.length === 1 ? 'repository' : 'repositories'
  const spend =
    cap === undefined ? formatUsd(costUsd) : `${formatUsd(costUsd)} of ${formatUsd(cap)}`
  return `${finished} of ${tasks.length} ${noun} finished · ${spend}`
}
