import { describe, expect, test } from 'bun:test'

import type { Family, GuideChainLayer, GuideSection, RepoSummary } from '@holtkeeper/api'

import {
  budgetSegments,
  buildSpaceTree,
  candidatesInSpace,
  entryNamesSpace,
  familyProblems,
  foldList,
  isGeneratedSection,
  isSteerableSection,
  knowledgeSearch,
  knowledgeTabOf,
  layerBody,
  layerSlots,
  lineDiff,
  parseSpace,
  pendingGenerated,
  reposOfSpace,
  scopeLabel,
  sectionRows,
  settingScopeOfSpace,
  spaceCounts,
  spaceKey,
  spaceTrail,
  tokensOf,
} from './guide.ts'

const repo = (path: string, groups: string[]): RepoSummary => ({
  repo: { forge: 'w', path },
  groups,
  health: 'not-analysed',
  cells: {},
})

const family = (id: string, name: string, members: string[]): Family => ({
  id,
  name,
  members,
  createdBy: 'u1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
})

const repos = [
  repo('shapes/circle', ['shapes']),
  repo('shapes/square', ['shapes']),
  repo('shapes/tools', ['shapes', 'tools']),
  repo('tools/lint', ['tools']),
  repo('loose/one', []),
]

const widgets = family('f1', 'Widget apps', ['w:shapes/circle', 'w:shapes/square'])

const section = (overrides: Partial<GuideSection> = {}): GuideSection => ({
  scope: 'repo:w:shapes/circle',
  section: 'general',
  rules: '',
  steering: '',
  version: 0,
  learnings: [],
  ...overrides,
})

const generated = (status: 'proposed' | 'accepted', inputHash = 'h1') => ({
  version: 1,
  body: '- Run `bun test`.',
  inputHash,
  model: 'model-a',
  costUsd: 0.04,
  status,
  generatedAt: '2026-11-01T00:00:00.000Z',
})

const chainLayer = (n: number, kind: GuideChainLayer['kind']): GuideChainLayer => ({
  n,
  kind,
  source: kind,
  text: `## Heading\n\n### Review\n\n- ${kind} rule`,
  chars: 10,
  fullChars: 10,
  cut: false,
})

describe('spaces', () => {
  test('keys round-trip and malformed keys are dropped', () => {
    for (const space of [
      { kind: 'all' as const },
      { kind: 'group' as const, group: 'shapes' },
      { kind: 'family' as const, family: 'f1' },
      { kind: 'repo' as const, repo: { forge: 'w', path: 'shapes/circle' } },
    ])
      expect(parseSpace(spaceKey(space))).toEqual(space)
    expect(parseSpace('repo:nopath')).toBeUndefined()
    expect(parseSpace('team:x')).toBeUndefined()
    expect(parseSpace(undefined)).toBeUndefined()
  })

  test('search parameters keep only a valid space, section and note', () => {
    expect(knowledgeSearch({ space: 'group:shapes', tab: 'notes' })).toEqual({
      space: 'group:shapes',
    })
    expect(knowledgeSearch({ space: 'nonsense' })).toEqual({})
    expect(knowledgeSearch({ space: 'all', section: 'review', note: 'n-1' })).toEqual({
      space: 'all',
      section: 'review',
      note: 'n-1',
    })
    expect(knowledgeSearch({ section: 'chapter', note: ' ' })).toEqual({})
  })

  test('the trail follows all, team, family and repository', () => {
    const labels = (space: Parameters<typeof spaceTrail>[0]) =>
      spaceTrail(space, repos, [widgets]).map((step) => step.label)
    expect(labels({ kind: 'all' })).toEqual(['All repositories'])
    expect(labels({ kind: 'group', group: 'tools' })).toEqual(['All repositories', 'tools'])
    expect(labels({ kind: 'family', family: 'f1' })).toEqual([
      'All repositories',
      'shapes',
      'Widget apps',
    ])
    expect(labels({ kind: 'repo', repo: { forge: 'w', path: 'shapes/circle' } })).toEqual([
      'All repositories',
      'shapes',
      'Widget apps',
      'shapes/circle',
    ])
    expect(labels({ kind: 'repo', repo: { forge: 'w', path: 'loose/one' } })).toEqual([
      'All repositories',
      'loose/one',
    ])
    expect(spaceTrail({ kind: 'family', family: 'f1' }, repos, [widgets])[2]?.space).toEqual({
      kind: 'family',
      family: 'f1',
    })
  })

  test('counts of a space, zeros when the server left it out', () => {
    const counts = { spaces: { 'group:shapes': { guide: 2, notes: 1, learnings: 3 } } }
    expect(spaceCounts(counts, { kind: 'group', group: 'shapes' })).toEqual({
      guide: 2,
      notes: 1,
      learnings: 3,
    })
    expect(spaceCounts(counts, { kind: 'all' })).toEqual({ guide: 0, notes: 0, learnings: 0 })
    expect(spaceCounts(undefined, { kind: 'all' }).learnings).toBe(0)
  })

  test('long lists fold behind N more, never hiding a single item', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(foldList(items, 5, false)).toEqual({ shown: ['a', 'b', 'c', 'd', 'e'], more: 2 })
    expect(foldList(items, 5, true)).toEqual({ shown: items, more: 0 })
    expect(foldList(items.slice(0, 6), 5, false).more).toBe(0)
  })

  test('the tab comes from the path', () => {
    expect(knowledgeTabOf('/knowledge/notes')).toBe('notes')
    expect(knowledgeTabOf('/knowledge/learnings/')).toBe('learnings')
    expect(knowledgeTabOf('/knowledge/guide')).toBe('guide')
    expect(knowledgeTabOf('/knowledge')).toBe('guide')
  })

  test('labels name the team, the family and the repository path', () => {
    expect(scopeLabel('all', [])).toBe('All repositories')
    expect(scopeLabel('group:shapes', [])).toBe('Team shapes')
    expect(scopeLabel('family:f1', [widgets])).toBe('Widget apps')
    expect(scopeLabel('repo:w:shapes/circle', [])).toBe('shapes/circle')
  })
})

