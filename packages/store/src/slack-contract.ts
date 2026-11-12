import { expect, test } from 'bun:test'

import type { SlackMessageLink, SlackStatusReply, Store } from './types.ts'

const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T09:00:00.000Z`

const link = (overrides: Partial<SlackMessageLink> = {}): SlackMessageLink => ({
  channel: 'C0123WIDGET',
  ts: '1700000000.000100',
  repo: 'acme:shapes/widget',
  mergeRequest: 7,
  createdAt: at(1),
  updatedAt: at(1),
  ...overrides,
})

const reply = (overrides: Partial<SlackStatusReply> = {}): SlackStatusReply => ({
  channel: 'C0123WIDGET',
  ts: '1700000000.000100',
  replyTs: '1700000000.000300',
  text: ':eyes: Reviewing',
  createdAt: at(1),
  updatedAt: at(1),
  ...overrides,
})

/** Contract tests every `SlackMessageStore` must pass; skipped for stores without one. */
export function slackMessageStoreTests(store: () => Store) {
  test('slack messages: put replaces, lists by message and by merge request', async () => {
    const messages = store().slackMessages
    if (!messages) return
    await messages.put(link())
    await messages.put(link({ mergeRequest: 3 }))
    await messages.put(
      link({ channel: 'C0456SHAPES', ts: '1700000001.000200', createdAt: at(2), updatedAt: at(2) }),
    )
    await messages.put(
      link({ status: 'reviewing', reaction: 'eyes', head: 'b'.repeat(40), title: 'Add widget' }),
    )

    const ofMessage = await messages.ofMessage('C0123WIDGET', '1700000000.000100')
    expect(ofMessage.map((entry) => entry.mergeRequest)).toEqual([3, 7])
    expect(ofMessage[1]).toEqual(
      link({ status: 'reviewing', reaction: 'eyes', head: 'b'.repeat(40), title: 'Add widget' }),
    )

    const ofMergeRequest = await messages.ofMergeRequest('acme:shapes/widget', 7)
    expect(ofMergeRequest.map((entry) => entry.channel)).toEqual(['C0123WIDGET', 'C0456SHAPES'])
    expect(await messages.ofMergeRequest('acme:shapes/other', 7)).toEqual([])
  })

  test('slack messages: delete drops one link or every link of a message', async () => {
    const messages = store().slackMessages
    if (!messages) return
    await messages.put(link())
    await messages.put(link({ mergeRequest: 3 }))
    await messages.put(link({ ts: '1700000009.000900' }))

    expect(
      await messages.delete('C0123WIDGET', '1700000000.000100', {
        repo: 'acme:shapes/widget',
        mergeRequest: 3,
      }),
    ).toBe(1)
    expect(
      (await messages.ofMessage('C0123WIDGET', '1700000000.000100')).map((e) => e.mergeRequest),
    ).toEqual([7])
    expect(await messages.delete('C0123WIDGET', '1700000000.000100')).toBe(1)
    expect(await messages.ofMessage('C0123WIDGET', '1700000000.000100')).toEqual([])
    expect(await messages.ofMessage('C0123WIDGET', '1700000009.000900')).toHaveLength(1)
  })

  test('slack messages: prune drops links created before a time', async () => {
    const messages = store().slackMessages
    if (!messages) return
    await messages.put(link())
    await messages.put(link({ ts: '1700000005.000500', createdAt: at(5), updatedAt: at(5) }))

    expect(await messages.prune(at(3))).toBe(1)
    expect(
      (await messages.ofMergeRequest('acme:shapes/widget', 7)).map((entry) => entry.ts),
    ).toEqual(['1700000005.000500'])
  })

  test('slack messages: status replies are kept per message and go with it', async () => {
    const messages = store().slackMessages
    if (!messages) return
    expect(await messages.replyOf('C0123WIDGET', '1700000000.000100')).toBeUndefined()
    await messages.put(link())
    await messages.putReply(reply())
    await messages.putReply(reply({ text: ':red_circle: Needs changes', updatedAt: at(2) }))
    await messages.putReply(reply({ ts: '1700000009.000900', replyTs: '1700000009.000950' }))
    expect(await messages.replyOf('C0123WIDGET', '1700000000.000100')).toEqual(
      reply({ text: ':red_circle: Needs changes', updatedAt: at(2) }),
    )

    await messages.delete('C0123WIDGET', '1700000000.000100', {
      repo: 'acme:shapes/widget',
      mergeRequest: 7,
    })
    expect(await messages.replyOf('C0123WIDGET', '1700000000.000100')).toBeDefined()
    expect(await messages.delete('C0123WIDGET', '1700000000.000100')).toBe(0)
    expect(await messages.replyOf('C0123WIDGET', '1700000000.000100')).toBeUndefined()
    expect(await messages.replyOf('C0123WIDGET', '1700000009.000900')).toBeDefined()
  })

  test('slack messages: prune drops old status replies of messages without links', async () => {
    const messages = store().slackMessages
    if (!messages) return
    await messages.putReply(reply())
    await messages.putReply(reply({ ts: '1700000005.000500', createdAt: at(5), updatedAt: at(5) }))
    await messages.put(link({ ts: '1700000007.000700', createdAt: at(1), updatedAt: at(1) }))
    await messages.putReply(reply({ ts: '1700000007.000700', replyTs: '1700000007.000750' }))

    await messages.prune(at(3))
    expect(await messages.replyOf('C0123WIDGET', '1700000000.000100')).toBeUndefined()
    expect(await messages.replyOf('C0123WIDGET', '1700000005.000500')).toBeDefined()
    expect(await messages.replyOf('C0123WIDGET', '1700000007.000700')).toBeUndefined()
  })

  test('slack messages: prune keeps a status reply while its message has newer links', async () => {
    const messages = store().slackMessages
    if (!messages) return
    await messages.put(link())
    await messages.put(link({ mergeRequest: 9, createdAt: at(5), updatedAt: at(5) }))
    await messages.putReply(reply())

    expect(await messages.prune(at(3))).toBe(1)
    expect(
      (await messages.ofMessage('C0123WIDGET', '1700000000.000100')).map((e) => e.mergeRequest),
    ).toEqual([9])
    expect(await messages.replyOf('C0123WIDGET', '1700000000.000100')).toEqual(reply())
  })
}
