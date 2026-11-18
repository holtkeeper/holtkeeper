import { describe, expect, test } from 'bun:test'

import type { RuleView } from '@holtkeeper/api'

import {
  activationOf,
  agentsLabel,
  blockSubtitle,
  isVersionConflict,
  knowledgeSearch,
  parseFiles,
  restoreRuleInput,
  ruleDraftOf,
  ruleDraftProblems,
  ruleInputOf,
  ruleScopeLabel,
  ruleVersions,
} from './rules.ts'

const rule = (extra: Partial<RuleView> = {}): RuleView => ({
  id: 'r-1',
  title: 'Contract tests for API routes',
  body: '- New API routes need a contract test.',
  scope: { repos: ['acme/round/*'] },
  author: 'u:ivo',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z',
  version: 3,
  canEdit: true,
  ...extra,
})

const titleOf = (key: string) => (key === 'widgets' ? 'Widgets' : key)

test('scopes read as all repositories, team titles or patterns', () => {
  expect(ruleScopeLabel({ all: true })).toBe('All repositories')
  expect(ruleScopeLabel({ teams: ['widgets', 'gizmo'] }, titleOf)).toBe('Team Widgets, gizmo')
  expect(ruleScopeLabel({ teams: ['widgets'], repos: ['acme/*/web'] }, titleOf)).toBe(
    'Team Widgets · acme/*/web',
  )
  expect(ruleScopeLabel({})).toBe('No repositories')
})

test('activation follows files, then a description without Always apply', () => {
  expect(activationOf({})).toBe('always')
  expect(activationOf({ files: ['src/routes/**'], description: 'Routes' })).toBe('files')
  expect(activationOf({ description: 'Migrating to widget-kit 5' })).toBe('requested')
  expect(activationOf({ description: 'Migrating', alwaysApply: true })).toBe('always')
  expect(activationOf({ description: '  ' })).toBe('always')
})

test('agents read as All or their labels in display order', () => {
  expect(agentsLabel(undefined)).toBe('All')
  expect(agentsLabel([])).toBe('All')
  expect(agentsLabel(['chat', 'review'])).toBe('Review, Chat')
})

describe('drafts', () => {
  test('a draft needs a title, a body and a scope', () => {
    const draft = ruleDraftOf(rule())
    expect(ruleDraftProblems(draft)).toEqual([])
    expect(ruleDraftProblems({ ...draft, title: ' ', body: '', scope: { teams: [] } })).toEqual([
      'Add a title',
      'Write the rule',
      'Pick a scope',
    ])
  })

  test('the body sends only filled fields, Always apply only with a description', () => {
    const draft = ruleDraftOf(rule())
    expect(ruleInputOf({ ...draft, alwaysApply: true }, 3)).toEqual({
      title: 'Contract tests for API routes',
      body: '- New API routes need a contract test.',
      scope: { repos: ['acme/round/*'] },
      version: 3,
    })
    expect(
      ruleInputOf({
        ...draft,
        files: ['src/routes/**'],
        agents: ['review', 'task'],
        description: ' Routes ',
        alwaysApply: true,
      }),
    ).toMatchObject({
      files: ['src/routes/**'],
      agents: ['review', 'task'],
      description: 'Routes',
      alwaysApply: true,
    })
  })

  test('restoring a revision saves its content against the current version', () => {
    const current = rule({ version: 4 })
    const revision = {
      title: 'Old title',
      body: 'Old body',
      scope: { all: true },
      version: 2,
      editedBy: 'u:mira',
      editedAt: '2026-11-02T10:00:00.000Z',
    }
    expect(restoreRuleInput(current, revision)).toEqual({
      title: 'Old title',
      body: 'Old body',
      scope: { all: true },
      version: 4,
    })
    expect(
      ruleVersions(current, [revision]).map((row) => [row.version, row.by, row.current]),
    ).toEqual([
      [4, 'u:ivo', true],
      [2, 'u:mira', false],
    ])
  })
})

test('a 409 is a version conflict', () => {
  expect(isVersionConflict({ status: 409 })).toBe(true)
  expect(isVersionConflict({ status: 400 })).toBe(false)
  expect(isVersionConflict(new Error('x'))).toBe(false)
})

test('blocks say where they come from and which files they cover', () => {
  expect(blockSubtitle({ layer: 'rule', source: 'All repositories' })).toBe(
    'Rule · All repositories',
  )
  expect(
    blockSubtitle({ layer: 'repo-file', source: 'src/cart/AGENTS.md', globs: ['src/cart/**'] }),
  ).toBe('Rules file · src/cart/AGENTS.md · src/cart/**')
})

test('touched files split on commas and lines, trimmed and once each', () => {
  expect(parseFiles(' src/a.ts, src/b.ts\nsrc/a.ts ,, ')).toEqual(['src/a.ts', 'src/b.ts'])
})

test('Knowledge search keeps known non-empty parameters', () => {
  expect(knowledgeSearch({ rule: 'r-1', learning: '', prompt: '', space: 'all' })).toEqual({
    rule: 'r-1',
    prompt: '',
  })
  expect(knowledgeSearch({ prompt: 'work:acme/widget-kit', learning: 7 })).toEqual({
    prompt: 'work:acme/widget-kit',
  })
})
