import { expect, test } from 'bun:test'

import type { LearningCandidate, Store } from './types.ts'

const at = (minute: number) => `2026-11-02T09:${String(minute).padStart(2, '0')}:00.000Z`

const candidate = (id: string, overrides: Partial<LearningCandidate> = {}): LearningCandidate => ({
  id,
  repo: 'work:games/arcade',
  rule: 'Do not flag magic numbers in tween presets.',
  key: 'do not flag magic numbers in tween presets',
  section: 'review',
  suggestedScope: 'repo',
  status: 'proposed',
  sources: [
    {
      repo: 'work:games/arcade',
      mergeRequest: 7,
      discussionId: 'd1',
      noteId: '41',
      author: 'sam',
      at: at(0),
    },
  ],
  model: 'fast-model',
  costUsd: 0.001,
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
})

/** Contract tests every `LearningStore` must pass. */
export function learningStoreTests(store: () => Store) {
  test('learnings: put, get, find by key and list newest first with filters', async () => {
    const learnings = store().learnings
    await learnings.put(candidate('a'))
    await learnings.put(
      candidate('b', { repo: 'work:games/puzzle', key: 'other', updatedAt: at(5) }),
    )
    await learnings.put(candidate('c', { status: 'accepted', key: 'third', updatedAt: at(3) }))

    expect(await learnings.get('a')).toEqual(candidate('a'))
    expect(await learnings.get('missing')).toBeUndefined()
    expect((await learnings.find('work:games/arcade', candidate('a').key))?.id).toBe('a')
    expect(await learnings.find('work:games/puzzle', candidate('a').key)).toBeUndefined()
    expect((await learnings.list()).map((c) => c.id)).toEqual(['b', 'c', 'a'])
    expect((await learnings.list({ repos: ['work:games/arcade'] })).map((c) => c.id)).toEqual([
      'c',
      'a',
    ])
    expect((await learnings.list({ status: ['proposed'] })).map((c) => c.id)).toEqual(['b', 'a'])

    await learnings.put(candidate('a', { rule: 'Edited.', status: 'rejected', updatedAt: at(9) }))
    expect(await learnings.get('a')).toMatchObject({ rule: 'Edited.', status: 'rejected' })
    expect((await learnings.list())[0]?.id).toBe('a')
  })

  test('learnings: a source is claimed once until released', async () => {
    const learnings = store().learnings
    expect(await learnings.claim('work:games/arcade!7#41', at(0))).toBe(true)
    expect(await learnings.claim('work:games/arcade!7#41', at(1))).toBe(false)
    await learnings.release('work:games/arcade!7#41')
    expect(await learnings.claim('work:games/arcade!7#41', at(2))).toBe(true)
  })

  test('learnings: reaction counts replace per comment and sum per category', async () => {
    const learnings = store().learnings
    const signal = {
      repo: 'work:games/arcade',
      mergeRequest: 7,
      noteId: '50',
      category: 'style',
      up: 0,
      down: 1,
      updatedAt: at(0),
    }
    await learnings.putReactions(signal)
    await learnings.putReactions({ ...signal, down: 2, updatedAt: at(1) })
    await learnings.putReactions({ ...signal, noteId: '51', category: 'bug', up: 3, down: 0 })
    await learnings.putReactions({ ...signal, repo: 'work:games/puzzle', noteId: '9', up: 1 })

    expect(await learnings.reactionTotals()).toEqual([
      { category: 'bug', comments: 1, up: 3, down: 0 },
      { category: 'style', comments: 2, up: 1, down: 3 },
    ])
    expect(await learnings.reactionTotals({ repos: ['work:games/arcade'] })).toEqual([
      { category: 'bug', comments: 1, up: 3, down: 0 },
      { category: 'style', comments: 1, up: 0, down: 2 },
    ])
    await learnings.putReactions({ ...signal, mergeRequest: 8, noteId: '60', up: 2, down: 0 })
    expect(
      (await learnings.reactions({ repo: 'work:games/arcade' })).map((s) => [
        s.mergeRequest,
        s.noteId,
        s.up,
        s.down,
      ]),
    ).toEqual([
      [7, '50', 0, 2],
      [7, '51', 3, 0],
      [8, '60', 2, 0],
    ])
    expect(
      (await learnings.reactions({ repo: 'work:games/arcade', mergeRequests: [8] })).map(
        (s) => s.noteId,
      ),
    ).toEqual(['60'])
  })
}
