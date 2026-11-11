import { describe, expect, test } from 'bun:test'

import type { AgentTaskGroupView, AgentTaskView, Scope, WriteTasksStatus } from '@holtkeeper/api'

import {
  matchesTaskFilter,
  taskCancellable,
  parseTasksSearch,
  taskGroupCap,
  taskGroupFlow,
  taskSegments,
  taskSourceLabel,
  taskStatusTone,
  writePoolState,
  writeTasksSwitch,
} from './tasks.ts'

const at = '2026-11-11T10:00:00.000Z'

const task = (id: string, repo: string, patch: Partial<AgentTaskView> = {}): AgentTaskView => ({
  id,
  groupId: 'g1',
  kind: 'upgrade',
  title: 'Upgrade some-lib',
  prompt: 'Bump it.',
  repo,
  requester: 'user:ann',
  source: { type: 'api' },
  status: 'queued',
  createdAt: at,
  updatedAt: at,
  branch: 'holtkeeper/g1-upgrade-some-lib',
  can: { retry: false, cancel: true },
  ...patch,
})

const group = (tasks: AgentTaskView[], patch: Partial<AgentTaskGroupView> = {}) =>
  ({
    id: 'g1',
    kind: 'upgrade',
    title: 'Upgrade some-lib',
    prompt: 'Bump it.',
    proposedBy: 'user:ann',
    source: { type: 'dependency-upgrade', ecosystem: 'npm', package: 'some-lib', to: '2.0.0' },
    repos: tasks.map((each) => each.repo),
    budgetClass: 'interactive',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    tasks,
    costUsd: 0,
    hasPatch: false,
    can: { approve: false, cancel: true },
    ...patch,
  }) satisfies AgentTaskGroupView

const of = (status: AgentTaskGroupView['status']) => ({ status })

const pool = (patch: Partial<WriteTasksStatus['pool']> = {}) => ({
  enabled: true,
  pool: { queued: 0, running: 0, ...patch },
})

const entry = (id: string, scope: Scope, value: unknown) => ({
  id,
  key: 'tasks.write',
  scope,
  value,
  secret: false,
  updatedAt: at,
})

describe('taskGroupFlow', () => {
  test('source fans out to repositories, then merge requests and their CI', () => {
    const flow = taskGroupFlow(
      group([
        task('t1', 'work:shop/a', {
          status: 'mr-open',
          mergeRequest: { id: 4, url: 'https://forge.test/a/4', draft: true, ci: 'failed' },
        }),
        task('t2', 'work:shop/b', {
          status: 'mr-open',
          mergeRequest: { id: 5, url: 'https://forge.test/b/5', draft: true, ci: 'none' },
        }),
        task('t3', 'work:shop/c', { status: 'failed' }),
      ]),
    )
    expect(flow.nodes.map((node) => node.id)).toEqual([
      'source',
      'repo:t1',
      'mr:t1',
      'ci:t1',
      'repo:t2',
      'mr:t2',
      'repo:t3',
    ])
    expect(flow.edges).toEqual([
      { from: 'source', to: 'repo:t1' },
      { from: 'repo:t1', to: 'mr:t1', tone: 'success' },
      { from: 'mr:t1', to: 'ci:t1', tone: 'danger' },
      { from: 'source', to: 'repo:t2' },
      { from: 'repo:t2', to: 'mr:t2', tone: 'success' },
      { from: 'source', to: 'repo:t3', tone: 'danger' },
    ])
  })

  test('proposed tasks hang dashed; pending repository requests hang off the asking task', () => {
    const flow = taskGroupFlow(
      group([task('t1', 'work:shop/a', { status: 'proposed' })], {
        requests: [
          {
            repo: 'work:shop/z',
            reason: 'shares the widget',
            taskId: 't1',
            status: 'pending',
            at,
          },
          { repo: 'work:shop/y', reason: 'no', taskId: 't1', status: 'rejected', at },
        ],
      }),
    )
    expect(flow.edges).toEqual([
      { from: 'source', to: 'repo:t1', dashed: true },
      { from: 'repo:t1', to: 'request:work:shop/z', dashed: true, label: 'asks' },
    ])
    expect(flow.nodes.at(-1)).toMatchObject({
      kind: 'request',
      data: { repo: 'work:shop/z', reason: 'shares the widget' },
    })
  })
})

