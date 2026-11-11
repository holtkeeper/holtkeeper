import { describe, expect, test } from 'bun:test'

import type { ReleaseBoardRow, ReleaseEntry, ReleasePlan } from '@holtkeeper/api'

import {
  actorName,
  bumpChoices,
  channelLabel,
  cardTicks,
  countLabel,
  entryGroups,
  failingGates,
  nextStep,
  planTasks,
  previewEdits,
  renameEntry,
  sortCards,
  stageText,
  toggleEntry,
  versionTicks,
} from './releases.ts'

const entry = (id: string, extra: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  id,
  section: 'features',
  breaking: false,
  bump: 'minor',
  title: `title ${id}`,
  text: `title ${id}`,
  tickets: [],
  mergeRequests: [],
  commits: [],
  authors: [],
  included: true,
  ...extra,
})

describe('edits', () => {
  test('leaving out and putting back entries', () => {
    const ruled = entry('a', { included: false, excludedBy: 'rule' })
    const plain = entry('b')
    let edits = toggleEntry({}, ruled, true)
    expect(edits).toEqual({ excluded: [], included: ['a'] })
    edits = toggleEntry(edits, plain, false)
    expect(edits).toEqual({ excluded: ['b'], included: ['a'] })
    edits = toggleEntry(edits, plain, true)
    expect(edits).toEqual({ excluded: [], included: ['a'] })
  })

  test('renaming to the original text drops the override', () => {
    const plain = entry('b')
    expect(renameEntry({}, plain, ' New text ')).toEqual({ texts: { b: 'New text' } })
    expect(renameEntry({ texts: { b: 'x' } }, plain, 'title b')).toEqual({ texts: {} })
  })

  test('previews edits on a plan', () => {
    const plan = {
      entries: [entry('a', { included: false, excludedBy: 'rule' }), entry('b')],
    } as ReleasePlan
    const preview = previewEdits(plan, { included: ['a'], excluded: ['b'], texts: { a: 'A' } })
    expect(preview.entries.map((e) => [e.text, e.included, e.excludedBy])).toEqual([
      ['A', true, undefined],
      ['title b', false, 'person'],
    ])
  })
})

const row = (path: string, stage: ReleaseBoardRow['stage'], extra: Partial<ReleaseBoardRow> = {}) =>
  ({
    repo: { forge: 'w', path },
    stage,
    mode: 'merge-request',
    pipelines: {},
    ...extra,
  }) as ReleaseBoardRow

const commit = (sha: string) => ({ sha, subject: sha, author: 'Jane', date: '2026-01-01' })

const deploy = (status: 'running' | 'failed' | 'ready') => ({
  tag: 'v1.2.0',
  environments: [{ name: 'prod', status, attempts: [], confirm: true }],
})

const pipeline = (status: 'success' | 'failed') => ({ id: 1, status, sha: 's', webUrl: 'u' })

