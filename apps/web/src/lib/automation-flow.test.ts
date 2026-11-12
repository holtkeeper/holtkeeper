import { describe, expect, test } from 'bun:test'

import type { ConfigEntryView, JobAnalyzerView, SettingView } from '@holtkeeper/api'

import {
  ALL_LANE,
  type AutomationInput,
  type AutomationLane,
  automationLanes,
  automationRules,
  describeRefresh,
  filterLane,
  jobLanes,
  laneFreshness,
  laneRuleCounts,
  mergedLane,
  policyEvents,
  ruleKind,
  ruleNodeId,
  sweepLimits,
  whyPath,
} from './automation-flow.ts'

const analyzer = (kind: string, extra: Partial<JobAnalyzerView> = {}): JobAnalyzerView => ({
  kind,
  label: kind.toUpperCase(),
  scope: 'repo',
  needs: {},
  schema: {},
  ...extra,
})

const analyzers = [
  analyzer('shapes', { refresh: { on: 'change', minInterval: '6h' } }),
  analyzer('colors', { refresh: { on: 'time', cadence: '1d' } }),
  analyzer('review', { needs: { agent: 'required' } }),
  analyzer('writer', { exclusive: true }),
]

const trigger = (
  id: string,
  data: ConfigEntryView<'trigger'>['data'],
): ConfigEntryView<'trigger'> => ({ type: 'trigger', id, data })

const schedule = (
  id: string,
  data: Partial<ConfigEntryView<'schedule'>['data']>,
): ConfigEntryView<'schedule'> => ({
  type: 'schedule',
  id,
  data: { name: id, enabled: true, analyzers: [], every: '1d', ...data },
})

