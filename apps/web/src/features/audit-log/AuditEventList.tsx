import { History } from 'lucide-react'

import type { useHistory } from '../../api/queries.ts'
import { actionLabel, outcomeLabel, outcomeTone } from '../../lib/audit-log.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import { Avatar, EmptyState, ErrorState, LoadMore, Placeholder, Tag } from '../../ui/index.ts'

/**
 * Audit events of a `useHistory` query, newest first: who did what, the outcome when it was not
 * a success, and when, with "Load older events" while more remain.
 */
export function AuditEventList({
  history,
  empty,
  framed = false,
}: {
  history: ReturnType<typeof useHistory>
  /** Title of the empty state. */
  empty: string
  /** Draws the list in a bordered panel. */
  framed?: boolean
}) {
  if (history.isPending) return <Placeholder className="h-32" />
  if (history.isError) return <ErrorState error={history.error} />
  const pages = history.data.pages
  const events = pages.flatMap((page) => page.events)
  const people = Object.assign({}, ...pages.map((page) => page.people))
  if (!events.length) return <EmptyState icon={<History />} title={empty} />
  return (
    <div className="flex flex-col gap-3">
      <ul
        className={`m-0 list-none p-0 ${framed ? 'rounded-xl border border-line bg-panel px-3' : ''}`}
      >
        {events.map((event) => {
          const person = personOf(people, event.actor.id)
          return (
            <li
              key={event.id}
              className="flex items-center gap-2 border-b border-line py-2 text-[12.5px] last:border-b-0"
            >
              <Avatar src={person.avatarUrl} name={person.name} size="xs" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{person.name}</span>{' '}
                <span className="text-muted">{actionLabel(event.action)}</span>
              </span>
              {event.outcome === 'ok' ? null : (
                <Tag tone={outcomeTone(event.outcome)}>{outcomeLabel(event.outcome)}</Tag>
              )}
              <time
                dateTime={event.at}
                title={formatDateTime(event.at)}
                className="mono shrink-0 text-xs text-muted"
              >
                {formatRelative(event.at)}
              </time>
            </li>
          )
        })}
      </ul>
      {history.hasNextPage ? (
        <LoadMore
          onLoad={() => void history.fetchNextPage()}
          isPending={history.isFetchingNextPage}
        >
          Load older events
        </LoadMore>
      ) : null}
    </div>
  )
}
