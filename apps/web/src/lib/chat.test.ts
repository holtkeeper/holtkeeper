import { expect, test } from 'bun:test'

import type { ChatForm, ChatMessageList, ChatMessageView, ChatThreadView } from '@holtkeeper/api'

import {
  asksAgent,
  firstUnreadId,
  formCommand,
  formatCost,
  groupMessages,
  hasLiveCards,
  initialValues,
  insertMention,
  matchingCommands,
  mentionAt,
  mentionOptions,
  mergeMessages,
  withNewer,
  withOlder,
  missingFields,
  parseMentions,
  scopeThreads,
  threadScope,
  toolCalls,
  toolSummary,
  unreadBadge,
  withoutPrefix,
} from './chat.ts'

const form: ChatForm = {
  command: 'release deploy',
  submitLabel: 'Deploy',
  fields: [
    {
      kind: 'select',
      name: 'environment',
      label: 'Environment',
      options: [{ value: 'qa', label: 'QA' }],
      initial: 'qa',
    },
    { kind: 'select', name: 'repos', label: 'Repositories', options: [], multiple: true },
    { kind: 'text', name: 'note', label: 'Note', optional: true },
    { kind: 'toggle', name: 'force', label: 'Ignore gates' },
  ],
}

test('forms start from their initial values and report missing fields', () => {
  const values = initialValues(form)
  expect(values).toEqual({ environment: 'qa', repos: [], force: false })
  expect(missingFields(form, values)).toEqual(['Repositories'])
  expect(missingFields(form, { ...values, repos: ['a'] })).toEqual([])
})

test('form commands match the server format', () => {
  expect(
    formCommand(form, { environment: 'qa', repos: ['a', 'b'], note: 'after "lunch"', force: true }),
  ).toBe('release deploy environment=qa repos=a,b note="after \\"lunch\\"" force=true')
  expect(formCommand(form, { note: '' })).toBe('release deploy')
})

const message = (status: 'running' | 'done', at: string): ChatMessageView => ({
  id: at,
  threadId: 't1',
  seq: 1,
  authorType: 'system',
  body: '',
  mentions: [],
  createdAt: at,
  card: { blocks: [{ type: 'steps', steps: [{ label: 'qa', status }] }] },
})
test('live cards are recent cards with unfinished steps', () => {
  const now = new Date('2026-11-02T12:00:00Z')
  expect(hasLiveCards([message('done', '2026-11-02T11:00:00Z')], now)).toBe(false)
  expect(hasLiveCards([message('running', '2026-11-02T11:00:00Z')], now)).toBe(true)
  expect(hasLiveCards([message('running', '2026-10-30T11:00:00Z')], now)).toBe(false)
})

test('hints match the first word, prefix or not', () => {
  const commands = [{ name: 'release' }, { name: 'help' }]
  expect(withoutPrefix('/holtkeeper release deploy')).toBe('release deploy')
  expect(matchingCommands(commands, '/holtkeeper re').map((c) => c.name)).toEqual(['release'])
  expect(matchingCommands(commands, '').map((c) => c.name)).toEqual(['release', 'help'])
  expect(matchingCommands(commands, 'release deploy')).toEqual([])
})

const said = (
  seq: number,
  at: string,
  author: string | undefined,
  extra: Partial<ChatMessageView> = {},
): ChatMessageView => ({
  id: `m${seq}`,
  threadId: 't1',
  seq,
  authorType: author === undefined ? 'agent' : 'human',
  ...(author !== undefined && { authorId: author }),
  body: `message ${seq}`,
  mentions: [],
  createdAt: at,
  ...extra,
})

test('messages merge by id and stay in seq order', () => {
  const first = [said(1, '2026-11-02T12:00:00Z', 'u1'), said(3, '2026-11-02T12:02:00Z', 'u2')]
  const merged = mergeMessages(first, [
    said(2, '2026-11-02T12:01:00Z', 'u1'),
    { ...said(3, '2026-11-02T12:02:00Z', 'u2'), body: 'changed' },
  ])
  expect(merged.map((m) => [m.seq, m.body])).toEqual([
    [1, 'message 1'],
    [2, 'message 2'],
    [3, 'changed'],
  ])
})

test('groups join one author within the gap and split on cards, gaps and days', () => {
  const card = { blocks: [] }
  const groups = groupMessages([
    said(1, '2026-11-02T12:00:00Z', 'u1'),
    said(2, '2026-11-02T12:03:00Z', 'u1'),
    said(3, '2026-11-02T12:20:00Z', 'u1'),
    said(4, '2026-11-02T12:21:00Z', undefined),
    said(5, '2026-11-02T12:22:00Z', undefined, { card }),
    said(6, '2026-11-02T12:23:00Z', undefined),
    said(7, '2026-11-04T12:00:00Z', undefined),
  ])
  expect(groups.map((group) => group.messages.map((m) => m.seq))).toEqual([
    [1, 2],
    [3],
    [4],
    [5],
    [6],
    [7],
  ])
  expect(groups.map((group) => group.day !== undefined)).toEqual([
    true,
    false,
    false,
    false,
    false,
    true,
  ])
  expect(groups[0]).toMatchObject({ key: 'm1', authorType: 'human', authorId: 'u1' })
})

test('the first unread message skips the viewer own messages', () => {
  const list = [
    said(1, '2026-11-02T12:00:00Z', 'u2'),
    said(2, '2026-11-02T12:01:00Z', 'u2'),
    said(3, '2026-11-02T12:02:00Z', 'me'),
    said(4, '2026-11-02T12:03:00Z', undefined),
  ]
  expect(firstUnreadId(list, 0, 'me')).toBeUndefined()
  expect(firstUnreadId(list, 1, 'me')).toBe('m4')
  expect(firstUnreadId(list, 2, 'me')).toBe('m2')
  expect(firstUnreadId(list, 9, 'me')).toBe('m1')
})

