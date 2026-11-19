import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'
import type { Discussion } from '@holtkeeper/forge'

import { HEAD, fakeAgent, fakeForge } from '../test/fakes.ts'
import { findingMarker } from './dedupe.ts'
import { replyBody } from './format.ts'
import { answerReplies, pendingReplies, repliedThreads } from './replies.ts'
import type { ReviewUsage } from './schema.ts'

const repo = { forge: 'work', path: 'shapes/circle' }
const mr = { id: 7, headSha: HEAD }

let nextNote = 1
const thread = (id: string, notes: [author: string, body: string][], line = 2): Discussion => ({
  id,
  resolvable: true,
  resolved: false,
  notes: notes.map(([author, body]) => ({
    id: nextNote++,
    author,
    body,
    createdAt: '',
    system: false,
  })),
  position: { path: 'src/area.ts', line, side: 'new', headSha: 'h' },
})

const finding = (text: string) => `${text}\n\n${findingMarker('f1')}`
const replyOf = (discussion: Discussion) => discussion.notes.at(-1)?.id ?? 0

const run = async (
  forge: ReturnType<typeof fakeForge>['forge'],
  agent: Agent,
  workspace: { dir?: string } = {},
) => {
  const usage: ReviewUsage = { turns: 0 }
  const pending = await pendingReplies({ forge, repo, mr: mr.id, botUsername: 'bot' })
  const outcomes = await answerReplies({
    forge,
    repo,
    mr,
    pending,
    agent,
    workspace: async () => workspace,
    botUsername: 'bot',
    usage,
  })
  return { outcomes, usage }
}

describe('repliedThreads', () => {
  test('keeps our threads a person answered last', () => {
    const answered = thread('answered', [
      ['bot', finding('Radius is never checked')],
      ['ann', 'Why?'],
      ['bot', replyBody('Because.')],
    ])
    const waiting = thread('waiting', [
      ['bot', finding('Radius is never checked')],
      ['ann', 'Why?'],
      ['bot', replyBody('Because.')],
      ['ann', 'Still unclear.'],
      ['raj', 'Same question.'],
    ])
    const foreign = thread('foreign', [
      ['ann', 'Look here'],
      ['raj', 'Ok'],
    ])
    const chat = thread('chat', [
      ['bot', 'Release card <!-- holtkeeper:chat -->'],
      ['ann', 'Thanks'],
    ])
    const untouched = thread('untouched', [['bot', finding('Unused import')]])
    const found = repliedThreads([answered, waiting, foreign, chat, untouched], 'bot')
    expect(found.map((item) => item.discussion.id)).toEqual(['waiting'])
    expect(found[0]?.reply.body).toBe('Same question.')
    expect(found[0]?.unanswered.map((note) => note.body)).toEqual([
      'Still unclear.',
      'Same question.',
    ])
  })
})

