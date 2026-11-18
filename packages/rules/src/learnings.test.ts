import { describe, expect, test } from 'bun:test'

import {
  decideLearning,
  findDuplicateLearning,
  learningApplies,
  learningKey,
  newLearning,
  reinforceLearning,
  settleLearning,
  wordOverlap,
} from './learnings.ts'

const policy = { approvalDelayDays: 3, expiryDays: 90 }
const now = '2026-01-10T00:00:00.000Z'
const repo = { forge: 'work', path: 'acme/round/web', teams: ['widgets'] }
const source = { repo: 'work:acme/round/web', mergeRequest: 7, noteId: 'n1', at: now }

const draft = (text = 'Use integer cents for prices.') =>
  newLearning(
    { text, scope: { repos: ['work:acme/round/web'] }, origin: 'reply', source },
    { id: 'l1', now, policy },
  )

describe('learning lifecycle', () => {
  test('a new learning waits for the approval delay, then activates', () => {
    const learning = draft()
    expect(learning.status).toBe('pending')
    expect(learning.activeAt).toBe('2026-01-13T00:00:00.000Z')
    expect(learning.key).toBe('use integer cents for prices')
    expect(settleLearning(learning, '2026-01-12T00:00:00.000Z', policy)).toBe(learning)
    expect(settleLearning(learning, '2026-01-13T00:00:00.000Z', policy).status).toBe('active')
  })

  test('zero delay or a person activates at once', () => {
    expect(
      newLearning(
        { text: 'x', scope: { all: true }, origin: 'agent' },
        { id: 'a', now, policy: { ...policy, approvalDelayDays: 0 } },
      ).status,
    ).toBe('active')
    const written = newLearning(
      { text: 'x', scope: { all: true }, origin: 'person' },
      { id: 'b', now, policy, approvedBy: 'mira' },
    )
    expect(written).toMatchObject({ status: 'active', decidedBy: 'mira', activeAt: now })
  })

  test('an active learning expires without reinforcement and comes back when reinforced', () => {
    const active = decideLearning(draft(), 'approve', 'mira', now)
    const later = '2026-04-20T00:00:00.000Z'
    const expired = settleLearning(active, later, policy)
    expect(expired.status).toBe('expired')
    const back = reinforceLearning(expired, { cited: true, actedOn: true }, later)
    expect(back).toMatchObject({ status: 'active', uses: 1, actedOn: 1, lastReinforcedAt: later })
  })

  test('a known source or a down vote does not reinforce', () => {
    const learning = draft()
    expect(reinforceLearning(learning, { source }, '2026-02-01T00:00:00.000Z')).toBe(learning)
    const down = reinforceLearning(learning, { vote: 'down' }, '2026-02-01T00:00:00.000Z')
    expect(down.votesDown).toBe(1)
    expect(down.lastReinforcedAt).toBe(now)
  })

  test('rejecting keeps it out', () => {
    expect(decideLearning(draft(), 'reject', 'mira', now).status).toBe('rejected')
  })
})

describe('duplicates', () => {
  test('same key or high overlap is a duplicate, rejected ones included', () => {
    const rejected = { ...draft(), status: 'rejected' as const }
    expect(findDuplicateLearning('use integer CENTS for prices!', [rejected])).toBe(rejected)
    expect(
      wordOverlap('use integer cents for all prices', 'use integer cents for prices'),
    ).toBeGreaterThanOrEqual(0.8)
    expect(findDuplicateLearning('Name widgets in kebab case.', [rejected])).toBeUndefined()
    expect(learningKey('  A, b!  ')).toBe('a b')
  })
})

describe('learningApplies', () => {
  test('needs active status, scope, agent and matching files', () => {
    const active = { ...draft(), status: 'active' as const, files: ['src/**'] }
    expect(learningApplies(active, repo, 'review', ['src/a.ts'])).toBe(true)
    expect(learningApplies(active, repo, 'review', ['docs/a.md'])).toBe(false)
    expect(learningApplies(active, repo, 'review')).toBe(true)
    expect(learningApplies({ ...active, agents: ['chat'] }, repo, 'review')).toBe(false)
    expect(learningApplies(draft(), repo, 'review')).toBe(false)
    expect(learningApplies(active, { ...repo, path: 'acme/other' }, 'review')).toBe(false)
  })
})
