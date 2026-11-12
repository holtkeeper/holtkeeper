import type { InboxCount, InboxFeed, InboxItem, InboxKind } from '@holtkeeper/api'

/** Which half of the Inbox a list shows: open decisions or the ones the viewer snoozed. */
export type InboxTab = 'open' | 'snoozed'

/** A kind segment of the Inbox; `all` shows every kind. */
export type InboxKindFilter = InboxKind | 'all'

/** The two sections of the Inbox in display order, with their headings. */
const inboxSections = [
  { id: 'mine', label: 'Waiting for you' },
  { id: 'teams', label: 'Your teams can also decide' },
] as const

type SectionId = (typeof inboxSections)[number]['id']

/** Kinds in segment order: plural label for the segment, singular for a row's tag. */
export const inboxKinds: readonly { id: InboxKind; label: string; singular: string }[] = [
  { id: 'task', label: 'Task proposals', singular: 'Task proposal' },
  { id: 'note', label: 'Notes', singular: 'Note' },
  { id: 'learning', label: 'Learnings', singular: 'Learning' },
  { id: 'guide', label: 'Guide', singular: 'Guide text' },
  { id: 'release', label: 'Releases', singular: 'Release' },
  { id: 'allowlist', label: 'Allowlist', singular: 'Allowlist entry' },
  { id: 'budget', label: 'Budget', singular: 'Budget warning' },
]

const isInboxKind = (value: unknown): value is InboxKind =>
  inboxKinds.some((kind) => kind.id === value)

/** The singular label of a kind, for a row's tag; the kind itself when unknown. */
export const kindLabel = (kind: InboxKind): string =>
  inboxKinds.find((each) => each.id === kind)?.singular ?? kind

/**
 * The record id a sheet shows for an item: its `id` without the kind prefix, cut to the first 8
 * characters when it is a uuid.
 */
export function shortItemId(id: string): string {
  const rest = id.slice(id.indexOf(':') + 1)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(rest) ? rest.slice(0, 8) : rest
}

/** What the positive decision is called for an item: Approve, Accept or Renew. */
export const approveLabel = (item: InboxItem): string =>
  item.kind === 'task' ? 'Approve' : item.kind === 'allowlist' ? 'Renew' : 'Accept'

/**
 * Whether the viewer can take the positive decision; a release offers Accept only with
 * `can.accept`, a budget warning has nothing to decide.
 */
export const canApprove = (item: InboxItem): boolean =>
  item.kind === 'release' ? item.can.accept : item.kind !== 'budget'

/**
 * Whether the item can be rejected; an allowlist entry can only be renewed or left to lapse, a
 * budget warning only acknowledged.
 */
export const canReject = (item: InboxItem): boolean =>
  item.kind === 'allowlist' || item.kind === 'budget'
    ? false
    : item.kind === 'release'
      ? item.can.run
      : true

/** Row order inside an Inbox section; `oldest` (the server's order) is the default. */
export type InboxSort = 'oldest' | 'newest' | 'due'

/** Sort choices in menu order. */
export const inboxSorts: readonly { id: InboxSort; label: string }[] = [
  { id: 'oldest', label: 'Oldest first' },
  { id: 'newest', label: 'Newest first' },
  { id: 'due', label: 'Lapses soonest' },
]

/**
 * Search parameters of `/inbox`: the open item, the kind segment, the tab, the row order (absent
 * for oldest first) and `for=mine` to show only what waits for the viewer.
 */
export interface InboxSearch {
  item?: string
  kind?: InboxKind
  tab?: 'snoozed'
  sort?: Exclude<InboxSort, 'oldest'>
  for?: 'mine'
}

/** Reads `/inbox` search parameters, dropping unknown values and keeping a non-empty item. */
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
  const item = typeof search.item === 'string' && search.item ? search.item : undefined
  return {
    ...(item && { item }),
    ...(isInboxKind(search.kind) && { kind: search.kind }),
    ...(search.tab === 'snoozed' && { tab: 'snoozed' as const }),
    ...((search.sort === 'newest' || search.sort === 'due') && { sort: search.sort }),
    ...(search.for === 'mine' && { for: 'mine' as const }),
  }
}

/** Kinds whose `dueAt` is an expiry; a budget warning's `dueAt` is only when the week resets. */
const lapses = (item: InboxItem) => item.dueAt !== undefined && item.kind !== 'budget'

const sorters: Record<InboxSort, (a: InboxItem, b: InboxItem) => number> = {
  oldest: () => 0,
  newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  due: (a, b) =>
    (lapses(a) ? Date.parse(a.dueAt!) : Infinity) - (lapses(b) ? Date.parse(b.dueAt!) : Infinity),
}

const inTab = (tab: InboxTab) => (item: InboxItem) => item.snoozed === (tab === 'snoozed')

