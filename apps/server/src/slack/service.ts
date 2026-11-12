import { randomUUID } from 'node:crypto'

import type { RepoRef } from '@holtkeeper/forge'
import { resolveSlackReviewChannels, slackReviews } from '@holtkeeper/settings'
import type { SlackMessageLink, SlackMessageStore, SlackReviewStatus } from '@holtkeeper/store'

import { type ServerDeps, repoKey, repoTarget } from '../context.ts'
import { commentsOffFor } from '../mr-comments.ts'
import {
  type MergeRequestStatusSink,
  type MergeRequestTarget,
  reviewTargetOf,
} from '../mr-status.ts'
import { type SlackApi, type SlackPoster, slackWebApi, slackWebPoster } from './client.ts'
import { type SlackConnection, slackConnection } from './connection.ts'
import { type SlackEmojiChoice, slackEmojiCatalog } from './emoji.ts'
import { type MergeRequestLink, mergeRequestLinks } from './links.ts'
import { latestReview, reviewStatusOf, statusListText, worstStatus } from './status.ts'

/** How long a Slack message keeps following its merge requests. */
const SLACK_RETENTION_DAYS = 30

const LOCK_TTL_SECONDS = 120
const LOCK_POLL_MS = 200
const LOCK_WAIT_MS = 60_000

/** Slack errors meaning the message can no longer carry a reaction from the bot. */
const TRACKED_SEPARATOR = '|'

/**
 * The emoji a stored reaction stands for. Before an add, both the custom emoji and its fallback
 * are recorded, so an add that succeeded but was never confirmed is still removed next time.
 */
const trackedNames = (reaction: string | undefined) =>
  reaction ? reaction.split(TRACKED_SEPARATOR).filter(Boolean) : []

const goneErrors = new Set(['message_not_found', 'channel_not_found', 'not_in_channel'])

/** Slack errors meaning the bot token cannot post: the app lacks `chat:write`. */
const scopeErrors = ['missing_scope', 'not_allowed_token_type']

const isScopeError = (error: string | undefined) => !!error && scopeErrors.includes(error)

/** A Slack message to look at for merge request links. */
export interface SlackMessage {
  channel: string
  ts: string
  text: string
  /** The text before an edit: links it already had are not handled again. */
  previousText?: string
}

/** The Slack review status: reads messages, and follows the merge requests they link. */
export interface SlackReviews extends MergeRequestStatusSink {
  /**
   * Starts following the merge requests a message links, where the gates allow it, and puts the
   * emoji of their current status on the message at once.
   */
  handleMessage(message: SlackMessage): Promise<void>
  /** Stops following a message that was deleted in Slack. */
  forgetMessage(channel: string, ts: string): Promise<void>
}

/** GitLab paths are case-insensitive, so links are keyed by the lowercased `forge:path`. */
const slackRepoKey = (repo: RepoRef) => repoKey(repo).toLowerCase()

const linkKey = (link: MergeRequestLink) => `${slackRepoKey(link.repo)}!${link.mergeRequest}`

/**
 * Merge requests of the given forges that a message links and that it did not link before an
 * edit (`previousText`), each once.
 */
export function newMergeRequestLinks(
  message: SlackMessage,
  forges: Readonly<Record<string, { url: string }>>,
): MergeRequestLink[] {
  const seen = new Set(mergeRequestLinks(message.previousText ?? '', forges).map(linkKey))
  return mergeRequestLinks(message.text, forges).filter((link) => !seen.has(linkKey(link)))
}

interface MergeRequestState {
  status?: SlackReviewStatus
  head?: string
  title?: string
}

const withState = (link: SlackMessageLink, state: MergeRequestState, at: string) => {
  const { status: _status, head: _head, ...rest } = link
  return {
    ...rest,
    ...(state.status && { status: state.status }),
    ...(state.head && { head: state.head }),
    ...(state.title && { title: state.title }),
    updatedAt: at,
  } satisfies SlackMessageLink
}

