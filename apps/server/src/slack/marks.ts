import type { Discussion, MergeRequestState } from '@holtkeeper/forge'
import { commentFinding } from '@holtkeeper/review'
import type { SlackMergeRequestMark, SlackMessageLink } from '@holtkeeper/store'
import { z } from 'zod'

import { slackEmojiSchema } from './connection.ts'

/** Setting key of the merge request marks on Slack messages. */
export const slackMarksSettingKey = 'slack.mergeRequestMarks'

/** Marks in the order they show on a message and in a status reply line. */
const slackMarks = [
  'comments',
  'approved',
  'merged',
] as const satisfies readonly SlackMergeRequestMark[]

const channelId = z
  .string()
  .trim()
  .regex(/^[CG][A-Z0-9]{6,20}$/, 'a Slack channel id such as C0123ABCD (channel details › About)')

/** The `slack.mergeRequestMarks` value; `{}` is valid and leaves marks off. */
const slackMarksSchema = z.object({
  enabled: z.boolean().default(false).describe('Show the marks'),
  channels: z
    .array(channelId)
    .max(100)
    .default([])
    .describe('Slack channel ids that show marks, e.g. C0123ABCD; empty: every channel'),
  emoji: z
    .object({
      comments: slackEmojiSchema
        .default('speech_balloon')
        .describe('Unresolved threads of people are open'),
      approved: slackEmojiSchema.default('white_check_mark').describe('Someone approved it'),
      merged: slackEmojiSchema.default('twisted_rightwards_arrows').describe('It was merged'),
    })
    .prefault({}),
})

/** A parsed `slack.mergeRequestMarks` value. */
export type SlackMarksSettings = z.output<typeof slackMarksSchema>

/** `slack.mergeRequestMarks` with defaults; a value that does not parse leaves marks off. */
export const slackMarksSettings = (value: unknown): SlackMarksSettings =>
  slackMarksSchema.safeParse(value ?? {}).data ?? slackMarksSchema.parse({})

/** Whether messages in `channel` show marks. */
export const marksOnIn = (settings: SlackMarksSettings, channel: string): boolean =>
  settings.enabled && (settings.channels.length === 0 || settings.channels.includes(channel))

/** The `slack.mergeRequestMarks` setting for the settings registry; one value for every repository. */
export const slackMarksDefinition = {
  key: slackMarksSettingKey,
  label: 'Slack merge request marks',
  description:
    'Extra emoji on Slack messages that link merge requests: open threads of people, approved, merged.',
  section: 'Integrations',
  global: true,
  default: slackMarksSchema.parse({}),
  schema: slackMarksSchema,
  help: `Next to the review status emoji, a message that links merge requests gets one emoji per mark, and every line of its status reply ends with the marks of that merge request.

- **comments**: an unresolved thread someone other than Holtkeeper started. Holtkeeper's own finding threads are left out; they already decide the review status.
- **approved**: someone other than Holtkeeper's account approved it. A message linking several merge requests shows it only when every one of them is approved.
- **merged**: it was merged; on a message with several, only when all of them are.

A message with several merge requests shows **comments** when any of them has open threads.

- **enabled**: off by default.
- **channels**: Slack channel ids (channel details › About), e.g. \`C0123ABCD\`; empty means every channel the app is in.
- **emoji**: Slack emoji names without colons, custom workspace emoji included. One the workspace lacks shows nothing and is logged once.

Marks follow merge request events and notes, so they change when someone approves, merges, comments or resolves a thread. Turning marks off for a channel takes them off a message at its merge requests' next change.`,
}

/** What `mergeRequestMarks` looks at, as the forge reports it now. */
export interface MarkInputs {
  /** Absent when the forge cannot tell. */
  state?: MergeRequestState
  approvedBy: readonly string[]
  discussions: readonly Discussion[]
  /** Username of Holtkeeper's own forge account, when known. */
  self?: string
}

/**
 * The marks of one merge request: `comments` for an unresolved, resolvable thread whose first
 * note is neither by Holtkeeper's account nor a Holtkeeper finding, `approved` for an approval by
 * anyone but Holtkeeper's account, `merged` once merged. In `slackMarks` order.
 */
export function mergeRequestMarks(inputs: MarkInputs): SlackMergeRequestMark[] {
  const notSelf = (username: string) => !inputs.self || username !== inputs.self
  const comments = inputs.discussions.some((discussion) => {
    if (!discussion.resolvable || discussion.resolved) return false
    const first = discussion.notes.find((note) => !note.system)
    return !!first && notSelf(first.author) && !commentFinding(first.body)
  })
  const marks: SlackMergeRequestMark[] = []
  if (comments) marks.push('comments')
  if (inputs.approvedBy.some(notSelf)) marks.push('approved')
  if (inputs.state === 'merged') marks.push('merged')
  return marks
}

const has = (link: Pick<SlackMessageLink, 'marks'>, mark: SlackMergeRequestMark) =>
  link.marks?.includes(mark) ?? false

/**
 * The marks a message about `links` shows: `comments` when any merge request has it, `approved`
 * and `merged` only when every one does. In `slackMarks` order.
 */
export function messageMarks(
  links: readonly Pick<SlackMessageLink, 'marks'>[],
): SlackMergeRequestMark[] {
  if (links.length === 0) return []
  return slackMarks.filter((mark) =>
    mark === 'comments'
      ? links.some((link) => has(link, mark))
      : links.every((link) => has(link, mark)),
  )
}