describe('space tree', () => {
  test('nests families and loose repositories under every team holding them', () => {
    const tree = buildSpaceTree(repos, [widgets], 'all', [])
    expect(tree.teams.map((t) => t.group)).toEqual(['shapes', 'tools'])
    const shapes = tree.teams[0]
    expect(shapes?.families.map((n) => [n.family.name, n.repos.map((r) => r.path)])).toEqual([
      ['Widget apps', ['shapes/circle', 'shapes/square']],
    ])
    expect(shapes?.repos.map((r) => r.path)).toEqual(['shapes/tools'])
    expect(tree.teams[1]?.repos.map((r) => r.path)).toEqual(['shapes/tools', 'tools/lint'])
    expect(tree.ungrouped.repos.map((r) => r.path)).toEqual(['loose/one'])
    expect(tree.counts).toMatchObject({ mine: 0, all: 5 })
    expect(tree.folded).toBe(0)
  })

  test('My teams folds other teams and repositories in no team', () => {
    const tree = buildSpaceTree(repos, [widgets], 'mine', [['shapes', 'other']])
    expect(tree.teams.map((t) => t.group)).toEqual(['shapes'])
    expect(tree.ungrouped.repos).toEqual([])
    expect(tree.counts).toMatchObject({ mine: 3, all: 5 })
    expect(tree.folded).toBe(1)
    expect(tree.others.map((t) => t.group)).toEqual(['tools'])
    expect(tree.otherRepos).toBe(1)
  })

  test('a group keeps that one team and folds nothing', () => {
    const tree = buildSpaceTree(repos, [widgets], 'group:tools', [['shapes', 'other']])
    expect(tree.teams.map((t) => t.group)).toEqual(['tools'])
    expect(tree.others).toEqual([])
    expect(tree.ungrouped.repos).toEqual([])
    expect(tree.counts.groups).toContainEqual({ group: 'tools', count: 2 })
  })

  test('My teams without home groups shows and folds nothing', () => {
    const tree = buildSpaceTree(repos, [widgets], 'mine', [])
    expect(tree.teams).toEqual([])
    expect(tree.others).toEqual([])
  })

  test('family members the viewer cannot see are left out', () => {
    const hidden = family('f2', 'Gadgets', ['w:secret/a', 'w:tools/lint'])
    const tools = buildSpaceTree(repos, [hidden], 'all', []).teams[1]
    expect(tools?.families[0]?.repos.map((r) => r.path)).toEqual(['tools/lint'])
  })
})

describe('space coverage', () => {
  test('repositories of a space filter learning candidates', () => {
    const covered = reposOfSpace({ kind: 'group', group: 'tools' }, repos, [widgets])
    expect([...(covered ?? [])]).toEqual(['w:shapes/tools', 'w:tools/lint'])
    expect(reposOfSpace({ kind: 'all' }, repos, [])).toBeUndefined()
    expect([...(reposOfSpace({ kind: 'family', family: 'f1' }, repos, [widgets]) ?? [])]).toEqual(
      widgets.members,
    )
    const candidates = [{ repo: 'w:tools/lint' }, { repo: 'w:shapes/circle' }]
    expect(candidatesInSpace(candidates, covered)).toEqual([{ repo: 'w:tools/lint' }])
    expect(candidatesInSpace(candidates, undefined)).toHaveLength(2)
  })

  test('policy entries made for a space, and the scope a new one starts with', () => {
    const space = { kind: 'family' as const, family: 'f1' }
    expect(settingScopeOfSpace(space, widgets.members)).toEqual({ repos: widgets.members })
    expect(entryNamesSpace({ repos: ['shapes/square'] }, space, widgets.members)).toBe(true)
    expect(entryNamesSpace({ groups: ['shapes'] }, space, widgets.members)).toBe(false)
    expect(entryNamesSpace({ all: true }, { kind: 'all' })).toBe(true)
    expect(settingScopeOfSpace({ kind: 'group', group: 'tools' })).toEqual({ groups: ['tools'] })
  })
})

