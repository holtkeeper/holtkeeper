import { expect, test } from 'bun:test'

import type { AgentTask, AgentTaskGroup, Store } from './types.ts'

const at = (minute: number) => `2026-11-02T09:${String(minute).padStart(2, '0')}:00.000Z`

const group = (id: string, overrides: Partial<AgentTaskGroup> = {}): AgentTaskGroup => ({
  id,
  kind: 'upgrade',
  title: 'Upgrade some-lib to 2.0.0',
  prompt: 'Bump some-lib and fix the renamed Widget props.',
  proposedBy: 'jane',
  source: { type: 'dependency-upgrade', ecosystem: 'npm', package: 'some-lib', to: '2.0.0' },
  repos: ['work:shapes/a', 'work:shapes/b'],
  budgetClass: 'interactive',
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

const task = (id: string, overrides: Partial<AgentTask> = {}): AgentTask => ({
  id,
  groupId: 'g1',
  kind: 'upgrade',
  title: 'Upgrade some-lib to 2.0.0',
  prompt: 'Bump some-lib and fix the renamed Widget props.',
  repo: 'work:shapes/a',
  requester: 'jane',
  source: { type: 'dependency-upgrade', ecosystem: 'npm', package: 'some-lib', to: '2.0.0' },
  status: 'proposed',
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

/** Contract tests every `AgentTaskStore` must pass. */
export function taskStoreTests(store: () => Store) {
  test('tasks: put, get, replace and list newest first with filters', async () => {
    const tasks = store().tasks
    await tasks.put(task('a'))
    await tasks.put(task('b', { repo: 'work:shapes/b', updatedAt: at(5) }))
    await tasks.put(task('c', { groupId: 'g2', status: 'queued', updatedAt: at(3) }))

    expect(await tasks.get('a')).toEqual(task('a'))
    expect(await tasks.get('missing')).toBeUndefined()
    expect((await tasks.list()).map((each) => each.id)).toEqual(['b', 'c', 'a'])
    expect((await tasks.list({ groupIds: ['g1'] })).map((each) => each.id)).toEqual(['b', 'a'])
    expect((await tasks.list({ repos: ['work:shapes/a'] })).map((each) => each.id)).toEqual([
      'c',
      'a',
    ])
    expect((await tasks.list({ status: ['queued'] })).map((each) => each.id)).toEqual(['c'])
    expect((await tasks.list({ requester: 'bob' })).map((each) => each.id)).toEqual([])
    expect((await tasks.list({ limit: 1 })).map((each) => each.id)).toEqual(['b'])

    const opened = task('a', {
      status: 'mr-open',
      jobId: 'job-1',
      costUsd: 0.42,
      mergeRequest: { id: 7, url: 'https://forge.test/mr/7', draft: true, ci: 'running' },
      updatedAt: at(9),
    })
    await tasks.put(opened)
    expect(await tasks.get('a')).toEqual(opened)
    expect((await tasks.list())[0]?.id).toBe('a')
  })

  test('tasks: transition replaces a task only from the given statuses', async () => {
    const tasks = store().tasks
    expect(await tasks.transition(task('a', { status: 'approved' }), ['proposed'])).toBe(false)
    await tasks.put(task('a'))
    const approved = task('a', { status: 'approved', updatedAt: at(1) })
    expect(await tasks.transition(approved, ['proposed'])).toBe(true)
    expect(await tasks.transition(task('a', { status: 'approved' }), ['proposed'])).toBe(false)
    expect(await tasks.get('a')).toEqual(approved)
    const running = task('a', { status: 'running', jobId: 'job-1', updatedAt: at(2) })
    expect(await tasks.transition(running, ['approved', 'queued'])).toBe(true)
    expect((await tasks.list({ status: ['running'] })).map((each) => each.id)).toEqual(['a'])
  })

  test('tasks: groups round-trip and list newest first with filters', async () => {
    const tasks = store().tasks
    await tasks.putGroup(group('g1'))
    await tasks.putGroup(
      group('g2', {
        source: { type: 'chat', threadId: 'th1', messageId: 'm1' },
        repos: ['work:tools/x'],
        proposedBy: 'bob',
        updatedAt: at(4),
      }),
    )

    expect(await tasks.getGroup('g1')).toEqual(group('g1'))
    expect(await tasks.getGroup('missing')).toBeUndefined()
    expect((await tasks.listGroups()).map((each) => each.id)).toEqual(['g2', 'g1'])
    expect((await tasks.listGroups({ sourceType: 'chat' })).map((each) => each.id)).toEqual(['g2'])
    expect((await tasks.listGroups({ repos: ['work:shapes/b'] })).map((each) => each.id)).toEqual([
      'g1',
    ])
    expect((await tasks.listGroups({ proposedBy: 'jane' })).map((each) => each.id)).toEqual(['g1'])
    expect((await tasks.listGroups({ limit: 1 })).map((each) => each.id)).toEqual(['g2'])

    const approved = group('g1', {
      approvedBy: 'jane',
      approvedAt: at(8),
      requests: [
        {
          repo: 'work:tools/x',
          reason: 'shares the Widget base',
          taskId: 'a',
          status: 'pending',
          at: at(8),
        },
      ],
      updatedAt: at(8),
    })
    await tasks.putGroup(approved)
    expect(await tasks.getGroup('g1')).toEqual(approved)
    expect((await tasks.listGroups())[0]?.id).toBe('g1')
  })
}
