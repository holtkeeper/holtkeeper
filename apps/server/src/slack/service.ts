import { randomUUID } from 'node:crypto'

import type { Discussion, GitForge, RepoRef } from '@holtkeeper/forge'
import type {
  SlackMergeRequestMark,
  SlackMessageLink,
  SlackMessageStore,
  SlackReviewStatus,
} from '@holtkeeper/store'

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
import {
  type SlackMarksSettings,
  marksOnIn,
  mergeRequestMarks,
  messageMarks,
  slackMarksSettingKey,
  slackMarksSettings,
} from './marks.ts'
import { latestReview, mergeRequestStatusOf, statusListText, worstStatus } from './status.ts'

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
}

/** `link` with `state`, and with `marks` when given (none otherwise). */
const withState = (
  link: SlackMessageLink,
  state: MergeRequestState,
  at: string,
  marks?: SlackMergeRequestMark[],
) => {
  const { status: _status, head: _head, marks: _marks, ...rest } = link
  return {
    ...rest,
    ...(state.status && { status: state.status }),
    ...(state.head && { head: state.head }),
    ...(marks && { marks }),
    updatedAt: at,
  } satisfies SlackMessageLink
}

type MarkEmoji = SlackMarksSettings['emoji']

const sameNames = (a: readonly string[] | undefined, b: readonly string[]) =>
  (a ?? []).join(' ') === b.join(' ')

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
 * A message in any channel the app receives is followed for merge requests of connected
 * repositories (configured forge, in the fleet with an owner team) whose reviews are on
 * (`mergeRequests.comments`); everything else is ignored without a trace, and a message whose
 * gate closes later loses its emoji. The message carries one emoji, the worst
 * status of its merge requests. A message following several merge requests also gets one reply
 * in its thread listing each one's status and `path!iid` (never its title, so nothing beyond the
 * link itself reaches the channel), edited in place as they change and kept (listing
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
  const noteInvalidEmoji = (name: string, where: string) => {
    if (invalidLogged.has(name)) return
    invalidLogged.add(name)
    log(`slack reviews: the workspace has no emoji ${name}; fix ${where}`)
  }
  const noteInvalidOverride = (name: string) =>
    noteInvalidEmoji(name, 'the override under Settings › Integrations › Slack')

  const marksSettings = async (): Promise<SlackMarksSettings> => {
    const entry = (await store.settings.list(slackMarksSettingKey)).find(
      (candidate) => candidate.scope.all === true && !candidate.secret,
    )
    return slackMarksSettings(entry?.value)
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

  /** Whether messages about `repo`'s merge requests get a status: Holtkeeper reviews them. */
  const followed = async (repo: RepoRef): Promise<boolean> => {
    if (!(repo.forge in config.forges)) return false
    if (repoTarget(config, repo).teams.length === 0) return false
    return !(await commentsOffFor(store, config, repo))
  }

  /**
   * The merge request's threads now: none listed when the forge cannot list them, `failed` when
   * listing them failed (logged).
   */
  const threadsOf = async (
    repo: RepoRef,
    mergeRequest: number,
  ): Promise<{ discussions?: Discussion[]; failed?: true }> => {
    const forge = config.forges[repo.forge]?.create()
    if (!forge?.listDiscussions) return {}
    try {
      return { discussions: await forge.listDiscussions(repo.path, mergeRequest) }
    } catch (error) {
      log(`slack reviews: threads of ${repoKey(repo)}!${mergeRequest}: ${messageOf(error)}`)
      return { failed: true }
    }
  }

  /** One merge request whose threads are listed at most once, for its status and its marks. */
  const lookupOf = (repo: RepoRef, mergeRequest: number) => {
    let threads: ReturnType<typeof threadsOf> | undefined
    return { repo, mergeRequest, threads: () => (threads ??= threadsOf(repo, mergeRequest)) }
  }
  type Lookup = ReturnType<typeof lookupOf>

  const selves = new Map<string, Promise<string | undefined>>()
  /** Username of Holtkeeper's account on a forge, asked once per process; `undefined` when unknown. */
  const selfOf = (name: string, forge: GitForge) => {
    let self = selves.get(name)
    if (!self) {
      self = (forge.getCurrentUser?.() ?? Promise.resolve(undefined)).then(
        (user) => user?.username,
        () => {
          selves.delete(name)
          return undefined
        },
      )
      selves.set(name, self)
    }
    return self
  }

  /**
   * `mergeRequestMarks` of a merge request now. When the forge fails to answer, `previous` is
   * kept (logged).
   */
  const marksOf = async (
    { repo, mergeRequest, threads }: Lookup,
    previous?: SlackMergeRequestMark[],
  ): Promise<SlackMergeRequestMark[] | undefined> => {
    const forge = config.forges[repo.forge]?.create()
    if (!forge) return previous
    try {
      const [current, approvedBy, listed, self] = await Promise.all([
        forge.getMergeRequest?.(repo.path, mergeRequest),
        forge.listApprovals?.(repo.path, mergeRequest) ?? [],
        threads(),
        selfOf(repo.forge, forge),
      ])
      if (listed.failed) return previous
      return mergeRequestMarks({
        ...(current && { state: current.state }),
        approvedBy,
        discussions: listed.discussions ?? [],
        ...(self && { self }),
      })
    } catch (error) {
      log(`slack reviews: marks of ${repoKey(repo)}!${mergeRequest}: ${messageOf(error)}`)
      return previous
    }
  }

  /**
   * The status of a merge request now: reviewing while a review job is queued or running, else
   * `mergeRequestStatusOf` its newest review and open threads. When the forge fails to list the
   * threads, a settled `previous` status is kept rather than guessed from the run alone.
   */
  const stateOf = async (
    { repo, mergeRequest, threads: threadsNow }: Lookup,
    previous?: SlackReviewStatus,
  ): Promise<MergeRequestState> => {
    const active = await store.jobs.list({ status: ['queued', 'running'], repo, limit: 500 })
    const job = active.find(
      (candidate) => reviewTargetOf(config, candidate)?.mergeRequest === mergeRequest,
    )
    if (job) return { status: 'reviewing', ...(job.ref !== undefined && { head: job.ref }) }
    const review = await latestReview(store.analyses, repo, mergeRequest)
    if (!review) return {}
    if (review.mode === 'skipped' || review.verdict === 'skipped')
      return { status: mergeRequestStatusOf(review, undefined), head: review.head }
    const threads = await threadsNow()
    if (threads.failed && previous && previous !== 'reviewing')
      return { status: previous, head: review.head }
    return { status: mergeRequestStatusOf(review, threads.discussions), head: review.head }
  }

  const mergeRequestUrl = (link: SlackMessageLink) => {
    const repo = repoOfLink(link)
    const base = (config.forges[repo.forge]?.url ?? '').replace(/\/+$/, '')
    return `${base}/${repo.path}/-/merge_requests/${link.mergeRequest}`
  }

  /**
   * Makes the message's status reply list `links`: posts it once two or more are followed and
   * edits it after that, also when fewer are left; with none left it stays as it was. A reply
   * Slack no longer has is posted again.
   */
  const syncReply = async (
    messages: SlackMessageStore,
    poster: SlackPoster,
    emoji: Readonly<Record<SlackReviewStatus, string>>,
    markEmoji: MarkEmoji | undefined,
    channel: string,
    ts: string,
    links: readonly SlackMessageLink[],
  ): Promise<void> => {
    const existing = await messages.replyOf(channel, ts)
    if (links.length === 0 || (!existing && links.length < 2)) return
    const text = statusListText(
      links.map((link) => ({
        ...(link.status && { status: link.status }),
        url: mergeRequestUrl(link),
        label: `${repoOfLink(link).path}!${link.mergeRequest}`,
        ...(markEmoji && link.marks && { marks: link.marks.map((mark) => markEmoji[mark]) }),
      })),
      emoji,
    )
    if (existing?.text === text) return
    const at = deps.now().toISOString()
    if (existing) {
      const updated = await poster.update({ channel, ts: existing.replyTs, text })
      if (updated.ok) {
        await messages.putReply({ ...existing, text, updatedAt: at })
        return
      }
      if (updated.error !== 'message_not_found') {
        noteFailedPost(updated.error)
        return
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
   * Makes the mark emoji on a message `wanted`, given those `tracked` on it: removes the others,
   * then adds the missing ones. Resolves with the mark emoji on the message afterwards (a failed
   * remove keeps its emoji, a failed add is not tracked so the next update retries it), or `gone`
   * for a message Slack no longer has. `beforeAdd` records the emoji about to be added first, so
   * an add that was never confirmed is still removed later.
   */
  const syncMarkReactions = async (
    api: SlackApi,
    channel: string,
    ts: string,
    tracked: readonly string[],
    wanted: readonly string[],
    beforeAdd: (names: string[]) => Promise<void>,
  ): Promise<{ gone: true } | { names: string[] }> => {
    const names = [...tracked]
    for (const name of tracked.filter((candidate) => !wanted.includes(candidate))) {
      // oxlint-disable-next-line no-await-in-loop -- at most three marks, one call each
      const removed = await api.removeReaction({ channel, ts, name })
      if (removed.error && goneErrors.has(removed.error)) return { gone: true }
      if (removed.ok) names.splice(names.indexOf(name), 1)
    }
    const missing = wanted.filter((name) => !names.includes(name))
    if (missing.length === 0) return { names }
    await beforeAdd([...names, ...missing])
    for (const name of missing) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const added = await api.addReaction({ channel, ts, name })
      if (added.error && goneErrors.has(added.error)) return { gone: true }
      if (added.ok) names.push(name)
      else if (added.error === 'invalid_name')
        noteInvalidEmoji(name, `${slackMarksSettingKey} under Settings › Integrations`)
    }
    return { names }
  }

  /**
   * Applies `change` to a message's links and makes its reaction, its mark emoji and its status
   * reply match them, under the message's lock. A failed remove keeps the old emoji tracked and
   * adds nothing, so the next update retries the swap; a message Slack no longer has is
   * forgotten. The emoji tracked is the one actually added; a fallback already shown is kept while
   * the workspace is not known to have the custom emoji. Without `markEmoji` (marks off for the
   * channel) mark emoji are taken off and the reply shows none.
   */
  const settle = (
    { api, poster }: SlackClients,
    connection: SlackConnection,
    channel: string,
    ts: string,
    markEmoji: MarkEmoji | undefined,
    change: (links: SlackMessageLink[]) => Promise<void>,
  ) =>
    locked(channel, ts, async () => {
      const messages = store.slackMessages
      if (!messages) return
      const before = await messages.ofMessage(channel, ts)
      const current = before.find((link) => link.reaction)?.reaction
      const currentMarks = before.find((link) => link.markReactions)?.markReactions ?? []
      await change(before)
      const stored = await messages.ofMessage(channel, ts)
      const links = stored.map(({ reaction: _reaction, markReactions: _marks, ...link }) => ({
        ...link,
        ...(current && { reaction: current }),
        ...(currentMarks.length > 0 && { markReactions: currentMarks }),
      }))
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
      const statusNames = trackedNames(shown)
      const wanted = markEmoji
        ? messageMarks(links)
            .map((mark) => markEmoji[mark])
            .filter((name) => !statusNames.includes(name))
        : []
      const withReactions = (link: SlackMessageLink, marks: readonly string[]) => {
        const { reaction: _reaction, markReactions: _marks, ...rest } = link
        return {
          ...rest,
          ...(shown && { reaction: shown }),
          ...(marks.length > 0 && { markReactions: [...marks] }),
        }
      }
      const marked = await syncMarkReactions(api, channel, ts, currentMarks, wanted, (names) =>
        Promise.all(links.map((link) => messages.put(withReactions(link, names)))).then(
          () => undefined,
        ),
      )
      if ('gone' in marked) {
        await messages.delete(channel, ts)
        return
      }
      const emoji = await catalog.textEmoji(connection)
      await syncReply(messages, poster, emoji, markEmoji, channel, ts, links)
      const latest = await messages.ofMessage(channel, ts)
      await Promise.all(
        latest
          .filter((link) => link.reaction !== shown || !sameNames(link.markReactions, marked.names))
          .map((link) => messages.put(withReactions(link, marked.names))),
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
        const targets: MergeRequestTarget[] = []
        for (const link of found) {
          // oxlint-disable-next-line no-await-in-loop -- a message links few merge requests
          const repo = await canonical(link.repo)
          // oxlint-disable-next-line no-await-in-loop -- see above
          if (await followed(repo)) targets.push({ repo, mergeRequest: link.mergeRequest })
        }
        if (targets.length === 0) return
        const settings = await marksSettings()
        const markEmoji = marksOnIn(settings, message.channel) ? settings.emoji : undefined
        await settle(
          clientsFor(connection),
          connection,
          message.channel,
          message.ts,
          markEmoji,
          async (existing) => {
            const at = deps.now().toISOString()
            for (const { repo, mergeRequest } of targets) {
              const key = slackRepoKey(repo)
              const before = existing.find(
                (entry) => entry.repo === key && entry.mergeRequest === mergeRequest,
              )
              const lookup = lookupOf(repo, mergeRequest)
              // oxlint-disable-next-line no-await-in-loop -- see above
              const [state, marks] = await Promise.all([
                stateOf(lookup, before?.status),
                markEmoji ? marksOf(lookup, before?.marks) : undefined,
              ])
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
                    createdAt: before?.createdAt ?? at,
                    updatedAt: at,
                  },
                  state,
                  at,
                  marks,
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
        const stillFollowed = await followed(target.repo)
        const clients = clientsFor(connection)
        const settings = await marksSettings()
        // Read once for all messages linking it: state and marks include forge calls.
        const lookup = lookupOf(target.repo, mergeRequest)
        let state: Promise<MergeRequestState> | undefined
        let marks: Promise<SlackMergeRequestMark[] | undefined> | undefined
        for (const { channel, ts } of tracked) {
          const markEmoji = marksOnIn(settings, channel) ? settings.emoji : undefined
          // oxlint-disable-next-line no-await-in-loop -- one message at a time keeps reactions in order
          await settle(clients, connection, channel, ts, markEmoji, async (links) => {
            const link = links.find(
              (entry) => entry.repo === key && entry.mergeRequest === mergeRequest,
            )
            if (!link) return
            if (!stillFollowed) {
              await messages.delete(channel, ts, { repo: key, mergeRequest })
              return
            }
            state ??= stateOf(lookup, link.status)
            if (markEmoji) marks ??= marksOf(lookup, link.marks)
            await messages.put(
              withState(
                { ...link, path: target.repo.path },
                await state,
                deps.now().toISOString(),
                markEmoji ? await marks : undefined,
              ),
            )
          })
        }
      }),
  }
}
