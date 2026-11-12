import type { SlackReviewStatus, Store } from '@holtkeeper/store'
import type { Vault } from '@holtkeeper/vault'
import { z } from 'zod'

/** Where the Slack app's credential is kept in `store.kv`. */
export const SLACK_CONNECTION_KEY = 'chat:slack:connection'

/** Every review status a Slack message can show, from in progress to done. */
const slackReviewStatuses = [
  'reviewing',
  'clean',
  'minor',
  'changes',
  'skipped',
] as const satisfies readonly SlackReviewStatus[]

/**
 * The emoji each status shows when the Slack credential overrides none: Holtkeeper's custom set,
 * which a workspace uploads from the holtkeeper/.github repository (`slack/emoji`).
 */
export const defaultSlackEmoji: Readonly<Record<SlackReviewStatus, string>> = {
  reviewing: 'hk-reviewing',
  clean: 'hk-clean',
  minor: 'hk-minor',
  changes: 'hk-changes',
  skipped: 'hk-skipped',
}

/** The standard emoji a status shows instead of its default when the workspace lacks it. */
export const fallbackSlackEmoji: Readonly<Record<SlackReviewStatus, string>> = {
  reviewing: 'eyes',
  clean: 'large_green_circle',
  minor: 'large_orange_circle',
  changes: 'red_circle',
  skipped: 'white_circle',
}

/**
 * A Slack emoji name without colons (`:eyes:` is accepted and stored as `eyes`), optionally with
 * a skin tone (`thumbsup::skin-tone-2`).
 */
const slackEmojiSchema = z
  .string()
  .trim()
  .transform((name) => name.replace(/^:+|:+$/g, ''))
  .pipe(
    z
      .string()
      .max(100)
      .regex(
        /^[a-z0-9][a-z0-9_+'-]*(::skin-tone-[2-6])?$/,
        'a Slack emoji name such as eyes or large_green_circle',
      ),
  )

/** Emoji overrides per status; a missing status uses `defaultSlackEmoji`. */
export const slackEmojiOverridesSchema = z.partialRecord(
  z.enum(slackReviewStatuses),
  slackEmojiSchema,
)

type SlackEmojiOverrides = z.infer<typeof slackEmojiOverridesSchema>

const storedSchema = z.object({
  botToken: z.string(),
  signingSecret: z.string(),
  connectedAt: z.string(),
  connectedBy: z.string(),
  emoji: slackEmojiOverridesSchema.optional().catch(undefined),
})

/** The stored Slack credential as kept in `store.kv`: tokens sealed with the vault. */
export type StoredSlackConnection = z.infer<typeof storedSchema>

/** The stored Slack credential, or `undefined` when none is stored or it does not parse. */
export async function storedSlackConnection(
  store: Pick<Store, 'kv'>,
): Promise<StoredSlackConnection | undefined> {
  return storedSchema.safeParse(await store.kv?.get(SLACK_CONNECTION_KEY)).data
}

/** The Slack credential ready to use: tokens opened, and the emoji a person set per status. */
export interface SlackConnection {
  botToken: string
  signingSecret: string
  /** Used as given; a status without one uses `defaultSlackEmoji` or its fallback. */
  overrides: SlackEmojiOverrides
}

/**
 * The stored Slack credential with its tokens opened, or `undefined` when none is stored or the
 * vault cannot open it (another vault key).
 */
export async function slackConnection(deps: {
  store: Pick<Store, 'kv'>
  vault: Vault
}): Promise<SlackConnection | undefined> {
  const stored = await storedSlackConnection(deps.store)
  if (!stored) return undefined
  try {
    return {
      botToken: await deps.vault.open(stored.botToken),
      signingSecret: await deps.vault.open(stored.signingSecret),
      overrides: stored.emoji ?? {},
    }
  } catch {
    return undefined
  }
}
