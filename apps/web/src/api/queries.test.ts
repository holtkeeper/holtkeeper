import { afterEach, expect, test } from 'bun:test'

import type { InboxItem } from '@holtkeeper/api'

import { api } from './endpoints.ts'
import { decideInbox, decisionQueryKeys, keys } from './queries.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

test('every decision refreshes Inbox, Home and its own area', () => {
  expect(decisionQueryKeys(['task'])).toEqual([keys.inbox, keys.home, ['tasks'], ['chat', 'poll']])
  expect(decisionQueryKeys(['learning', 'learning'])).toEqual([
    keys.inbox,
    keys.home,
    keys.learnings,
    keys.rules,
  ])
  expect(decisionQueryKeys(['release', 'release'])).toEqual([keys.inbox, keys.home, keys.releases])
  for (const kind of ['budget', 'allowlist'] as const)
    expect(decisionQueryKeys([kind]).slice(0, 2)).toEqual([keys.inbox, keys.home])
  expect(decisionQueryKeys(['allowlist'])).toContainEqual(keys.settings)
})

test('rule and effective prompt queries live under the prefix rule mutations refresh', () => {
  const repo = { forge: 'gl', path: 'acme/widget-kit' }
  for (const key of [keys.rule('r-1'), keys.effectiveRules(repo, 'review', ['src/a.ts'])])
    expect(key[0]).toBe(keys.rules[0])
  expect(keys.effectiveRules(repo, 'task', ['a.ts', 'b.ts'])).toEqual([
    'rules',
    'effective',
    'gl:acme/widget-kit',
    'task',
    'a.ts,b.ts',
  ])
  expect(keys.chatContext('t-1')).toEqual([...keys.chat, 'context', 't-1'])
})

test('chat threads send q only when it has text, and the export link names the thread', async () => {
  const calls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : input.toString())
      return new Response('{}', { status: 200 })
    },
    { preconnect: realFetch.preconnect },
  )
  await api.chatThreads(true, '  widget ')
  await api.chatThreads(false, '   ')
  await api.decideLearning('l-1', 'approve')
  await api.rules({ team: 'widgets', text: '  money ' })
  await api.learnings({ status: ['pending', 'active'], text: ' ' })
  await api.effectiveRules({ forge: 'gl', path: 'acme/widget-kit' }, 'review', ['a.ts', 'b.ts'])
  expect(calls).toEqual([
    '/api/chat/threads?archived=true&q=widget',
    '/api/chat/threads',
    '/api/learnings/l-1/approve',
    '/api/rules?team=widgets&text=money',
    '/api/learnings?status=pending%2Cactive',
    '/api/rules/effective?repo=gl%3Aacme%2Fwidget-kit&agent=review&files=a.ts%2Cb.ts',
  ])
  expect(api.chatExportUrl('t 1')).toBe('/api/chat/threads/t%201/export')
})

test('an Inbox decision on a task group approves or rejects it, never cancels', async () => {
  const calls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(
        `${init?.method ?? 'GET'} ${input instanceof Request ? input.url : input.toString()}`,
      )
      return new Response('{}', { status: 200 })
    },
    { preconnect: realFetch.preconnect },
  )
  const item: InboxItem = {
    id: 'task:g-1',
    kind: 'task',
    title: 'Upgrade some-lib',
    createdAt: '2026-11-02T09:00:00.000Z',
    proposedBy: 'u:mira',
    groupId: 'g-1',
    taskKind: 'upgrade',
    scope: 'acme/widget-kit',
    repos: [{ repo: 'work:acme/widget-kit', teams: [] }],
    href: '/ops/tasks',
    snoozed: false,
  }
  await decideInbox(item, 'reject')
  await decideInbox(item, 'approve')
  expect(calls).toEqual(['POST /api/task-groups/g-1/reject', 'POST /api/task-groups/g-1/approve'])
})
