import { expect, test } from 'bun:test'

import type { InboxCount, InboxFeed, InboxItem } from '@holtkeeper/api'

import {
  approveLabel,
  canApprove,
  canReject,
  groupInbox,
  inboxKpis,
  shortItemId,
  kindCounts,
  lineDiff,
  openCount,
  parseInboxSearch,
  renewalDate,
  runBulk,
  snoozeUntil,
  waitLabel,
} from './inbox.ts'

const base = {
  scope: 'acme/widget-kit',
  repos: [{ repo: 'work:acme/widget-kit', groups: ['web'] }],
  href: '/ops/tasks',
  snoozed: false,
}

const task = (id: string, createdAt: string, snoozed = false): InboxItem => ({
  ...base,
  id: `task:${id}`,
  kind: 'task',
  title: `Upgrade some-lib ${id}`,
  createdAt,
  proposedBy: 'u:mira',
  groupId: id,
  taskKind: 'upgrade',
  snoozed,
})

const release = (can: { accept: boolean; run: boolean }): InboxItem => ({
  ...base,
  id: 'release:work:acme/widget-kit',
  kind: 'release',
  title: 'Release acme/widget-kit 1.3.0',
  createdAt: '2026-11-02T09:00:00.000Z',
  repo: 'work:acme/widget-kit',
  stage: 'proposed',
  next: '1.3.0',
  head: 'abc123',
  can,
})

const allowlist: InboxItem = {
  ...base,
  id: 'allowlist:a-1:ABC-123',
  kind: 'allowlist',
  title: 'ABC-123 expires',
  scope: 'Team Web',
  createdAt: '2026-11-04T00:00:00.000Z',
  dueAt: '2026-11-14T00:00:00.000Z',
  settingId: 'a-1',
  settingScope: { groups: ['web'] },
  entry: { id: 'ABC-123', reason: 'Not reachable.', expires: '2026-11-14' },
  expires: '2026-11-14',
  expired: false,
}

const learning: InboxItem = {
  ...base,
  id: 'learning:l-1',
  kind: 'learning',
  title: 'Name widgets after their shape',
  scope: 'acme/shape-lib',
  repos: [{ repo: 'work:acme/shape-lib', groups: ['pay'] }],
  createdAt: '2026-11-01T10:00:00.000Z',
  learningId: 'l-1',
  section: 'review',
  suggestedScope: 'repo',
}

const feed: InboxFeed = {
  mine: [
    task('g-1', '2026-10-15T10:00:00.000Z'),
    task('g-2', '2026-11-03T10:00:00.000Z', true),
    release({ accept: true, run: true }),
    allowlist,
  ],
  teams: [learning, task('g-3', '2026-11-05T10:00:00.000Z')],
  people: { 'u:mira': { name: 'Mira K.', avatarUrl: '' } },
}

const now = new Date('2026-11-12T10:00:00.000Z')

test('the open rows of a feed match the count the server sends for it', () => {
  const server: InboxCount = { mine: 3, teams: 2, total: 5 }
  expect(openCount(feed)).toEqual(server)
  const rows = groupInbox(feed, { tab: 'open', kind: 'all' }).flatMap((s) => s.items)
  expect(rows).toHaveLength(server.total)
  expect(kindCounts(feed, 'open').all).toBe(server.total)
})

test('groups rows into the two sections, keeping order, per tab, kind and query', () => {
  const open = groupInbox(feed, { tab: 'open', kind: 'all' })
  expect(open.map((s) => [s.label, s.items.map((i) => i.id)])).toEqual([
    ['Waiting for you', ['task:g-1', 'release:work:acme/widget-kit', 'allowlist:a-1:ABC-123']],
    ['Your teams can also decide', ['learning:l-1', 'task:g-3']],
  ])
  expect(
    groupInbox(feed, { tab: 'snoozed', kind: 'all' }).map((s) => s.items.map((i) => i.id)),
  ).toEqual([['task:g-2'], []])
  expect(
    groupInbox(feed, { tab: 'open', kind: 'task' }).map((s) => s.items.map((i) => i.id)),
  ).toEqual([['task:g-1'], ['task:g-3']])
  expect(
    groupInbox(feed, { tab: 'open', kind: 'all', query: 'shape-lib' }).flatMap((s) =>
      s.items.map((i) => i.id),
    ),
  ).toEqual(['learning:l-1'])
  expect(
    groupInbox(feed, { tab: 'open', kind: 'all', query: 'mira g-3' }).flatMap((s) =>
      s.items.map((i) => i.id),
    ),
  ).toEqual(['task:g-3'])
})

test('counts each kind segment in the chosen tab', () => {
  expect(kindCounts(feed, 'open')).toEqual({
    all: 5,
    task: 2,
    note: 0,
    learning: 1,
    guide: 0,
    release: 1,
    allowlist: 1,
    budget: 0,
  })
  expect(kindCounts(feed, 'snoozed')).toMatchObject({ all: 1, task: 1 })
})

