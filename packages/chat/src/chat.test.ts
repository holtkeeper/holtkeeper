import { describe, expect, test } from 'bun:test'

import { rootPrincipal } from '@holtkeeper/access'
import type { GitForge } from '@holtkeeper/forge'
import { z } from 'zod'

import { type Card, formCommand, textCard } from './card.ts'
import {
  type ChatAuthorization,
  type ChatMessage,
  type ChatSurface,
  ChatUserError,
  defineCommand,
  liveMessage,
} from './command.ts'
import { mergeRequestSurface, mergeRequestThread } from './forge.ts'
import { muteMentions, renderMarkdown } from './markdown.ts'
import { commandOptions, parseCommandLine, splitWords } from './parse.ts'
import { createChatRouter } from './router.ts'

function memorySurface(options: { editable?: boolean } = {}) {
  const posted: Card[] = []
  const updates: { id: string | undefined; card: Card }[] = []
  const surface: ChatSurface = {
    id: 'memory',
    post: async (thread, card) => {
      posted.push(card)
      return { surface: 'memory', thread, id: String(posted.length) }
    },
    ...(options.editable !== false && {
      update: async (message, card) => void updates.push({ id: message.id, card }),
    }),
  }
  return { surface, posted, updates }
}

const message = (text: string): ChatMessage => ({
  surface: 'memory',
  thread: { room: 'general' },
  actor: { provider: 'gitlab:work', externalId: '42', username: 'dev' },
  text,
  repo: { forge: 'work', path: 'games/app-x' },
})

const allowed = async (): Promise<ChatAuthorization> => ({
  allowed: true,
  principal: rootPrincipal('test'),
})

describe('parse', () => {
  test('splits words and keeps quoted spaces', () => {
    expect(splitWords(' a "b c" d="e f" "say \\"hi\\""')).toEqual(['a', 'b c', 'd=e f', 'say "hi"'])
    expect(splitWords('x ""')).toEqual(['x', ''])
  })

  test('finds the command on any line, or a bare one', () => {
    expect(parseCommandLine('Thanks!\n/holtkeeper release deploy prod')).toEqual({
      name: 'release',
      args: ['deploy', 'prod'],
    })
    expect(parseCommandLine('release deploy')).toBeUndefined()
    expect(parseCommandLine('release deploy', { bare: true })).toEqual({
      name: 'release',
      args: ['deploy'],
    })
    expect(parseCommandLine('/hk help', { prefix: 'hk' })?.name).toBe('help')
  })

  test('maps arguments to options', () => {
    expect(commandOptions(['deploy', 'prod', 'tag=v1', '--yes'], ['step', 'environment'])).toEqual({
      step: 'deploy',
      environment: 'prod',
      tag: 'v1',
      yes: true,
    })
    expect(commandOptions(['a', 'b', 'c'], ['first', 'rest'])).toEqual({
      first: 'a',
      rest: ['b', 'c'],
    })
  })
})

describe('cards', () => {
  test('form command quotes values and skips empty ones', () => {
    const command = formCommand(
      {
        command: 'release deploy',
        submitLabel: 'Deploy',
        fields: [
          { kind: 'select', name: 'environments', label: 'Where', options: [], multiple: true },
          { kind: 'text', name: 'note', label: 'Note', optional: true },
          { kind: 'text', name: 'empty', label: 'Empty', optional: true },
          { kind: 'toggle', name: 'force', label: 'Force' },
        ],
      },
      { environments: ['qa', 'prod'], note: 'after "lunch"', empty: '', force: false },
    )
    expect(command).toBe('release deploy environments=qa,prod note="after \\"lunch\\"" force=false')
    expect(splitWords(command)).toContain('note=after "lunch"')
  })

  test('markdown renders every block and mutes mentions', () => {
    const text = renderMarkdown(
      {
        title: 'Release games/app-x',
        tone: 'good',
        url: 'https://holt.example/releases/work/games/app-x',
        blocks: [
          { type: 'text', text: 'Ping @lead, mail a@b.example' },
          { type: 'fields', fields: [{ label: 'Next', value: '1.3.0' }] },
          {
            type: 'steps',
            steps: [
              { label: 'qa', status: 'done', url: 'https://ci.example/1' },
              { label: 'prod', status: 'running', detail: 'deploy-prod' },
            ],
          },
          { type: 'list', items: [{ text: 'gate', tone: 'bad' }] },
          {
            type: 'actions',
            actions: [{ label: 'Deploy', command: 'release deploy prod --yes', style: 'danger' }],
          },
          {
            type: 'form',
            form: {
              command: 'release deploy',
              submitLabel: 'Deploy',
              fields: [
                {
                  kind: 'select',
                  name: 'environment',
                  label: 'Environment',
                  options: [{ value: 'qa', label: 'QA' }],
                },
              ],
            },
          },
          { type: 'context', text: 'dry run' },
        ],
      },
      { prefix: 'hk' },
    )
    expect(text).toBe(
      [
        '#### 🟢 Release games/app-x',
        'Ping @​lead, mail a@b.example',
        '- **Next:** 1.3.0',
        '- ✅ [**qa**](https://ci.example/1)\n- 🔄 **prod** — deploy-prod',
        '- 🔴 gate',
        'Reply with:\n- `/hk release deploy prod --yes` — Deploy ⚠️',
        '**Deploy** — reply with `/hk release deploy environment=<environment>`\n- `environment` — Environment: `qa`',
        '<sub>dry run</sub>',
        '[Open in Holtkeeper](https://holt.example/releases/work/games/app-x)',
      ].join('\n\n'),
    )
    expect(muteMentions('`@code` @here')).toBe('`@code` @​here')
  })
})

