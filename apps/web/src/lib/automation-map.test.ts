import { describe, expect, test } from 'bun:test'

import type { ConfigEntryView, JobAnalyzerView } from '@holtkeeper/api'

import { automationMap, withAnalyzer, withoutAnalyzer } from './automation-map.ts'

const analyzer = (kind: string, scope: 'repo' | 'group' = 'repo'): JobAnalyzerView => ({
  kind,
  label: kind.toUpperCase(),
  scope,
  needs: {},
  schema: {},
})

const schedule = (
  id: string,
  data: Partial<ConfigEntryView<'schedule'>['data']>,
): ConfigEntryView<'schedule'> => ({
  type: 'schedule',
  id,
  provenance: 'panel',
  data: { name: id, enabled: true, analyzers: [], every: '1d', ...data },
})

const trigger = (
  id: string,
  data: ConfigEntryView<'trigger'>['data'],
): ConfigEntryView<'trigger'> => ({ type: 'trigger', id, provenance: 'file', data })

describe('automation map', () => {
  test('links schedules and triggers to the analyzers they queue', () => {
    const map = automationMap(
      [
        schedule('nightly', {
          name: 'Nightly audit',
          analyzers: ['audit', 'licenses'],
          groups: ['games', ['web', 'shop']],
          windows: { skipWeekends: true },
        }),
        schedule('weekly', { enabled: false, analyzers: ['audit'], repos: ['work:games/*'] }),
      ],
      [
        trigger('merge-request', { on: 'mergeRequest', analyzers: ['review', 'review'] }),
        trigger('command:port', { on: 'command', command: 'port', analyzer: 'gone' }),
      ],
      [analyzer('audit'), analyzer('licenses', 'group'), analyzer('review'), analyzer('quality')],
    )

    expect(map.events).toEqual([
      {
        id: 'schedule:nightly',
        kind: 'schedule',
        entryId: 'nightly',
        title: 'Nightly audit',
        when: 'Every day, no weekends',
        scope: 'groups games, web + shop',
        enabled: true,
      },
      {
        id: 'schedule:weekly',
        kind: 'schedule',
        entryId: 'weekly',
        title: 'weekly',
        when: 'Every day',
        scope: 'repos work:games/*',
        enabled: false,
      },
      {
        id: 'trigger:merge-request',
        kind: 'trigger',
        entryId: 'merge-request',
        title: 'merge-request',
        when: 'Merge request open, update, reopen',
        scope: 'every repository',
        enabled: true,
      },
      {
        id: 'trigger:command:port',
        kind: 'trigger',
        entryId: 'command:port',
        title: 'command:port',
        when: '/holtkeeper port',
        scope: 'every repository',
        enabled: true,
      },
    ])
    expect(map.edges).toEqual([
      { from: 'schedule:nightly', to: 'analyzer:audit', enabled: true },
      { from: 'schedule:nightly', to: 'analyzer:licenses', enabled: true },
      { from: 'schedule:weekly', to: 'analyzer:audit', enabled: false },
      { from: 'trigger:merge-request', to: 'analyzer:review', enabled: true },
      { from: 'trigger:command:port', to: 'analyzer:gone', enabled: true },
    ])
    expect(map.analyzers).toEqual([
      {
        id: 'analyzer:audit',
        kind: 'audit',
        label: 'AUDIT',
        known: true,
        scope: 'repo',
        idle: false,
      },
      { id: 'analyzer:gone', kind: 'gone', label: 'gone', known: false, idle: false },
      {
        id: 'analyzer:licenses',
        kind: 'licenses',
        label: 'LICENSES',
        known: true,
        scope: 'group',
        idle: false,
      },
      {
        id: 'analyzer:review',
        kind: 'review',
        label: 'REVIEW',
        known: true,
        scope: 'repo',
        idle: false,
      },
    ])
    expect(map.idle).toEqual(['quality'])
  })

  test('an empty config has nothing to draw', () => {
    expect(automationMap([], [], [analyzer('audit')])).toEqual({
      events: [],
      analyzers: [],
      edges: [],
      idle: ['audit'],
    })
  })

  test('editors also get the analyzers nothing runs', () => {
    const map = automationMap(
      [schedule('nightly', { analyzers: ['audit'] })],
      [],
      [analyzer('audit'), analyzer('quality')],
      { withIdle: true },
    )
    expect(map.analyzers.map((a) => [a.kind, a.idle])).toEqual([
      ['audit', false],
      ['quality', true],
    ])
    expect(map.idle).toEqual(['quality'])
  })
})

describe('linking analyzers', () => {
  const nightly = schedule('nightly', {
    analyzers: ['audit', 'licenses'],
    options: { licenses: { policy: 'strict' }, audit: { fix: true } },
  }).data

  test('adds an analyzer once', () => {
    expect(withAnalyzer(nightly, 'quality').analyzers).toEqual(['audit', 'licenses', 'quality'])
    expect(withAnalyzer(nightly, 'audit')).toBe(nightly)
    expect(withAnalyzer({ on: 'tag', analyzers: ['a'] }, 'b')).toEqual({
      on: 'tag',
      analyzers: ['a', 'b'],
    })
  })

  test('a command trigger swaps its analyzer', () => {
    expect(withAnalyzer({ on: 'command', command: 'port', analyzer: 'port' }, 'audit')).toEqual({
      on: 'command',
      command: 'port',
      analyzer: 'audit',
    })
    expect(
      withoutAnalyzer({ on: 'command', command: 'port', analyzer: 'port' }, 'port'),
    ).toHaveProperty('error')
  })

  test('removes an analyzer with its options, never the last one', () => {
    expect(withoutAnalyzer(nightly, 'licenses')).toEqual({
      data: { ...nightly, analyzers: ['audit'], options: { audit: { fix: true } } },
    })
    const onlyAudit = { ...nightly, analyzers: ['audit'], options: { audit: { fix: true } } }
    expect(withoutAnalyzer(onlyAudit, 'audit')).toHaveProperty('error')
    const { options: _options, ...bare } = nightly
    expect(withoutAnalyzer({ ...nightly, options: { audit: {} } }, 'audit')).toEqual({
      data: { ...bare, analyzers: ['licenses'] },
    })
    expect(withoutAnalyzer({ on: 'mergeRequest', analyzers: ['a', 'b'] }, 'a')).toEqual({
      data: { on: 'mergeRequest', analyzers: ['b'] },
    })
  })
})