describe('answerReplies', () => {
  test('answers several threads in one call of the main tier and posts nothing for none', async () => {
    const first = thread('d1', [
      ['bot', finding('Radius is never checked')],
      ['ann', 'Negative radius cannot reach this function.'],
    ])
    const second = thread('d2', [
      ['bot', finding('Area is rounded twice')],
      ['ann', 'Why is that a problem?'],
    ])
    const thanks = thread('d3', [
      ['bot', finding('Unused import')],
      ['ann', 'Thanks, will remove it later.'],
    ])
    const { forge, replies, resolved, marksOn } = fakeForge({
      files: [],
      discussions: [first, second, thanks],
      contents: { 'src/area.ts': 'a\nb\nc' },
    })
    for (const item of [first, second, thanks])
      await forge.addNoteMark?.(repo.path, mr.id, replyOf(item), 'seen')
    const { agent, tasks } = fakeAgent({
      review: [
        {
          answers: [
            { id: 'd1', action: 'concede', body: 'You are right.', resolve: true },
            {
              id: 'd2',
              action: 'explain',
              body: 'The second rounding loses cents.',
              resolve: false,
            },
            { id: 'd3', action: 'none', body: '', resolve: false },
          ],
        },
      ],
    })
    const { outcomes, usage } = await run(forge, agent)
    expect(tasks.map((task) => [task.taskKind, task.tier])).toEqual([['review', 'main']])
    expect(tasks[0]?.system).toContain('A decline or a fix claim is never `none`')
    expect(tasks[0]?.prompt).toContain('## Thread d1 on src/area.ts:2')
    expect(tasks[0]?.prompt).toContain('## Thread d3 on src/area.ts:2')
    expect(outcomes).toEqual([
      {
        discussionId: 'd1',
        path: 'src/area.ts',
        line: 2,
        action: 'concede',
        replied: true,
        resolved: true,
      },
      {
        discussionId: 'd2',
        path: 'src/area.ts',
        line: 2,
        action: 'explain',
        replied: true,
        resolved: false,
      },
      {
        discussionId: 'd3',
        path: 'src/area.ts',
        line: 2,
        action: 'ack',
        replied: false,
        resolved: false,
      },
    ])
    expect(replies.map((reply) => reply.discussionId)).toEqual(['d1', 'd2'])
    expect(resolved).toEqual(['d1'])
    expect(marksOn(replyOf(first))).toEqual([])
    expect(marksOn(replyOf(second))).toEqual([])
    expect(marksOn(replyOf(thanks))).toEqual(['done'])
    expect(usage.turns).toBe(2)
  })

  test('a single reply that needs no answer gets only the done mark', async () => {
    const thanks = thread('d1', [
      ['bot', finding('Unused import')],
      ['ann', 'Thanks, will remove it.'],
    ])
    const { forge, replies, marksOn } = fakeForge({ files: [], discussions: [thanks] })
    const { agent } = fakeAgent({ review: [{ action: 'none', body: '', resolve: false }] })
    const { outcomes } = await run(forge, agent)
    expect(outcomes.map((o) => [o.action, o.replied])).toEqual([['ack', false]])
    expect(replies).toEqual([])
    expect(marksOn(replyOf(thanks))).toEqual(['done'])
  })

  test('a reply marked done is not looked at again', async () => {
    const thanks = thread('d1', [
      ['bot', finding('Unused import')],
      ['ann', 'Ok'],
    ])
    const { forge } = fakeForge({ files: [], discussions: [thanks] })
    await forge.addNoteMark?.(repo.path, mr.id, replyOf(thanks), 'done')
    const { agent, tasks } = fakeAgent({})
    expect((await run(forge, agent)).outcomes).toEqual([])
    expect(tasks).toEqual([])
  })

  test('answers every reply however long the thread, and resolves when the author asks', async () => {
    const argued = thread('d1', [
      ['bot', finding('Radius is never checked')],
      ['ann', 'Not needed.'],
      ['bot', replyBody('A negative radius gives a negative area.')],
      ['ann', 'Still not needed.'],
      ['bot', replyBody('A caller may still pass one.')],
      ['ann', 'We live with it, close the thread.'],
    ])
    const { forge, replies, resolved } = fakeForge({ files: [], discussions: [argued] })
    const { agent, tasks } = fakeAgent({
      review: [{ action: 'explain', body: 'Your call, closing it.', resolve: true }],
    })
    const { outcomes } = await run(forge, agent)
    expect(tasks).toHaveLength(1)
    expect(replies.map((r) => r.discussionId)).toEqual(['d1'])
    expect(resolved).toEqual(['d1'])
    expect(outcomes.map((o) => [o.action, o.resolved])).toEqual([['explain', true]])
  })

  test('answers a general thread with the current state of the review threads', async () => {
    const summary: Discussion = {
      ...thread('s', [
        ['bot', 'Summary <!-- holtkeeper:review summary head=h -->'],
        ['ann', 'All fine.'],
      ]),
      position: undefined,
    }
    const settled = {
      ...thread('r', [['bot', finding('**Major** · bug — **Radius is never checked**')]]),
      resolved: true,
    }
    const open = thread('o', [
      ['bot', finding('**Minor** · tests — **No test for the zero area**')],
    ])
    const { forge } = fakeForge({ files: [], discussions: [summary, settled, open] })
    const { agent, tasks } = fakeAgent({
      review: [{ action: 'explain', body: 'One open thread remains.', resolve: false }],
    })
    await run(forge, agent)
    expect(tasks[0]?.prompt).toContain('- resolved: src/area.ts:2 Radius is never checked')
    expect(tasks[0]?.prompt).toContain('- open: src/area.ts:2 No test for the zero area')
  })

  test('confirms a fixed claim from the code with status notes and resolves the thread', async () => {
    const fixed = thread('d1', [
      ['bot', finding('Radius is never checked')],
      ['ann', 'Already fixed.'],
    ])
    const not = thread('d2', [
      ['bot', finding('Area is rounded twice')],
      ['ann', 'Fixed too.'],
    ])
    const { forge, replies, resolved } = fakeForge({
      files: [],
      discussions: [fixed, not],
      contents: { 'src/area.ts': 'a\nb\nc' },
    })
    const { agent } = fakeAgent({
      review: [
        {
          answers: [
            { id: 'd1', action: 'fixed', body: 'The radius is validated now.', resolve: false },
            {
              id: 'd2',
              action: 'open',
              body: 'Both rounding calls are still there.',
              resolve: true,
            },
          ],
        },
      ],
    })
    const { outcomes } = await run(forge, agent, { dir: import.meta.dir })
    expect(outcomes.map((outcome) => [outcome.action, outcome.resolved])).toEqual([
      ['fixed', true],
      ['open', false],
    ])
    expect(replies[0]?.body).toContain('Resolved at `hhhhhhhh`: The radius is validated now.')
    expect(replies[1]?.body).toContain('Still applies at `hhhhhhhh`: Both rounding calls')
    expect(resolved).toEqual(['d1'])
  })

  test('answers one by one what the batch left out', async () => {
    const first = thread('d1', [
      ['bot', finding('Radius is never checked')],
      ['ann', 'Why?'],
    ])
    const second = thread('d2', [
      ['bot', finding('Area is rounded twice')],
      ['ann', 'Why?'],
    ])
    const { forge, replies } = fakeForge({ files: [], discussions: [first, second] })
    const { agent, tasks } = fakeAgent({
      review: [
        { answers: [{ id: 'd2', action: 'explain', body: 'Second.', resolve: false }] },
        { action: 'explain', body: 'First.', resolve: false },
      ],
    })
    const { outcomes } = await run(forge, agent)
    expect(tasks).toHaveLength(2)
    expect(outcomes.map((outcome) => outcome.action)).toEqual(['explain', 'explain'])
    expect(replies.map((reply) => reply.discussionId).toSorted()).toEqual(['d1', 'd2'])
  })

  test('drops the answer of a thread that got a newer note meanwhile', async () => {
    const first = thread('d1', [
      ['bot', finding('Radius is never checked')],
      ['ann', 'Why?'],
    ])
    const second = thread('d2', [
      ['bot', finding('Area is rounded twice')],
      ['ann', 'Why?'],
    ])
    const { forge, state, replies } = fakeForge({ files: [], discussions: [first, second] })
    const scripted = fakeAgent({
      review: [
        {
          answers: [
            { id: 'd1', action: 'explain', body: 'First.', resolve: false },
            { id: 'd2', action: 'explain', body: 'Second.', resolve: false },
          ],
        },
      ],
    })
    const agent: Agent = {
      name: 'fake',
      async run<Output>(task: AgentTask<Output>) {
        if (task.taskKind === 'review')
          state.discussions = [
            first,
            {
              ...second,
              notes: [
                ...second.notes,
                { id: 999, author: 'ann', body: 'Never mind.', createdAt: '', system: false },
              ],
            },
          ]
        return scripted.agent.run(task)
      },
    }
    const { outcomes } = await run(forge, agent)
    expect(outcomes.map((outcome) => [outcome.discussionId, outcome.action])).toEqual([
      ['d1', 'explain'],
      ['d2', 'skipped'],
    ])
    expect(replies.map((reply) => reply.discussionId)).toEqual(['d1'])
  })
})
