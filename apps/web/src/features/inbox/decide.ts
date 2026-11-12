import type { InboxItem } from '@holtkeeper/api'

import { messageOf } from '../../api/client.ts'
import {
  type InboxDecision,
  type InboxDecisionOptions,
  useInboxDecisions,
} from '../../api/queries.ts'
import { approveLabel } from '../../lib/inbox.ts'
import { notify } from '../../ui/index.ts'

/** Takes a decision on one item, telling the person how it went. */
export type Decide = (
  item: InboxItem,
  decision: InboxDecision,
  options?: InboxDecisionOptions,
) => void

const doneText = (item: InboxItem, decision: InboxDecision) =>
  decision === 'reject'
    ? item.kind === 'release'
      ? 'Dismissed until new commits arrive'
      : item.kind === 'task'
        ? 'Task cancelled'
        : 'Rejected'
    : item.kind === 'task'
      ? 'Queued on the write workers'
      : item.kind === 'allowlist'
        ? 'Renewed'
        : 'Accepted'

/** `Decide` backed by `useInboxDecisions`; `onDone` runs after each decision that went through. */
export function useDecide(onDone: (item: InboxItem) => void): { decide: Decide; pending: boolean } {
  const { decide } = useInboxDecisions()
  return {
    pending: decide.isPending,
    decide: (item, decision, options = {}) =>
      decide.mutate(
        { item, decision, ...options },
        {
          onSuccess: () => {
            notify.success(doneText(item, decision), item.title)
            onDone(item)
          },
          onError: (error) =>
            notify.error(
              decision === 'reject' ? 'Not rejected' : `${approveLabel(item)} failed`,
              messageOf(error),
            ),
        },
      ),
  }
}
