import { describe, expect, test } from 'bun:test'

import type { ResolvedSettingRow, SettingDefinitionView, SettingView } from '@holtkeeper/api'

import {
  fromParentGroup,
  layerCounts,
  orgRowMatches,
  orgRows,
  parentGroupCount,
  resolvedSections,
  rowMatches,
  sectionSlug,
  setHere,
  sourceLabel,
} from './resolved-settings.ts'
import type { ScopeFocus } from './scope.ts'

const repo: ScopeFocus = { kind: 'repo', repo: { forge: 'work', path: 'acme/widget-kit' } }
const group: ScopeFocus = { kind: 'group', group: 'web' }

const entry = (scope: SettingView['scope']): SettingView => ({
  id: 'e',
  key: 'k',
  scope,
  value: 1,
  secret: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
})

const row = (
  key: string,
  section: string,
  source: ResolvedSettingRow['source'] = { layer: 'default' },
): ResolvedSettingRow => ({
  key,
  label: key.toUpperCase(),
  section,
  value: 1,
  source,
  ...(source.entry ? { entry: source.entry } : {}),
  overrides: 0,
})

describe('resolvedSections', () => {
  test('groups rows by section in first-seen order', () => {
    const sections = resolvedSections([
      row('a', 'Merge requests'),
      row('b', 'AI'),
      row('c', 'Merge requests'),
    ])
    expect(sections.map((s) => [s.id, s.label, s.rows.map((r) => r.key)])).toEqual([
      ['merge-requests', 'Merge requests', ['a', 'c']],
      ['ai', 'AI', ['b']],
    ])
    expect(sectionSlug(' Updates ')).toBe('updates')
  })
})

describe('filters', () => {
  const own = row('own', 'AI', { layer: 'repo', entry: entry({ repos: ['work:acme/widget-kit'] }) })
  const pattern = row('pattern', 'AI', { layer: 'repo', entry: entry({ repos: ['acme/*'] }) })
  const fallback = row('fallback', 'AI')

  test('here keeps entries naming the focus, changed drops defaults', () => {
    expect(setHere(own, repo)).toBe(true)
    expect(setHere(pattern, repo)).toBe(false)
    expect([own, pattern, fallback].filter((r) => rowMatches(r, repo, 'here'))).toEqual([own])
    expect([own, pattern, fallback].filter((r) => rowMatches(r, repo, 'changed'))).toEqual([
      own,
      pattern,
    ])
  })

  test('the query matches label or key', () => {
    expect(rowMatches(own, repo, 'all', 'OWN')).toBe(true)
    expect(rowMatches(own, repo, 'all', 'zzz')).toBe(false)
  })

  test('layerCounts counts winners per layer', () => {
    expect(layerCounts([own, pattern, fallback])).toEqual({
      default: 1,
      org: 0,
      group: 0,
      repo: 2,
    })
  })
})

describe('sourceLabel', () => {
  test('a subgroup focus names entries of its parent group', () => {
    const round: ScopeFocus = { kind: 'group', group: 'shapes.round' }
    const parent = { layer: 'group' as const, groups: ['shapes'] }
    const own = { layer: 'group' as const, groups: ['shapes.round', 'shapes'] }
    expect(sourceLabel(parent, round)).toBe('Parent group')
    expect(sourceLabel(own, round)).toBe('This group')
    expect(fromParentGroup(parent, round)).toBe(true)
    expect(fromParentGroup(own, round)).toBe(false)
    expect(fromParentGroup(parent, { kind: 'group', group: 'shapes' })).toBe(false)
    expect(sourceLabel(parent, { kind: 'group', group: 'shapes' })).toBe('This group')
    const rows = [own, parent, { layer: 'org' as const }].map(
      (source, index): ResolvedSettingRow => ({
        key: `k${index}`,
        label: `k${index}`,
        section: 'Polling',
        value: 1,
        source,
        overrides: 0,
      }),
    )
    expect(parentGroupCount(rows, round)).toBe(1)
    expect(parentGroupCount(rows, group)).toBe(0)
  })

  test('names the layer in words', () => {
    expect(sourceLabel({ layer: 'default' }, repo)).toBe('Default')
    expect(sourceLabel({ layer: 'org' }, repo)).toBe('Org')
    expect(sourceLabel({ layer: 'group', groups: ['web', 'payments'] }, repo)).toBe(
      'Group web + payments',
    )
    expect(sourceLabel({ layer: 'group', groups: ['web'] }, group)).toBe('This group')
    expect(
      sourceLabel({ layer: 'repo', entry: entry({ repos: ['work:acme/widget-kit'] }) }, repo),
    ).toBe('This repo')
    expect(sourceLabel({ layer: 'repo', entry: entry({ repos: ['acme/*'] }) }, repo)).toBe(
      'Repo pattern',
    )
  })
})

const definition = (key: string, extra: Partial<SettingDefinitionView> = {}) =>
  ({
    key,
    label: key,
    description: '',
    section: 'Polling',
    secret: false,
    schema: {},
    default: 5,
    ...extra,
  }) satisfies SettingDefinitionView
const setting = (key: string, scope: SettingView['scope'], value: unknown, updatedAt: string) =>
  ({
    id: `${key}-${updatedAt}`,
    key,
    scope,
    value,
    secret: false,
    updatedAt,
  }) satisfies SettingView

describe('orgRows', () => {
  test('takes the newest org entry, falls back to the default and counts narrower entries', () => {
    const rows = orgRows(
      [
        definition('polling'),
        definition('toolchain'),
        definition('widget.token', { secret: true }),
      ],
      [
        setting('polling', { all: true }, 10, '2026-11-01T00:00:00.000Z'),
        setting('polling', { all: true }, 15, '2026-11-02T00:00:00.000Z'),
        setting('polling', { groups: ['web'] }, 1, '2026-11-03T00:00:00.000Z'),
        setting('toolchain', { repos: ['acme/*'] }, 2, '2026-11-03T00:00:00.000Z'),
      ],
    )
    expect(rows.map((org) => [org.key, org.value, org.source.layer, org.narrower])).toEqual([
      ['polling', 15, 'org', 1],
      ['toolchain', 5, 'default', 1],
    ])
    expect(rows[0]?.replaces).toEqual({ layer: 'default', value: 5 })
  })

  test('filters by text and by being set somewhere', () => {
    const [polling, toolchain] = orgRows(
      [definition('polling'), definition('toolchain')],
      [setting('polling', { all: true }, 10, '2026-11-01T00:00:00.000Z')],
    )
    if (!polling || !toolchain) throw new Error('rows missing')
    expect(orgRowMatches(polling, 'POLL')).toBeTrue()
    expect(orgRowMatches(toolchain, 'poll')).toBeFalse()
    expect(orgRowMatches(toolchain, '', true)).toBeFalse()
    expect(orgRowMatches(polling, '', true)).toBeTrue()
  })
})
