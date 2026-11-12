import type { AuditEvent, PersonView } from '@holtkeeper/api'
import { useSearch } from '@tanstack/react-router'
import { Download, History, ShieldCheck, UserRound } from 'lucide-react'
import { Fragment, useEffect, useEffectEvent, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { api } from '../../api/endpoints.ts'
import { useHistory, useHistoryScope, useVerifyAuditLog } from '../../api/queries.ts'
import { useHistorySummary, useLastAuditVerify } from '../../api/settings-system.ts'
import {
  auditActionLabel,
  auditDays,
  auditScopeLabel,
  auditStripCounts,
  chainStatus,
  formatClock,
  formatSeq,
} from '../../lib/audit-labels.ts'
import {
  type HistoryFilters,
  auditEventMatches,
  emptyHistoryFilters,
  historyAreas,
  historyQueryOf,
  historyRanges,
  outcomeLabel,
  outcomeTone,
  scopeRepos,
  targetLabel,
} from '../../lib/audit-log.ts'
import { formatDateTime } from '../../lib/format.ts'
import { personOf } from '../../lib/people.ts'
import { settingsSections } from '../../lib/settings-sections.ts'
import { sheetCommand } from '../../lib/sheet.ts'
import { isEditableTarget } from '../../lib/slash-focus.ts'
import {
  Avatar,
  EmptyState,
  ErrorState,
  FilterButton,
  Kbd,
  ListFooter,
  LoadMore,
  Page,
  Placeholder,
  SegmentedTabs,
  SideSheet,
  Strip,
  type StripCell,
  Table,
  Tag,
  Td,
  Th,
  Tr,
  notify,
} from '../../ui/index.ts'
import { useScope } from '../shell/scope.ts'
import { EventDetails, type EventSection, eventDetails } from './EventDetails.tsx'

const outcomeOptions = [
  { id: 'ok', label: 'Succeeded' },
  { id: 'denied', label: 'Denied' },
  { id: 'error', label: 'Failed' },
]

const one = (value: string) => (value ? [value] : [])

const chainTone = {
  success: 'text-ok',
  danger: 'text-bad',
  default: 'text-muted',
} as const

function EventRow({
  event,
  person,
  selected,
  onOpen,
  onActor,
}: {
  event: AuditEvent
  person: PersonView
  selected: boolean
  onOpen: () => void
  onActor: () => void
}) {
  return (
    <Tr selected={selected}>
      <Td>
        <time dateTime={event.at} title={formatDateTime(event.at)} className="mono block">
          {formatClock(event.at)}
        </time>
        <span className="mono text-[11px] text-dim">{formatSeq(event.seq)}</span>
      </Td>
      <Td>
        <button
          type="button"
          aria-label={`Show only events by ${person.name}`}
          onClick={onActor}
          className="flex min-w-0 items-center gap-2 text-left hover:underline"
        >
          <Avatar src={person.avatarUrl} name={person.name} size="xs" />
          <span className="truncate">{person.name}</span>
        </button>
      </Td>
      <Td>
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 items-center gap-1.5 text-left"
          title={event.action}
        >
          <span className="truncate">{auditActionLabel(event.action)}</span>
          {event.outcome === 'ok' ? null : (
            <Tag tone={outcomeTone(event.outcome)}>
              {outcomeLabel(event.outcome)}
              {event.status !== undefined ? ` · ${event.status}` : ''}
            </Tag>
          )}
        </button>
      </Td>
      <Td className="max-w-[240px]">
        <button
          type="button"
          onClick={onOpen}
          title={targetLabel(event.target)}
          className="mono block max-w-full truncate text-left text-xs"
        >
          {event.target.id ?? event.target.type}
        </button>
      </Td>
      <Td className="max-w-[220px] truncate text-xs text-muted">
        <span className={event.target.repo ? 'mono' : ''}>{auditScopeLabel(event)}</span>
      </Td>
    </Tr>
  )
}

/**
 * Settings › Audit log, who did what: the audit events the viewer may see, newest first and
 * grouped by day, with each event's `#seq`, narrowed by the scope switch and the filters. A strip
 * counts events, denied and failed ones and who acted (`GET /api/history/summary`). Viewers with
 * a global `audit:read` also see the daily chain check, verify the chain by hand and export. A row
 * opens the event in the side sheet (J and K open the first or last row); the actor filters by
 * them. The search narrows the loaded events by action, target and `#seq` or id prefix, and a
 * `?repo=` link opens the log filtered to that repository.
 */
export function AuditLogPage() {
  const scope = useHistoryScope()
  const { view, setView, homeGroups } = useScope()
  const search = useSearch({ from: '/app/settings/$section' })
  const [filters, setFilters] = useState<HistoryFilters>(() => ({
    ...emptyHistoryFilters,
    ...(search.repo && { repo: search.repo }),
  }))
  const [text, setText] = useState('')
  const [openId, setOpenId] = useState<string>()
  const [section, setSection] = useState<EventSection>('event')
  const [now] = useState(() => new Date())
  const repos = scopeRepos(view, scope.data, homeGroups)
  const query = historyQueryOf(filters, repos, now)
  const nothingInScope = repos !== undefined && repos.length === 0 && !filters.repo
  const ready = scope.isSuccess && !nothingInScope
  const instance = scope.data?.instance === true
  const history = useHistory(query, ready)
  const summary = useHistorySummary(query, ready)
  const denied = useHistorySummary({ ...query, outcome: 'denied' }, ready && !filters.outcome)
  const failed = useHistorySummary({ ...query, outcome: 'error' }, ready && !filters.outcome)
  const lastVerify = useLastAuditVerify(instance)
  const verify = useVerifyAuditLog()

  const loaded = history.data?.pages.flatMap((page) => page.events) ?? []
  const events = loaded.filter((event) => auditEventMatches(event, text))
  const people: Record<string, PersonView> = { ...summary.data?.people }
  for (const page of history.data?.pages ?? []) Object.assign(people, page.people)
  const personFor = (event: AuditEvent) => {
    const known = personOf(people, event.actor.id)
    return known.known ? known : { ...known, name: event.actor.name }
  }

  const index = events.findIndex((event) => event.id === openId)
  const open = index >= 0 ? events[index] : undefined
  const set = (patch: Partial<HistoryFilters>) =>
    setFilters((current) => ({ ...current, ...patch }))
  const chain = instance ? chainStatus(lastVerify.data, events[0]?.seq, verify.data) : undefined
  const checkedThrough = instance
    ? (verify.data?.lastSeq ?? lastVerify.data?.result?.lastSeq)
    : undefined
  const actorOptions = [
    ...(summary.data?.actors ?? []).map((actor) => ({ id: actor.key, label: actor.name })),
    ...(filters.actor && !summary.data?.actors.some((actor) => actor.key === filters.actor)
      ? [
          {
            id: filters.actor,
            label:
              loaded.find((event) => event.actor.id === filters.actor)?.actor.name ?? filters.actor,
          },
        ]
      : []),
  ]
  const days = auditDays(events, now)

  const counts = summary.data
    ? auditStripCounts(
        summary.data,
        filters.outcome === 'denied' ? summary.data.total : (denied.data?.total ?? 0),
        filters.outcome === 'error' ? summary.data.total : (failed.data?.total ?? 0),
      )
    : undefined
  const range = historyRanges.find((entry) => entry.id === filters.range)?.label ?? ''
  const cells: StripCell[] = counts
    ? [
        {
          value: counts.total.toLocaleString('en-US'),
          label: filters.range === 'all' ? 'events' : `events in ${range}`,
        },
        { value: counts.denied, label: 'denied', tone: counts.denied ? 'danger' : 'none' },
        { value: counts.failed, label: 'failed', tone: counts.failed ? 'warning' : 'none' },
        {
          end: true,
          value: counts.people,
          label: `${counts.people === 1 ? 'person' : 'people'} · ${counts.agents} ${counts.agents === 1 ? 'agent' : 'agents'}${counts.system ? ' · system' : ''}`,
        },
      ]
    : []

  const repoOptions = (scope.data?.repos ?? []).map((entry) => ({
    id: entry.repo,
    label: entry.repo,
  }))

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (openId !== undefined || event.isComposing || !events.length) return
    const command = sheetCommand({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      editable: isEditableTarget(event.target),
    })
    if (command !== 'next' && command !== 'previous') return
    event.preventDefault()
    setOpenId(command === 'next' ? events[0]?.id : events.at(-1)?.id)
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  return (
    <Page
      title={settingsSections.audit.label}
      crumbs={[{ label: settingsSections.audit.label }]}
      description={settingsSections.audit.description}
      tabs={false}
      scope={{ value: view, onChange: setView }}
      {...(instance
        ? {
            primary: {
              label: 'Verify chain',
              icon: ShieldCheck,
              isDisabled: verify.isPending,
              onPress: () =>
                verify.mutate(
                  {},
                  { onError: (error) => notify.error('Verification failed', messageOf(error)) },
                ),
            },
            more: (['csv', 'ndjson'] as const).map((format) => ({
              label: `Export ${format.toUpperCase()}`,
              icon: Download,
              onAction: () => window.location.assign(api.auditLogExportUrl(query, format)),
            })),
          }
        : {})}
      search={{
        value: text,
        onChange: setText,
        'aria-label': 'Filter events',
        placeholder: 'Action, target, id',
      }}
      filters={
        <>
          <FilterButton
            single
            label="Area"
            options={historyAreas}
            value={one(filters.area)}
            onChange={([area]) => set({ area: area ?? '' })}
          />
          <FilterButton
            single
            label="Repository"
            options={repoOptions}
            value={one(filters.repo)}
            onChange={([repo]) => set({ repo: repo ?? '' })}
          />
          <FilterButton
            single
            label="Person"
            options={actorOptions}
            value={one(filters.actor)}
            onChange={([actor]) => set({ actor: actor ?? '' })}
          />
          <FilterButton
            single
            label="Outcome"
            options={outcomeOptions}
            value={one(filters.outcome)}
            onChange={([outcome]) => set({ outcome: outcome ?? '' })}
          />
          <SegmentedTabs
            aria-label="Time range"
            items={historyRanges}
            selected={filters.range}
            onSelect={(next) => {
              const picked = historyRanges.find((entry) => entry.id === next)
              if (picked) set({ range: picked.id })
            }}
          />
        </>
      }
    >
      <section className="overflow-hidden rounded-xl border border-line bg-panel">
        {chain ? (
          <div role="status" className="flex items-start gap-3 border-b border-line px-3.5 py-3">
            <ShieldCheck
              aria-hidden
              className={`mt-0.5 size-4 shrink-0 ${chainTone[chain.tone]}`}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                <Tag tone={chain.tone} dot>
                  {chain.title}
                </Tag>
                <span className="text-muted">{chain.detail}</span>
              </div>
              <p className="m-0 text-xs text-muted">
                Each event stores a fingerprint of the one before it. Editing or deleting any event
                breaks the chain from that point on, so a check shows whether the log was changed
                after the fact.
              </p>
            </div>
          </div>
        ) : null}
        {cells.length ? <Strip label="Audit log summary" cells={cells} /> : null}

        {scope.isError ? (
          <ErrorState error={scope.error} />
        ) : nothingInScope ? (
          <EmptyState
            icon={<History />}
            title="No repositories here"
            description="Switch the scope to see events of other repositories."
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
          <Table label="Audit events">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th>Target</Th>
                <Th>Scope</Th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <Fragment key={day.key}>
                  <tr>
                    <th
                      colSpan={5}
                      scope="colgroup"
                      className="border-b border-line bg-raise px-3.5 py-1.5 text-left text-[11.5px] font-semibold"
                    >
                      {day.title}
                      {day.title === day.date ? null : (
                        <span className="font-normal text-muted"> · {day.date}</span>
                      )}
                    </th>
                  </tr>
                  {day.events.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      person={personFor(event)}
                      selected={event.id === openId}
                      onOpen={() => setOpenId(event.id)}
                      onActor={() => set({ actor: event.actor.id })}
                    />
                  ))}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
        {events.length ? (
          <ListFooter
            shown={events.length}
            total={text ? events.length : Math.max(counts?.total ?? 0, events.length)}
            noun="events"
            {...(text
              ? { caption: `matching “${text.trim()}” among ${loaded.length} loaded` }
              : {})}
            more={
              history.hasNextPage ? (
                <LoadMore
                  onLoad={() => void history.fetchNextPage()}
                  isPending={history.isFetchingNextPage}
                  size="sm"
                >
                  Load older
                </LoadMore>
              ) : undefined
            }
            hints={
              <>
                Navigate <Kbd>J</Kbd>
                <Kbd>K</Kbd> · open <Kbd>↵</Kbd>
              </>
            }
          />
        ) : null}
      </section>

      <SideSheet
        open={open !== undefined}
        onClose={() => setOpenId(undefined)}
        id={open ? formatSeq(open.seq) : undefined}
        title={open ? auditActionLabel(open.action) : ''}
        index={index}
        total={counts?.total ?? events.length}
        {...(index > 0 && { onPrevious: () => setOpenId(events[index - 1]?.id) })}
        {...(index >= 0 &&
          index < events.length - 1 && { onNext: () => setOpenId(events[index + 1]?.id) })}
        {...(open && filters.actor !== open.actor.id
          ? {
              quietActions: [
                {
                  label: `Only ${personFor(open).name}`,
                  icon: UserRound,
                  onPress: () => set({ actor: open.actor.id }),
                },
              ] as const,
            }
          : {})}
        tabs={{
          items: [
            { id: 'event', label: 'Event' },
            { id: 'changes', label: 'Changes', badge: open?.changes?.length ?? 0 },
            ...(open && eventDetails(open) ? [{ id: 'details', label: 'Details' }] : []),
          ],
          selected: section,
          onSelect: (id) => setSection(id === 'changes' || id === 'details' ? id : 'event'),
          'aria-label': 'Event sections',
        }}
      >
        {open ? (
          <EventDetails
            event={open}
            person={personFor(open)}
            section={section === 'details' && !eventDetails(open) ? 'event' : section}
            checkedThrough={checkedThrough}
          />
        ) : null}
      </SideSheet>
    </Page>
  )
}