test('mentions parse like the server and decide whether the agent replies', () => {
  expect(parseMentions('hi @Holtkeeper, ask @rita.moss. mail a@b.test or @x/y')).toEqual([
    'holtkeeper',
    'rita.moss',
  ])
  expect(asksAgent('@holtkeeper why?', false)).toBe(true)
  expect(asksAgent('plain words', false)).toBe(false)
  expect(asksAgent('plain words', true)).toBe(true)
  expect(asksAgent('/release @holtkeeper', true)).toBe(false)
  expect(asksAgent('   ', true)).toBe(false)
})

test('the mention being typed is found at the caret and replaced by the pick', () => {
  expect(mentionAt('ask @ri', 7)).toEqual({ start: 4, query: 'ri' })
  expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
  expect(mentionAt('mail a@b', 8)).toBeUndefined()
  expect(mentionAt('ask @ri now', 11)).toBeUndefined()
  expect(insertMention('ask @ri now', 4, 7, 'rita.moss')).toEqual({
    text: 'ask @rita.moss now',
    caret: 15,
  })
  expect(insertMention('ask @ri', 4, 7, 'rita.moss')).toEqual({
    text: 'ask @rita.moss ',
    caret: 15,
  })
})

test('mention options match handles and name words, the agent first', () => {
  const people = [
    { handle: 'rita.moss', name: 'Rita Moss', avatarUrl: '/a.svg' },
    { handle: 'tomreed', name: 'Tom Reed', avatarUrl: '/b.svg' },
  ]
  expect(mentionOptions(people, '').map((option) => option.handle)).toEqual([
    'holtkeeper',
    'rita.moss',
    'tomreed',
  ])
  expect(mentionOptions(people, 'Re').map((option) => option.handle)).toEqual(['tomreed'])
  expect(mentionOptions(people, 'h').map((option) => option.handle)).toEqual(['holtkeeper'])
  expect(mentionOptions(people, '', 2)).toHaveLength(2)
})

test('threads scope by home groups, team-wide threads count as mine', () => {
  const threads = [
    { id: 'a', groups: [] },
    { id: 'b', groups: ['games'] },
    { id: 'c', groups: ['puzzles'] },
  ]
  const ids = (view: 'mine' | 'all' | 'others') =>
    scopeThreads(threads, view, ['games']).shown.map((thread) => thread.id)
  expect(ids('mine')).toEqual(['a', 'b'])
  expect(ids('others')).toEqual(['c'])
  expect(ids('all')).toEqual(['a', 'b', 'c'])
  expect(scopeThreads(threads, 'mine', ['games']).counts).toEqual({ mine: 2, all: 3, others: 1 })
  expect(threadScope({ repo: 'work:g/app' })).toBe('g/app')
  expect(threadScope({ group: 'games' })).toBe('games')
  expect(threadScope({})).toBe('Team')
})

test('tool traces pair calls with results and summarize', () => {
  expect(
    toolSummary([
      { tool: 'knowledge', calls: 2 },
      { tool: 'catalog', calls: 1 },
    ]),
  ).toBe('knowledge ×2 · catalog')
  const at = '2026-11-02T12:00:00Z'
  expect(
    toolCalls([
      {
        type: 'assistant',
        at,
        text: 'looking',
        toolCalls: [{ id: 'c1', name: 'k', input: { q: 'x' } }],
      },
      { type: 'tool-result', at, id: 'c1', output: 'found', isError: true },
      { type: 'tool-result', at, id: 'zz', output: 'stray' },
      { type: 'assistant', at, toolCalls: [{ id: 'c2', name: 'r', input: 'raw' }] },
    ]),
  ).toEqual([
    { id: 'c1', name: 'k', input: '{"q":"x"}', output: 'found', isError: true },
    { id: 'c2', name: 'r', input: 'raw' },
  ])
})

test('costs and badges format compactly', () => {
  expect(formatCost(0.0423)).toBe('$0.042')
  expect(formatCost(1.5)).toBe('$1.50')
  expect(unreadBadge(0)).toBe('')
  expect(unreadBadge(7)).toBe('7')
  expect(unreadBadge(120)).toBe('99+')
})

test('polls fold newer messages in, older pages go in front', () => {
  const thread: ChatThreadView = {
    id: 't1',
    title: 'Planning',
    groups: [],
    createdBy: 'u1',
    createdAt: '2026-11-02T12:00:00Z',
    updatedAt: '2026-11-02T12:00:00Z',
    archived: false,
    autoReply: false,
    replying: false,
    unread: 0,
    participants: [],
    summarized: false,
  }
  const page = (seqs: number[], hasMore: boolean, serverTime: string): ChatMessageList => ({
    thread,
    messages: seqs.map((seq) => said(seq, '2026-11-02T12:00:00Z', 'u1')),
    hasMore,
    cursor: seqs.at(-1) ?? 0,
    serverTime,
  })
  const current = { ...page([3, 4], true, 't1'), cursor: 4 }
  const polled = withNewer(current, {
    ...page([5], false, 't2'),
    thread: { ...thread, replying: true },
  })
  expect(polled.messages.map((m) => m.seq)).toEqual([3, 4, 5])
  expect(polled).toMatchObject({
    hasMore: true,
    cursor: 5,
    serverTime: 't2',
    thread: { replying: true },
  })
  const older = withOlder(polled, page([1, 2], false, 't3'))
  expect(older.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
  expect(older).toMatchObject({ hasMore: false, cursor: 5, serverTime: 't2' })
})
