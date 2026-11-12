import { describe, expect, test } from 'bun:test'

import type { ReleaseEntry, ReleasePlan } from '@holtkeeper/api'

import {
  actorName,
  bumpChoices,
  channelLabel,
  countLabel,
  entryGroups,
  failingGates,
  planTasks,
  previewEdits,
  renameEntry,
  toggleEntry,
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

const commit = (sha: string) => ({ sha, subject: sha, author: 'Jane', date: '2026-01-01' })

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

  test('splits failing gates by severity', () => {
    const { hard, soft, warn } = failingGates([
      { id: 'empty', ok: false, severity: 'block', message: 'nothing' },
      { id: 'pipeline', ok: false, severity: 'block', message: 'failed' },
      { id: 'changelog', ok: false, severity: 'warn', message: 'no entries' },
      { id: 'pipeline', ok: false, severity: 'info', message: 'no pipeline' },
      { id: 'blockers', ok: true, severity: 'block', message: 'ok' },
    ])
    expect(hard.map((gate) => gate.id)).toEqual(['empty'])
    expect(soft.map((gate) => gate.message)).toEqual(['failed'])
    expect(warn.map((gate) => gate.id)).toEqual(['changelog'])
  })

  test('labels counts', () => {
    expect(countLabel(1, false)).toBe('1 commit')
    expect(countLabel(300, true)).toBe('300+ commits')
    expect(countLabel(2, false, 'task')).toBe('2 tasks')
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
