import { describe, expect, test } from 'bun:test'

import type { LearningView } from '@holtkeeper/api'

import {
  helpfulShare,
  learningCreateOf,
  learningDraftOf,
  learningDraftProblems,
  learningPatchOf,
  learningTiming,
  learningTotals,
  originLabel,
  reactionSum,
  sourceLabel,
} from './learnings.ts'

const now = new Date('2026-11-18T12:00:00.000Z')

const learning = (extra: Partial<LearningView> = {}): LearningView => ({
  id: 'l-1',
  text: 'Snapshot tests need a fixed seed.',
  key: 'snapshot tests need a fixed seed',
  scope: { repos: ['work:acme/widget-kit'] },
  origin: 'reply',
  status: 'pending',
  sources: [],
  createdAt: '2026-11-17T12:00:00.000Z',
  updatedAt: '2026-11-17T12:00:00.000Z',
  activeAt: '2026-11-20T12:00:00.000Z',
  lastReinforcedAt: '2026-11-17T12:00:00.000Z',
  uses: 0,
  actedOn: 0,
  votesUp: 0,
  votesDown: 0,
  canEdit: true,
  ...extra,
})

describe('learningTiming', () => {
  test('a pending learning says when it activates', () => {
    expect(learningTiming(learning(), now)).toEqual({ label: 'Activates in 2 days', soon: false })
    expect(learningTiming(learning({ activeAt: '2026-11-19T13:00:00.000Z' }), now)).toEqual({
      label: 'Activates in 1 day',
      soon: true,
    })
    expect(learningTiming(learning({ activeAt: '2026-11-18T08:00:00.000Z' }), now)?.label).toBe(
      'Activates today',
    )
  })

  test('an active learning says when it expires, soon within 14 days', () => {
    expect(
      learningTiming(learning({ status: 'active', expiresAt: '2027-01-28T13:00:00.000Z' }), now),
    ).toEqual({ label: 'Expires in 71 days', soon: false })
    expect(
      learningTiming(learning({ status: 'active', expiresAt: '2026-11-27T13:00:00.000Z' }), now),
    ).toEqual({ label: 'Expires in 9 days', soon: true })
    expect(learningTiming(learning({ status: 'active' }), now)).toBeUndefined()
  })

  test('expired and rejected learnings change nothing by themselves', () => {
    expect(learningTiming(learning({ status: 'expired' }), now)).toBeUndefined()
    expect(learningTiming(learning({ status: 'rejected' }), now)).toBeUndefined()
  })
})

test('totals count pending, active and active ones expiring soon', () => {
  expect(
    learningTotals(
      [
        learning(),
        learning({ status: 'active', expiresAt: '2026-11-25T12:00:00.000Z' }),
        learning({ status: 'active', expiresAt: '2027-02-01T12:00:00.000Z' }),
        learning({ status: 'rejected' }),
      ],
      now,
    ),
  ).toEqual({ pending: 1, active: 2, expiringSoon: 1 })
})

test('sources read as merge request and path, the repository alone or a direct proposal', () => {
  const at = '2026-11-01T00:00:00.000Z'
  expect(sourceLabel({ repo: 'work:acme/round/web', mergeRequest: 318, at })).toBe(
    '!318 acme/round/web',
  )
  expect(sourceLabel({ repo: 'work:acme/round/web', at })).toBe('acme/round/web')
  expect(sourceLabel({ at })).toBe('Direct proposal')
  expect(originLabel('miner')).toBe('Rule miner')
})

describe('drafts', () => {
  test('a new learning needs text and a scope and sends only what is filled in', () => {
    const draft = {
      text: ' Put new hooks in src/hooks/. ',
      reason: ' ',
      scope: { all: true },
      files: [],
      agents: [],
    }
    expect(learningDraftProblems(draft)).toEqual([])
    expect(learningDraftProblems({ ...draft, text: '', scope: {} })).toEqual([
      'Write the learning',
      'Pick a scope',
    ])
    expect(learningCreateOf(draft)).toEqual({
      text: 'Put new hooks in src/hooks/.',
      scope: { all: true },
    })
  })

  test('an edit clears emptied fields with null', () => {
    const draft = learningDraftOf(learning({ reason: 'Flaky CI', files: ['**/*.test.tsx'] }))
    expect(learningPatchOf({ ...draft, reason: '', files: [] })).toEqual({
      text: 'Snapshot tests need a fixed seed.',
      scope: { repos: ['work:acme/widget-kit'] },
      reason: null,
      files: null,
      agents: null,
    })
    expect(learningPatchOf({ ...draft, agents: ['review'] })).toMatchObject({
      reason: 'Flaky CI',
      files: ['**/*.test.tsx'],
      agents: ['review'],
    })
  })
})

test('reactions sum over categories with a helpful share', () => {
  expect(helpfulShare({ up: 3, down: 1 })).toBe(75)
  expect(helpfulShare({ up: 0, down: 0 })).toBeUndefined()
  expect(
    reactionSum([
      { category: 'bug', comments: 2, up: 3, down: 1 },
      { category: 'style', comments: 1, up: 0, down: 2 },
    ]),
  ).toEqual({ comments: 3, up: 3, down: 3 })
})
