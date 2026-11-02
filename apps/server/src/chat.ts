import { type Action, can, type Principal, type Scope, scopeCoversRepo } from '@holtkeeper/access'
import {
  type ChatCommand,
  type ChatRouter,
  type ChatSurface,
  ChatUserError,
  createChatRouter,
  defineCommand,
  mergeRequestSurface,
  textCard,
} from '@holtkeeper/chat'
import { slackSurface } from '@holtkeeper/chat-slack'
import type { RepoRef } from '@holtkeeper/forge'
import { parseVerifyCommand } from '@holtkeeper/identities'
import type { ReleaseEvent } from '@holtkeeper/release'
import { z } from 'zod'

import { deployCard, type LiveDeploy, releaseCommand } from './chat-release.ts'
import { type WebChatStore, webChatStore, webSurface } from './chat-web.ts'
import { CLAIM_TTL_SECONDS, claimKey } from './claims.ts'
import { type ServerDeps, repoTarget } from './context.ts'
import { releaseServiceFor } from './releases.ts'
import { identitiesFor } from './routes/accounts.ts'
import { slackServiceFor } from './slack.ts'

/** Hidden marker of every chat note, so events skip them and review replies leave them alone. */
export const CHAT_MARKER = 'holtkeeper:chat'

/** How long a deploy card keeps following release events. */
const LIVE_TTL_SECONDS = 3 * 86_400

const repoKeyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`
const liveKey = (repo: RepoRef) => `chat:live-deploys:${repoKeyOf(repo)}`

const liveDeploySchema = z.array(
  z.object({
    posted: z.object({
      surface: z.string(),
      thread: z.record(z.string(), z.union([z.string(), z.number()])),
      id: z.string().optional(),
    }),
    repo: z.object({ forge: z.string(), path: z.string() }),
    tag: z.string(),
  }),
)

/** What one conversation may reach, whoever writes there. */
export interface ChatLimit {
  scope: Scope
  actions: readonly Action[]
}

/** The chat side of a server: surfaces, the router and live cards that follow release events. */
export interface ServerChat {
  /** `merge-requests`, `web` and `slack` (whose posts fail while Slack is not connected). */
  surface(id: string): ChatSurface | undefined
  /** The panel conversations. */
  readonly conversations: WebChatStore
  /**
   * A router with the built-in commands plus `extra` (e.g. commands that queue analyzers). With
   * `principal` (the panel's signed-in person) actions are checked against its grants; otherwise
   * the actor's linked account decides. `limit` narrows both to what a conversation may do, e.g.
   * a connected Slack channel.
   */
  router(
    extra?: readonly ChatCommand<unknown>[],
    options?: { principal?: Principal; limit?: ChatLimit },
  ): ChatRouter
}

function createServerChat(deps: ServerDeps): ServerChat {
  const { config, store } = deps
  const memory = new Map<string, unknown>()
  const kv = store.kv ?? {
    get: async (key: string) => memory.get(key),
    set: async (key: string, value: unknown) => void memory.set(key, value),
    delete: async (key: string) => void memory.delete(key),
  }
  const conversations = webChatStore(kv, deps.now)
  const web = webSurface(conversations)

  const mergeRequests = mergeRequestSurface({
    forgeOf: (forge) => config.forges[forge]?.create(),
    marker: CHAT_MARKER,
  })
  const surface = (id: string): ChatSurface | undefined => {
    if (id === mergeRequests.id) return mergeRequests
    if (id === web.id) return web
    if (id === 'slack') return slackSurface({ client: slackServiceFor(deps).client })
    return undefined
  }

  const pageOf = (repo: RepoRef) => {
    const base = config.server?.publicUrl?.replace(/\/$/, '')
    return base
      ? `${base}/release-board/repo?repo=${encodeURIComponent(repoKeyOf(repo))}`
      : undefined
  }

  const livesOf = async (repo: RepoRef): Promise<LiveDeploy[]> => {
    const parsed = liveDeploySchema.safeParse(await kv.get(liveKey(repo)))
    return parsed.success ? parsed.data : []
  }

  const follow = async (live: LiveDeploy) => {
    const kept = (await livesOf(live.repo)).filter(
      (entry) => entry.posted.id !== live.posted.id || entry.posted.surface !== live.posted.surface,
    )
    await kv.set(liveKey(live.repo), [...kept, live].slice(-20), LIVE_TTL_SECONDS)
  }

  const releases = releaseServiceFor(deps)
  releases.subscribe(async (event: ReleaseEvent) => {
    if (!event.tag || !event.kind.startsWith('deploy-')) return
    const lives = (await livesOf(event.repo)).filter((live) => live.tag === event.tag)
    if (lives.length === 0) return
    const state = await releases.deployOf(event.repo, event.tag)
    const card = deployCard(event.repo, state, pageOf(event.repo))
    for (const live of lives) {
      const target = surface(live.posted.surface)
      if (!target) continue
      try {
        // oxlint-disable-next-line no-await-in-loop -- a handful of cards, one forge
        if (target.update && live.posted.id !== undefined) await target.update(live.posted, card)
        // oxlint-disable-next-line no-await-in-loop -- a handful of cards, one forge
        else await target.post(live.posted.thread, card)
      } catch (error) {
        console.error(
          `chat: updating a deploy card failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  })

  const verify = defineCommand({
    name: 'verify',
    summary: 'Proves you own this account, with the code from Account → Linked accounts.',
    usage: '<code>',
    positional: ['code'],
    options: z.object({ code: z.string().min(1) }),
    async run({ options, message, reply }) {
      const identities = identitiesFor(deps)
      if (!identities) {
        await reply(textCard('', 'This server keeps no linked accounts.', 'warning'))
        return
      }
      const code = parseVerifyCommand(`/holtkeeper verify ${options.code}`)
      const result = code
        ? await identities.completeChallenge({
            provider: message.actor.provider,
            externalId: message.actor.externalId,
            ...(message.actor.username && { username: message.actor.username }),
            code,
          })
        : { ok: false as const, reason: 'wrong-code' }
      await reply(
        result.ok
          ? textCard('', 'Your account is verified.', 'good')
          : textCard('', `Verification failed: ${result.reason}.`, 'warning'),
      )
    },
  })

  const link = defineCommand({
    name: 'link',
    summary: 'Sends you a private link that connects this chat account to your Holtkeeper user.',
    options: z.object({}).loose(),
    async run({ message, reply }) {
      const direct =
        message.surface === 'slack' &&
        typeof message.thread['channel'] === 'string' &&
        message.thread['channel'].startsWith('D')
      if (!direct)
        throw new ChatUserError(
          'Send `link` to me in a direct message in Slack: the link must stay private.',
        )
      const base = config.server?.publicUrl?.replace(/\/$/, '')
      if (!base)
        throw new ChatUserError('This server has no public URL (server.publicUrl) to link from.')
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      const username =
        message.actor.username ??
        (await slackServiceFor(deps)
          .client.user(message.actor.externalId)
          .then((user) => user.name)
          .catch(() => undefined))
      await kv.set(
        claimKey(token),
        {
          provider: message.actor.provider,
          externalId: message.actor.externalId,
          ...(username && { username }),
        },
        CLAIM_TTL_SECONDS,
      )
      await reply({
        title: 'Link your account',
        tone: 'info',
        url: `${base}/accounts/claim?token=${token}`,
        blocks: [
          {
            type: 'text',
            text: 'Open the link below while signed in to Holtkeeper, within 15 minutes. It works once; anyone who opens it links your account to theirs, so keep it to yourself.',
          },
        ],
      })
    },
  })

  const release = releaseCommand({ deps, pageOf, follow })

  const router = (
    extra: readonly ChatCommand<unknown>[] = [],
    options: { principal?: Principal; limit?: ChatLimit } = {},
  ) =>
    createChatRouter({
      commands: [...extra, verify, link, release],
      authorize: async (actor, action, repo) => {
        const { limit } = options
        if (limit) {
          if (!limit.actions.includes(action)) return { allowed: false, reason: 'outside-scope' }
          if (repo && !scopeCoversRepo(limit.scope, repoTarget(config, repo)))
            return { allowed: false, reason: 'outside-scope' }
        }
        const signedIn = options.principal
        if (signedIn)
          return can(
            signedIn,
            action,
            repo ? { kind: 'repo', repo: repoTarget(config, repo) } : { kind: 'global' },
          )
            ? { allowed: true, principal: signedIn }
            : { allowed: false, reason: 'forbidden' }
        const identities = identitiesFor(deps)
        if (!identities) return { allowed: false, reason: 'not-linked' }
        if (repo) {
          const result = await identities.authorizeExternal({
            provider: actor.provider,
            externalId: actor.externalId,
            action,
            repo: repoTarget(config, repo),
          })
          return result.allowed && result.principal
            ? { allowed: true, principal: result.principal }
            : { allowed: false, reason: result.reason }
        }
        const principal = await identities.resolveExternalActor(actor)
        if (!principal) return { allowed: false, reason: 'not-linked' }
        return can(principal, action, { kind: 'global' })
          ? { allowed: true, principal }
          : { allowed: false, reason: 'forbidden' }
      },
      onError: (error) =>
        console.error(
          `chat: command failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })

  return { surface, conversations, router }
}

const chats = new WeakMap<ServerDeps, ServerChat>()

/** The one chat of a server, shared by forge events and the Slack routes. */
export function chatFor(deps: ServerDeps): ServerChat {
  let chat = chats.get(deps)
  if (!chat) {
    chat = createServerChat(deps)
    chats.set(deps, chat)
  }
  return chat
}
