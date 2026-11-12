import { createHash } from 'node:crypto'

import type { SlackReviewStatus, Store } from '@holtkeeper/store'

import { type SlackConnection, defaultSlackEmoji, fallbackSlackEmoji } from './connection.ts'

/** How long what a workspace has (or lacks) of Holtkeeper's custom emoji is trusted. */
const SLACK_EMOJI_KNOWN_SECONDS = 6 * 60 * 60

/** The emoji a status tries first, and the standard one to use when the workspace lacks it. */
export interface SlackEmojiChoice {
  name: string
  /** Set only for a default custom emoji whose presence is not known to be missing. */
  fallback?: string
  /** Whether the workspace has `name`; `undefined` while nobody tried it within the TTL. */
  known?: boolean
}

/**
 * Which of Holtkeeper's default custom emoji a Slack workspace has, learned from
 * `reactions.add` answers and kept per process and in `store.kv` (shared by all processes) for
 * `SLACK_EMOJI_KNOWN_SECONDS`, so a set uploaded later is picked up after that.
 */
export interface SlackEmojiCatalog {
  /**
   * The emoji a reaction for `status` should be: an override as given; otherwise the default
   * custom emoji with its standard fallback, or the fallback alone when the workspace is known to
   * lack the custom one.
   */
  choose(connection: SlackConnection, status: SlackReviewStatus): Promise<SlackEmojiChoice>
  /** Records whether the workspace has the custom emoji `name`. */
  remember(connection: SlackConnection, name: string, present: boolean): Promise<void>
  /**
   * The emoji every status shows in text: overrides as given; a default custom emoji when the
   * workspace is known to have it, or when its presence is unknown and another default custom
   * emoji is known present; the standard fallback otherwise.
   */
  textEmoji(connection: SlackConnection): Promise<Record<SlackReviewStatus, string>>
}

const statuses = [
  'reviewing',
  'clean',
  'minor',
  'changes',
  'skipped',
] as const satisfies readonly SlackReviewStatus[]

const workspaceOf = (connection: SlackConnection) =>
  createHash('sha256').update(connection.botToken).digest('hex').slice(0, 16)

const keyOf = (connection: SlackConnection, name: string) =>
  `chat:slack:emoji:${workspaceOf(connection)}:${name}`

/** `SlackEmojiCatalog` over the store's `kv`; without one it only remembers per process. */
export function slackEmojiCatalog(deps: {
  store: Pick<Store, 'kv'>
  now: () => Date
}): SlackEmojiCatalog {
  const memory = new Map<string, { present: boolean; until: number }>()
  const known = async (connection: SlackConnection, name: string): Promise<boolean | undefined> => {
    const key = keyOf(connection, name)
    const now = deps.now().getTime()
    const cached = memory.get(key)
    if (cached && cached.until > now) return cached.present
    const stored = await deps.store.kv?.get(key)
    if (typeof stored !== 'object' || stored === null || !('present' in stored)) return undefined
    const until = 'until' in stored && typeof stored.until === 'number' ? stored.until : undefined
    if (until !== undefined && until <= now) return undefined
    const present = stored.present === true
    memory.set(key, { present, until: until ?? now + SLACK_EMOJI_KNOWN_SECONDS * 1000 })
    return present
  }

  const remember = async (connection: SlackConnection, name: string, present: boolean) => {
    const key = keyOf(connection, name)
    const until = deps.now().getTime() + SLACK_EMOJI_KNOWN_SECONDS * 1000
    memory.set(key, { present, until })
    await deps.store.kv?.set(key, { present, until }, SLACK_EMOJI_KNOWN_SECONDS)
  }

  const choose = async (
    connection: SlackConnection,
    status: SlackReviewStatus,
  ): Promise<SlackEmojiChoice> => {
    const override = connection.overrides[status]
    if (override) return { name: override }
    const name = defaultSlackEmoji[status]
    const fallback = fallbackSlackEmoji[status]
    const present = await known(connection, name)
    if (present === false) return { name: fallback }
    return present ? { name, fallback, known: true } : { name, fallback }
  }

  const textEmoji = async (connection: SlackConnection) => {
    const presence = new Map(
      await Promise.all(
        statuses.map(
          async (status) => [status, await known(connection, defaultSlackEmoji[status])] as const,
        ),
      ),
    )
    const setPresent = [...presence.values()].includes(true)
    const pick = (status: SlackReviewStatus) => {
      const override = connection.overrides[status]
      if (override) return override
      const present = presence.get(status) ?? setPresent
      return present ? defaultSlackEmoji[status] : fallbackSlackEmoji[status]
    }
    return {
      reviewing: pick('reviewing'),
      clean: pick('clean'),
      minor: pick('minor'),
      changes: pick('changes'),
      skipped: pick('skipped'),
    }
  }

  return { choose, remember, textEmoji }
}