describe('sections', () => {
  test('pending generated text is a proposal, or a first text nobody accepted', () => {
    expect(pendingGenerated(section())).toBeUndefined()
    expect(pendingGenerated(section({ generated: generated('proposed') }))?.inputHash).toBe('h1')
    expect(pendingGenerated(section({ generated: generated('accepted') }))).toBeUndefined()
    expect(
      pendingGenerated(
        section({ generated: generated('accepted'), proposal: generated('proposed', 'h2') }),
      )?.inputHash,
    ).toBe('h2')
  })

  test('which sections are generated and steerable', () => {
    expect(isGeneratedSection('testing')).toBe(true)
    expect(isGeneratedSection('review')).toBe(false)
    expect(isSteerableSection('testing')).toBe(true)
    expect(isSteerableSection('commits')).toBe(false)
  })

  test('budget segments split human, generated, notes and free characters of the 12k', () => {
    const segments = budgetSegments({
      total: 12_000,
      used: 900,
      humanUsed: 500,
      generatedUsed: 300,
      notesUsed: 100,
    })
    expect(segments.map((s) => [s.key, s.value])).toEqual([
      ['Human', 500],
      ['Generated', 300],
      ['Notes', 100],
      ['Free', 11_100],
    ])
    expect(
      budgetSegments({ total: 12_000, used: 1000, humanUsed: 600, generatedUsed: 300 })[2]?.value,
    ).toBe(100)
    expect(tokensOf(10_664)).toBe(2666)
  })

  test('section rows take layers from the chain, else from the space, with a status', () => {
    const sections = [
      section({
        section: 'general',
        rules: '- one\n\n- two',
        version: 3,
        editedAt: '2026-11-01T00:00:00.000Z',
      }),
      section({ section: 'review' }),
      section({ section: 'testing', generated: generated('proposed') }),
    ]
    const own = sectionRows(sections)
    expect(own.map((row) => [row.section, [...row.layers], row.rules, row.status])).toEqual([
      ['general', ['repo'], 2, 'set'],
      ['review', [], 0, 'empty'],
      ['testing', ['generated'], 0, 'proposal'],
    ])
    const chained = sectionRows(sections, {
      sections: [{ section: 'review', layers: [chainLayer(1, 'repo-file'), chainLayer(2, 'all')] }],
    })
    expect(chained[1]).toMatchObject({ status: 'inherited' })
    expect([...(chained[1]?.layers ?? [])]).toEqual(['all'])
  })

  test('layer slots keep an editable place for the repository and generated text', () => {
    const slots = layerSlots(
      [chainLayer(1, 'repo-file'), chainLayer(2, 'all'), chainLayer(3, 'notes')],
      {
        generated: true,
      },
    )
    expect(
      slots.map((slot) => ('empty' in slot ? `empty:${slot.empty}` : slot.layer.kind)),
    ).toEqual(['repo-file', 'empty:repo', 'all', 'empty:generated', 'notes'])
    const full = layerSlots([chainLayer(1, 'repo'), chainLayer(2, 'generated')], {
      generated: true,
    })
    expect(full).toHaveLength(2)
    expect(layerBody(chainLayer(1, 'all').text)).toBe('- all rule')
  })

  test('a line diff pairs removals before additions and keeps context', () => {
    const hunk = lineDiff('a\nb\nc', 'a\nx\nc\nd')
    expect(hunk.lines.map((line) => `${line.kind[0]}${line.text}`)).toEqual([
      'ca',
      'rb',
      'ax',
      'cc',
      'ad',
    ])
    expect(hunk).toMatchObject({ oldLines: 3, newLines: 4 })
    expect(lineDiff('same', 'same').lines).toEqual([{ kind: 'context', text: 'same' }])
  })
})

describe('families', () => {
  test('a family needs a name and two known repositories', () => {
    const known = new Set(['w:a', 'w:b'])
    expect(familyProblems({ name: ' ', members: ['w:a'] }, known)).toEqual([
      'Add a name',
      'Add at least two repositories',
    ])
    expect(familyProblems({ name: 'Pair', members: ['w:a', 'w:c'] }, known)).toEqual([
      'w:c is not a known repository',
    ])
    expect(familyProblems({ name: 'Pair', members: ['w:a', 'w:b'] }, known)).toEqual([])
  })
})