describe('helpers', () => {
  test('groups included entries by type, breaking first, and keeps the left-out ones apart', () => {
    const { groups, leftOut } = entryGroups([
      entry('a', { section: 'fixes' }),
      entry('b'),
      entry('c', { section: 'breaking' }),
      entry('d', { section: 'fixes', included: false, excludedBy: 'rule' }),
      entry('e', { section: 'fixes' }),
    ])
    expect(groups.map((g) => [g.title, g.entries.map((e) => e.id)])).toEqual([
      ['Breaking changes', ['c']],
      ['Features', ['b']],
      ['Fixes', ['a', 'e']],
    ])
    expect(leftOut.map((e) => e.id)).toEqual(['d'])
    expect(entryGroups([]).groups).toEqual([])
  })

  test('collects tasks of included entries, the most worked-on first', () => {
    const tasks = planTasks([
      entry('a', { tickets: ['ABC-1'], text: 'Add widget', commits: [commit('1')] }),
      entry('b', {
        tickets: ['ABC-2', 'ABC-1'],
        text: 'Fix gadget',
        commits: [commit('2'), commit('3')],
      }),
      entry('c', { tickets: ['ABC-9'], included: false, commits: [commit('4')] }),
    ])
    expect(tasks).toEqual([
      { key: 'ABC-1', titles: ['Add widget', 'Fix gadget'], commits: 3 },
      { key: 'ABC-2', titles: ['Fix gadget'], commits: 2 },
    ])
  })

  test('offers bumps of semantic versions only', () => {
    expect(bumpChoices('1.6.5')).toEqual({ major: '2.0.0', minor: '1.7.0', patch: '1.6.6' })
    expect(bumpChoices('2.0.0-rc.1').patch).toBe('2.0.0')
    expect(bumpChoices('2026.11.0-x.y')).toEqual({
      major: '2027.0.0',
      minor: '2026.12.0',
      patch: '2026.11.0',
    })
    expect(bumpChoices(undefined)).toEqual({})
  })

  test('splits failing gates', () => {
    const { hard, soft } = failingGates([
      { id: 'empty', ok: false, message: 'nothing' },
      { id: 'pipeline', ok: false, message: 'failed' },
      { id: 'blockers', ok: true, message: 'ok' },
    ])
    expect(hard.map((gate) => gate.id)).toEqual(['empty'])
    expect(soft.map((gate) => gate.id)).toEqual(['pipeline'])
  })

  test('labels counts and sorts cards: needing action, then stage, then path', () => {
    expect(countLabel(1, false)).toBe('1 commit')
    expect(countLabel(300, true)).toBe('300+ commits')
    expect(
      sortCards([
        { ...row('b', 'released'), needsAction: false },
        { ...row('c', 'awaiting-version'), needsAction: false },
        { ...row('a', 'released'), needsAction: false },
        { ...row('d', 'idle'), needsAction: true },
      ]).map((r) => r.repo.path),
    ).toEqual(['d', 'c', 'a', 'b'])
  })

  test('says where a repository stands and what to do next', () => {
    expect(stageText(row('a', 'awaiting-version'))).toBe('Waiting for acceptance')
    expect(stageText(row('a', 'awaiting-version', { mode: 'trunk' }))).toBe('Ready to tag')
    expect(stageText(row('a', 'released', { deploy: deploy('running') }))).toBe('Deploying to prod')
    expect(stageText(row('a', 'released', { error: 'boom' }))).toBe('Could not read the forge')
    expect(nextStep(row('a', 'awaiting-version', { next: 'v1.3.0' }))).toBe('Create v1.3.0')
    expect(
      nextStep(
        row('a', 'proposed', { request: { id: 12, title: 't', webUrl: 'u', draft: false } }),
      ),
    ).toBe('Review !12')
    expect(nextStep(row('a', 'released', { deploy: deploy('failed') }))).toBe('Retry prod')
    expect(nextStep(row('a', 'released', { deploy: deploy('ready') }))).toBe('Deploy to prod')
    expect(nextStep(row('a', 'idle'))).toBeUndefined()
  })

  test('builds the deploy strip ticks of cards and versions', () => {
    const ticks = cardTicks(
      row('a', 'released', {
        source: 'develop',
        target: 'main',
        pipelines: { source: pipeline('success'), target: pipeline('failed') },
        deploy: {
          tag: 'v1.0.0',
          environments: [
            { name: 'staging', status: 'success', attempts: [], confirm: false },
            { name: 'prod', status: 'missing', attempts: [], confirm: true },
          ],
        },
      }),
    )
    expect(ticks.map((t) => t.tone)).toEqual(['success', 'danger', 'success', 'skipped'])
    expect(ticks[2]?.label).toBe('v1.0.0 on staging: Deployed')
    expect(cardTicks(row('a', 'idle', { mode: 'trunk' }))).toEqual([])
    expect(
      versionTicks(
        [
          { environment: 'prod', status: 'failed', at: '2026-01-02', actor: 'a' },
          { environment: 'qa', status: 'succeeded', at: '2026-01-01', actor: 'a' },
        ],
        ['staging', 'prod'],
      ).map((t) => [t.label, t.tone]),
    ).toEqual([
      ['staging: not deployed', 'skipped'],
      ['prod: failed', 'danger'],
      ['qa: succeeded', 'success'],
    ])
  })

  test('names who ran a step and where', () => {
    const people = { u1: { name: 'Jane Doe', avatarUrl: '/a.svg' } }
    expect(actorName(people, 'u1', 'Old name')).toBe('Jane Doe')
    expect(actorName(people, 'u2', 'Sam Roe')).toBe('Sam Roe')
    expect(actorName(people, 'lead')).toBe('lead')
    expect(channelLabel('web')).toBe('in the panel chat')
    expect(channelLabel('teams')).toBe('in teams')
    expect(channelLabel(undefined)).toBeUndefined()
  })
})
