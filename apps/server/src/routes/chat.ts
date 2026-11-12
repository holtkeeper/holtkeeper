import { type Principal, can, groupLineage } from '@holtkeeper/access'
import type {
  AgentTranscriptView,
  ChatCommandView,
  ChatMessageList,
  ChatMessageView,
  ChatPeopleView,
  ChatPostResult,
  ChatThreadContextView,
  ChatThreadList,
  ChatThreadView,
  ChatUnreadView,
} from '@holtkeeper/api'
import { type Card, type CardBlock, renderMarkdown } from '@holtkeeper/chat'
import type {
  ChatMessage,
  ChatMessageRef,
  ChatPerson,
  ChatThread,
  ChatThreadContext,
  User,
} from '@holtkeeper/store'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { mentionsAgent, parseMentions, participantLabels, uniqueRefs } from '../chat-prompt.ts'
import {
  STALE_REPLY_MS,
  bodyRefs,
  canReadRepo,
  canSeeThread,
  hasChatAccess,
} from '../chat-threads.ts'
import { PLACEHOLDER_TITLE, chatTitles } from '../chat-titles.ts'
import { chatFor } from '../chat.ts'
import {
  type AppContext,
  type Env,
  type ServerDeps,
  groupLabeler,
  parseRepo,
  principalOf,
  readBody,
  repoTarget,
  ForbiddenException,
} from '../context.ts'
import { plural } from '../text.ts'
import { readTranscript } from '../transcripts.ts'
import { canReadAiScope } from './ai.ts'
import { avatarUrl } from './avatars.ts'

const repoField = z.string().regex(/^[^:]+:.+$/, 'must look like <forge>:<path>')
const repoKey = repoField.optional()

/** Repositories one thread may carry as context. */
const MAX_CONTEXT_REPOS = 20

const contextReposSchema = z.array(repoField).max(MAX_CONTEXT_REPOS).optional()

const threadSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    repo: repoKey,
    group: z.string().min(1).optional(),
    autoReply: z.boolean().optional(),
    contextRepos: contextReposSchema,
  })
  .refine((input) => !(input.repo && input.group), 'give repo or group, not both')

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
    autoReply: z.boolean().optional(),
    contextRepos: contextReposSchema,
    muted: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'nothing to change')

/** Messages read per page while exporting a thread. */
const EXPORT_PAGE = 500

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
  if (!hasChatAccess(principal)) throw new ForbiddenException('repos:read')
  return principal
}

/** What the viewer may see of a message: refs whose `repo` they may read, cost with `ai:read`. */
interface MessageSight {
  readable: (repo: string) => boolean
  cost: boolean
}

const visibleRefs = (refs: readonly ChatMessageRef[], readable: (repo: string) => boolean) =>
  refs.filter((ref) => !('repo' in ref) || ref.repo === undefined || readable(ref.repo))

const HIDDEN_TASK = 'A change in repositories you cannot see.'

/**
 * `card` without what task blocks say about repositories the viewer may not read: their steps
 * (with job errors) and merge requests go, and a block with no readable repository becomes a
 * neutral line. Cards without such repositories come back as they are.
 */
function visibleCard(card: Card, readable: (repo: string) => boolean): Card {
  let changed = false
  const repos: string[] = []
  const blocks = card.blocks.map((block): CardBlock => {
    if (block.type !== 'task') return block
    const seen = block.repos.filter(readable)
    repos.push(...seen)
    if (seen.length === block.repos.length) return block
    changed = true
    if (!seen.length) return { type: 'text', text: HIDDEN_TASK }
    const steps = block.steps?.filter((step) => readable(step.label))
    const mergeRequests = block.mergeRequests?.filter((mr) => readable(mr.repo))
    return {
      type: 'task',
      repos: seen,
      summary: block.summary,
      status: block.status,
      ...(block.groupId && { groupId: block.groupId }),
      ...(block.budgetUsd !== undefined && { budgetUsd: block.budgetUsd }),
      ...(steps?.length && { steps }),
      ...(mergeRequests?.length && { mergeRequests }),
    }
  })
  if (!changed) return card
  return {
    ...(card.title && { title: card.title }),
    ...(repos.length && { subtitle: repos.join(', ') }),
    ...(card.tone && { tone: card.tone }),
    ...(card.url && { url: card.url }),
    blocks,
  }
}

