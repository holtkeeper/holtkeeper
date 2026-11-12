import { describe, expect, test } from 'bun:test'

import type { AgentTaskGroupView, AgentTaskView, Scope, WriteTasksStatus } from '@holtkeeper/api'

import {
  type TaskListFilter,
  diffstatShares,
  endedSummary,
  formatDiffstat,
  groupCiSummary,
  groupDiffstat,
  groupSpendCap,
  matchesTaskList,
  needsApprovalCount,
  parseTaskSheetTab,
  parseTasksSearch,
  patchFiles,
  taskApprovalBadge,
  taskCancellable,
  taskFilterOptions,
  taskGroupCap,
  taskGroupFlow,
  taskGroupTeams,
  taskProgressCaption,
  taskSectionCaption,
  taskSectionOf,
  taskSections,
  taskSegments,
  taskSourceLabel,
  taskStatusTone,
  taskViewCounts,
  writePoolState,
  writeTasksEntry,
  writeWorkersText,
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
  ci: 'none',
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
    can: { approve: false, cancel: true, retry: false, reject: false },
    ...patch,
  }) satisfies AgentTaskGroupView

const pool = (patch: Partial<WriteTasksStatus['pool']> = {}) => ({
  enabled: true,
  pool: { queued: 0, running: 0, busyWorkers: 0, ...patch },
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
    expect(taskStatusTone.running).toBe('info')
    expect(taskStatusTone.proposed).toBe('warning')
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

test('the write pool counts busy workers against the live ones when the server knows them', () => {
  expect(writeWorkersText({ busyWorkers: 1, totalWorkers: 3 })).toBe('1 / 3')
  expect(writeWorkersText({ busyWorkers: 0, totalWorkers: 0 })).toBe('0 / 0')
  expect(writeWorkersText({ busyWorkers: 2 })).toBe('2 busy')
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

test('search keeps a task and a tab only with their group and drops unknown values', () => {
  expect(parseTasksSearch({ group: 'g1', task: 't1', tab: 'diff', view: 'ended' })).toEqual({
    group: 'g1',
    task: 't1',
    tab: 'diff',
    view: 'ended',
  })
  expect(parseTasksSearch({ task: 't1', tab: 'flow', view: 'open' })).toEqual({})
  expect(parseTasksSearch({ group: 'g1', tab: 'plan', view: 'nope' })).toEqual({ group: 'g1' })
  expect(parseTasksSearch({ view: 'all', group: '' })).toEqual({ view: 'all' })
  expect(parseTaskSheetTab('runs')).toBe('runs')
  expect(parseTaskSheetTab('nope')).toBe('plan')
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
  expect(
    writeTasksEntry([entry('s1', { groups: ['shop'] }, {}), entry('s2', { all: true }, {})])?.id,
  ).toBe('s2')
  expect(writeTasksSwitch([], false)).toEqual({
    key: 'tasks.write',
    scope: { all: true },
    value: { enabled: false },
  })
})

const mr = (id: number) => ({ id, url: `https://forge.test/mr/${id}`, draft: true })

const sample = () => [
  group([task('a1', 'work:acme/a', { status: 'proposed' })], { id: 'ga', status: 'proposed' }),
  group([task('b1', 'work:acme/b', { status: 'running' })], { id: 'gb', status: 'running' }),
  group([task('c1', 'work:acme/c', { status: 'approved' })], { id: 'gc', status: 'approved' }),
  group([task('d1', 'work:acme/d', { status: 'mr-open', mergeRequest: mr(1) })], {
    id: 'gd',
    status: 'mr-open',
  }),
  group(
    [
      task('e1', 'work:acme/e', { status: 'mr-open', mergeRequest: mr(2) }),
      task('e2', 'work:acme/f', { status: 'failed' }),
    ],
    { id: 'ge', status: 'mr-open' },
  ),
  group([task('f1', 'work:acme/g', { status: 'failed' })], { id: 'gf', status: 'failed' }),
  group([task('g1', 'work:acme/h', { status: 'done' })], { id: 'gg', status: 'done' }),
  group([task('h1', 'work:acme/i', { status: 'cancelled' })], { id: 'gh', status: 'cancelled' }),
]

describe('sections', () => {
  test('groups land in the section that says what they need next', () => {
    expect(sample().map((each) => [each.id, taskSectionOf(each)])).toEqual([
      ['ga', 'approval'],
      ['gb', 'running'],
      ['gc', 'running'],
      ['gd', 'opened'],
      ['ge', 'failed'],
      ['gf', 'failed'],
      ['gg', 'ended'],
      ['gh', 'ended'],
    ])
  })

  test('views pick open, ended or every section, in order and without empty ones', () => {
    const ids = (view: 'open' | 'ended' | 'all') =>
      taskSections(sample(), view).map((section) => [
        section.id,
        section.groups.map((each) => each.id),
      ])
    expect(ids('open')).toEqual([
      ['approval', ['ga']],
      ['running', ['gb', 'gc']],
      ['opened', ['gd']],
      ['failed', ['ge', 'gf']],
    ])
    expect(ids('ended')).toEqual([['ended', ['gg', 'gh']]])
    expect(ids('all').map(([id]) => id)).toEqual([
      'approval',
      'running',
      'opened',
      'failed',
      'ended',
    ])
    expect(taskSections([], 'all')).toEqual([])
    expect(taskViewCounts(sample())).toEqual({ open: 6, ended: 2, all: 8 })
    expect(endedSummary(sample())).toBe('1 done, 1 cancelled')
  })

  test('the badge counts groups waiting for approval and caps at 99+', () => {
    expect(needsApprovalCount(sample())).toBe(1)
    expect(taskApprovalBadge(undefined)).toBe('')
    expect(taskApprovalBadge(0)).toBe('')
    expect(taskApprovalBadge(3)).toBe('3')
    expect(taskApprovalBadge(120)).toBe('99+')
  })

  test('section captions count workers, queue and drafts', () => {
    const groups = [
      group([
        task('t1', 'work:acme/a', { status: 'running' }),
        task('t2', 'work:acme/b', { status: 'queued' }),
        task('t3', 'work:acme/c', { status: 'approved' }),
      ]),
    ]
    expect(taskSectionCaption('running', groups)).toBe('1 repository on workers · 2 queued')
    expect(
      taskSectionCaption('opened', [
        group([task('t1', 'work:acme/a', { status: 'mr-open', mergeRequest: mr(1) })]),
      ]),
    ).toBe('waiting for review on the forge · 1 draft merge request')
    expect(taskSectionCaption('approval', [])).toBe('nothing runs until someone approves')
  })

  test('the progress caption counts what matters', () => {
    expect(taskProgressCaption([{ status: 'proposed' }, { status: 'proposed' }])).toBe('0 of 2')
    expect(taskProgressCaption([{ status: 'mr-open' }, { status: 'done' }])).toBe('2 of 2')
    expect(
      taskProgressCaption([{ status: 'mr-open' }, { status: 'running' }, { status: 'queued' }]),
    ).toBe('1 MR · 1 running · 1 queued')
    expect(taskProgressCaption([{ status: 'failed' }, { status: 'approved' }])).toBe(
      '1 queued · 1 failed',
    )
  })
})

describe('CI column', () => {
  test('shows the most pressing CI and how many merge requests share it', () => {
    expect(groupCiSummary([task('t1', 'work:acme/a')])).toBeUndefined()
    expect(
      groupCiSummary([
        task('t1', 'work:acme/a', { mergeRequest: mr(1), ci: 'success' }),
        task('t2', 'work:acme/b', { mergeRequest: mr(2), ci: 'success' }),
      ]),
    ).toEqual({ ci: 'success', label: 'Passed' })
    expect(
      groupCiSummary([
        task('t1', 'work:acme/a', { mergeRequest: mr(1), ci: 'success' }),
        task('t2', 'work:acme/b', { mergeRequest: mr(2), ci: 'failed' }),
        task('t3', 'work:acme/c', { mergeRequest: mr(3), ci: 'running' }),
        task('t4', 'work:acme/d', { ci: 'none' }),
      ]),
    ).toEqual({ ci: 'failed', label: 'Failed · 1 of 3' })
    expect(
      groupCiSummary([task('t1', 'work:acme/a', { mergeRequest: mr(1), ci: 'none' })]),
    ).toEqual({ ci: 'none', label: 'No pipeline' })
  })
})

describe('diffstat', () => {
  test('sums what the tasks know', () => {
    expect(groupDiffstat([task('t1', 'work:acme/a')])).toBeUndefined()
    const stat = groupDiffstat([
      task('t1', 'work:acme/a', {
        diffstat: { files: 3, additions: 20, deletions: 4, source: 'merge-request' },
      }),
      task('t2', 'work:acme/b', {
        diffstat: { files: 1, additions: 2, deletions: 6, source: 'patch' },
      }),
      task('t3', 'work:acme/c'),
    ])
    expect(stat).toEqual({ files: 4, additions: 22, deletions: 10, repos: 2 })
    expect(formatDiffstat(stat!)).toBe('4 files · +22 −10')
    expect(formatDiffstat({ files: 1, additions: 1, deletions: 0 })).toBe('1 file · +1 −0')
  })

  test('bar shares scale to the largest row', () => {
    expect(diffstatShares({ additions: 30, deletions: 10 }, 80)).toEqual({
      add: 0.375,
      del: 0.125,
      rest: 0.5,
    })
    expect(diffstatShares({ additions: 6, deletions: 2 }, 4)).toEqual({
      add: 0.75,
      del: 0.25,
      rest: 0,
    })
    expect(diffstatShares({ additions: 0, deletions: 0 }, 0)).toEqual({ add: 0, del: 0, rest: 1 })
  })

  test('files of a patch count added and removed lines, not headers', () => {
    const patch = [
      'diff --git a/src/widget.ts b/src/widget.ts',
      'index 111..222 100644',
      '--- a/src/widget.ts',
      '+++ b/src/widget.ts',
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      '+more',
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '\\ No newline at end of file',
    ].join('\n')
    expect(patchFiles(patch)).toEqual([
      { path: 'src/widget.ts', additions: 2, deletions: 1 },
      { path: 'old.txt', additions: 0, deletions: 2 },
    ])
    expect(patchFiles('')).toEqual([])
  })
})

test('the spend cap of a group prefers the tasks own caps', () => {
  const caps = { perRepoUsd: 2, perGroupUsd: 12 }
  expect(groupSpendCap({ tasks: [{ budgetUsd: 1.5 }, { budgetUsd: 2 }] }, caps)).toBe(3.5)
  expect(groupSpendCap({ tasks: [{ budgetUsd: 1.5 }, {}] }, caps)).toBe(4)
  expect(groupSpendCap({ tasks: [{}] }, undefined)).toBeUndefined()
})

describe('filters', () => {
  const groups = [
    group([task('a1', 'work:acme/widget-kit', { mergeRequest: mr(231) })], {
      id: 'aaaabbbb-1',
      title: 'Rename widget props',
      kind: 'chat',
      source: { type: 'chat', threadId: 'th' },
      proposedBy: 'user:teo',
    }),
    group([task('b1', 'work:acme/ledger-api')], { id: 'ccccdddd-2', proposedBy: 'user:ana' }),
  ]
  const none: TaskListFilter = { query: '', kinds: [], sources: [], repos: [], proposers: [] }

  const ids = (filter: Partial<typeof none>) =>
    groups.filter((each) => matchesTaskList(each, { ...none, ...filter })).map((each) => each.id)

  test('match by text, kind, source, repository and proposer', () => {
    expect(ids({})).toEqual(['aaaabbbb-1', 'ccccdddd-2'])
    expect(ids({ query: 'WIDGET' })).toEqual(['aaaabbbb-1'])
    expect(ids({ query: '!231' })).toEqual(['aaaabbbb-1'])
    expect(ids({ query: 'ccccdd' })).toEqual(['ccccdddd-2'])
    expect(ids({ kinds: ['upgrade'] })).toEqual(['ccccdddd-2'])
    expect(ids({ sources: ['chat'] })).toEqual(['aaaabbbb-1'])
    expect(ids({ repos: ['work:acme/ledger-api'] })).toEqual(['ccccdddd-2'])
    expect(ids({ proposers: ['user:teo', 'user:ana'] })).toEqual(['aaaabbbb-1', 'ccccdddd-2'])
  })

  test('options come from the groups, labelled and sorted', () => {
    const options = taskFilterOptions(groups, { 'user:teo': { name: 'Teo R.' } })
    expect(options.kinds).toEqual([
      { id: 'chat', label: 'Chat request' },
      { id: 'upgrade', label: 'Upgrade' },
    ])
    expect(options.sources.map((each) => each.label)).toEqual(['Chat', 'Dependency upgrade'])
    expect(options.proposers).toEqual([
      { id: 'user:teo', label: 'Teo R.' },
      { id: 'user:ana', label: 'user:ana' },
    ])
  })

  test('teams of a group are the groups of its repositories', () => {
    const map = new Map([
      ['work:acme/a', ['web']],
      ['work:acme/b', ['web', 'payments']],
    ])
    expect(taskGroupTeams({ repos: ['work:acme/a', 'work:acme/b', 'work:acme/z'] }, map)).toEqual([
      'web',
      'payments',
    ])
  })
})
