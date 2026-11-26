import { describe, expect, test } from 'bun:test'

import type { Discussion } from '@holtkeeper/forge'
import { commentBody } from '@holtkeeper/review'

import {
  marksOnIn,
  mergeRequestMarks,
  messageMarks,
  slackMarksDefinition,
  slackMarksSettings,
} from './marks.ts'

const thread = (author: string, options: Partial<Discussion> = {}): Discussion => ({
  id: `thread-${author}`,
  resolvable: true,
  resolved: false,
  notes: [{ id: 1, author, body: 'Why a gizmo here?', createdAt: '', system: false }],
  ...options,
})

describe('mergeRequestMarks', () => {
  test('nothing for an open merge request without approvals or threads', () => {
    expect(mergeRequestMarks({ state: 'open', approvedBy: [], discussions: [] })).toEqual([])
  })

  test('every mark, in order', () => {
    expect(
      mergeRequestMarks({
        state: 'merged',
        approvedBy: ['jane'],
        discussions: [thread('jane')],
        self: 'bot',
      }),
    ).toEqual(['comments', 'approved', 'merged'])
  })

  test("Holtkeeper's account, its findings, resolved and unresolvable threads do not count", () => {
    const finding = commentBody({
      id: 'f1',
      severity: 'minor',
      category: 'bug',
      title: 'Off by one',
      body: 'The loop skips the last item.',
      source: 'agent',
    })
    const discussions = [
      thread('bot'),
      thread('jane', { resolved: true }),
      thread('jane', { resolvable: false }),
      {
        ...thread('alex'),
        notes: [{ id: 2, author: 'alex', body: finding, createdAt: '', system: false }],
      },
    ]
    expect(
      mergeRequestMarks({ state: 'closed', approvedBy: ['bot'], discussions, self: 'bot' }),
    ).toEqual([])
  })

  test('a system note is skipped when looking for who started a thread', () => {
    const discussion = thread('jane')
    discussion.notes.unshift({
      id: 0,
      author: 'bot',
      body: 'changed a line',
      createdAt: '',
      system: true,
    })
    expect(mergeRequestMarks({ approvedBy: [], discussions: [discussion], self: 'bot' })).toEqual([
      'comments',
    ])
  })
})

describe('messageMarks', () => {
  test('comments when any has them, approved and merged only when all have them', () => {
    expect(
      messageMarks([{ marks: ['approved', 'merged'] }, { marks: ['comments', 'merged'] }, {}]),
    ).toEqual(['comments'])
    expect(
      messageMarks([{ marks: ['approved', 'merged'] }, { marks: ['approved', 'merged'] }]),
    ).toEqual(['approved', 'merged'])
    expect(messageMarks([])).toEqual([])
  })
})

describe('slack.mergeRequestMarks', () => {
  test('off by default, with standard emoji', () => {
    expect(slackMarksDefinition.default).toEqual({
      enabled: false,
      channels: [],
      emoji: {
        comments: 'speech_balloon',
        approved: 'white_check_mark',
        merged: 'twisted_rightwards_arrows',
      },
    })
  })

  test('colons are dropped, and a value that does not parse leaves marks off', () => {
    expect(slackMarksSettings({ enabled: true, emoji: { comments: ':comment:' } }).emoji).toEqual({
      comments: 'comment',
      approved: 'white_check_mark',
      merged: 'twisted_rightwards_arrows',
    })
    expect(slackMarksSettings({ enabled: true, channels: ['not a channel'] }).enabled).toBe(false)
  })

  test('empty channels mean every channel', () => {
    const everywhere = slackMarksSettings({ enabled: true })
    expect(marksOnIn(everywhere, 'C0123WIDGET')).toBe(true)
    const listed = slackMarksSettings({ enabled: true, channels: ['C0123WIDGET'] })
    expect(marksOnIn(listed, 'C0123WIDGET')).toBe(true)
    expect(marksOnIn(listed, 'C0456OTHER')).toBe(false)
    expect(marksOnIn(slackMarksSettings({}), 'C0123WIDGET')).toBe(false)
  })
})
