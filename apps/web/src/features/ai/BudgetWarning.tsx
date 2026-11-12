import type { InboxBudgetItem } from '@holtkeeper/api'
import { Check } from 'lucide-react'

import { messageOf } from '../../api/client.ts'
import { useInboxDecisions } from '../../api/queries.ts'
import { formatUsd } from '../../lib/ai-usage.ts'
import { formatDateTime } from '../../lib/format.ts'
import { Button, KeyValue, LinkButton, notify } from '../../ui/index.ts'

/**
 * The sheet body of an Inbox budget warning: the week's spend against the budget and its warning
 * line, a link to Settings › AI, and Acknowledge, which snoozes the warning until the week ends.
 */
export function BudgetWarningBody({ item }: { item: InboxBudgetItem }) {
  const { snoozeMany } = useInboxDecisions()
  const warnUsd = (item.weeklyUsd * item.warnPercent) / 100
  return (
    <div className="flex flex-col gap-3">
      <KeyValue
        rows={[
          { label: 'Week of', value: <span className="font-mono">{item.week}</span> },
          { label: 'Spent', value: <span className="font-mono">{formatUsd(item.spentUsd)}</span> },
          {
            label: 'Warning line',
            value: (
              <span className="font-mono">
                {formatUsd(warnUsd)} ({item.warnPercent}%)
              </span>
            ),
          },
          {
            label: 'Weekly budget',
            value: <span className="font-mono">{formatUsd(item.weeklyUsd)}</span>,
          },
          { label: 'Applies to', value: item.scope },
          ...(item.dueAt ? [{ label: 'Week ends', value: formatDateTime(item.dueAt) }] : []),
        ]}
      />
      {item.detail ? <p className="text-xs text-muted">{item.detail}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <LinkButton
          size="sm"
          variant="secondary"
          to="/settings/$section"
          params={{ section: 'ai' }}
        >
          Open Settings › AI
        </LinkButton>
        {!item.snoozed && item.dueAt ? (
          <Button
            size="sm"
            variant="ghost"
            isPending={snoozeMany.isPending}
            onPress={() =>
              snoozeMany.mutate(
                { items: [item], until: item.dueAt! },
                {
                  onSuccess: () => notify.success('Acknowledged until the week ends', item.title),
                  onError: (error) => notify.error('Not acknowledged', messageOf(error)),
                },
              )
            }
          >
            <Check className="size-3.5" />
            Acknowledge
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted">
        Shown once per budget and week to people who may change it. Nothing waits on it.
      </p>
    </div>
  )
}
