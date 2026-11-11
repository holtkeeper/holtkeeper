import { describe, expect, test } from 'bun:test'

import type { ChatMessage } from '@holtkeeper/store'

import {
  anonymize,
  buildChatPrompt,
  buildSummaryPrompt,
  mentionsAgent,
  parseMentions,
  participantLabel,
  participantLabels,
  planSummary,
} from '../src/chat-prompt.ts'

let seq = 0
const message = (
  authorType: ChatMessage['authorType'],
  body: string,
  authorId?: string,
): ChatMessage => {
  seq += 1
  return {
    id: `m${seq}`,
    threadId: 't1',
    seq,
    authorType,
    ...(authorId && { authorId }),
    body,
    mentions: parseMentions(body),
    createdAt: '2026-11-01T09:00:00.000Z',
  }
}

const people = [
  { id: 'u-rhea', name: 'Rhea Stone', email: 'rhea.stone@example.test' },
  { id: 'u-tom', name: 'Tomas Reed', email: 'treed@example.test' },
  { id: 'u-kit', name: 'Kit Moss' },
]

describe('chat prompt', () => {
  test('labels go A to Z, then AA', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(participantLabel)).toEqual([
      'Participant A',
      'Participant B',
      'Participant Z',
      'Participant AA',
      'Participant AB',
      'Participant AZ',
      'Participant BA',
    ])
    expect([...participantLabels(['u-tom', 'u-rhea'])]).toEqual([
      ['u-tom', 'Participant A'],
      ['u-rhea', 'Participant B'],
    ])
  })

  test('mentions skip package scopes and emails', () => {
    expect(parseMentions('@Holtkeeper see @some-lib/widget, mail a@b.test, @tom.')).toEqual([
      'holtkeeper',
      'tom',
    ])
    expect(mentionsAgent(parseMentions('hey @holtkeeper'))).toBe(true)
    expect(mentionsAgent(parseMentions('hey holtkeeper'))).toBe(false)
  })

  test('anonymize replaces ids, emails, user names and names; unknown emails become [email]', () => {
    const labels = participantLabels(['u-tom', 'u-rhea'])
    expect(
      anonymize(
        'Rhea Stone asked @treed and u-tom; rhea.stone@example.test cc x@y.test, Kit too. Max width stays.',
        people,
        labels,
      ),
    ).toBe(
      'Participant B asked @Participant A and Participant A; Participant B cc [email], a teammate too. Max width stays.',
    )
    expect(anonymize('rhea said so, and Rhea agreed', people, labels)).toBe(
      'rhea said so, and Participant B agreed',
    )
    expect(anonymize('ask @kitmoss or @KitMoss', people, labels)).toBe(
      'ask @a teammate or @a teammate',
    )
  })

  test('human turns since the last reply are merged; the agent is assistant', () => {
    seq = 0
    const prompt = buildChatPrompt({
      participants: ['u-tom', 'u-rhea'],
      people,
      summary: { text: 'Tomas Reed wanted a calmer grid.', uptoMessageId: 'm0', tokens: 40 },
      messages: [
        message('human', 'How do we theme the widget?', 'u-tom'),
        message('agent', 'Use the theme tokens.'),
        message('human', 'Rhea, thoughts?', 'u-tom'),
        message('human', '@holtkeeper and dark mode?', 'u-rhea'),
        message('system', ''),
      ],
    })
    expect(prompt).toBe(
      [
        'Summary of the earlier conversation:\nParticipant A wanted a calmer grid.',
        'Conversation so far:\nParticipant A: How do we theme the widget?\nassistant: Use the theme tokens.',
        'New messages since your last reply:\nParticipant A: Participant B, thoughts?\nParticipant B: @holtkeeper and dark mode?\nsystem: ',
        'Reply to the new messages.',
      ].join('\n\n'),
    )
  })

  test('summaries are planned only above the threshold and keep the newest messages', () => {
    const history = (count: number) => ({
      participants: ['u-tom'],
      people,
      messages: Array.from({ length: count }, (_, index) =>
        message('human', `${index} ${'x'.repeat(396)}`, 'u-tom'),
      ),
    })
    const limits = { threshold: 1000, keep: 300 }
    expect(planSummary(history(9), limits)).toBeUndefined()
    const small = history(12)
    const plan = planSummary(small, limits)
    expect(plan?.fold.map((entry) => entry.id)).toEqual(
      small.messages.slice(0, 10).map((m) => m.id),
    )
    expect(plan?.uptoMessageId).toBe(small.messages[9]?.id)
    expect(plan?.tokens).toBeGreaterThan(1000)
    const huge = {
      participants: ['u-tom'],
      people,
      messages: [
        message('human', 'y'.repeat(8000), 'u-tom'),
        message('human', 'z'.repeat(8000), 'u-tom'),
      ],
    }
    expect(planSummary(huge, limits)?.fold.map((entry) => entry.id)).toEqual([huge.messages[0]!.id])
    const folded = buildSummaryPrompt(
      { ...small, summary: { text: 'Kit Moss left.', uptoMessageId: 'm0', tokens: 1 } },
      plan?.fold ?? [],
    )
    expect(folded).toStartWith(
      'Previous summary:\na teammate left.\n\nMessages to fold in:\nParticipant A: 0 ',
    )
  })
})
