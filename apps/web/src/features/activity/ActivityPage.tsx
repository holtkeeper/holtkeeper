import type { ActivityEvent, ActivityPerson } from '@holtkeeper/api'
import { Activity, FileSearch, KeyRound, Settings2, UserRound } from 'lucide-react'
import { motion } from 'motion/react'

import { useActivity } from '../../api/queries.ts'
import { formatDate, formatRelative, isoDay } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  Page,
  Panel,
  Placeholder,
  Tooltip,
} from '../../ui/index.ts'

const iconFor = (action: string) => {
  const area = action.split('.')[0]
  if (area === 'audit') return FileSearch
  if (area === 'credential') return KeyRound
  if (area === 'setting') return Settings2
  if (area === 'user') return UserRound
  return Activity
}

const verb = (action: string) => action.replaceAll('.', ' ').replaceAll('_', ' ')

function Details({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details)
  if (!entries.length) return null
  return (
    <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-1">
          <dt className="text-muted">{key}</dt>
          <dd className="font-mono">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Who did what, newest first, grouped by day. */
export function ActivityPage() {
  const activity = useActivity()
  const events = activity.data?.pages.flatMap((page) => page.events) ?? []
  const people: Record<string, ActivityPerson> = {}
  for (const page of activity.data?.pages ?? []) Object.assign(people, page.people)
  const days = Map.groupBy(events, (event: ActivityEvent) => isoDay(event.at))

  return (
    <Page title="Activity" icon="activity" description="Changes and audits, newest first">
      {activity.isPending ? (
        <Placeholder className="h-72" />
      ) : activity.isError ? (
        <ErrorState error={activity.error} />
      ) : events.length === 0 ? (
        <EmptyState icon={<Activity />} title="Nothing happened yet" />
      ) : (
        <div className="flex flex-col gap-6">
          {[...days.entries()].map(([day, list]) => (
            <Panel key={day} title={formatDate(`${day}T12:00:00Z`)}>
              <ol className="relative flex flex-col gap-4 border-l border-separator pl-6">
                {list.map((event, index) => {
                  const Icon = iconFor(event.action)
                  const actor = personOf(people, event.actor)
                  const subject = event.subject ? personOf(people, event.subject) : undefined
                  return (
                    <motion.li
                      key={event.id}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{
                        opacity: 1,
                        x: 0,
                        transition: { delay: Math.min(index, 10) * 0.025 },
                      }}
                      className="relative"
                    >
                      <span className="absolute -left-[2.1rem] grid size-7 place-items-center rounded-full border border-border bg-surface">
                        <Icon className="size-3.5 text-muted" />
                      </span>
                      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <Tooltip content={event.actor}>
                          <span
                            tabIndex={0}
                            className="inline-flex items-center gap-1.5 self-center"
                          >
                            <Avatar src={actor.avatarUrl} name={actor.name} size="xs" />
                            <span className={actor.known ? 'font-medium' : 'font-mono text-xs'}>
                              {actor.name}
                            </span>
                          </span>
                        </Tooltip>
                        <span className="text-muted">{verb(event.action)}</span>
                        {subject?.known ? (
                          event.subject === event.actor ? (
                            <span className="text-muted">themselves</span>
                          ) : (
                            <Tooltip content={event.subject}>
                              <span
                                tabIndex={0}
                                className="inline-flex items-center gap-1.5 self-center"
                              >
                                <Avatar src={subject.avatarUrl} name={subject.name} size="xs" />
                                <span className="font-medium">{subject.name}</span>
                              </span>
                            </Tooltip>
                          )
                        ) : event.subject ? (
                          <span className="font-mono text-xs">{event.subject}</span>
                        ) : null}
                        <time dateTime={event.at} className="ml-auto text-xs text-muted">
                          {formatRelative(event.at)}
                        </time>
                      </div>
                      {event.details ? <Details details={event.details} /> : null}
                    </motion.li>
                  )
                })}
              </ol>
            </Panel>
          ))}
          {activity.hasNextPage ? (
            <Button
              variant="secondary"
              onPress={() => void activity.fetchNextPage()}
              isPending={activity.isFetchingNextPage}
            >
              Load older
            </Button>
          ) : null}
        </div>
      )}
    </Page>
  )
}
