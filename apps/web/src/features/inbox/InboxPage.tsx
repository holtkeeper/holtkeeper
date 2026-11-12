import type { InboxFeed, InboxItem, InboxKind } from '@holtkeeper/api'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  BookOpen,
  Check,
  Clock,
  FileText,
  Gauge,
  Inbox,
  Lightbulb,
  Pencil,
  Rocket,
  X,
  type LucideIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react'

import { messageOf } from '../../api/client.ts'
import { useInbox, useInboxDecisions, useSnoozeMutations } from '../../api/queries.ts'
import { neighbours } from '../../lib/flow.ts'
import { daysUntil, formatDateTime, isoDay, plural } from '../../lib/format.ts'
import {
  type BulkResult,
  type InboxKindFilter,
  type InboxSearch,
  type InboxTab,
  approveLabel,
  canApprove,
  canReject,
  groupInbox,
  inboxKinds,
  inboxKpis,
  inboxSorts,
  kindCounts,
  kindLabel,
  parseInboxSearch,
  renewalDate,
  shortItemId,
  snoozeUntil,
  waitLabel,
} from '../../lib/inbox.ts'
import { personOf } from '../../lib/people.ts'
import { decisionCommand } from '../../lib/sheet.ts'
import { isEditableTarget } from '../../lib/slash-focus.ts'
import {
  Avatar,
  Button,
  Count,
  EmptyState,
  ErrorState,
  FilterButton,
  Kbd,
  Notice,
  Page,
  Placeholder,
  SegmentedTabs,
  SelectAllTh,
  SelectTd,
  SideSheet,
  Strip,
  Table,
  Tag,
  Td,
  Th,
  Tooltip,
  Tr,
  notify,
} from '../../ui/index.ts'
import { type Decide, useDecide } from './decide.ts'
import { InboxSheetBody, sheetTabs } from './InboxSheetBody.tsx'

const kindIcons: Record<InboxKind, LucideIcon> = {
  task: Pencil,
  note: BookOpen,
  learning: Lightbulb,
  guide: FileText,
  release: Rocket,
  allowlist: Clock,
  budget: Gauge,
}

const crumbs = [{ label: 'Inbox' }] as const

const onSnoozeError = (error: Error) => notify.error('Not changed', messageOf(error))

function Due({ item, now }: { item: InboxItem; now: Date }) {
  if (!item.dueAt) return null
  const days = daysUntil(item.dueAt, now)
  const past = Date.parse(item.dueAt) <= now.getTime()
  if (item.kind === 'budget')
    return (
      <div className="text-[11.5px] text-muted">
        {past || days < 1 ? 'Resets today' : `Resets in ${plural(days, 'day')}`}
      </div>
    )
  return (
    <div className={`text-[11.5px] ${past ? 'text-bad' : days < 7 ? 'text-warn' : 'text-muted'}`}>
      {past ? 'Expired' : days < 1 ? 'Expires today' : `Expires in ${plural(days, 'day')}`}
    </div>
  )
}

