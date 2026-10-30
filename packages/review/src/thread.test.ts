import { describe, expect, test } from 'bun:test'

import type { Discussion } from '@holtkeeper/forge'

import { fakeAgent, fakeForge } from '../test/fakes.ts'
import { findingMarker } from './dedupe.ts'
import { replyToThread, suggestionMarkdown } from './thread.ts'

const repo = { forge: 'work', path: 'games/a' }

const discussion = (notes: [author: string, body: string][]): Discussion => ({
  id: 'd1',
  resolvable: true,
  resolved: false,
  notes: notes.map(([author, body], index) => ({
    id: index,
    author,
    body,
    createdAt: '',
    system: false,
  })),
  position: { path: 'src/price.ts', line: 2, side: 'new', headSha: 'h' },
})

const ours = `Rounding missing\n\n${findingMarker('f1')}`

describe('replyToThread', () => {
  test('proposes an updated suggestion in GitLab syntax', async () => {
    const thread = discussion([
      ['bot', ours],
      ['jane', 'Rounding happens in the caller.'],
    ])
    const { forge, replies, resolved } = fakeForge({
      files: [],
      discussions: [thread],
      contents: { 'src/price.ts': 'a\nb\nc' },
    })
    const { agent, tasks } = fakeAgent({
      review: [
        {
          action: 'update',
          body: 'Then round at the boundary instead:',
          suggestion: { startLine: 1, line: 2, replacement: 'x\ny' },
          resolve: false,
        },
      ],
    })
    const result = await replyToThread({ forge, repo, mr: 7, discussion: 'd1', agent })
    expect(result).toEqual({ discussionId: 'd1', action: 'update', replied: true, resolved: false })
    expect(tasks[0]?.prompt).toContain('**jane**:\nRounding happens in the caller.')
    expect(tasks[0]?.prompt).toContain('2  b')
    expect(tasks[0]?.capabilities).toEqual([])
    expect(replies[0]?.body).toContain('```suggestion:-1+0\nx\ny\n```')
    expect(replies[0]?.body).toContain('holtkeeper:review')
    expect(resolved).toEqual([])
  })

  test('concedes and resolves', async () => {
    const thread = discussion([
      ['bot', ours],
      ['jane', 'This is intended.'],
    ])
    const { forge, resolved } = fakeForge({ files: [], discussions: [] })
    const { agent } = fakeAgent({
      review: [{ action: 'concede', body: 'You are right.', resolve: true }],
    })
    const result = await replyToThread({ forge, repo, mr: 7, discussion: thread, agent })
    expect(result.resolved).toBe(true)
    expect(resolved).toEqual(['d1'])
  })

  test('saves a rule the author taught', async () => {
    const thread = discussion([
      ['bot', ours],
      ['jane', 'We never round here: prices are integers in cents everywhere.'],
    ])
    const { forge } = fakeForge({ files: [], discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        {
          action: 'concede',
          body: 'Got it.',
          resolve: true,
          learning: { title: 'Prices are integer cents', body: 'Do not ask for rounding.' },
        },
      ],
    })
    const learned: unknown[] = []
    const result = await replyToThread({
      forge,
      repo,
      mr: 7,
      discussion: thread,
      agent,
      learn: async (learning) => {
        learned.push(learning)
        return { id: 'k1', status: 'proposed' }
      },
    })
    expect(tasks[0]?.system).toContain('`learning`')
    expect(learned).toEqual([
      {
        title: 'Prices are integer cents',
        body: 'Do not ask for rounding.',
        discussionId: 'd1',
        noteId: 1,
      },
    ])
    expect(result.learning).toEqual({ id: 'k1', status: 'proposed' })
  })

  test('reports a failed learning without failing the reply', async () => {
    const thread = discussion([
      ['bot', ours],
      ['jane', 'Intended.'],
    ])
    const { forge, replies } = fakeForge({ files: [], discussions: [] })
    const { agent, tasks } = fakeAgent({
      review: [
        { action: 'concede', body: 'Ok.', resolve: true, learning: { title: 't', body: 'b' } },
      ],
    })
    const result = await replyToThread({
      forge,
      repo,
      mr: 7,
      discussion: thread,
      agent,
      learn: () => Promise.reject(new Error('store down')),
    })
    expect(replies).toHaveLength(1)
    expect(result.learning).toEqual({ error: 'store down' })
    const plain = await replyToThread({ forge, repo, mr: 7, discussion: thread, agent })
    expect(tasks[1]?.system).not.toContain('`learning`')
    expect(plain.learning).toBeUndefined()
  })

  test('leaves foreign threads and answered threads alone', async () => {
    const { forge, replies } = fakeForge({ files: [], discussions: [] })
    const { agent, tasks } = fakeAgent({})
    const foreign = await replyToThread({
      forge,
      repo,
      mr: 7,
      discussion: discussion([
        ['jane', 'q'],
        ['bob', 'a'],
      ]),
      agent,
    })
    expect(foreign.action).toBe('skipped')
    const answered = await replyToThread({
      forge,
      repo,
      mr: 7,
      discussion: discussion([
        ['bot', ours],
        ['jane', 'q'],
        ['holtkeeper', 'a'],
      ]),
      agent,
      botUsername: 'holtkeeper',
    })
    expect(answered.reason).toContain('already ours')
    expect(tasks).toEqual([])
    expect(replies).toEqual([])
  })
})

test('suggestionMarkdown', () => {
  expect(suggestionMarkdown('a\n')).toBe('```suggestion:-0+0\na\n```')
})
