import type { Principal } from '@holtkeeper/access'
import type {
  AgentTranscriptView,
  ChatCommandView,
  ChatMessageList,
  ChatMessageView,
  ChatPeopleView,
  ChatPostResult,
  ChatThreadList,
  ChatThreadView,
  ChatUnreadView,
} from '@holtkeeper/api'
import type { ChatMessage, ChatPerson, ChatThread, User } from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { mentionsAgent, parseMentions, participantLabels } from '../chat-prompt.ts'
import { STALE_REPLY_MS, canSeeThread, hasChatAccess } from '../chat-threads.ts'
import { chatFor } from '../chat.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
} from '../context.ts'
import { readTranscript } from '../transcripts.ts'
import { avatarUrl } from './avatars.ts'

const repoKey = z
  .string()
  .regex(/^[^:]+:.+$/, 'must look like <forge>:<path>')
  .optional()

const threadSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    repo: repoKey,
    group: z.string().min(1).optional(),
    autoReply: z.boolean().optional(),
  })
  .refine((input) => !(input.repo && input.group), 'give repo or group, not both')

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
    autoReply: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'nothing to change')

const postSchema = z.object({
  body: z.string().trim().min(1).max(8000),
  repo: repoKey,
})

const readSchema = z.object({ messageId: z.string().min(1) })

/** The answer to a slash command in a team-wide thread. */
const TEAM_COMMANDS_REFUSED =
  'Commands run in a repository or group thread. Open one for the repository or team you mean and run the command there.'

/** How far `serverTime` trails the clock, for updates stamped before a poll but committed after. */
const CHANGE_MARGIN_MS = 30_000

const cursor = (value: string | undefined, name: string) => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new HTTPException(400, { message: `${name} must be a message seq` })
  return parsed
}

const caller = (c: AppContext): Principal => {
  const principal = principalOf(c)
  if (!hasChatAccess(principal))
    throw new HTTPException(403, { message: 'missing permission repos:read' })
  return principal
}

const messageView = (thread: ChatThread, message: ChatMessage): ChatMessageView => {
  const label =
    message.authorId !== undefined
      ? participantLabels(thread.participants).get(message.authorId)
      : undefined
  return {
    id: message.id,
    threadId: message.threadId,
    seq: message.seq,
    authorType: message.authorType,
    ...(message.authorId !== undefined && { authorId: message.authorId }),
    ...(label && { authorLabel: label }),
    body: message.body,
    ...(message.card && { card: message.card }),
    ...(message.toolTrace && { toolTrace: message.toolTrace }),
    ...(message.costUsd !== undefined && { costUsd: message.costUsd }),
    ...(message.transcriptRef !== undefined && { transcriptRef: message.transcriptRef }),
    mentions: message.mentions,
    createdAt: message.createdAt,
    ...(message.updatedAt !== undefined && { updatedAt: message.updatedAt }),
  }
}

/** The users a body mentions by id, user name (email before `@`) or name without spaces. */
const mentionKeys = (user: User) =>
  [user.id, user.email?.split('@')[0] ?? '', user.name.replaceAll(/\s+/g, '')].map((key) =>
    key.toLowerCase(),
  )

/** The handle the composer offers for a user; `mentionKeys` matches it. */
const handleOf = (user: User) =>
  (user.email?.split('@')[0] || user.name.replaceAll(/\s+/g, '')).toLowerCase()

const personOf = (principal: Principal): ChatPerson => ({
  id: principal.id,
  ...(principal.name && { name: principal.name }),
  ...(principal.email && { email: principal.email }),
})

const userPrincipal = (user: User): Principal => ({
  id: user.id,
  name: user.name,
  ...(user.email && { email: user.email }),
  provider: 'users',
  grants: user.grants,
})