const rowKey = (link: Pick<SlackMessageLink, 'repo' | 'mergeRequest'>) =>
  `${link.repo}!${link.mergeRequest}`

/** The `forge` and `path` of a stored `forge:path` key. */
const repoOfKey = (key: string): RepoRef => {
  const at = key.indexOf(':')
  return { forge: key.slice(0, at), path: key.slice(at + 1) }
}

const repoOfLink = (link: SlackMessageLink): RepoRef => {
  const repo = repoOfKey(link.repo)
  return link.path ? { ...repo, path: link.path } : repo
}

interface SlackClients {
  api: SlackApi
  poster: SlackPoster
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The Slack review status over the server's store, settings and the stored Slack credential.
 * A message is followed only for merge requests of connected repositories (configured forge, in
 * a config group) whose reviews are on (`mergeRequests.comments`) and whose `slack.reviews`
 * channels include the message's channel; everything else is ignored without a trace, and a
 * message whose gate closes later loses its emoji. The message carries one emoji, the worst
 * status of its merge requests. A message following several merge requests also gets one reply
 * in its thread listing each one's status, edited in place as they change and kept (listing
 * what is left) when the set shrinks, and left as it was once none is; without `chat:write` only the reaction is set. Updates of
 * one message, reaction and reply together, are applied one at a time, across processes sharing
 * the store. Statuses without an override show Holtkeeper's custom emoji where the workspace
 * has them and the standard fallback where it does not (learned from `reactions.add`, see
 * `SlackEmojiCatalog`); overrides are used as given. Without a stored Slack credential or a
 * store for messages it does nothing. Nothing here throws: failures are logged.
 */
