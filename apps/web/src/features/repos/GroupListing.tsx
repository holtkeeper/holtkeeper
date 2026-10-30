import { RefreshCw } from 'lucide-react'

import { messageOf } from '../../api/client.ts'
import { useGroupListing, useListGroup } from '../../api/queries.ts'
import { formatDate, formatRelative } from '../../lib/format.ts'
import { Button, ErrorState, Notice, Panel, Placeholder, notify } from '../../ui/index.ts'
import { useSession } from '../shell/session.ts'
import { ListingAttempts } from './Attempts.tsx'

/**
 * The repositories polling and schedules find for a group on its forge, listed every 30 minutes
 * or by hand, with the recent attempts.
 */
export function GroupListing({ group }: { group: string }) {
  const { can } = useSession()
  const listing = useGroupListing(group)
  const list = useListGroup(group)

  if (listing.isPending) return <Placeholder className="h-40" />
  if (listing.isError) return <ErrorState error={listing.error} />
  const { repos, listedAt, attempts } = listing.data
  const latest = attempts[0]

  return (
    <Panel
      title="Listing on the forge"
      description="What the group's patterns resolve to on the forge. Polling and schedules use this list; it is refreshed every 30 minutes."
      actions={
        can('settings:write') ? (
          <Button
            variant="secondary"
            size="sm"
            isPending={list.isPending}
            onPress={() =>
              list.mutate(undefined, {
                onSuccess: (result) =>
                  result.attempts[0]?.error
                    ? notify.error('Listing failed', result.attempts[0].error)
                    : notify.success(`${result.repos.length} repositories found`),
                onError: (error) => notify.error('Listing failed', messageOf(error)),
              })
            }
          >
            <RefreshCw className="size-3.5" />
            List now
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {latest?.error ? (
          <Notice tone="danger" title="The last listing failed">
            {latest.error}
            {listedAt
              ? ` Polling keeps the list from ${formatRelative(listedAt)}.`
              : ' Polling uses the exact paths of the patterns until a listing succeeds.'}
          </Notice>
        ) : null}
        <p className="text-sm text-muted">
          {listedAt ? (
            <>
              <span title={formatDate(listedAt)}>Listed {formatRelative(listedAt)}</span>:{' '}
              {repos.length ? repos.map((repo) => repo.path).join(', ') : 'no repositories'}.
            </>
          ) : (
            'Never listed successfully.'
          )}
        </p>
        <ListingAttempts attempts={attempts} />
      </div>
    </Panel>
  )
}