const matchesQuery = (item: InboxItem, query: string, people: InboxFeed['people']) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [
    item.title,
    item.scope,
    item.detail ?? '',
    ...item.repos.map((repo) => repo.repo),
    item.proposedBy ? (people[item.proposedBy]?.name ?? item.proposedBy) : '',
  ]
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * The rows of a feed as the Inbox lists them: the two sections in order (only Waiting for you
 * with `mine`), narrowed to one tab, one kind segment and a free-text query over title, scope,
 * detail, repositories and the proposer's name. Rows keep the server's oldest-first order unless
 * `sort` says newest first or soonest to lapse (items that never lapse last, budget warnings
 * among them). Empty sections are kept.
 */
export function groupInbox(
  feed: InboxFeed,
  filter: {
    tab: InboxTab
    kind: InboxKindFilter
    query?: string
    sort?: InboxSort
    mine?: boolean
  },
): { id: SectionId; label: string; items: InboxItem[] }[] {
  return inboxSections
    .filter((section) => !filter.mine || section.id === 'mine')
    .map((section) => ({
      id: section.id,
      label: section.label,
      items: feed[section.id]
        .filter(
          (item) =>
            inTab(filter.tab)(item) &&
            (filter.kind === 'all' || item.kind === filter.kind) &&
            matchesQuery(item, filter.query ?? '', feed.people),
        )
        .toSorted(sorters[filter.sort ?? 'oldest']),
    }))
}

/** Items of one tab per kind segment, `all` included, over both sections. */
export function kindCounts(feed: InboxFeed, tab: InboxTab): Record<InboxKindFilter, number> {
  const items = [...feed.mine, ...feed.teams].filter(inTab(tab))
  const count = (kind: InboxKind) => items.filter((item) => item.kind === kind).length
  return {
    all: items.length,
    task: count('task'),
    note: count('note'),
    learning: count('learning'),
    guide: count('guide'),
    release: count('release'),
    allowlist: count('allowlist'),
    budget: count('budget'),
  }
}

/** The sizes of a feed's sections without snoozed items: what `/api/inbox/count` answers for it. */
export function openCount(feed: InboxFeed): InboxCount {
  const mine = feed.mine.filter(inTab('open')).length
  const teams = feed.teams.filter(inTab('open')).length
  return { mine, teams, total: mine + teams }
}

const dayMs = 24 * 3600 * 1000

/** Figures of the summary strip, over open items only. */
export interface InboxKpis extends InboxCount {
  /** Items whose expiry already passed; budget warnings never count, they only reset. */
  expired: number
  /** Items that lapse on their own within the next 7 days; budget warnings never count. */
  expiring: number
  /** Whole days the oldest open item has waited; `undefined` with nothing open. */
  oldestDays?: number
  snoozed: number
}

/** The strip figures over open items; `snoozed` counts the rest of the feed. */
export function inboxKpis(feed: InboxFeed, now: Date): InboxKpis {
  const all = [...feed.mine, ...feed.teams]
  const open = all.filter(inTab('open'))
  const oldest = Math.min(...open.map((item) => Date.parse(item.createdAt)))
  const left = open.flatMap((item) =>
    lapses(item) ? [Date.parse(item.dueAt!) - now.getTime()] : [],
  )
  return {
    ...openCount(feed),
    expired: left.filter((ms) => ms <= 0).length,
    expiring: left.filter((ms) => ms > 0 && ms <= 7 * dayMs).length,
    ...(open.length && { oldestDays: Math.max(0, Math.floor((now.getTime() - oldest) / dayMs)) }),
    snoozed: all.length - open.length,
  }
}

/** How long an item has waited, compact: `5m`, `9h`, `27d`. */
export function waitLabel(createdAt: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(createdAt)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (24 * 60))}d`
}

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * dayMs).toISOString().slice(0, 10)

/**
 * The expiry a renewal sets by default: `days` after the entry's current last day, or after
 * `today` when that is later (an entry that already lapsed starts again from today).
 */
export const renewalDate = (expires: string, today: string, days = 30): string =>
  addDays(expires > today ? expires : today, days)

/** When a snooze of `days` days from `now` ends, as the API takes it. */
export const snoozeUntil = (now: Date, days = 1): string =>
  new Date(now.getTime() + days * dayMs).toISOString()

/** The outcome of a bulk decision: ids that went through and, per failed row, its error. */
export interface BulkResult {
  done: string[]
  failed: { id: string; title: string; error: string }[]
}

/**
 * Runs `decide` on each item one after another, so the server sees the same requests a person
 * clicking each row would send. A failure is recorded against its row and the loop goes on.
 */
export async function runBulk(
  items: readonly InboxItem[],
  decide: (item: InboxItem) => Promise<unknown>,
): Promise<BulkResult> {
  const result: BulkResult = { done: [], failed: [] }
  for (const item of items) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one request after another, as clicks would send them
      await decide(item)
      result.done.push(item.id)
    } catch (error) {
      result.failed.push({
        id: item.id,
        title: item.title,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}

/** One line of a line diff: kept, added in `after` or removed from `before`. */
export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

/** A line diff of two texts by longest common subsequence, removals before additions. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const lcs = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  )
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      lines.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      lines.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  return lines
}
