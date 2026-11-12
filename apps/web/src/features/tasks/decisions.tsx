import type { AgentTaskGroupView } from '@holtkeeper/api'
import { type ReactNode, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useTaskGroupMutations, useWriteTasks } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { plural } from '../../lib/format.ts'
import { groupSpendCap } from '../../lib/tasks.ts'
import { ConfirmDialog, notify } from '../../ui/index.ts'
import { WriteTasksOff } from './TaskGroupView.tsx'

type Confirm = { kind: 'approve' | 'reject' | 'cancel'; group: AgentTaskGroupView }

/** Decisions on task groups the Tasks page and its sheet share. */
export interface GroupDecisions {
  /** Asks for confirmation, then approves, rejects or cancels `group`. */
  ask: (kind: Confirm['kind'], group: AgentTaskGroupView) => void
  /** Queues the failed and cancelled tasks of `group` again. */
  retry: (group: AgentTaskGroupView) => void
  /** Whether a decision on `groupId` is on its way. */
  busy: (groupId: string) => boolean
  /** The confirmation dialogs; render once. */
  dialogs: ReactNode
}

/**
 * Approve, Reject, Cancel and Retry for task groups. Approve names the spend cap and warns while
 * `tasks.write` is off; Reject audits the proposal as rejected; Cancel stops queued and running
 * repositories; Retry needs no confirmation since its group was approved before.
 */
export function useGroupDecisions(): GroupDecisions {
  const mutations = useTaskGroupMutations()
  const caps = useWriteTasks()
  const [confirm, setConfirm] = useState<Confirm>()
  const close = () => setConfirm(undefined)
  const group = confirm?.group
  const cap = group ? groupSpendCap(group, caps.data) : undefined
  const switchedOff = caps.data?.enabled === false
  const failed = (title: string) => (error: Error) => {
    close()
    notify.error(title, messageOf(error))
  }

  return {
    ask: (kind, each) => setConfirm({ kind, group: each }),
    retry: (each) =>
      mutations.retryGroup.mutate(each.id, {
        onSuccess: () => notify.success('Queued again on the write workers', each.title),
        onError: (error) => notify.error('Not started', messageOf(error)),
      }),
    busy: (groupId) =>
      (mutations.retryGroup.isPending && mutations.retryGroup.variables === groupId) ||
      (mutations.approve.isPending && mutations.approve.variables === groupId) ||
      (mutations.reject.isPending && mutations.reject.variables === groupId) ||
      (mutations.cancel.isPending && mutations.cancel.variables === groupId),
    dialogs: group ? (
      <>
        <ConfirmDialog
          isOpen={confirm.kind === 'approve'}
          onOpenChange={(open) => !open && close()}
          title="Run this change?"
          confirmLabel="Approve and run"
          isPending={mutations.approve.isPending}
          isDisabled={switchedOff}
          onConfirm={() =>
            mutations.approve.mutate(group.id, {
              onSuccess: () => {
                close()
                notify.success('Queued on the write workers', group.title)
              },
              onError: failed('Not started'),
            })
          }
        >
          An agent changes {plural(group.tasks.length, 'repository', 'repositories')} and opens
          draft merge requests for review. It runs as your request
          {cap !== undefined ? `, capped at ${formatUsd(cap)}` : ''}.
          {switchedOff ? <WriteTasksOff /> : null}
        </ConfirmDialog>
        <ConfirmDialog
          isOpen={confirm.kind === 'reject'}
          onOpenChange={(open) => !open && close()}
          title="Reject this task?"
          confirmLabel="Reject"
          isPending={mutations.reject.isPending}
          onConfirm={() =>
            mutations.reject.mutate(group.id, {
              onSuccess: () => {
                close()
                notify.success('Rejected', group.title)
              },
              onError: failed('Not rejected'),
            })
          }
        >
          Nothing runs and nothing is spent. The proposal ends as rejected in the audit log; propose
          it again from Chat to change your mind.
        </ConfirmDialog>
        <ConfirmDialog
          isOpen={confirm.kind === 'cancel'}
          onOpenChange={(open) => !open && close()}
          title="Cancel this task?"
          confirmLabel="Cancel it"
          isPending={mutations.cancel.isPending}
          onConfirm={() =>
            mutations.cancel.mutate(group.id, {
              onSuccess: close,
              onError: failed('Not cancelled'),
            })
          }
        >
          Queued and running repositories stop. Merge requests already open stay; close them on the
          forge.
        </ConfirmDialog>
      </>
    ) : null,
  }
}