/**
 * The team chat. Every endpoint needs a signed-in caller and answers 404 for threads it cannot see
 * (`canSeeThread`): repository and group threads need `repos:read` there, unscoped threads chat
 * access (`repos:read` anywhere).
 *
 * - `GET /chat/threads?archived=true` — visible threads with unread counts, and the commands.
 * - `POST /chat/threads` `{ title, repo?, group?, autoReply? }` — a new thread.
 * - `GET /chat/threads/:id` and `PATCH /chat/threads/:id` `{ title?, archived?, autoReply? }`.
 * - `GET /chat/threads/:id/people` — enabled `users` accounts that can see the thread, to mention.
 * - `GET /chat/threads/:id/messages?before=&after=&changedSince=&limit=` — a page of messages.
 * - `POST /chat/threads/:id/messages` `{ body, repo? }` — a message; `/command` runs a command
 *   about `repo` (400 when it lies outside a repository or group thread's scope, and always in
 *   team-wide threads),
 *   `@holtkeeper` (or `autoReply`) starts an agent reply in the background.
 * - `POST /chat/threads/:id/read` `{ messageId }` and `GET /chat/unread`.
 * - `GET /chat/messages/:id/transcript` — the transcript of an agent reply in a visible thread.
 *
 * The page polls the messages with `after` and `changedSince` every few seconds.
 */