function Row({
  item,
  feed,
  now,
  selected,
  onSelect,
  open,
  onOpen,
  error,
  decide,
  onSnooze,
  busy,
}: {
  item: InboxItem
  feed: InboxFeed
  now: Date
  selected: ReadonlySet<string>
  onSelect: (next: Set<string>) => void
  open: boolean
  onOpen: () => void
  error?: string
  decide: Decide
  onSnooze: () => void
  busy: boolean
}) {
  const Icon = kindIcons[item.kind]
  const person = item.proposedBy ? personOf(feed.people, item.proposedBy) : undefined
  return (
    <Tr selected={open} onClick={onOpen}>
      <SelectTd
        id={item.id}
        selected={selected}
        onChange={onSelect}
        label={`Select: ${item.title}`}
      />
      <Td valign="top">
        <Tag>
          <Icon className="size-3" />
          {kindLabel(item.kind)}
        </Tag>
      </Td>
      <Td valign="top" className="w-full min-w-60 whitespace-normal">
        <div className="font-medium">{item.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
          <span className={item.repos.length ? 'mono' : ''}>{item.scope}</span>
          {person ? (
            <>
              <span className="text-dim">·</span>
              <Avatar src={person.avatarUrl} name={person.name} size="xs" />
              <span>{person.name}</span>
            </>
          ) : null}
          {item.detail ? (
            <>
              <span className="text-dim">·</span>
              <span>{item.detail}</span>
            </>
          ) : null}
        </div>
        {error ? <p className="mt-1 text-xs text-bad">{error}</p> : null}
      </Td>
      <Td valign="top" className="whitespace-nowrap">
        <Tooltip content={formatDateTime(item.createdAt)}>
          <span tabIndex={0} className="mono text-xs text-muted">
            {waitLabel(item.createdAt, now)}
          </span>
        </Tooltip>
        <Due item={item} now={now} />
      </Td>
      <Td align="right" valign="top" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-end gap-1">
          {canApprove(item) ? (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() =>
                decide(
                  item,
                  'approve',
                  item.kind === 'allowlist'
                    ? { expires: renewalDate(item.expires, isoDay(now)) }
                    : {},
                )
              }
            >
              <Check className="size-3.5" />
              {approveLabel(item)}
            </Button>
          ) : null}
          {canReject(item) ? (
            <Button
              size="sm"
              variant="ghost"
              isDisabled={busy}
              onPress={() => decide(item, 'reject')}
            >
              Reject
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            isDisabled={busy}
            aria-label={`${item.snoozed ? 'Unsnooze' : 'Snooze'}: ${item.title}`}
            onPress={onSnooze}
          >
            <Clock className="size-3.5" />
          </Button>
        </div>
      </Td>
    </Tr>
  )
}

function InboxSheet({
  item,
  index,
  total,
  previous,
  next,
  decide,
  onSnooze,
  onClose,
}: {
  item: InboxItem
  index?: number
  total: number
  previous?: () => void
  next?: () => void
  decide: Decide
  onSnooze: (days: number) => void
  onClose: () => void
}) {
  const tabs = sheetTabs[item.kind]
  const Icon = kindIcons[item.kind]
  const shortId = shortItemId(item.id)
  const [tab, setTab] = useState(tabs[0]!.id)
  const formOwnsApproval = item.kind === 'learning' || item.kind === 'allowlist'
  const quiet = [
    ...(canApprove(item) && !formOwnsApproval
      ? [{ label: approveLabel(item), icon: Check, onPress: () => decide(item, 'approve') }]
      : []),
    ...(canReject(item)
      ? [{ label: 'Reject', icon: X, onPress: () => decide(item, 'reject') }]
      : []),
  ]
  return (
    <SideSheet
      open
      onClose={onClose}
      id={shortId}
      copyId={shortId}
      title={item.title}
      total={total}
      {...(index !== undefined && { index })}
      {...(previous && { onPrevious: previous })}
      {...(next && { onNext: next })}
      {...(quiet.length === 2
        ? { quietActions: [quiet[0]!, quiet[1]!] as const }
        : quiet.length === 1
          ? { quietActions: [quiet[0]!] as const }
          : {})}
      more={[
        ...(item.snoozed
          ? [{ label: 'Unsnooze', icon: Clock, onAction: () => onSnooze(0) }]
          : [
              { label: 'Snooze 1 day', icon: Clock, onAction: () => onSnooze(1) },
              { label: 'Snooze 1 week', icon: Clock, onAction: () => onSnooze(7) },
            ]),
        { label: 'Open where it lives', href: item.href },
      ]}
      {...(tabs.length > 1 && {
        tabs: { items: tabs, selected: tab, onSelect: setTab, 'aria-label': 'Details' },
      })}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Tag>
            <Icon className="size-3" />
            {kindLabel(item.kind)}
          </Tag>
          <Tag tone="warning" dot>
            {item.snoozed ? 'Snoozed' : 'Needs a decision'}
          </Tag>
          <span className={`text-xs text-muted ${item.repos.length ? 'mono' : ''}`}>
            {item.scope}
          </span>
        </div>
        <InboxSheetBody key={`${item.id}:${tab}`} item={item} tab={tab} decide={decide} />
      </div>
    </SideSheet>
  )
}

function BulkErrors({ result, onDismiss }: { result: BulkResult; onDismiss: () => void }) {
  if (!result.failed.length) return null
  return (
    <div className="border-b border-line px-3 py-2">
      <Notice
        tone="danger"
        title={`${plural(result.failed.length, 'row')} not decided${result.done.length ? `, ${result.done.length} done` : ''}`}
      >
        <ul className="flex flex-col gap-0.5">
          {result.failed.map((row) => (
            <li key={row.id}>
              <b>{row.title}</b>: {row.error}
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" onPress={onDismiss}>
          Dismiss
        </Button>
      </Notice>
    </div>
  )
}

/**
 * Home › Inbox: every decision waiting for the viewer in two sections, what they may decide in
 * their home groups and what their teams can also decide, with a summary strip, kind segments,
 * inline and bulk decisions with per-row errors, a Snoozed tab and a side sheet per item. J and K
 * step through rows, A approves, R rejects and S snoozes the open one.
 */
export function InboxPage() {
  const search = useSearch({ from: '/app/inbox' })
  const navigate = useNavigate({ from: '/inbox' })
  const inbox = useInbox()
  const decisions = useInboxDecisions()
  const snoozes = useSnoozeMutations()
  const [now] = useState(() => new Date())
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [bulk, setBulk] = useState<BulkResult>()
  const tab: InboxTab = search.tab ?? 'open'
  const kind: InboxKindFilter = search.kind ?? 'all'

  const set = (patch: Partial<Record<keyof InboxSearch, unknown>>) =>
    void navigate({ search: (previous) => parseInboxSearch({ ...previous, ...patch }) })

  const feed = inbox.data
  const sections = feed
    ? groupInbox(feed, {
        tab,
        kind,
        query,
        ...(search.sort && { sort: search.sort }),
        mine: search.for === 'mine',
      })
    : []
  const rows = sections.flatMap((section) => section.items)
  const ids = rows.map((item) => item.id)
  const all = feed ? [...feed.mine, ...feed.teams] : []
  const current = all.find((item) => item.id === search.item)
  const step = neighbours(ids, search.item)
  const openItem = (id: string | undefined) => set({ item: id })
  const errors = Object.fromEntries((bulk?.failed ?? []).map((row) => [row.id, row.error]))

  const { decide, pending } = useDecide((item) => {
    if (item.id !== search.item) return
    openItem(step.next ?? step.previous)
  })

  const snooze = (item: InboxItem, days = 1) => {
    if (item.snoozed || days === 0)
      snoozes.unsnooze.mutate(item.id, {
        onSuccess: () => notify.success('Back in the Inbox'),
        onError: onSnoozeError,
      })
    else
      snoozes.snooze.mutate(
        { id: item.id, until: snoozeUntil(new Date(), days) },
        {
          onSuccess: () => {
            notify.success(`Snoozed for ${plural(days, 'day')}`, item.title)
            if (item.id === search.item && tab === 'open') openItem(step.next ?? step.previous)
          },
          onError: onSnoozeError,
        },
      )
  }

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing) return
    const command = decisionCommand({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      editable: isEditableTarget(event.target),
    })
    if (!command || command === 'close') return
    if (command === 'next' || command === 'previous') {
      if (current || !ids.length) return
      event.preventDefault()
      openItem(command === 'next' ? ids[0] : ids.at(-1))
      return
    }
    if (!current) return
    event.preventDefault()
    if (command === 'snooze') snooze(current)
    else if (command === 'reject' && canReject(current)) decide(current, 'reject')
    else if (command === 'approve' && canApprove(current))
      decide(
        current,
        'approve',
        current.kind === 'allowlist'
          ? { expires: renewalDate(current.expires, isoDay(new Date())) }
          : {},
      )
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  const chosen = rows.filter((item) => selected.has(item.id))
  const runBulk = (decision: 'approve' | 'reject') => {
    const eligible = chosen.filter(decision === 'approve' ? canApprove : canReject)
    decisions.bulk.mutate(
      {
        items: eligible,
        decision,
        options: (item) =>
          item.kind === 'allowlist'
            ? { expires: renewalDate(item.expires, isoDay(new Date())) }
            : {},
      },
      {
        onSuccess: (result) => {
          setBulk(result)
          setSelected(new Set(result.failed.map((row) => row.id)))
          const skipped = chosen.length - eligible.length
          if (result.done.length)
            notify.success(
              `${plural(result.done.length, 'decision')} made`,
              skipped ? `${plural(skipped, 'row')} could not take it and stayed` : undefined,
            )
        },
      },
    )
  }
  const snoozeSelected = () =>
    decisions.snoozeMany.mutate(
      { items: chosen, until: snoozeUntil(new Date(), 1) },
      {
        onSuccess: (result) => {
          setBulk(result)
          setSelected(new Set(result.failed.map((row) => row.id)))
        },
      },
    )
  const busy = pending || decisions.bulk.isPending || decisions.snoozeMany.isPending

  const counts = feed ? kindCounts(feed, tab) : undefined
  const kpis = feed ? inboxKpis(feed, now) : undefined

  return (
    <Page
      crumbs={crumbs}
      search={{
        value: query,
        onChange: setQuery,
        'aria-label': 'Filter inbox',
        placeholder: 'Filter by title, repo, person',
      }}
      filters={
        <>
          <SegmentedTabs
            aria-label="Whose decisions"
            selected={search.for ?? 'all'}
            onSelect={(id) => {
              setSelected(new Set())
              set({ for: id === 'mine' ? 'mine' : undefined })
            }}
            items={[
              {
                id: 'mine',
                label: <>For me {kpis ? <Count>{kpis.mine}</Count> : null}</>,
              },
              {
                id: 'all',
                label: <>My teams {kpis ? <Count>{kpis.total}</Count> : null}</>,
              },
            ]}
          />
          <SegmentedTabs
            aria-label="Inbox tab"
            selected={tab}
            onSelect={(id) => {
              setSelected(new Set())
              set({ tab: id === 'snoozed' ? 'snoozed' : undefined })
            }}
            items={[
              { id: 'open', label: 'Open' },
              {
                id: 'snoozed',
                label: (
                  <>
                    Snoozed
                    {kpis?.snoozed ? <Count>{kpis.snoozed}</Count> : null}
                  </>
                ),
                icon: Clock,
              },
            ]}
          />
        </>
      }
    >
      <div className="-mx-4 -mt-4 -mb-4 text-[13px]">
        {kpis ? (
          <Strip
            label="Inbox summary"
            cells={[
              { value: kpis.mine, label: 'wait for you' },
              { value: kpis.teams, label: 'more for your teams' },
              ...(kpis.expired
                ? [{ value: kpis.expired, label: 'expired', tone: 'danger' as const }]
                : []),
              ...(kpis.expiring
                ? [{ value: kpis.expiring, label: 'expire this week', tone: 'warning' as const }]
                : []),
              ...(kpis.oldestDays !== undefined
                ? [{ value: `${kpis.oldestDays}d`, label: 'oldest wait' }]
                : []),
              { value: kpis.snoozed, label: 'snoozed', end: true },
            ]}
          />
        ) : null}
        {counts ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
            <SegmentedTabs
              aria-label="Filter by kind"
              selected={kind}
              onSelect={(id) => set({ kind: id === 'all' ? undefined : id })}
              items={[
                {
                  id: 'all',
                  label: (
                    <>
                      All <Count>{counts.all}</Count>
                    </>
                  ),
                },
                ...inboxKinds.map((each) => ({
                  id: each.id,
                  icon: kindIcons[each.id],
                  label: (
                    <>
                      {each.label} <Count>{counts[each.id]}</Count>
                    </>
                  ),
                })),
              ]}
            />
            <FilterButton
              single
              label="Sort"
              all="Oldest first"
              className="ms-auto"
              options={inboxSorts}
              value={search.sort ? [search.sort] : []}
              onChange={([sort]) => set({ sort: sort === 'oldest' ? undefined : sort })}
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
          <span className="text-muted">
            {chosen.length ? `${chosen.length} selected` : 'Select rows to decide in bulk'}
          </span>
          <span className="flex-1" />
          {tab === 'open' ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!chosen.some(canApprove) || busy}
                isPending={
                  decisions.bulk.isPending && decisions.bulk.variables?.decision === 'approve'
                }
                onPress={() => runBulk('approve')}
              >
                <Check className="size-3.5" />
                Approve selected
              </Button>
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!chosen.some(canReject) || busy}
                isPending={
                  decisions.bulk.isPending && decisions.bulk.variables?.decision === 'reject'
                }
                onPress={() => runBulk('reject')}
              >
                Reject selected
              </Button>
              <Button
                size="sm"
                variant="secondary"
                isDisabled={!chosen.length || busy}
                isPending={decisions.snoozeMany.isPending}
                onPress={snoozeSelected}
              >
                <Clock className="size-3.5" />
                Snooze 1 day
              </Button>
            </>
          ) : null}
        </div>
        {bulk ? <BulkErrors result={bulk} onDismiss={() => setBulk(undefined)} /> : null}
        {inbox.isPending ? (
          <div className="flex flex-col gap-1 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Placeholder key={i} className="h-10" />
            ))}
          </div>
        ) : inbox.isError ? (
          <div className="p-3">
            <ErrorState error={inbox.error} />
          </div>
        ) : !rows.length ? (
          <EmptyState
            icon={<Inbox className="size-5" />}
            title={tab === 'snoozed' ? 'Nothing snoozed' : 'Nothing waits for you'}
            description={
              tab === 'snoozed'
                ? 'Snoozed items come back on their own when the snooze ends.'
                : 'Task proposals, notes, learnings, Guide text, releases and expiring allowlist entries show up here.'
            }
          />
        ) : (
          <Table label="Decisions">
            <thead>
              <tr>
                <SelectAllTh ids={ids} selected={selected} onChange={setSelected} />
                <Th>Kind</Th>
                <Th>Proposal</Th>
                <Th>Waiting</Th>
                <Th align="right">
                  <span className="sr-only">Decision</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {sections.map((section) =>
                section.items.length ? (
                  <SectionRows key={section.id} label={section.label} count={section.items.length}>
                    {section.items.map((item) => (
                      <Row
                        key={item.id}
                        item={item}
                        feed={feed!}
                        now={now}
                        selected={selected}
                        onSelect={setSelected}
                        open={item.id === search.item}
                        onOpen={() => openItem(item.id)}
                        decide={decide}
                        onSnooze={() => snooze(item)}
                        busy={busy}
                        {...(errors[item.id] && { error: errors[item.id] })}
                      />
                    ))}
                  </SectionRows>
                ) : null,
              )}
            </tbody>
          </Table>
        )}
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5 text-xs text-muted">
          <span>
            {kpis ? `${kpis.total} open` : ''} · decisions made here also show in Tasks, Notes,
            Learnings, Guide, Releases and Security
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5">
            Next <Kbd>J</Kbd>
            <Kbd>K</Kbd> · approve <Kbd>A</Kbd> · reject <Kbd>R</Kbd> · snooze <Kbd>S</Kbd>
          </span>
        </footer>
      </div>
      {search.item === undefined ? null : current ? (
        <InboxSheet
          key={current.id}
          item={current}
          total={ids.length}
          {...(step.index >= 0 && { index: step.index })}
          {...(step.previous && { previous: () => openItem(step.previous) })}
          {...(step.next && { next: () => openItem(step.next) })}
          decide={decide}
          onSnooze={(days) => snooze(current, days)}
          onClose={() => openItem(undefined)}
        />
      ) : (
        <SideSheet open onClose={() => openItem(undefined)} title="Inbox item">
          {inbox.isPending ? (
            <Placeholder className="h-40" />
          ) : inbox.isError ? (
            <ErrorState error={inbox.error} />
          ) : (
            <p className="text-sm text-muted">
              This decision is no longer waiting: someone took it, or it lapsed.
            </p>
          )}
        </SideSheet>
      )}
    </Page>
  )
}

function SectionRows({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: ReactNode
}) {
  return (
    <>
      <tr>
        <th
          colSpan={5}
          scope="colgroup"
          className="border-b border-line bg-raise px-3.5 py-1.5 text-left text-xs font-medium text-muted"
        >
          {label} · {count}
        </th>
      </tr>
      {children}
    </>
  )
}