const failing = (error: Error) =>
  defineCommand({
    name: 'fail',
    summary: 'Fails.',
    options: z.object({}),
    run: async () => {
      throw error
    },
  })

describe('router', () => {
  const echo = defineCommand({
    name: 'echo',
    summary: 'Repeats text.',
    usage: '<text>',
    positional: ['text'],
    options: z.object({ text: z.string(), loud: z.boolean().optional() }),
    run: async ({ options, reply }) => {
      await reply(textCard('Echo', options.loud ? options.text.toUpperCase() : options.text))
    },
  })

  test('runs a command and answers on the surface', async () => {
    const { surface, posted } = memorySurface()
    const router = createChatRouter({ commands: [echo], authorize: allowed })
    const outcome = await router.handle(message('/holtkeeper echo hi --loud'), surface)
    expect(outcome).toEqual({ status: 'done', command: 'echo' })
    expect(posted).toEqual([textCard('Echo', 'HI')])
  })

  test('ignores messages without a command', async () => {
    const { surface, posted } = memorySurface()
    const router = createChatRouter({ commands: [echo], authorize: allowed })
    expect((await router.handle(message('just talking'), surface)).status).toBe('ignored')
    expect(posted).toEqual([])
  })

  test('answers unknown commands with help and invalid ones with usage', async () => {
    const { surface, posted } = memorySurface()
    const router = createChatRouter({ commands: [echo], authorize: allowed })
    expect((await router.handle(message('/holtkeeper nope'), surface)).status).toBe('unknown')
    expect(JSON.stringify(posted[0])).toContain('/holtkeeper echo <text>')
    expect(JSON.stringify(posted[0])).toContain('/holtkeeper help')
    expect((await router.handle(message('/holtkeeper echo'), surface)).status).toBe('invalid')
    expect(posted[1]?.tone).toBe('warning')
  })

  test('explains refusals by reason', async () => {
    const { surface, posted } = memorySurface()
    const guarded = defineCommand({
      name: 'ship',
      summary: 'Ships.',
      options: z.object({}),
      run: async ({ require, message: { repo } }) => {
        await require('releases:run', repo)
      },
    })
    const router = createChatRouter({
      commands: [guarded],
      authorize: async () => ({ allowed: false, reason: 'not-linked' }),
    })
    const outcome = await router.handle(message('/holtkeeper ship'), surface)
    expect(outcome).toEqual({ status: 'denied', command: 'ship', detail: 'not-linked' })
    expect(JSON.stringify(posted[0])).toContain('gitlab account is not linked')
  })

  test('shows user errors as they are and hides other failures', async () => {
    const { surface, posted } = memorySurface()
    const errors: unknown[] = []
    const router = (error: Error) =>
      createChatRouter({
        commands: [failing(error)],
        authorize: allowed,
        onError: (failure) => void errors.push(failure),
      })
    await router(new ChatUserError('Nothing to release')).handle(
      message('/holtkeeper fail'),
      surface,
    )
    await router(new Error('token=secret')).handle(message('/holtkeeper fail'), surface)
    expect(JSON.stringify(posted[0])).toContain('Nothing to release')
    expect(JSON.stringify(posted[1])).not.toContain('secret')
    expect(errors).toHaveLength(1)
  })

  test('live messages update in place, or post again without updates', async () => {
    const editable = memorySurface()
    const live = liveMessage(editable.surface, await editable.surface.post({}, textCard('a', '1')))
    await live.update(textCard('a', '2'))
    expect(editable.updates).toEqual([{ id: '1', card: textCard('a', '2') }])

    const plain = memorySurface({ editable: false })
    const again = liveMessage(plain.surface, await plain.surface.post({}, textCard('a', '1')))
    await again.update(textCard('a', '2'))
    expect(plain.posted).toHaveLength(2)
    expect(again.posted.id).toBe('2')
  })
})

describe('merge request surface', () => {
  const repo = { forge: 'work', path: 'games/app-x' }

  test('posts a thread, replies in it and edits notes', async () => {
    const calls: unknown[][] = []
    const forge = {
      postMergeRequestNote: async (...args: unknown[]) => {
        calls.push(['post', ...args])
        return { noteId: 7, discussionId: 'd1' }
      },
      updateMergeRequestNote: async (...args: unknown[]) => void calls.push(['update', ...args]),
    } as unknown as GitForge
    const surface = mergeRequestSurface({ forgeOf: () => forge, marker: 'holtkeeper:chat' })
    const posted = await surface.post(mergeRequestThread(repo, 3), textCard('Hi', 'there'))
    expect(posted).toEqual({
      surface: 'merge-requests',
      thread: { forge: 'work', path: 'games/app-x', mergeRequest: 3, discussionId: 'd1' },
      id: '7',
    })
    expect(calls[0]).toEqual([
      'post',
      'games/app-x',
      3,
      '#### Hi\n\nthere\n\n<!-- holtkeeper:chat -->',
      {},
    ])
    await surface.update?.(posted, textCard('Hi', 'again'))
    expect(calls[1]?.slice(0, 4)).toEqual(['update', 'games/app-x', 3, 7])
  })

  test('falls back to plain comments and replies', async () => {
    const calls: string[] = []
    const forge = {
      commentOnMergeRequest: async () => void calls.push('comment'),
      replyToDiscussion: async () => void calls.push('reply'),
    } as unknown as GitForge
    const surface = mergeRequestSurface({ forgeOf: () => forge, marker: 'm' })
    const posted = await surface.post(mergeRequestThread(repo, 3), textCard('a', 'b'))
    await surface.post(mergeRequestThread(repo, 3, 'd2'), textCard('a', 'b'))
    expect(calls).toEqual(['comment', 'reply'])
    expect(posted.id).toBeUndefined()
  })
})