const setting = (id: string, key: string, scope: SettingView['scope'], value: unknown) => ({
  id,
  key,
  scope,
  value,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

const input = (extra: Partial<AutomationInput> = {}): AutomationInput => ({
  groups: ['toys', 'games'],
  triggers: [],
  schedules: [],
  settings: [],
  analyzers,
  ...extra,
})

const lane = (lanes: AutomationLane[], id: string) => {
  const found = lanes.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`no lane ${id}`)
  return found
}

const ids = (found: AutomationLane, kind: string) =>
  found.nodes.filter((node) => node.kind === kind).map((node) => node.id)

describe('automation lanes', () => {
  test('one lane for every repository, then one per group, each with freshness', () => {
    const lanes = automationLanes(input())
    expect(lanes.map((l) => [l.id, l.label])).toEqual([
      [ALL_LANE, 'All repositories'],
      ['games', 'games'],
      ['toys', 'toys'],
    ])
    const games = lane(lanes, 'games')
    expect(ids(games, 'event')).toEqual(['event:freshness'])
    expect(ids(games, 'rule')).toEqual(['rule:freshness'])
    expect(ids(games, 'action')).toEqual(['action:freshness'])
    expect(games.edges).toEqual([
      { from: 'event:freshness', to: 'rule:freshness' },
      { from: 'rule:freshness', to: 'action:freshness' },
    ])
    expect(ids(lane(lanes, ALL_LANE), 'rule')).toEqual(['rule:freshness', 'rule:release'])
  })

  test('triggers and schedules sit in the lanes of their groups', () => {
    const lanes = automationLanes(
      input({
        triggers: [
          trigger('tag', { on: 'tag', analyzers: ['shapes'], groups: ['games'] }),
          trigger('push', { on: 'push', analyzers: ['colors'], branches: ['main'] }),
          trigger('label:deep', { on: 'label', label: 'deep', analyzers: ['review'] }),
        ],
        schedules: [
          schedule('nightly', {
            analyzers: ['colors'],
            groups: [['games', 'toys']],
            cron: '0 3 * * *',
            every: undefined,
          }),
        ],
      }),
    )
    const games = lane(lanes, 'games')
    expect(ids(games, 'rule')).toEqual([
      'rule:trigger:tag',
      'rule:schedule:nightly',
      'rule:freshness',
    ])
    expect(ids(lane(lanes, 'toys'), 'rule')).toEqual(['rule:schedule:nightly', 'rule:freshness'])
    const all = lane(lanes, ALL_LANE)
    expect(ids(all, 'rule')).toEqual([
      'rule:trigger:push',
      'rule:trigger:label:deep',
      'rule:freshness',
      'rule:release',
    ])
    const nightly = games.nodes.find((node) => node.id === 'rule:schedule:nightly')
    expect(nightly?.data).toMatchObject({
      title: 'nightly',
      chips: ['Every day at 03:00', 'only games + toys'],
      events: ['schedule'],
      analyzers: ['colors'],
    })
    const label = all.nodes.find((node) => node.id === 'rule:trigger:label:deep')
    expect(label?.data).toMatchObject({ title: 'Label deep', ai: true })
    expect(ids(all, 'action')).toContain('analyzer:review')
    expect(all.nodes.find((node) => node.id === 'analyzer:review')?.data).toMatchObject({
      action: 'review',
      ai: true,
    })
  })

  test('policies project their events, condition chips and actions, scoped like their entry', () => {
    const lanes = automationLanes(
      input({
        settings: [
          setting('p1', 'mergeRequests.policies', { groups: ['toys'] }, [
            {
              id: 'bots',
              name: 'Bot bumps',
              when: { event: ['open', 'update'], author: { bot: true }, targetBranch: 'main' },
              actions: [{ type: 'approve' }, { type: 'enqueue', analyzer: 'shapes' }],
              skipAnalyzers: ['review'],
            },
            { id: 'off', name: 'Off', enabled: false, when: { labelAdded: ['x'] }, actions: [] },
          ]),
        ],
      }),
    )
    const toys = lane(lanes, 'toys')
    const bots = toys.nodes.find((node) => node.id === 'rule:policy:p1:bots')
    expect(bots?.data).toMatchObject({
      title: 'Bot bumps',
      chips: ['on open, update', 'target is main', 'author is anyone (bot)', 'skips review'],
      events: ['mergeRequest'],
      analyzers: ['shapes'],
      enabled: true,
    })
    expect(ids(toys, 'action')).toEqual([
      'action:freshness',
      'action:policy:approve',
      'analyzer:shapes',
    ])
    expect(toys.edges).toContainEqual({
      from: 'event:label',
      to: 'rule:policy:p1:off',
      dashed: true,
    })
    expect(ids(lane(lanes, ALL_LANE), 'rule')).not.toContain('rule:policy:p1:bots')
  })

  test('a new repository trigger without analyzers runs every read-only analyzer', () => {
    const lanes = automationLanes(
      input({ triggers: [trigger('new-repo', { on: 'newRepo', exclude: ['colors'] })] }),
    )
    const all = lane(lanes, ALL_LANE)
    expect(all.nodes.find((node) => node.id === 'rule:trigger:new-repo')?.data).toMatchObject({
      chips: ['skips colors'],
      wildcard: { node: 'action:read-only', except: ['colors'] },
      ai: true,
    })
  })

  test('the freshness rule follows the team override', () => {
    const settings = [
      setting('f1', 'freshness', { groups: ['games'] }, { mode: 'off' }),
      setting('f2', 'freshness', { all: true }, { mode: 'slower', factor: 4 }),
    ]
    const lanes = automationLanes(input({ settings }))
    expect(lane(lanes, 'games').nodes.find((n) => n.id === 'rule:freshness')?.data).toMatchObject({
      chips: ['off for this team'],
      enabled: false,
    })
    expect(lane(lanes, 'toys').nodes.find((n) => n.id === 'rule:freshness')?.data).toMatchObject({
      chips: ['4x slower'],
      enabled: true,
    })
    expect(laneFreshness(settings, 'toys')).toMatchObject({ mode: 'slower', inherited: true })
    expect(laneFreshness(settings, 'games')).toMatchObject({ mode: 'off', inherited: false })
    expect(laneFreshness([], undefined)).toEqual({ mode: 'on', factor: 3, inherited: false })
  })

  test('an entry shared by several groups is inherited, not a team override', () => {
    const shared = setting('f3', 'freshness', { groups: ['games', 'toys'] }, { mode: 'off' })
    expect(laneFreshness([shared], 'games')).toMatchObject({
      mode: 'off',
      inherited: true,
      entry: shared,
    })
    const own = setting('f4', 'freshness', { groups: ['games'] }, { mode: 'slower', factor: 2 })
    expect(laneFreshness([shared, own], 'games')).toMatchObject({ entry: own, inherited: false })
  })

  test('policy events come from event, labelAdded and command conditions', () => {
    expect(policyEvents({})).toEqual(['mergeRequest'])
    expect(policyEvents({ event: ['merge', 'command'], labelAdded: ['x'] })).toEqual([
      'mergeRequest',
      'label',
      'command',
    ])
  })
})

describe('why a job ran', () => {
  const lanes = automationLanes(
    input({
      triggers: [
        trigger('merge-request', { on: 'mergeRequest', analyzers: ['review'] }),
        trigger('tag', { on: 'tag', analyzers: ['shapes'] }),
      ],
      schedules: [schedule('weekly', { analyzers: ['colors'], groups: ['games'] })],
      settings: [
        setting('p1', 'mergeRequests.policies', { all: true }, [
          {
            id: 'deep',
            name: 'Deep',
            when: { labelAdded: ['deep'] },
            actions: [{ type: 'enqueue', analyzer: 'review' }],
          },
        ]),
      ],
    }),
  )

  test('a webhook job highlights every trigger and policy of its event that queues it', () => {
    const path = whyPath(lane(lanes, ALL_LANE), { trigger: 'webhook', analyzer: 'review' })
    expect(path?.nodes.toSorted()).toEqual([
      'analyzer:review',
      'event:label',
      'event:mergeRequest',
      'rule:policy:p1:deep',
      'rule:trigger:merge-request',
    ])
    expect(path?.edges).toContain('event:label->rule:policy:p1:deep')
    expect(path?.edges).not.toContain('event:mergeRequest->rule:policy:p1:deep')
  })

  test('disabled policies and a team with freshness off explain nothing', () => {
    const quiet = automationLanes(
      input({
        triggers: [trigger('merge-request', { on: 'mergeRequest', analyzers: ['review'] })],
        settings: [
          setting('p2', 'mergeRequests.policies', { all: true }, [
            {
              id: 'off',
              name: 'Off',
              enabled: false,
              when: { event: ['open'] },
              actions: [{ type: 'enqueue', analyzer: 'review' }],
            },
          ]),
          setting('f1', 'freshness', { groups: ['games'] }, { mode: 'off' }),
        ],
      }),
    )
    expect(
      whyPath(lane(quiet, ALL_LANE), { trigger: 'webhook', analyzer: 'review' })?.nodes.toSorted(),
    ).toEqual(['analyzer:review', 'event:mergeRequest', 'rule:trigger:merge-request'])
    expect(whyPath(lane(quiet, 'games'), { trigger: 'freshness', analyzer: 'shapes' })).toBe(
      undefined,
    )
  })

  test('schedule runs, by hand too, and freshness jobs follow their rule', () => {
    const games = lane(lanes, 'games')
    const scheduled = {
      nodes: ['rule:schedule:weekly', 'analyzer:colors', 'event:schedule'],
      edges: ['rule:schedule:weekly->analyzer:colors', 'event:schedule->rule:schedule:weekly'],
    }
    expect(whyPath(games, { trigger: 'schedule', analyzer: 'colors', schedule: 'weekly' })).toEqual(
      scheduled,
    )
    expect(whyPath(games, { trigger: 'manual', analyzer: 'colors', schedule: 'weekly' })).toEqual(
      scheduled,
    )
    expect(whyPath(games, { trigger: 'freshness', analyzer: 'shapes' })?.nodes).toEqual([
      'rule:freshness',
      'action:freshness',
      'event:freshness',
    ])
  })

  test('nothing explains a manual job, or a tag job of an analyzer the trigger no longer runs', () => {
    const all = lane(lanes, ALL_LANE)
    expect(whyPath(all, { trigger: 'manual', analyzer: 'shapes' })).toBeUndefined()
    expect(whyPath(all, { trigger: 'tag', analyzer: 'colors' })).toBeUndefined()
    expect(whyPath(all, { trigger: 'tag', analyzer: 'shapes' })?.nodes).toContain(
      'rule:trigger:tag',
    )
    expect(jobLanes(['games'])).toEqual([ALL_LANE, 'games'])
  })
})

test('refresh policies and sweep limits read in plain words', () => {
  expect(describeRefresh({ on: 'change', minInterval: '6h' })).toBe('on change, at most every 6h')
  expect(describeRefresh({ on: 'change', minInterval: '1d', paths: ['go.mod'], heavy: true })).toBe(
    'on change of its files, at most every 1d, at night',
  )
  expect(describeRefresh({ on: 'time', cadence: '7d' })).toBe('every 7d')
  expect(sweepLimits([])).toEqual({
    maxJobsPerHour: 10,
    maxAiJobsPerHour: 2,
    nightWindow: { from: '01:00', to: '07:00' },
  })
  expect(
    sweepLimits([
      setting(
        's',
        'freshness.sweep',
        { all: true },
        { maxJobsPerHour: 4, nightWindow: { from: '00:00', to: '05:00' } },
      ),
    ]),
  ).toEqual({ maxJobsPerHour: 4, maxAiJobsPerHour: 2, nightWindow: { from: '00:00', to: '05:00' } })
})

const sample = () =>
  input({
    triggers: [
      trigger('push', { on: 'push', analyzers: ['colors'] }),
      trigger('tag', { on: 'tag', analyzers: ['shapes'], groups: ['games'] }),
    ],
    schedules: [
      schedule('nightly', { analyzers: ['review'], groups: ['games'], enabled: false }),
      schedule('weekly', { analyzers: ['colors'], groups: ['toys'] }),
    ],
    settings: [setting('f1', 'freshness', { groups: ['games'] }, { mode: 'off' })],
  })

describe('one canvas per team', () => {
  test('rules know their lanes and kinds', () => {
    const rules = automationRules(sample())
    expect(rules.map((rule) => [rule.id, rule.lanes])).toEqual([
      ['rule:trigger:push', [ALL_LANE]],
      ['rule:trigger:tag', ['games']],
      ['rule:schedule:nightly', ['games']],
      ['rule:schedule:weekly', ['toys']],
    ])
    expect(rules.find((rule) => rule.id === 'rule:schedule:nightly')?.ai).toBe(true)
    expect(ruleNodeId({ type: 'policy', settingId: 's1', policyId: 'p' })).toBe('rule:policy:s1:p')
    expect(ruleKind({ type: 'trigger', id: 'push' })).toBe('trigger')
    expect(ruleKind({ type: 'freshness' })).toBe('builtin')
    expect(ruleKind({ type: 'release' })).toBe('builtin')
  })

  test('a team lane merged with every repository, the team winning shared nodes', () => {
    const lanes = automationLanes(sample())
    const games = mergedLane(lanes, 'games')
    expect(games).toMatchObject({ id: 'games', group: 'games', label: 'games' })
    expect(ids(games, 'event')).toEqual([
      'event:push',
      'event:tag',
      'event:mergeRequest',
      'event:schedule',
      'event:freshness',
    ])
    expect(ids(games, 'rule')).toEqual([
      'rule:trigger:push',
      'rule:freshness',
      'rule:release',
      'rule:trigger:tag',
      'rule:schedule:nightly',
    ])
    expect(ids(games, 'rule')).not.toContain('rule:schedule:weekly')
    const freshness = games.nodes.find((node) => node.id === 'rule:freshness')
    expect(freshness?.data).toMatchObject({ enabled: false, chips: ['off for this team'] })
    expect(games.edges).toContainEqual({
      from: 'event:freshness',
      to: 'rule:freshness',
      dashed: true,
    })
    expect(games.edges.filter((e) => e.to === 'rule:freshness')).toHaveLength(1)
    const labels = games.nodes.flatMap((node) => (node.kind === 'action' ? [node.data.label] : []))
    expect(labels).toEqual(labels.toSorted((a, b) => a.localeCompare(b)))
  })

  test('every repository alone for all or an unknown team', () => {
    const lanes = automationLanes(sample())
    const all = lane(lanes, ALL_LANE)
    expect(
      mergedLane(lanes)
        .nodes.map((n) => n.id)
        .toSorted(),
    ).toEqual(all.nodes.map((n) => n.id).toSorted())
    expect(mergedLane(lanes, 'nobody')).toMatchObject({ id: ALL_LANE, label: 'All repositories' })
    expect(mergedLane(lanes, 'nobody').group).toBeUndefined()
  })

  test('rule counts per lane', () => {
    expect(laneRuleCounts(automationLanes(sample()))).toEqual({ all: 3, games: 3, toys: 2 })
  })

  test('filters keep matching rules with their events and actions', () => {
    const games = mergedLane(automationLanes(sample()), 'games')
    const schedules = filterLane(games, { kinds: ['schedule'] })
    expect(ids(schedules, 'rule')).toEqual(['rule:schedule:nightly'])
    expect(ids(schedules, 'event')).toEqual(['event:schedule'])
    expect(ids(schedules, 'action')).toEqual(['analyzer:review'])
    expect(schedules.edges).toEqual([
      { from: 'event:schedule', to: 'rule:schedule:nightly', dashed: true },
      { from: 'rule:schedule:nightly', to: 'analyzer:review', dashed: true },
    ])
    expect(ids(filterLane(games, { ai: true }), 'rule')).toEqual(['rule:schedule:nightly'])
    expect(ids(filterLane(games, { kinds: ['builtin'] }), 'rule')).toEqual([
      'rule:freshness',
      'rule:release',
    ])
    expect(ids(filterLane(games, { kinds: ['trigger', 'policy'] }), 'rule')).toEqual([
      'rule:trigger:push',
      'rule:trigger:tag',
    ])
  })

  test('the text matches titles, chips and linked events or actions', () => {
    const games = mergedLane(automationLanes(sample()), 'games')
    expect(ids(filterLane(games, { query: 'branch PUSH' }), 'rule')).toEqual(['rule:trigger:push'])
    expect(ids(filterLane(games, { query: 'off for' }), 'rule')).toEqual(['rule:freshness'])
    expect(ids(filterLane(games, { query: 'SHAPES' }), 'rule')).toEqual(['rule:trigger:tag'])
    expect(ids(filterLane(games, { query: 'release step' }), 'rule')).toEqual(['rule:release'])
    const none = filterLane(games, { query: 'nothing like this' })
    expect(none.nodes).toEqual([])
    expect(none.edges).toEqual([])
    expect(filterLane(games, {})).toEqual(games)
    expect(filterLane(games, { query: 'colors', kinds: ['schedule'] }).nodes).toEqual([])
  })
})
