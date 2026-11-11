import type { AuditEvent, PersonView } from '@holtkeeper/api'
import { Download, History, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import { useHistory, useHistoryScope, useVerifyAuditLog } from '../../api/queries.ts'
import { formatDateTime, formatRelative } from '../../lib/format.ts'
import {
  type HistoryFilters,
  actionLabel,
  emptyHistoryFilters,
  historyAreas,
  historyQueryOf,
  historyRanges,
  outcomeTone,
  scopeRepos,
  targetLabel,
  verificationSummary,
} from '../../lib/history.ts'
import { personOf } from '../../lib/people.ts'
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  LoadMore,
  Notice,
  Page,
  Placeholder,
  ScopeSwitch,
  Segmented,
  Select,
  SideSheet,
  Tag,
  buttonClass,
  notify,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { EventDetails } from './EventDetails.tsx'

const any = 'any'

const outcomeOptions = [
  { id: any, label: 'Any outcome' },
  { id: 'ok', label: 'ok' },
  { id: 'denied', label: 'denied' },
  { id: 'error', label: 'error' },
]

const rowGrid =
  'grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[88px_minmax(0,200px)_minmax(0,1fr)_minmax(0,260px)]'

function Row({
  event,
  person,
  onOpen,
  onActor,
}: {
  event: AuditEvent
  person: PersonView
  onOpen: () => void
  onActor: () => void
}) {
  return (
    <li
      className={`${rowGrid} min-h-9 border-b border-line px-3 py-1.5 last:border-b-0 hover:bg-raise`}
    >
      <time
        dateTime={event.at}
        title={formatDateTime(event.at)}
        className="mono truncate text-xs text-muted"
      >
        {formatRelative(event.at)}
      </time>
      <button
        type="button"
        onClick={onActor}
        title={`Only ${person.name}`}
        className="flex min-w-0 items-center gap-2 text-left hover:underline"
      >
        <Avatar src={person.avatarUrl} name={person.name} size="xs" />
        <span className="truncate">{person.name}</span>
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="col-span-2 flex min-w-0 items-center gap-2 text-left sm:col-span-1"
      >
        <span className="truncate">{actionLabel(event.action)}</span>
        {event.outcome === 'ok' ? null : (
          <Tag tone={outcomeTone(event.outcome)}>{event.outcome}</Tag>
        )}
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="mono col-span-2 truncate text-left text-xs text-muted sm:col-span-1"
        title={targetLabel(event.target)}
      >
        {targetLabel(event.target)}
      </button>
    </li>
  )
}

/**
 * Who did what: the audit events the viewer may see, newest first, narrowed by the scope switch
 * and the filters. A row opens the event's details in the side sheet; the actor filters by them.
 */
export function HistoryPage() {
  const scope = useHistoryScope()
  const { view, setView, homeGroups } = useScope()
  const [filters, setFilters] = useState<HistoryFilters>(emptyHistoryFilters)
  const [openId, setOpenId] = useState<string>()
  const [now] = useState(() => new Date())
  const repos = scopeRepos(view, scope.data, homeGroups)
  const query = historyQueryOf(filters, repos, now)
  const nothingInScope = repos !== undefined && repos.length === 0 && !filters.repo
  const history = useHistory(query, scope.isSuccess && !nothingInScope)
  const verify = useVerifyAuditLog()

  const events = history.data?.pages.flatMap((page) => page.events) ?? []
  const people: Record<string, PersonView> = {}
  for (const page of history.data?.pages ?? []) Object.assign(people, page.people)
  const personFor = (event: AuditEvent) => {
    const known = personOf(people, event.actor.id)
    return known.known ? known : { ...known, name: event.actor.name }
  }

  const index = events.findIndex((event) => event.id === openId)
  const open = index >= 0 ? events[index] : undefined
  const set = (patch: Partial<HistoryFilters>) =>
    setFilters((current) => ({ ...current, ...patch }))
  const instance = scope.data?.instance === true
  const summary = verify.data ? verificationSummary(verify.data) : undefined
  const actorName = filters.actor
    ? (events.find((event) => event.actor.id === filters.actor)?.actor.name ?? filters.actor)
    : undefined

  const repoOptions = [
    { id: any, label: 'Any repository' },
    ...(scope.data?.repos ?? []).map((entry) => ({
      id: entry.repo,
      label: <span className="mono text-xs">{entry.repo}</span>,
      text: entry.repo,
    })),
  ]

  return (
    <Page
      title="History"
      icon="auditlog"
      description="Who changed what, newest first"
      actions={
        <>
          <ScopeSwitch value={view} onChange={setView} />
          {instance ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                isPending={verify.isPending}
                onPress={() =>
                  verify.mutate(
                    {},
                    { onError: (error) => notify.error('Verification failed', messageOf(error)) },
                  )
                }
              >
                <ShieldCheck className="size-4" />
                Verify chain
              </Button>
              {(['csv', 'ndjson'] as const).map((format) => (
                <a
                  key={format}
                  href={api.auditLogExportUrl(query, format)}
                  download
                  className={buttonClass('secondary', 'sm')}
                >
                  <Download className="size-4" />
                  {format.toUpperCase()}
                </a>
              ))}
            </>
          ) : null}
        </>
      }
    >
      {summary ? (
        <Notice tone={summary.tone} title={summary.title}>
          {summary.description}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Area"
          options={[{ id: any, label: 'Any area' }, ...historyAreas]}
          value={filters.area || any}
          onChange={(area) => set({ area: area === any ? '' : area })}
          className="w-40"
        />
        <Select
          aria-label="Repository"
          options={repoOptions}
          value={filters.repo || any}
          onChange={(repo) => set({ repo: repo === any ? '' : repo })}
          className="w-64"
        />
        <Select
          aria-label="Outcome"
          options={outcomeOptions}
          value={filters.outcome || any}
          onChange={(outcome) => set({ outcome: outcome === any ? '' : outcome })}
          className="w-36"
        />
        <Segmented
          aria-label="Time range"
          options={historyRanges}
          value={filters.range}
          onChange={(range) => set({ range })}
        />
        {actorName ? (
          <Tag className="gap-1.5">
            {actorName}
            <button
              type="button"
              aria-label="Clear the person filter"
              onClick={() => set({ actor: '' })}
              className="text-muted hover:text-current"
            >
              <X className="size-3" />
            </button>
          </Tag>
        ) : null}
      </div>

      <section className="overflow-hidden rounded-xl border border-line bg-panel">
        <div
          className={`${rowGrid} hidden border-b border-line px-3 py-2 text-xs text-dim sm:grid`}
          aria-hidden
        >
          <span>Time</span>
          <span>Actor</span>
          <span>Action</span>
          <span>Target</span>
        </div>
        {scope.isError ? (
          <ErrorState error={scope.error} />
        ) : nothingInScope ? (
          <EmptyState
            icon={<History />}
            title="No repositories here"
            description="Switch the scope to see history of other repositories."
          />
        ) : history.isPending ? (
          <div className="flex flex-col gap-1 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Placeholder key={i} className="h-7" />
            ))}
          </div>
        ) : history.isError ? (
          <ErrorState error={history.error} />
        ) : events.length === 0 ? (
          <EmptyState
            icon={<History />}
            title="Nothing happened here"
            description="Widen the time range or loosen the filters."
          />
        ) : (
          <ul className="text-[13px]">
            {events.map((event) => (
              <Row
                key={event.id}
                event={event}
                person={personFor(event)}
                onOpen={() => setOpenId(event.id)}
                onActor={() => set({ actor: event.actor.id })}
              />
            ))}
          </ul>
        )}
        {history.hasNextPage ? (
          <div className="border-t border-line p-2">
            <LoadMore
              onLoad={() => void history.fetchNextPage()}
              isPending={history.isFetchingNextPage}
            >
              Load older
            </LoadMore>
          </div>
        ) : null}
      </section>

      <SideSheet
        open={open !== undefined}
        onClose={() => setOpenId(undefined)}
        id={open ? `#${open.seq}` : undefined}
        title={open ? actionLabel(open.action) : ''}
        index={index}
        total={events.length}
        {...(index > 0 && { onPrevious: () => setOpenId(events[index - 1]?.id) })}
        {...(index >= 0 &&
          index < events.length - 1 && { onNext: () => setOpenId(events[index + 1]?.id) })}
      >
        {open ? <EventDetails event={open} person={personFor(open)} /> : null}
      </SideSheet>
    </Page>
  )
}