describe('status mapping', () => {
  test('every status has a tone, failures read as danger', () => {
    expect(taskStatusTone.failed).toBe('danger')
    expect(taskStatusTone['mr-open']).toBe('success')
    expect(taskStatusTone.running).toBe('accent')
  })

  test('filters split work in progress, open merge requests and ended groups', () => {
    expect(matchesTaskFilter(of('proposed'), 'active')).toBe(true)
    expect(matchesTaskFilter(of('running'), 'active')).toBe(true)
    expect(matchesTaskFilter(of('mr-open'), 'active')).toBe(false)
    expect(matchesTaskFilter(of('mr-open'), 'mr-open')).toBe(true)
    expect(matchesTaskFilter(of('failed'), 'ended')).toBe(true)
    expect(matchesTaskFilter(of('done'), 'ended')).toBe(true)
    expect(matchesTaskFilter(of('queued'), 'ended')).toBe(false)
    expect(matchesTaskFilter(of('queued'), 'all')).toBe(true)
    expect(taskCancellable('running')).toBe(true)
    expect(taskCancellable('mr-open')).toBe(false)
  })

  test('segments count tasks by status in a stable order', () => {
    expect(
      taskSegments([{ status: 'failed' }, { status: 'done' }, { status: 'done' }]).map(
        (segment) => [segment.label, segment.value, segment.tone],
      ),
    ).toEqual([
      ['Done', 2, 'success'],
      ['Failed', 1, 'danger'],
    ])
  })

  test('sources read in a few words', () => {
    expect(
      taskSourceLabel({
        type: 'dependency-upgrade',
        ecosystem: 'npm',
        package: 'some-lib',
        from: '1.0.0',
        to: '2.0.0',
      }),
    ).toBe('some-lib 1.0.0 → 2.0.0')
    expect(taskSourceLabel({ type: 'mcp', client: 'editor' })).toBe('MCP · editor')
    expect(taskSourceLabel({ type: 'chat', threadId: 'th' })).toBe('Chat')
  })
})

test('the spend cap splits the group cap like the server, to the cent', () => {
  expect(taskGroupCap({ perRepoUsd: 1.5, perGroupUsd: 5 }, 2)).toEqual({ perRepo: 1.5, total: 3 })
  expect(taskGroupCap({ perRepoUsd: 1.5, perGroupUsd: 5 }, 6)).toEqual({
    perRepo: 0.83,
    total: 4.98,
  })
  expect(taskGroupCap({ perRepoUsd: 1.5, perGroupUsd: 5 }, 0)).toEqual({ perRepo: 0, total: 0 })
})

test('the write pool is stalled when a task waits long and nothing runs', () => {
  const now = new Date('2026-11-11T10:10:00.000Z')
  expect(writePoolState({ ...pool(), enabled: false }, now)).toBe('off')
  expect(writePoolState(pool(), now)).toBe('idle')
  expect(writePoolState(pool({ queued: 1, running: 1, oldestQueuedAt: at }), now)).toBe('working')
  expect(writePoolState(pool({ queued: 1, oldestQueuedAt: at }), now)).toBe('stalled')
  expect(writePoolState(pool({ queued: 1, oldestQueuedAt: '2026-11-11T10:08:00.000Z' }), now)).toBe(
    'idle',
  )
})

test('search keeps a task only with its group and drops unknown filters', () => {
  expect(parseTasksSearch({ group: 'g1', task: 't1', filter: 'active' })).toEqual({
    group: 'g1',
    task: 't1',
    filter: 'active',
  })
  expect(parseTasksSearch({ task: 't1', filter: 'all' })).toEqual({})
  expect(parseTasksSearch({ filter: 'nope', group: '' })).toEqual({})
})

test('the kill switch flips only enabled on the global entry and keeps its caps', () => {
  expect(
    writeTasksSwitch(
      [
        entry('s1', { groups: ['shop'] }, { enabled: false }),
        entry('s2', { all: true }, { perRepoUsd: 1 }),
      ],
      true,
    ),
  ).toEqual({
    id: 's2',
    key: 'tasks.write',
    scope: { all: true },
    value: { perRepoUsd: 1, enabled: true },
  })
  expect(writeTasksSwitch([], false)).toEqual({
    key: 'tasks.write',
    scope: { all: true },
    value: { enabled: false },
  })
})
