import { expect, test } from 'bun:test'

import type { ChatMessageInput, ChatThreadInput, Store } from './types.ts'

const at = (minute: number) => `2026-11-03T10:${String(minute).padStart(2, '0')}:00.000Z`

const thread = (id: string, overrides: Partial<ChatThreadInput> = {}): ChatThreadInput => ({
  id,
  title: `Thread ${id}`,
  createdBy: 'user-1',
  createdAt: at(0),
  autoReply: false,
  ...overrides,
})

const message = (
  id: string,
  threadId: string,
  minute: number,
  overrides: Partial<ChatMessageInput> = {},
): ChatMessageInput => {
  const human = (overrides.authorType ?? 'human') === 'human'
  return {
    id,
    threadId,
    authorType: 'human',
    ...(human && { authorId: 'user-1' }),
    body: `Message ${id}`,
    mentions: [],
    createdAt: at(minute),
    ...overrides,
  }
}

/** Contract tests every `ChatStore` must pass. */
export function chatStoreTests(store: () => Store) {
  test('chat: threads are created, patched and listed by last activity', async () => {
    const chat = store().chat
    const created = await chat.createThread(thread('t1', { repo: 'work:games/arcade' }))
    expect(created).toEqual({
      ...thread('t1', { repo: 'work:games/arcade' }),
      updatedAt: at(0),
      archived: false,
      participants: [],
    })
    await chat.createThread(thread('t2', { group: 'games', createdAt: at(1) }))
    expect((await chat.listThreads()).map((t) => t.id)).toEqual(['t2', 't1'])

    await chat.addMessage(message('m1', 't1', 5))
    expect((await chat.listThreads()).map((t) => t.id)).toEqual(['t1', 't2'])
    expect((await chat.getThread('t1'))?.updatedAt).toBe(at(5))

    const patched = await chat.updateThread('t1', {
      title: 'Renamed',
      autoReply: true,
      participants: ['user-1', 'user-2'],
      summary: { text: 'Earlier talk.', uptoMessageId: 'm1', tokens: 12 },
      claimReply: { by: 'pod-a', at: at(6), staleBefore: at(0) },
    })
    expect(patched).toMatchObject({
      title: 'Renamed',
      autoReply: true,
      participants: ['user-1', 'user-2'],
      summary: { text: 'Earlier talk.', uptoMessageId: 'm1', tokens: 12 },
      replyingSince: at(6),
      replyingBy: 'pod-a',
      updatedAt: at(5),
    })
    const held = await chat.updateThread('t1', {
      claimReply: { by: 'pod-b', at: at(7), staleBefore: at(1) },
      releaseReply: 'pod-b',
      addParticipants: ['user-2', 'user-3', 'user-3'],
    })
    expect(held).toMatchObject({
      replyingBy: 'pod-a',
      replyingSince: at(6),
      participants: ['user-1', 'user-2', 'user-3'],
    })
    await chat.updateThread('t1', {
      rememberPeople: [
        { id: 'user-1', name: 'Kit Roe' },
        { id: 'user-2', name: 'Ada Pine', email: 'ada.pine@example.test' },
      ],
    })
    const remembered = await chat.updateThread('t1', {
      rememberPeople: [{ id: 'user-1', name: 'Kit Roe', email: 'kit.roe@example.test' }],
    })
    expect(remembered?.people).toEqual([
      { id: 'user-2', name: 'Ada Pine', email: 'ada.pine@example.test' },
      { id: 'user-1', name: 'Kit Roe', email: 'kit.roe@example.test' },
    ])
    const stolen = await chat.updateThread('t1', {
      claimReply: { by: 'pod-b', at: at(20), staleBefore: at(10) },
    })
    expect(stolen).toMatchObject({ replyingBy: 'pod-b', replyingSince: at(20) })
    expect((await chat.updateThread('t1', { releaseReply: 'pod-a' }))?.replyingBy).toBe('pod-b')
    const cleared = await chat.updateThread('t1', { summary: null, releaseReply: 'pod-b' })
    expect(cleared?.summary).toBeUndefined()
    expect(cleared?.replyingSince).toBeUndefined()
    expect(cleared?.replyingBy).toBeUndefined()
    expect(await chat.updateThread('missing', { title: 'x' })).toBeUndefined()

    await chat.updateThread('t2', { archived: true })
    expect((await chat.listThreads()).map((t) => t.id)).toEqual(['t1'])
    expect((await chat.listThreads({ archived: true })).map((t) => t.id)).toEqual(['t2'])
    expect(await chat.getThread('missing')).toBeUndefined()
  })

  test('chat: messages keep their fields, get growing seq and page by cursor', async () => {
    const chat = store().chat
    await chat.createThread(thread('t1'))
    await chat.createThread(thread('t2'))
    const first = await chat.addMessage(
      message('m1', 't1', 1, {
        body: 'Hi @holtkeeper',
        mentions: ['holtkeeper'],
      }),
    )
    await chat.addMessage(message('x1', 't2', 2))
    const reply = await chat.addMessage(
      message('m2', 't1', 3, {
        authorType: 'agent',
        body: 'Hello.',
        card: { title: 'Proposed change', blocks: [{ type: 'text', text: 'Rename the widget.' }] },
        toolTrace: [{ tool: 'search_knowledge', calls: 2 }],
        costUsd: 0.12,
        transcriptRef: 'artifact-1',
      }),
    )
    for (let minute = 4; minute < 9; minute++)
      // oxlint-disable-next-line no-await-in-loop -- seq order is what the test checks
      await chat.addMessage(message(`m${minute}`, 't1', minute))

    expect(first).toMatchObject({ id: 'm1', mentions: ['holtkeeper'] })
    expect(reply.seq).toBeGreaterThan(first.seq)
    const stored = await chat.getMessage('m2')
    expect(stored).toEqual({ ...reply })
    expect(stored?.authorId).toBeUndefined()
    expect(stored?.card?.title).toBe('Proposed change')
    expect(await chat.getMessage('missing')).toBeUndefined()

    const all = await chat.listMessages('t1')
    expect(all.map((m) => m.id)).toEqual(['m1', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8'])
    expect((await chat.listMessages('t1', { limit: 2 })).map((m) => m.id)).toEqual(['m7', 'm8'])
    const m5 = all.find((m) => m.id === 'm5')
    expect((await chat.listMessages('t1', { before: m5?.seq, limit: 2 })).map((m) => m.id)).toEqual(
      ['m2', 'm4'],
    )
    expect((await chat.listMessages('t1', { after: m5?.seq })).map((m) => m.id)).toEqual([
      'm6',
      'm7',
      'm8',
    ])
    expect(
      (await chat.listMessages('t1', { after: first.seq, limit: 1 })).map((m) => m.id),
    ).toEqual(['m2'])
  })

  test('chat: cards change in place and show up for changedSince', async () => {
    const chat = store().chat
    await chat.createThread(thread('t1'))
    const card = await chat.addMessage(
      message('m1', 't1', 1, {
        authorType: 'system',
        body: '',
        card: { title: 'Deploy', blocks: [] },
      }),
    )
    const last = await chat.addMessage(message('m2', 't1', 2))
    const updated = await chat.updateMessage('m1', {
      card: { title: 'Deploy', tone: 'good', blocks: [] },
      updatedAt: at(9),
    })
    expect(updated).toMatchObject({ id: 'm1', updatedAt: at(9), card: { tone: 'good' } })
    expect(await chat.updateMessage('missing', { body: 'x', updatedAt: at(9) })).toBeUndefined()
    expect((await chat.getMessage('m1'))?.seq).toBe(card.seq)

    expect((await chat.listMessages('t1', { after: last.seq })).map((m) => m.id)).toEqual([])
    expect(
      (await chat.listMessages('t1', { after: last.seq, changedSince: at(9) })).map((m) => m.id),
    ).toEqual(['m1'])
    expect(
      (await chat.listMessages('t1', { after: last.seq, changedSince: at(10) })).map((m) => m.id),
    ).toEqual([])
  })

  test('chat: read markers only move forward and drive unread counts', async () => {
    const chat = store().chat
    await chat.createThread(thread('t1'))
    await chat.createThread(thread('t2'))
    await chat.createThread(thread('t3'))
    await chat.addMessage(message('m1', 't1', 1, { authorId: 'user-2' }))
    await chat.addMessage(message('m2', 't1', 2))
    await chat.addMessage(message('m3', 't1', 3, { authorType: 'agent', body: 'Answer.' }))
    await chat.addMessage(message('m4', 't2', 4, { authorId: 'user-2' }))

    expect(await chat.unreadCounts('user-1', ['t1', 't2', 't3'])).toEqual({ t1: 2, t2: 1 })

    await chat.markRead('t1', 'user-1', 'm3')
    await chat.markRead('t1', 'user-1', 'm1')
    await chat.markRead('t1', 'user-1', 'm4')
    await chat.markRead('t1', 'user-1', 'missing')
    expect(await chat.reads('user-1')).toEqual([
      {
        threadId: 't1',
        userId: 'user-1',
        lastReadMessageId: 'm3',
        lastReadSeq: expect.any(Number),
      },
    ])
    expect(await chat.unreadCounts('user-1', ['t1', 't2'])).toEqual({ t2: 1 })
    expect(await chat.unreadCounts('user-2', ['t1'])).toEqual({ t1: 2 })
    expect(await chat.reads('user-2')).toEqual([])
  })
}