const messageView = (
  thread: ChatThread,
  message: ChatMessage,
  sight: MessageSight,
): ChatMessageView => {
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
    ...(message.card && { card: visibleCard(message.card, sight.readable) }),
    ...(message.toolTrace && { toolTrace: message.toolTrace }),
    ...(sight.cost && message.costUsd !== undefined && { costUsd: message.costUsd }),
    ...(message.transcriptRef !== undefined && { transcriptRef: message.transcriptRef }),
    mentions: message.mentions,
    refs: visibleRefs(message.refs, sight.readable),
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

const exportName = (title: string) =>
  `${
    title
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .slice(0, 60) || 'thread'
  }.md`

const exportTime = (at: string) => `${at.slice(0, 16).replace('T', ' ')} UTC`

/**
 * A thread as Markdown for people: title, scope and export time, then every message under its
 * author's name and participant label and its time, cards rendered as in merge request notes.
 */
function exportMarkdown(
  thread: ChatThread,
  messages: readonly ChatMessage[],
  people: readonly { id: string; label: string; name?: string }[],
  now: Date,
  readable: (repo: string) => boolean,
  groupLabel: (key: string) => string,
): string {
  const scope = thread.repo ?? (thread.group ? `group ${groupLabel(thread.group)}` : 'whole team')
  const authorOf = (message: ChatMessage) => {
    if (message.authorType === 'agent') return 'Holtkeeper'
    if (message.authorType === 'system') return 'Holtkeeper (system)'
    const person = people.find((entry) => entry.id === message.authorId)
    if (!person) return 'Someone'
    return person.name ? `${person.name} (${person.label})` : person.label
  }
  return `${[
    `# ${thread.title}`,
    `Thread about ${scope} · ${plural(messages.length, 'message')} · exported ${exportTime(now.toISOString())}`,
    ...messages.map((message) =>
      [
        `---\n\n**${authorOf(message)}** · ${exportTime(message.createdAt)}`,
        ...(message.body ? [message.body] : []),
        ...(message.card ? [renderMarkdown(visibleCard(message.card, readable))] : []),
      ].join('\n\n'),
    ),
  ].join('\n\n')}\n`
}

/**
 * The team chat. Every endpoint needs a signed-in caller and answers 404 for threads it cannot see
 * (`canSeeThread`): repository and group threads need `repos:read` there, unscoped threads chat
 * access (`repos:read` anywhere). Context repositories, message refs and task card entries of
 * repositories the caller may not read are left out; costs show only with `ai:read` (or `ai:admin`) on the thread's scope
 * (its repository, its group, everything for team-wide threads).
 *
 * - `GET /chat/threads?archived=true&q=` — visible threads with unread and message counts, the
 *   archived count, and the commands.
 * - `POST /chat/threads` `{ title?, repo?, group?, autoReply?, contextRepos? }` — a new thread;
 *   without a title (or a blank one) it is named from its first message (`chatTitles`).
 * - `GET /chat/threads/:id` and `PATCH /chat/threads/:id`
 *   `{ title?, archived?, autoReply?, contextRepos?, muted? }`; `muted` is the caller's own.
 * - `GET /chat/threads/:id/context` — totals of the whole thread for its context column.
 * - `GET /chat/threads/:id/export` — the thread as a Markdown download.
 * - `GET /chat/threads/:id/people` — enabled `users` accounts that can see the thread, to mention.
 * - `GET /chat/threads/:id/messages?before=&after=&changedSince=&limit=` — a page of messages.
 * - `POST /chat/threads/:id/messages` `{ body, repo? }` — a message; `/command` runs a command
 *   about `repo` (400 when it lies outside a repository or group thread's scope, and always in
 *   team-wide threads),
 *   `@holtkeeper` (or `autoReply`) starts an agent reply in the background.
 * - `POST /chat/threads/:id/read` `{ messageId }` and `GET /chat/unread` (muted threads left out).
 * - `GET /chat/messages/:id/transcript` — the transcript of an agent reply in a visible thread.
 *
 * The page polls the messages with `after` and `changedSince` every few seconds.
 */
export function chatRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()
  const chat = deps.store.chat
  const titles = chatTitles(deps)

  const visibleThread = async (principal: Principal, id: string): Promise<ChatThread> => {
    const thread = await chat.getThread(id)
    if (!thread || !canSeeThread(deps.config, principal, thread))
      throw new HTTPException(404, { message: 'thread not found' })
    return thread
  }

  const readable = (principal: Principal) => (repo: string) =>
    canReadRepo(deps.config, principal, repo)

  const canSeeCost = (principal: Principal, thread: Pick<ChatThread, 'repo' | 'group'>) => {
    const repo = parseRepo(thread.repo)
    if (repo) {
      const target = { kind: 'repo' as const, repo: repoTarget(deps.config, repo) }
      return can(principal, 'ai:read', target) || can(principal, 'ai:admin', target)
    }
    return canReadAiScope(principal, thread.group ? { groups: [thread.group] } : { all: true })
  }

  const sightOf = (principal: Principal, thread: ChatThread): MessageSight => ({
    readable: readable(principal),
    cost: canSeeCost(principal, thread),
  })

  /** The caller's readable repositories of `given`; 400 for unknown forges, 403 for others. */
  const checkedRepos = (principal: Principal, given: readonly string[]) => {
    for (const text of given) {
      const repo = parseRepo(text)
      if (!repo || !deps.config.forges[repo.forge])
        throw new HTTPException(400, { message: `${text} is not a configured repository` })
      if (!canReadRepo(deps.config, principal, text))
        throw new ForbiddenException('repos:read', text)
    }
    return [...new Set(given)]
  }

  const contextOf = async (thread: ChatThread): Promise<ChatThreadContext> =>
    (await chat.context(thread.id)) ?? {
      messageCount: 0,
      costUsd: 0,
      repos: [...thread.contextRepos],
      tools: [],
      participants: [],
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
    return thread.group ? groupLineage(thread.group) : []
  }

  const threadView = async (
    principal: Principal,
    thread: ChatThread,
    extra: { unread?: number; muted?: boolean; messageCount?: number } = {},
  ): Promise<ChatThreadView> => ({
    id: thread.id,
    title: thread.title,
    ...(thread.titlePending && { titlePending: true }),
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
    unread: extra.unread ?? 0,
    participants: await participantsOf(thread),
    summarized: thread.summary !== undefined,
    messageCount: extra.messageCount ?? 0,
    contextRepos: thread.contextRepos.filter(readable(principal)),
    muted: extra.muted ?? false,
  })

  /** The thread as the caller sees it, with their unread count and mute. */
  const viewFor = async (principal: Principal, thread: ChatThread) => {
    const [unread, muted, counts] = await Promise.all([
      chat.unreadCounts(principal.id, [thread.id]),
      chat.mutedThreads(principal.id),
      chat.messageCounts([thread.id]),
    ])
    return threadView(principal, thread, {
      unread: unread[thread.id] ?? 0,
      muted: muted.includes(thread.id),
      messageCount: counts[thread.id] ?? 0,
    })
  }

  app.get('/chat/threads', async (c) => {
    const principal = caller(c)
    const archived = c.req.query('archived') === 'true'
    const q = c.req.query('q')?.trim().slice(0, 200)
    const visible = (await chat.listThreads({ archived: 'all', ...(q && { q }) })).filter(
      (thread) => canSeeThread(deps.config, principal, thread),
    )
    const threads = visible.filter((thread) => thread.archived === archived)
    const ids = threads.map((thread) => thread.id)
    const [unread, muted, counts] = await Promise.all([
      chat.unreadCounts(principal.id, ids),
      chat.mutedThreads(principal.id),
      chat.messageCounts(ids),
    ])
    return c.json<ChatThreadList>({
      threads: await Promise.all(
        threads.map((thread) =>
          threadView(principal, thread, {
            unread: unread[thread.id] ?? 0,
            muted: muted.includes(thread.id),
            messageCount: counts[thread.id] ?? 0,
          }),
        ),
      ),
      commands: commands(),
      groups: Object.keys(deps.config.groups).filter((group) =>
        canSeeThread(deps.config, principal, { group }),
      ),
      archivedCount: visible.filter((thread) => thread.archived).length,
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
      throw new ForbiddenException('repos:read', input.repo)
    const contextRepos = checkedRepos(principal, input.contextRepos ?? [])
    const thread = await chat.createThread({
      id: crypto.randomUUID(),
      title: input.title || PLACEHOLDER_TITLE,
      ...(!input.title && { titlePending: true }),
      ...scope,
      createdBy: principal.id,
      createdAt: deps.now().toISOString(),
      autoReply: input.autoReply ?? false,
      participants: [principal.id],
      contextRepos,
    })
    c.set('audit', {
      action: 'chat.thread.create',
      target: { type: 'chat', id: thread.id },
      details: { title: thread.title, ...(contextRepos.length && { contextRepos }) },
    })
    return c.json<ChatThreadView>(await threadView(principal, thread), 201)
  })

  app.get('/chat/threads/:id', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    return c.json<ChatThreadView>(await viewFor(principal, thread))
  })

  app.patch('/chat/threads/:id', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    const { muted, ...input } = await readBody(c, patchSchema)
    const given = input.contextRepos && checkedRepos(principal, input.contextRepos)
    const hidden = thread.contextRepos.filter((repo) => !canReadRepo(deps.config, principal, repo))
    if (given && given.length + hidden.length > MAX_CONTEXT_REPOS)
      throw new HTTPException(400, {
        message: `a thread carries at most ${MAX_CONTEXT_REPOS} repositories`,
      })
    const changes = {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.archived !== undefined && { archived: input.archived }),
      ...(input.autoReply !== undefined && { autoReply: input.autoReply }),
      ...(given && { contextRepos: [...given, ...hidden] }),
    }
    const updated =
      Object.keys(changes).length > 0 ? await chat.updateThread(thread.id, changes) : thread
    if (!updated) throw new HTTPException(404, { message: 'thread not found' })
    if (muted !== undefined) await chat.setMuted(thread.id, principal.id, muted)
    if (Object.keys(input).length > 0)
      c.set('audit', {
        action: 'chat.thread.update',
        target: { type: 'chat', id: thread.id },
        details: { ...input, ...(given && { contextRepos: given }) },
      })
    return c.json<ChatThreadView>(await viewFor(principal, updated))
  })

  app.get('/chat/threads/:id/context', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    const context = await contextOf(thread)
    const sees = readable(principal)
    const repos = context.repos.filter(sees)
    const labels = await participantsOf({
      ...thread,
      participants: [
        ...thread.participants,
        ...context.participants
          .map((person) => person.id)
          .filter((id) => !thread.participants.includes(id)),
      ],
    })
    return c.json<ChatThreadContextView>({
      messageCount: context.messageCount,
      ...(canSeeCost(principal, thread) && { costUsd: context.costUsd }),
      repos,
      hiddenRepoCount: context.repos.length - repos.length,
      tools: context.tools,
      participants: context.participants.flatMap((person) => {
        const view = labels.find((entry) => entry.id === person.id)
        return view ? [{ ...view, messages: person.messages }] : []
      }),
    })
  })

  app.get('/chat/threads/:id/export', async (c) => {
    const principal = caller(c)
    const thread = await visibleThread(principal, c.req.param('id'))
    const people = await participantsOf(thread)
    const messages: ChatMessage[] = []
    let after = 0
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- pages follow each other's cursor
      const page = await chat.listMessages(thread.id, { after, limit: EXPORT_PAGE })
      messages.push(...page)
      const last = page.at(-1)
      if (!last || page.length < EXPORT_PAGE) break
      after = last.seq
    }
    const markdown = exportMarkdown(
      thread,
      messages,
      people,
      deps.now(),
      readable(principal),
      groupLabeler(deps.config),
    )
    c.set('audit', { action: 'chat.thread.export', target: { type: 'chat', id: thread.id } })
    return c.body(markdown, 200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${exportName(thread.title)}"`,
    })
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
    const sight = sightOf(principal, thread)
    return c.json<ChatMessageList>({
      thread: await viewFor(principal, thread),
      messages: messages.map((message) => messageView(thread, message, sight)),
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
    const command = input.body.startsWith('/')
    const message = await chat.addMessage({
      id: crypto.randomUUID(),
      threadId: thread.id,
      authorType: 'human',
      authorId: principal.id,
      body: input.body,
      mentions,
      refs: uniqueRefs([
        ...(command && input.repo ? [{ kind: 'repo' as const, repo: input.repo }] : []),
        ...bodyRefs(deps.config, input.body),
      ]),
      createdAt: deps.now().toISOString(),
    })
    await chat.markRead(thread.id, principal.id, message.id)
    c.set('audit', { action: 'chat.message', target: { type: 'chat', id: thread.id } })
    if (!command) titles.nameFrom(thread, principal)

    const server = chatFor(deps)
    let replying = false
    if (command) {
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
    return c.json<ChatPostResult>({
      message: messageView(thread, message, sightOf(principal, thread)),
      replying,
    })
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
    const muted = new Set(await chat.mutedThreads(principal.id))
    const threads = (await chat.listThreads()).filter(
      (thread) => !muted.has(thread.id) && canSeeThread(deps.config, principal, thread),
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
