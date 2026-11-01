import { describe, expect, test } from 'bun:test'

import type { ReleaseBoardRow, ReleaseEntry, ReleasePlan } from '@holtkeeper/api'

import {
  bumpChoices,
  countLabel,
  entrySections,
  failingGates,
  previewEdits,
  renameEntry,
  sortRows,
  toggleEntry,
} from './releases.ts'

const entry = (id: string, extra: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  id,
  section: 'features',
  breaking: false,
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

const row = (path: string, stage: ReleaseBoardRow['stage']) =>
  ({ repo: { forge: 'w', path }, stage }) as ReleaseBoardRow

describe('helpers', () => {
  test('groups entries by section in order', () => {
    const sections = entrySections([
      entry('a', { section: 'breaking' }),
      entry('b'),
      entry('c', { section: 'breaking' }),
    ])
    expect(sections.map((s) => [s.title, s.entries.length])).toEqual([
      ['Breaking changes', 2],
      ['Features', 1],
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
      { id: 'freeze', ok: true, message: 'ok' },
    ])
    expect(hard.map((gate) => gate.id)).toEqual(['empty'])
    expect(soft.map((gate) => gate.id)).toEqual(['pipeline'])
  })

  test('labels counts and sorts rows by stage', () => {
    expect(countLabel(1, false)).toBe('1 commit')
    expect(countLabel(300, true)).toBe('300+ commits')
    expect(
      sortRows([row('b', 'released'), row('c', 'awaiting-version'), row('a', 'released')]).map(
        (r) => r.repo.path,
      ),
    ).toEqual(['c', 'a', 'b'])
  })
})