test('summarises open items for the strip', () => {
  expect(inboxKpis(feed, now)).toEqual({
    mine: 3,
    teams: 2,
    total: 5,
    expired: 0,
    expiring: 1,
    oldestDays: 28,
    snoozed: 1,
  })
  expect(inboxKpis({ mine: [], teams: [], people: {} }, now)).toEqual({
    mine: 0,
    teams: 0,
    total: 0,
    expired: 0,
    expiring: 0,
    snoozed: 0,
  })
  const lapsed = { ...allowlist, id: 'allowlist:a-1:ABC-124', dueAt: '2026-11-10T00:00:00.000Z' }
  const later = { ...allowlist, id: 'allowlist:a-1:ABC-125', dueAt: '2026-12-01T00:00:00.000Z' }
  expect(inboxKpis({ mine: [allowlist, lapsed, later], teams: [], people: {} }, now)).toMatchObject(
    { expired: 1, expiring: 1 },
  )
})

test('names and offers decisions per kind', () => {
  expect(approveLabel(feed.mine[0]!)).toBe('Approve')
  expect(approveLabel(allowlist)).toBe('Renew')
  expect(approveLabel(learning)).toBe('Accept')
  expect(canApprove(release({ accept: false, run: true }))).toBe(false)
  expect(canApprove(release({ accept: true, run: false }))).toBe(true)
  expect(canReject(release({ accept: true, run: false }))).toBe(false)
  expect(canReject(allowlist)).toBe(false)
  expect(canReject(learning)).toBe(true)
})

test('reads the search of /inbox', () => {
  expect(parseInboxSearch({ item: 'task:g-1', kind: 'task', tab: 'snoozed' })).toEqual({
    item: 'task:g-1',
    kind: 'task',
    tab: 'snoozed',
  })
  expect(parseInboxSearch({ item: '', kind: 'widget', tab: 'open' })).toEqual({})
})

test('formats waits, renewals and snoozes', () => {
  expect(waitLabel('2026-11-12T09:55:00.000Z', now)).toBe('5m')
  expect(waitLabel('2026-11-12T01:00:00.000Z', now)).toBe('9h')
  expect(waitLabel('2026-10-15T10:00:00.000Z', now)).toBe('28d')
  expect(renewalDate('2026-11-14', '2026-11-12')).toBe('2026-12-14')
  expect(renewalDate('2026-10-01', '2026-11-12', 7)).toBe('2026-11-19')
  expect(snoozeUntil(now)).toBe('2026-11-13T10:00:00.000Z')
})

test('bulk decisions run one by one and collect errors per row', async () => {
  const seen: string[] = []
  const result = await runBulk(feed.mine, async (item) => {
    seen.push(item.id)
    if (item.kind === 'release') throw new Error('acme/widget-kit moved to def45678 since')
  })
  expect(seen).toEqual(feed.mine.map((item) => item.id))
  expect(result.done).toEqual(['task:g-1', 'task:g-2', 'allowlist:a-1:ABC-123'])
  expect(result.failed).toEqual([
    {
      id: 'release:work:acme/widget-kit',
      title: 'Release acme/widget-kit 1.3.0',
      error: 'acme/widget-kit moved to def45678 since',
    },
  ])
})

test('diffs two texts line by line', () => {
  expect(
    lineDiff('- Run make check.\n- Use ShapeBase.', '- Run make test.\n- Use ShapeBase.'),
  ).toEqual([
    { kind: 'del', text: '- Run make check.' },
    { kind: 'add', text: '- Run make test.' },
    { kind: 'same', text: '- Use ShapeBase.' },
  ])
  expect(lineDiff('', 'new')).toEqual([{ kind: 'add', text: 'new' }])
})

test('shows uuids of items short and other ids whole', () => {
  expect(shortItemId('note:3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e')).toBe('3f2a9c1e')
  expect(shortItemId('allowlist:a-1:ABC-123')).toBe('a-1:ABC-123')
})

const budget: InboxItem = {
  ...base,
  id: 'budget:2026-11-09',
  kind: 'budget',
  title: 'AI spend is close to the weekly limit',
  scope: 'Organization',
  repos: [],
  createdAt: '2026-11-11T08:00:00.000Z',
  dueAt: '2026-11-13T00:00:00.000Z',
  week: '2026-11-09',
  spentUsd: 120,
  weeklyUsd: 150,
  warnPercent: 80,
}

test('a budget warning resets rather than lapses, so it never counts as expiring', () => {
  const past = { ...budget, id: 'budget:2026-11-02', dueAt: '2026-11-09T00:00:00.000Z' }
  expect(inboxKpis({ mine: [budget, past], teams: [], people: {} }, now)).toMatchObject({
    expired: 0,
    expiring: 0,
  })
})

const sortedIds = (sort: 'newest' | 'due') =>
  groupInbox(
    { ...feed, mine: [...feed.mine, budget] },
    { tab: 'open', kind: 'all', sort, mine: true },
  ).map((s) => [s.id, s.items.map((i) => i.id)])

test('sorts rows inside each section and narrows to what waits for the viewer', () => {
  const ids = sortedIds
  expect(ids('newest')).toEqual([
    [
      'mine',
      ['budget:2026-11-09', 'allowlist:a-1:ABC-123', 'release:work:acme/widget-kit', 'task:g-1'],
    ],
  ])
  expect(ids('due')).toEqual([
    [
      'mine',
      ['allowlist:a-1:ABC-123', 'task:g-1', 'release:work:acme/widget-kit', 'budget:2026-11-09'],
    ],
  ])
  expect(parseInboxSearch({ sort: 'due', for: 'mine' })).toEqual({ sort: 'due', for: 'mine' })
  expect(parseInboxSearch({ sort: 'oldest', for: 'everyone' })).toEqual({})
})