export function chatRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const chat = deps.store.chat

  const visibleThread = async (principal: Principal, id: string): Promise<ChatThread> => {
    const thread = await chat.getThread(id)
    if (!thread || !canSeeThread(deps.config, principal, thread))
      throw new HTTPException(404, { message: 'thread not found' })
    return thread
  }

  const commands = (): ChatCommandView[] =>
    chatFor(deps)
      .router()
      .commands.filter((command) => !command.hidden && command.name !== 'verify')
      .map((command) => ({
        name: command.name,
        summary: command.summary,
        ...(command.usage && { usage: command.usage }),
      }))

  const participantsOf = async (thread: ChatThread) => {
    const labels = participantLabels(thread.participants)
    const users = await Promise.all(thread.participants.map((id) => deps.store.users.getUser(id)))
    return thread.participants.map((id, index) => {
      const user = users[index]
      const name = user?.name ?? thread.people?.find((person) => person.id === id)?.name
      return {
        id,
        label: labels.get(id) ?? '',
        ...(name && { name }),
        avatarUrl: avatarUrl(user?.avatarSeed ?? id),
      }
    })
  }

  const insideThread = (thread: ChatThread, repoText: string) => {
    if (thread.repo) return repoText === thread.repo
    if (!thread.group) return true
    const repo = parseRepo(repoText)
    return repo !== undefined && repoTarget(deps.config, repo).groups.includes(thread.group)
  }

  const groupsOf = (thread: ChatThread): string[] => {
    const repo = parseRepo(thread.repo)
    if (repo) return repoTarget(deps.config, repo).groups
    return thread.group ? [thread.group] : []
  }

  const threadView = async (thread: ChatThread, unread = 0): Promise<ChatThreadView> => ({
    id: thread.id,
    title: thread.title,
    ...(thread.repo && { repo: thread.repo }),
    ...(thread.group && { group: thread.group }),
    groups: groupsOf(thread),
    createdBy: thread.createdBy,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archived: thread.archived,
    autoReply: thread.autoReply,
    replying:
      thread.replyingSince !== undefined &&
      deps.now().getTime() - Date.parse(thread.replyingSince) < STALE_REPLY_MS,
    unread,
    participants: await participantsOf(thread),
    summarized: thread.summary !== undefined,
  })

  const unreadOf = async (principal: Principal, thread: ChatThread) =>
    (await chat.unreadCounts(principal.id, [thread.id]))[thread.id] ?? 0

  app.get('/chat/threads', async (c) => {
    const principal = caller(c)
    const threads = (
      await chat.listThreads({ archived: c.req.query('archived') === 'true' })
    ).filter((thread) => canSeeThread(deps.config, principal, thread))
    const unread = await chat.unreadCounts(
      principal.id,
      threads.map((thread) => thread.id),
    )
    return c.json<ChatThreadList>({
      threads: await Promise.all(threads.map((thread) => threadView(thread, unread[thread.id]))),
      commands: commands(),
      groups: Object.keys(deps.config.groups).filter((group) =>
        canSeeThread(deps.config, principal, { group }),
      ),
    })
  })

  app.post('/chat/threads', async (c) => {
    const principal = caller(c)
    const input = await readBody(c, threadSchema)
    const repo = parseRepo(input.repo)
    if (repo && !deps.config.forges[repo.forge])
      throw new HTTPException(400, { message: `forge ${repo.forge} is not configured` })
    if (input.group && !deps.config.groups[input.group])
      throw new HTTPException(400, { message: `group ${input.group} is not configured` })
    const scope = {
      ...(input.repo && { repo: input.repo }),
      ...(input.group && { group: input.group }),
    }
    if (!canSeeThread(deps.config, principal, scope))
      throw new HTTPException(403, { message: 'missing permission repos:read' })
    const thread = await chat.createThread({
      id: crypto.randomUUID(),
      title: input.title,
      ...scope,
      createdBy: principal.id,
      createdAt: deps.now().toISOString(),
      autoReply: input.autoReply ?? false,
      participants: [principal.id],
    })
    c.set('audit', {
      action: 'chat.thread.create',
      target: { type: 'chat', id: thread.id },
      details: { title: thread.title },
    })
    return c.json<ChatThreadView>(await threadView(thread), 201)
  })

  app.get('/chat/threads/:id', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    return c.json<ChatThreadView>(await threadView(thread, await unreadOf(principal, thread)))
  })

  app.patch('/chat/threads/:id', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    const input = await readBody(c, patchSchema)
    const updated = await chat.updateThread(thread.id, {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.archived !== undefined && { archived: input.archived }),
      ...(input.autoReply !== undefined && { autoReply: input.autoReply }),
    })
    if (!updated) throw new HTTPException(404, { message: 'thread not found' })
    c.set('audit', {
      action: 'chat.thread.update',
      target: { type: 'chat', id: thread.id },
      details: { ...input },
    })
    return c.json<ChatThreadView>(await threadView(updated, await unreadOf(principal, updated)))
  })

  app.get('/chat/threads/:id/people', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    const users = (await deps.store.users.listUsers()).filter(
      (user) => !user.disabled && canSeeThread(deps.config, userPrincipal(user), thread),
    )
    return c.json<ChatPeopleView>({
      people: users
        .map((user) => ({
          id: user.id,
          handle: handleOf(user),
          name: user.name,
          avatarUrl: avatarUrl(user.avatarSeed ?? user.id),
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    })
  })

  app.get('/chat/threads/:id/messages', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    const serverTime = new Date(deps.now().getTime() - CHANGE_MARGIN_MS).toISOString()
    const before = cursor(c.req.query('before'), 'before')
    const after = cursor(c.req.query('after'), 'after')
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200)
    const changedSince = c.req.query('changedSince')
    const messages = await chat.listMessages(thread.id, {
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
      ...(changedSince && { changedSince }),
      limit,
    })
    const first = messages[0]
    const nextAfter =
      after === undefined
        ? (messages.at(-1)?.seq ?? 0)
        : (messages
            .filter((message) => message.seq > after)
            .slice(0, limit)
            .at(-1)?.seq ?? after)
    const hasMore =
      after === undefined && first !== undefined
        ? (await chat.listMessages(thread.id, { before: first.seq, limit: 1 })).length > 0
        : false
    return c.json<ChatMessageList>({
      thread: await threadView(thread, await unreadOf(principal, thread)),
      messages: messages.map((message) => messageView(thread, message)),
      hasMore,
      cursor: nextAfter,
      serverTime,
    })
  })

  app.post('/chat/threads/:id/messages', async (c) => {
    const principal = caller(c)
    let thread = await visibleThread(principal, c.req.param('id'))
    if (thread.archived) throw new HTTPException(409, { message: 'the thread is archived' })
    const input = await readBody(c, postSchema)
    const repoText = input.repo ?? thread.repo
    if (input.body.startsWith('/') && !thread.repo && !thread.group)
      throw new HTTPException(400, { message: TEAM_COMMANDS_REFUSED })
    if (input.body.startsWith('/') && repoText && !insideThread(thread, repoText))
      throw new HTTPException(400, { message: `${repoText} is outside this thread` })
    const mentions = parseMentions(input.body)
    const mentioned = (await deps.store.users.listUsers())
      .filter(
        (user) =>
          !user.disabled &&
          mentions.some((mention) => mentionKeys(user).includes(mention)) &&
          canSeeThread(deps.config, userPrincipal(user), thread),
      )
      .map((user) => user.id)
    const joining = [principal.id, ...mentioned].filter((id) => !thread.participants.includes(id))
    const poster = personOf(principal)
    const known = thread.people?.find((person) => person.id === principal.id)
    const changed = known?.name !== poster.name || known?.email !== poster.email
    if (joining.length > 0 || changed)
      thread =
        (await chat.updateThread(thread.id, {
          ...(joining.length > 0 && { addParticipants: joining }),
          ...(changed && { rememberPeople: [poster] }),
        })) ?? thread
    const message = await chat.addMessage({
      id: crypto.randomUUID(),
      threadId: thread.id,
      authorType: 'human',
      authorId: principal.id,
      body: input.body,
      mentions,
      createdAt: deps.now().toISOString(),
    })
    await chat.markRead(thread.id, principal.id, message.id)
    c.set('audit', { action: 'chat.message', target: { type: 'chat', id: thread.id } })

    const server = chatFor(deps)
    let replying = false
    if (input.body.startsWith('/')) {
      const surface = server.surface('web')
      if (!surface) throw new HTTPException(503, { message: 'the panel chat is not available' })
      const repo = parseRepo(repoText)
      const router = server.router([], { principal })
      const line = router.parse(input.body) ?? router.parse(input.body.slice(1), true)
      await router.handle(
        {
          surface: surface.id,
          thread: { thread: thread.id, ...(repoText && { repo: repoText }) },
          actor: { provider: `panel:${principal.provider}`, externalId: principal.id },
          text: input.body,
          ...(repo && { repo }),
        },
        surface,
        line,
      )
    } else if (mentionsAgent(mentions) || thread.autoReply) {
      server.replies.trigger(thread.id, principal)
      replying = true
    }
    return c.json<ChatPostResult>({ message: messageView(thread, message), replying })
  })

  app.post('/chat/threads/:id/read', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    const input = await readBody(c, readSchema)
    await chat.markRead(thread.id, principal.id, input.messageId)
    return c.body(null, 204)
  })

  app.get('/chat/unread', async (c) => {
    const principal = caller(c)
    const threads = (await chat.listThreads()).filter((thread) =>
      canSeeThread(deps.config, principal, thread),
    )
    const counts = await chat.unreadCounts(
      principal.id,
      threads.map((thread) => thread.id),
    )
    return c.json<ChatUnreadView>({
      threads: counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    })
  })

  app.get('/chat/messages/:id/transcript', async (c) => {
    const principal = caller(c)
    const message = await chat.getMessage(c.req.param('id'))
    const thread = message && (await chat.getThread(message.threadId))
    const visible = thread && canSeeThread(deps.config, principal, thread)
    const ref = visible && message.authorType === 'agent' ? message.transcriptRef : undefined
    const lines = ref && deps.artifacts ? await readTranscript(deps.artifacts, ref) : undefined
    if (!ref || !lines) throw new HTTPException(404, { message: 'transcript not found' })
    return c.json<AgentTranscriptView>({ ref, lines })
  })

  return app
}
