import { expect, test } from 'bun:test'

import type { Learning, Store } from './types.ts'

const at = (minute: number) => `2026-11-02T09:${String(minute).padStart(2, '0')}:00.000Z`

const learning = (id: string, overrides: Partial<Learning> = {}): Learning => ({
  id,
  text: 'Do not flag magic numbers in tween presets.',
  key: 'do not flag magic numbers in tween presets',
  scope: { repos: ['work:games/arcade'] },
  origin: 'reply',
  status: 'pending',
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
  activeAt: at(30),
  lastReinforcedAt: at(0),
  uses: 0,
  actedOn: 0,
  votesUp: 0,
  votesDown: 0,
  ...overrides,
})

/** Contract tests every `LearningStore` must pass. */
export function learningStoreTests(store: () => Store) {
  test('learnings: put, get, find by key, list newest first with filters, remove', async () => {
    const learnings = store().learnings
    await learnings.put(learning('a'))
    await learnings.put(learning('b', { key: 'other', origin: 'miner', updatedAt: at(5) }))
    await learnings.put(learning('c', { status: 'active', key: 'third', updatedAt: at(3) }))

    expect(await learnings.get('a')).toEqual(learning('a'))
    expect(await learnings.get('missing')).toBeUndefined()
    expect((await learnings.find(learning('a').key))?.id).toBe('a')
    expect(await learnings.find('missing key')).toBeUndefined()
    expect((await learnings.list()).map((l) => l.id)).toEqual(['b', 'c', 'a'])
    expect((await learnings.list({ status: ['pending'] })).map((l) => l.id)).toEqual(['b', 'a'])
    expect((await learnings.list({ origin: ['reply'] })).map((l) => l.id)).toEqual(['c', 'a'])
    expect(
      (await learnings.list({ status: ['pending'], origin: ['reply'] })).map((l) => l.id),
    ).toEqual(['a'])
    expect(await learnings.list({ status: [] })).toEqual([])

    await learnings.put(
      learning('a', {
        text: 'Edited.',
        key: 'edited',
        status: 'rejected',
        updatedAt: at(9),
        decidedBy: 'jane',
        decidedAt: at(9),
      }),
    )
    expect(await learnings.get('a')).toMatchObject({ text: 'Edited.', status: 'rejected' })
    expect(await learnings.find(learning('a').key)).toBeUndefined()
    expect((await learnings.find('edited'))?.id).toBe('a')
    expect((await learnings.list())[0]?.id).toBe('a')

    await learnings.remove('a')
    expect(await learnings.get('a')).toBeUndefined()
    expect(await learnings.find('edited')).toBeUndefined()
    expect((await learnings.list()).map((l) => l.id)).toEqual(['b', 'c'])
    await learnings.remove('missing')
  })

  test('learnings: optional fields round-trip and stay absent when unset', async () => {
    const learnings = store().learnings
    const full = learning('full', {
      reason: 'Presets are tuned by designers.',
      scope: { teams: ['games'] },
      files: ['src/tweens/**'],
      agents: ['review'],
      origin: 'agent',
      status: 'active',
      sources: [{ author: 'principal-1', at: at(1), url: 'https://forge.test/mr/7' }],
      uses: 4,
      actedOn: 2,
      votesUp: 3,
      votesDown: 1,
      decidedBy: 'jane',
      decidedAt: at(2),
      editedBy: 'kim',
    })
    await learnings.put(full)
    expect(await learnings.get('full')).toEqual(full)

    const { model: _model, costUsd: _cost, ...bare } = learning('bare', { key: 'bare' })
    await learnings.put(bare)
    const stored = await learnings.get('bare')
    expect(stored).toEqual(bare)
    for (const field of ['model', 'costUsd', 'reason', 'files', 'agents', 'decidedBy'])
      expect(Object.hasOwn(stored!, field)).toBe(false)
  })

  test('learnings: search matches prefixes of the text, filters and limits', async () => {
    const learnings = store().learnings
    await learnings.put(
      learning('one', { text: 'Name snapshot files after the widget.', key: '1' }),
    )
    await learnings.put(
      learning('two', {
        text: 'Snapshot tests replace snapshot fixtures.',
        key: '2',
        status: 'active',
      }),
    )
    await learnings.put(learning('three', { text: 'Translations use ICU.', key: '3' }))

    const hits = await learnings.search('snapsh')
    expect(hits.map((hit) => hit.learning.id).toSorted()).toEqual(['one', 'two'])
    expect(hits.every((hit) => hit.score > 0)).toBeTrue()
    expect(hits.find((hit) => hit.learning.id === 'two')?.learning).toEqual(
      await learnings.get('two'),
    )
    expect((await learnings.search('widget')).map((h) => h.learning.id)).toEqual(['one'])
    expect(
      (await learnings.search('snapshot', { status: ['active'] })).map((h) => h.learning.id),
    ).toEqual(['two'])
    expect(await learnings.search('snapshot', { origin: ['miner'] })).toEqual([])
    expect(await learnings.search('snapshot translations', undefined, 1)).toHaveLength(1)
    expect(await learnings.search('   ')).toEqual([])
    expect(await learnings.search('nothing-like-this')).toEqual([])
    const hostile = ['"', 'AND', 'NEAR(x y)', 'text:icu', '*', "\\ ' '' :* & | ! <->", '((']
    for (const found of await Promise.all(hostile.map((query) => learnings.search(query))))
      expect(Array.isArray(found)).toBeTrue()
    expect((await learnings.search('text:icu')).map((h) => h.learning.id)).toEqual(['three'])

    await learnings.put(learning('three', { text: 'Dates use Temporal.', key: '3' }))
    expect(await learnings.search('icu')).toEqual([])
    await learnings.remove('one')
    expect((await learnings.search('snapshot')).map((h) => h.learning.id)).toEqual(['two'])
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

  test('learnings: signals keep what became of a comment and list across repositories', async () => {
    const learnings = store().learnings
    const signal = {
      repo: 'work:games/arcade',
      mergeRequest: 7,
      noteId: '50',
      category: 'bug',
      up: 0,
      down: 0,
      updatedAt: at(0),
    }
    await learnings.putReactions(signal)
    await learnings.putReactions({
      ...signal,
      outcome: 'fixed',
      mergeRequestState: 'merged',
      severity: 'major',
      source: 'agent',
      model: 'fast-model',
      promptVersion: 'p-1',
      humanReplies: 2,
      updatedAt: at(1),
    })
    await learnings.putReactions({ ...signal, repo: 'work:games/puzzle', noteId: '9' })

    expect(await learnings.reactions({ repo: 'work:games/arcade' })).toEqual([
      {
        ...signal,
        outcome: 'fixed',
        mergeRequestState: 'merged',
        severity: 'major',
        source: 'agent',
        model: 'fast-model',
        promptVersion: 'p-1',
        humanReplies: 2,
        updatedAt: at(1),
      },
    ])
    expect((await learnings.reactions()).map((s) => [s.repo, s.noteId])).toEqual([
      ['work:games/arcade', '50'],
      ['work:games/puzzle', '9'],
    ])
  })
}
