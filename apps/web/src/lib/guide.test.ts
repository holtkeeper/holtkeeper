import { describe, expect, test } from 'bun:test'

import type { Family, GuideSection, RepoSummary } from '@holtkeeper/api'

import {
  budgetSegments,
  buildSpaceTree,
  candidatesInSpace,
  entryNamesSpace,
  familyProblems,
  isGeneratedSection,
  isSteerableSection,
  knowledgeSearch,
  parseSpace,
  pendingGenerated,
  reposOfSpace,
  scopeLabel,
  sectionIsEmpty,
  settingScopeOfSpace,
  spaceKey,
} from './guide.ts'

const repo = (path: string, groups: string[]): RepoSummary => ({
  repo: { forge: 'w', path },
  groups,
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
  body: '- Run `bun test`.',
  inputHash,
  model: 'model-a',
  costUsd: 0.04,
  status,
  generatedAt: '2026-11-01T00:00:00.000Z',
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

  test('search parameters keep only a valid space and tab', () => {
    expect(knowledgeSearch({ space: 'group:shapes', tab: 'notes' })).toEqual({
      space: 'group:shapes',
      tab: 'notes',
    })
    expect(knowledgeSearch({ space: 'nonsense', tab: 'other' })).toEqual({})
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
    expect(tree.counts).toEqual({ mine: 0, all: 2, others: 2 })
    expect(tree.folded).toBe(0)
  })

  test('My team folds other teams and repositories in no team', () => {
    const tree = buildSpaceTree(repos, [widgets], 'mine', [['shapes', 'other']])
    expect(tree.teams.map((t) => t.group)).toEqual(['shapes'])
    expect(tree.ungrouped.repos).toEqual([])
    expect(tree.counts).toEqual({ mine: 1, all: 2, others: 1 })
    expect(tree.folded).toBe(1)
    expect(buildSpaceTree(repos, [], 'others', ['shapes']).teams.map((t) => t.group)).toEqual([
      'tools',
    ])
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

  test('empty sections and which sections are generated', () => {
    expect(sectionIsEmpty(section())).toBe(true)
    expect(sectionIsEmpty(section({ steering: 'Focus on the API' }))).toBe(false)
    expect(isGeneratedSection('testing')).toBe(true)
    expect(isGeneratedSection('review')).toBe(false)
    expect(isSteerableSection('testing')).toBe(true)
    expect(isSteerableSection('commits')).toBe(false)
  })

  test('budget segments split human, generated and note characters', () => {
    const segments = budgetSegments({
      total: 12_000,
      human: 8_000,
      generated: 4_000,
      used: 900,
      humanUsed: 500,
      generatedUsed: 300,
      notesUsed: 100,
    })
    expect(segments.map((s) => [s.tone, s.value])).toEqual([
      ['accent', 500],
      ['code', 300],
      ['info', 100],
    ])
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