export function createSlackReviews(
  deps: Pick<ServerDeps, 'config' | 'store' | 'vault' | 'now' | 'slackApi' | 'slackPoster'>,
  options: { log?: (line: string) => void } = {},
): SlackReviews {
  const { config, store } = deps
  const log = options.log ?? ((line: string) => console.error(line))
  const posterLog = (line: string) => {
    if (!scopeErrors.some((error) => line.endsWith(`: ${error}`))) log(line)
  }
  const clientsFor = (connection: SlackConnection): SlackClients => ({
    api: deps.slackApi?.(connection.botToken) ?? slackWebApi({ token: connection.botToken, log }),
    poster:
      deps.slackPoster?.(connection.botToken) ??
      slackWebPoster({ token: connection.botToken, log: posterLog }),
  })

  const catalog = slackEmojiCatalog(deps)
  const invalidLogged = new Set<string>()
  const noteInvalidOverride = (name: string) => {
    if (invalidLogged.has(name)) return
    invalidLogged.add(name)
    log(
      `slack reviews: the workspace has no emoji ${name}; fix the override under Settings › Integrations › Slack`,
    )
  }

  let scopeLogged = false
  const noteFailedPost = (error: string | undefined) => {
    if (!isScopeError(error) || scopeLogged) return
    scopeLogged = true
    log(
      `slack reviews: the app cannot post (${error}); add the chat:write scope and reinstall it to get status replies`,
    )
  }

  const canonical = async (repo: RepoRef): Promise<RepoRef> => {
    const key = slackRepoKey(repo)
    const heads = await store.analyses.latestHeads({ kind: 'review' })
    return heads.find((head) => slackRepoKey(head.repo) === key)?.repo ?? repo
  }

  const channelsOf = async (repo: RepoRef): Promise<string[]> => {
    if (!(repo.forge in config.forges)) return []
    const target = repoTarget(config, repo)
    if (target.groups.length === 0) return []
    if (await commentsOffFor(store, config, repo)) return []
    return resolveSlackReviewChannels(await store.settings.list(slackReviews.key), target)
  }

  const stateOf = async (repo: RepoRef, mergeRequest: number): Promise<MergeRequestState> => {
    const active = await store.jobs.list({ status: ['queued', 'running'], repo, limit: 500 })
    const job = active.find(
      (candidate) => reviewTargetOf(config, candidate)?.mergeRequest === mergeRequest,
    )
    if (job) return { status: 'reviewing', ...(job.ref !== undefined && { head: job.ref }) }
    const review = await latestReview(store.analyses, repo, mergeRequest)
    return review
      ? {
          status: reviewStatusOf(review),
          head: review.head,
          ...(review.mergeRequest.title && { title: review.mergeRequest.title }),
        }
      : {}
  }

  const titleMisses = new Set<string>()
  const titleFromForge = async (link: SlackMessageLink): Promise<string | undefined> => {
    const key = rowKey(link)
    if (titleMisses.has(key)) return undefined
    const repo = repoOfLink(link)
    let title: string | undefined
    try {
      const forge = config.forges[repo.forge]?.create()
      title = (await forge?.getMergeRequest?.(repo.path, link.mergeRequest))?.title || undefined
    } catch (error) {
      log(`slack reviews: title of ${link.repo}!${link.mergeRequest}: ${messageOf(error)}`)
    }
    if (!title) titleMisses.add(key)
    return title
  }

  const mergeRequestUrl = (link: SlackMessageLink) => {
    const repo = repoOfLink(link)
    const base = (config.forges[repo.forge]?.url ?? '').replace(/\/+$/, '')
    return `${base}/${repo.path}/-/merge_requests/${link.mergeRequest}`
  }

  /**
   * Makes the message's status reply list `links`: posts it once two or more are followed and
   * edits it after that, also when fewer are left; with none left it stays as it was. A reply
   * Slack no longer has is posted again. A title the forge could not give is not asked again
   * in this process.
   * Returns the titles it had to look up, keyed by `rowKey`.
   */
  const syncReply = async (
    messages: SlackMessageStore,
    poster: SlackPoster,
    emoji: Readonly<Record<SlackReviewStatus, string>>,
    channel: string,
    ts: string,
    links: readonly SlackMessageLink[],
  ): Promise<Map<string, string>> => {
    const titles = new Map<string, string>()
    const existing = await messages.replyOf(channel, ts)
    if (links.length === 0 || (!existing && links.length < 2)) return titles
    for (const link of links) {
      if (link.title) continue
      // oxlint-disable-next-line no-await-in-loop -- a message links few merge requests
      const title = await titleFromForge(link)
      if (title) titles.set(rowKey(link), title)
    }
    const text = statusListText(
      links.map((link) => {
        const title = link.title ?? titles.get(rowKey(link))
        const label = `${repoOfLink(link).path.split('/').at(-1)}!${link.mergeRequest}`
        return {
          ...(link.status && { status: link.status }),
          url: mergeRequestUrl(link),
          label: title ? `${label} ${title}` : label,
        }
      }),
      emoji,
    )
    if (existing?.text === text) return titles
    const at = deps.now().toISOString()
    if (existing) {
      const updated = await poster.update({ channel, ts: existing.replyTs, text })
      if (updated.ok) {
        await messages.putReply({ ...existing, text, updatedAt: at })
        return titles
      }
      if (updated.error !== 'message_not_found') {
        noteFailedPost(updated.error)
        return titles
      }
    }
    const posted = await poster.post({ channel, threadTs: ts, text })
    if (posted.ok && posted.ts)
      await messages.putReply({
        channel,
        ts,
        replyTs: posted.ts,
        text,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      })
    else noteFailedPost(posted.error)
    return titles
  }

  const chains = new Map<string, Promise<void>>()

  const leased = async (key: string, work: () => Promise<void>) => {
    const kv = store.kv
    if (!kv?.acquireLease || !kv.releaseLease) return work()
    const leaseKey = `slack:message:${key}`
    const holder = randomUUID()
    for (let waited = 0; ; waited += LOCK_POLL_MS) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the holder to finish
      const lease = await kv.acquireLease(leaseKey, holder, LOCK_TTL_SECONDS)
      if (lease.holder === holder) break
      if (waited >= LOCK_WAIT_MS) throw new Error(`message ${key} stayed busy`)
      // oxlint-disable-next-line no-await-in-loop -- see above
      await Bun.sleep(LOCK_POLL_MS)
    }
    try {
      await work()
    } finally {
      await kv.releaseLease(leaseKey, holder)
    }
  }

  const locked = (channel: string, ts: string, work: () => Promise<void>) => {
    const key = `${channel}/${ts}`
    const run = (chains.get(key) ?? Promise.resolve()).then(() => leased(key, work))
    const tail = run.catch(() => undefined)
    chains.set(key, tail)
    void tail.finally(() => {
      if (chains.get(key) === tail) chains.delete(key)
    })
    return run
  }

  /**
   * Adds the emoji `choice` names, its standard fallback when the workspace lacks that default
   * custom one. Resolves with the emoji added (none when the add failed), or `gone` for a message Slack no
   * longer has.
   */
  const addStatusReaction = async (
    api: SlackApi,
    connection: SlackConnection,
    channel: string,
    ts: string,
    choice: SlackEmojiChoice,
  ): Promise<{ gone: true } | { name?: string }> => {
    let name = choice.name
    let added = await api.addReaction({ channel, ts, name })
    if (added.error === 'invalid_name') {
      if (!choice.fallback) noteInvalidOverride(name)
      else {
        await catalog.remember(connection, name, false)
        name = choice.fallback
        added = await api.addReaction({ channel, ts, name })
      }
    } else if (added.ok && choice.fallback && choice.known === undefined)
      await catalog.remember(connection, name, true)
    if (added.error && goneErrors.has(added.error)) return { gone: true }
    return added.ok ? { name } : {}
  }

  /**
   * Applies `change` to a message's links and makes its reaction and status reply match them,
   * under the message's lock. A failed remove keeps the old emoji tracked and adds nothing, so
   * the next update retries the swap; a message Slack no longer has is forgotten. The emoji
   * tracked is the one actually added; a fallback already shown is kept while the workspace is
   * not known to have the custom emoji.
   */
  const settle = (
    { api, poster }: SlackClients,
    connection: SlackConnection,
    channel: string,
    ts: string,
    change: (links: SlackMessageLink[]) => Promise<void>,
  ) =>
    locked(channel, ts, async () => {
      const messages = store.slackMessages
      if (!messages) return
      const before = await messages.ofMessage(channel, ts)
      const current = before.find((link) => link.reaction)?.reaction
      await change(before)
      const links = await messages.ofMessage(channel, ts)
      const worst = worstStatus(links.map((link) => link.status))
      const choice = worst ? await catalog.choose(connection, worst) : undefined
      const keptFallback =
        current !== undefined && choice?.known !== true && choice?.fallback === current
      let shown = current
      if (choice?.name !== current && !keptFallback) {
        let removed: Awaited<ReturnType<SlackApi['removeReaction']>> | undefined
        for (const name of trackedNames(current)) {
          // oxlint-disable-next-line no-await-in-loop -- at most two names, removed in order
          removed = await api.removeReaction({ channel, ts, name })
          if (!removed.ok) break
        }
        if (removed?.error && goneErrors.has(removed.error)) {
          await messages.delete(channel, ts)
          return
        }
        if (!removed || removed.ok) {
          const intended = choice
            ? [choice.name, choice.fallback].filter(Boolean).join(TRACKED_SEPARATOR)
            : undefined
          if (intended)
            await Promise.all(links.map((link) => messages.put({ ...link, reaction: intended })))
          const added = choice ? await addStatusReaction(api, connection, channel, ts, choice) : {}
          if ('gone' in added) {
            await messages.delete(channel, ts)
            return
          }
          shown = added.name ?? intended
        }
      }
      const emoji = await catalog.textEmoji(connection)
      const titles = await syncReply(messages, poster, emoji, channel, ts, links)
      await Promise.all(
        links
          .filter((link) => link.reaction !== shown || titles.has(rowKey(link)))
          .map(({ reaction: _reaction, ...link }) => {
            const title = titles.get(rowKey(link))
            return messages.put({
              ...link,
              ...(shown && { reaction: shown }),
              ...(title && { title }),
            })
          }),
      )
    })

  const guarded = async (label: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      log(`slack reviews: ${label}: ${messageOf(error)}`)
    }
  }

  return {
    handleMessage: (message) =>
      guarded(`message ${message.channel}/${message.ts}`, async () => {
        const messages = store.slackMessages
        if (!messages) return
        const found = newMergeRequestLinks(message, config.forges)
        if (found.length === 0) return
        const connection = await slackConnection(deps)
        if (!connection) return
        const followed: MergeRequestTarget[] = []
        for (const link of found) {
          // oxlint-disable-next-line no-await-in-loop -- a message links few merge requests
          const repo = await canonical(link.repo)
          // oxlint-disable-next-line no-await-in-loop -- see above
          const channels = await channelsOf(repo)
          if (channels.includes(message.channel))
            followed.push({ repo, mergeRequest: link.mergeRequest })
        }
        if (followed.length === 0) return
        await settle(
          clientsFor(connection),
          connection,
          message.channel,
          message.ts,
          async (existing) => {
            const at = deps.now().toISOString()
            for (const { repo, mergeRequest } of followed) {
              // oxlint-disable-next-line no-await-in-loop -- see above
              const state = await stateOf(repo, mergeRequest)
              const key = slackRepoKey(repo)
              const before = existing.find(
                (entry) => entry.repo === key && entry.mergeRequest === mergeRequest,
              )
              // oxlint-disable-next-line no-await-in-loop -- see above
              await messages.put(
                withState(
                  {
                    channel: message.channel,
                    ts: message.ts,
                    repo: key,
                    path: repo.path,
                    mergeRequest,
                    ...(before?.reaction && { reaction: before.reaction }),
                    ...(before?.title && { title: before.title }),
                    createdAt: before?.createdAt ?? at,
                    updatedAt: at,
                  },
                  state,
                  at,
                ),
              )
            }
          },
        )
        const cutoff = new Date(deps.now().getTime() - SLACK_RETENTION_DAYS * 86_400_000)
        await messages.prune(cutoff.toISOString())
      }),

    forgetMessage: (channel, ts) =>
      guarded(`deleted message ${channel}/${ts}`, async () => {
        const messages = store.slackMessages
        if (!messages) return
        await locked(channel, ts, async () => {
          await messages.delete(channel, ts)
        })
      }),

    reviewChanged: (target: MergeRequestTarget) =>
      guarded(`${repoKey(target.repo)}!${target.mergeRequest}`, async () => {
        const messages = store.slackMessages
        if (!messages) return
        const key = slackRepoKey(target.repo)
        const { mergeRequest } = target
        const tracked = await messages.ofMergeRequest(key, mergeRequest)
        if (tracked.length === 0) return
        const connection = await slackConnection(deps)
        if (!connection) return
        const channels = await channelsOf(target.repo)
        const clients = clientsFor(connection)
        for (const { channel, ts } of tracked) {
          // oxlint-disable-next-line no-await-in-loop -- one message at a time keeps reactions in order
          await settle(clients, connection, channel, ts, async (links) => {
            const link = links.find(
              (entry) => entry.repo === key && entry.mergeRequest === mergeRequest,
            )
            if (!link) return
            if (!channels.includes(channel)) {
              await messages.delete(channel, ts, { repo: key, mergeRequest })
              return
            }
            const state = await stateOf(target.repo, mergeRequest)
            await messages.put(
              withState({ ...link, path: target.repo.path }, state, deps.now().toISOString()),
            )
          })
        }
      }),
  }
}
