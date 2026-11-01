import { describe, expect, test } from 'bun:test'

import { inferBranchRules, inferCommitRules } from './infer.ts'

const commit = (title: string, body = '') => ({
  title,
  message: body ? `${title}\n\n${body}` : title,
  parents: ['p'],
})

const ticketed = [
  'feat(web): [GTW-101] add release board',
  'fix(server): [GTW-102] retry empty snapshots',
  'feat(core): [GTW-103] read push rules',
  'refactor(web): [GTW-104] split diff view',
  'fix(web): [GTW-105] keep scroll position',
  'feat(server): [GTW-106] knowledge tools',
  'chore(deps): [GTW-107] bump zod',
  'fix(core): [GTW-108] handle null rules',
  'feat(cli): [GTW-109] release command',
  'docs(core): [GTW-110] describe forge contract',
].map((title) => commit(title))

describe('inferCommitRules', () => {
  test('learns conventional titles with bracketed tickets', () => {
    const inferred = inferCommitRules([
      ...ticketed,
      { title: "Merge branch 'feat/x' into main", message: 'Merge', parents: ['a', 'b'] },
      commit('Revert "feat: something"'),
      commit('fixup! feat(web): [GTW-101] add release board'),
    ])
    expect(inferred.analyzed).toBe(10)
    expect(inferred.rules).toEqual({
      conventional: true,
      scopeRequired: true,
      ticket: { pattern: 'GTW-\\d+', required: true, placement: 'bracket' },
      maxLength: 72,
      subjectCase: 'lower',
      noTrailingPeriod: true,
      body: 'none',
      template: '<type>(<scope>): [<TICKET>] <subject>',
    })
    expect(inferred.types[0]).toEqual({ name: 'feat', count: 4 })
    expect(inferred.scopes.map((scope) => scope.name)).toContain('web')
  })

  test('sets no rule below the share threshold or the minimum sample', () => {
    const mixed = [
      ...ticketed.slice(0, 6),
      commit('Update readme.'),
      commit('Fix the build'),
      commit('Add tests', 'Longer explanation'),
      commit('wip'),
      commit('More things'),
    ]
    const inferred = inferCommitRules(mixed)
    expect(inferred.rules.conventional).toBeUndefined()
    expect(inferred.rules.ticket).toEqual({
      pattern: 'GTW-\\d+',
      required: false,
      placement: 'bracket',
    })
    expect(inferCommitRules(ticketed.slice(0, 5)).rules).toEqual({})
  })

  test('learns tickets in the scope and keys of several projects', () => {
    const titles = Array.from({ length: 12 }, (_, i) =>
      commit(`feat(${i % 2 ? 'ABC' : 'GTW'}-${i}): Change ${i}`, 'Why it changed'),
    )
    const { rules } = inferCommitRules(titles)
    expect(rules.ticket).toEqual({
      pattern: '(?:ABC|GTW)-\\d+',
      required: true,
      placement: 'scope',
    })
    expect(rules.scopeRequired).toBeUndefined()
    expect(rules.subjectCase).toBe('upper')
    expect(rules.body).toBe('required')
    expect(rules.template).toBe('<type>(<TICKET>): <subject>')
  })
})

describe('inferBranchRules', () => {
  test('learns prefixes, tickets and case from work branches', () => {
    const names = [
      'feat/GTW-1-release-board',
      'fix/GTW-2-empty-snapshots',
      'feat/GTW-3-push-rules',
      'fix/GTW-4-scroll',
      'feat/GTW-5-knowledge',
      'chore/GTW-6-deps',
    ]
    const { rules, analyzed } = inferBranchRules([
      { name: 'main', default: true },
      { name: 'release', protected: true },
      ...names.map((name) => ({ name })),
    ])
    expect(analyzed).toBe(6)
    expect(rules).toEqual({
      prefixes: ['feat', 'fix'],
      ticket: { pattern: 'GTW-\\d+', required: true },
      case: 'kebab',
      template: '<prefix>/<TICKET>-<description>',
    })
  })

  test('needs enough branches', () => {
    expect(inferBranchRules([{ name: 'feat/a' }, { name: 'feat/b' }]).rules).toEqual({})
  })

  test('puts the ticket first when names hold only the ticket after the prefix', () => {
    const { rules } = inferBranchRules(
      [
        'feature/BCT-5128-main',
        'feature/BCT-4943',
        'feature/BCT-4790',
        'feature/BCT-4235',
        'feature/BCT-1-fix-npm',
      ].map((name) => ({ name })),
    )
    expect(rules.template).toBe('<prefix>/<TICKET>-<description>')
  })
})

describe('tickets before the type', () => {
  test('are read as conventional titles with a leading ticket', () => {
    const titles = Array.from({ length: 12 }, (_, i) =>
      commit(`[BCT-${5100 + i}] ${i % 3 ? 'feat' : 'fix'}: Change number ${i}`),
    )
    const { rules, types } = inferCommitRules(titles)
    expect(rules).toMatchObject({
      conventional: true,
      ticket: { pattern: 'BCT-\\d+', required: true, placement: 'lead' },
      subjectCase: 'upper',
      template: '[<TICKET>] <type>: <subject>',
    })
    expect(types.map((type) => type.name)).toEqual(['feat', 'fix'])
  })
})
