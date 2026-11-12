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
  expect(decisionQueryKeys(['learning', 'guide'])).toEqual([
    keys.inbox,
    keys.home,
    keys.learnings,
    keys.guide,
    keys.knowledgeCounts,
  ])
  expect(decisionQueryKeys(['release', 'release'])).toEqual([keys.inbox, keys.home, keys.releases])
  for (const kind of ['note', 'allowlist'] as const)
    expect(decisionQueryKeys([kind]).slice(0, 2)).toEqual([keys.inbox, keys.home])
  expect(decisionQueryKeys(['allowlist'])).toContainEqual(keys.settings)
})

test('phase-19 queries live under the prefixes their mutations refresh', () => {
  const repo = { forge: 'gl', path: 'acme/widget-kit' }
  expect(keys.knowledgeCounts[0]).toBe(keys.knowledge[0])
  for (const key of [
    keys.guideChain(repo, 'testing'),
    keys.guideChain(repo),
    keys.guideRepoFiles(repo),
    keys.guideGeneratedHistory('repo:gl:acme/widget-kit', 'testing'),
  ])
    expect(key[0]).toBe(keys.guide[0])
  expect(keys.guideChain(repo)).toEqual(['guide', 'chain', 'gl:acme/widget-kit', '*'])
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
  await api.acceptLearnings({ ids: ['l-1', 'l-2'] })
  expect(calls).toEqual([
    '/api/chat/threads?archived=true&q=widget',
    '/api/chat/threads',
    '/api/learnings/accept',
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
    repos: [{ repo: 'work:acme/widget-kit', groups: [] }],
    href: '/ops/tasks',
    snoozed: false,
  }
  await decideInbox(item, 'reject')
  await decideInbox(item, 'approve')
  expect(calls).toEqual(['POST /api/task-groups/g-1/reject', 'POST /api/task-groups/g-1/approve'])
})
