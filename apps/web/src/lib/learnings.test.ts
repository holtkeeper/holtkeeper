import { describe, expect, test } from 'bun:test'

import type { LearningCandidateView } from '@holtkeeper/api'

import {
  acceptedBySection,
  confidenceAria,
  confidenceLabel,
  evidenceOf,
  filterLearnings,
  helpfulShare,
  isAutoAccepted,
  learningsInSpace,
  reactionSum,
  selectableIds,
  selectionAfter,
  sourceCounts,
  suggestedScopeOf,
} from './learnings.ts'

const source = (discussionId: string) => ({
  repo: 'gitlab:acme/widget-kit',
  mergeRequest: 4,
  discussionId,
  noteId: discussionId,
  author: 'mira',
  at: '2026-11-01T00:00:00.000Z',
})

const candidate = (
  id: string,
  overrides: Partial<LearningCandidateView> = {},
): LearningCandidateView => ({
  id,
  repo: 'gitlab:acme/widget-kit',
  rule: 'Do not flag magic numbers in Widget presets.',
  key: id,
  section: 'review',
  suggestedScope: 'repo',
  status: 'proposed',
  sources: [source('d1')],
  model: 'fast',
  costUsd: 0,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  canDecide: true,
  scopes: ['repo:gitlab:acme/widget-kit', 'group:web'],
  sourceKind: 'review-reply',
  confidence: 1,
  ...overrides,
})

describe('confidence labels', () => {
  test('1–2 are low, 3 medium, 4–5 high', () => {
    expect([1, 2, 3, 4, 5].map(confidenceLabel)).toEqual(['Low', 'Low', 'Medium', 'High', 'High'])
    expect(confidenceAria(4)).toBe('Confidence high, 4 of 5')
  })
})

describe('filtering and order', () => {
  const list = [
    candidate('a', { confidence: 2, updatedAt: '2026-11-03T00:00:00.000Z' }),
    candidate('b', {
      confidence: 4,
      sourceKind: 'merged',
      section: 'testing',
      sources: [source('d1'), source('d2'), source('d3')],
    }),
    candidate('c', {
      confidence: 3,
      sourceKind: 'mcp',
      sources: [],
      proposal: { by: 'u1', reason: 'seen in three repositories' },
    }),
  ]

  test('evidence counts replies and a direct proposal', () => {
    expect(list.map(evidenceOf)).toEqual([1, 3, 1])
  })

  test('sorts by evidence, confidence or newest', () => {
    const empty = { sections: [], confidence: [] }
    expect(filterLearnings(list, empty).map((c) => c.id)).toEqual(['b', 'c', 'a'])
    expect(filterLearnings(list, empty, 'confidence').map((c) => c.id)).toEqual(['b', 'c', 'a'])
    expect(filterLearnings(list, empty, 'newest').map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  test('filters by source, section and confidence level', () => {
    expect(
      filterLearnings(list, { source: 'mcp', sections: [], confidence: [] }).map((c) => c.id),
    ).toEqual(['c'])
    expect(
      filterLearnings(list, { sections: ['testing'], confidence: [] }).map((c) => c.id),
    ).toEqual(['b'])
    expect(
      filterLearnings(list, { sections: [], confidence: ['Low', 'Medium'] }).map((c) => c.id),
    ).toEqual(['c', 'a'])
    expect(sourceCounts(list)).toEqual({ all: 3, 'review-reply': 1, merged: 1, mcp: 1 })
  })
})

describe('space and selection', () => {
  const list = [
    candidate('a'),
    candidate('b', { repo: 'gitlab:acme/storefront' }),
    candidate('c', { canDecide: false }),
    candidate('d', { status: 'accepted', section: 'testing' }),
  ]

  test('a space keeps candidates of the repositories it covers', () => {
    expect(learningsInSpace(list, { kind: 'all' }, [])).toHaveLength(4)
    expect(
      learningsInSpace(list, { kind: 'group', group: 'web' }, ['gitlab:acme/storefront']).map(
        (c) => c.id,
      ),
    ).toEqual(['b'])
    expect(
      learningsInSpace(
        list,
        { kind: 'repo', repo: { forge: 'gitlab', path: 'acme/storefront' } },
        [],
      ).map((c) => c.id),
    ).toEqual(['b'])
  })

  test('only proposed candidates the caller may decide are selectable', () => {
    expect(selectableIds(list)).toEqual(['a', 'b'])
  })

  test('after a batch only the failed candidates stay selected', () => {
    expect([
      ...selectionAfter({ accepted: ['a'], failed: [{ id: 'b', error: 'no rights' }] }),
    ]).toEqual(['b'])
  })

  test('the suggested scope wins among the scopes the caller may pick', () => {
    expect(suggestedScopeOf(candidate('x', { suggestedScope: 'group' }))).toBe('group:web')
    expect(suggestedScopeOf(candidate('x', { suggestedScope: 'family' }))).toBe(
      'repo:gitlab:acme/widget-kit',
    )
    expect(suggestedScopeOf(candidate('x', { scopes: [] }))).toBeUndefined()
    expect(
      suggestedScopeOf(
        candidate('x', {
          suggestedScope: 'group',
          targetScope: 'group:web',
          scopes: ['repo:gitlab:acme/widget-kit', 'group:web.forms', 'group:web'],
        }),
      ),
    ).toBe('group:web')
  })

  test('auto-accepted means accepted by the policy and not confirmed by a person', () => {
    expect(isAutoAccepted(candidate('x', { status: 'accepted', decidedBy: 'auto-accept' }))).toBe(
      true,
    )
    expect(isAutoAccepted(candidate('x', { status: 'accepted', decidedBy: 'user-1' }))).toBe(false)
    expect(isAutoAccepted(candidate('x', { status: 'rejected', decidedBy: 'auto-accept' }))).toBe(
      false,
    )
  })

  test('accepted rules per section', () => {
    expect(acceptedBySection(list, ['general', 'review', 'testing'])).toEqual([
      { section: 'testing', count: 1 },
    ])
  })
})

describe('reactions', () => {
  test('helpful share and sums', () => {
    expect(helpfulShare({ up: 3, down: 1 })).toBe(75)
    expect(helpfulShare({ up: 0, down: 0 })).toBeUndefined()
    expect(
      reactionSum([
        { category: 'bug', comments: 2, up: 3, down: 1 },
        { category: 'style', comments: 1, up: 0, down: 2 },
      ]),
    ).toEqual({ comments: 3, up: 3, down: 3 })
  })
})
