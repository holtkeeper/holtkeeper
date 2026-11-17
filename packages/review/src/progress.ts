import type { GitForge } from '@holtkeeper/forge'

import { MARKER_PREFIX } from './dedupe.ts'
import type { ReviewMessages } from './messages.ts'
import { formatDuration } from './size.ts'

/** The hidden marker of the note that says a review is running. */
export const PROGRESS_MARKER = `<!-- ${MARKER_PREFIX} progress -->`

/**
 * Where a running review is, as the progress note shows it: the agent passes (`parts` is 1 for a
 * diff reviewed in one pass, `deep` when that pass runs on the deep tier), the cross-part pass of
 * a split review, the verification of `findings` findings, and posting.
 */
export type ReviewStage =
  | { stage: 'review'; parts: number; done: number; deep: boolean }
  | { stage: 'cross'; parts: number; deep: boolean }
  | { stage: 'verify'; findings: number }
  | { stage: 'post' }

/** The note that says a review is running, once posted. */
export interface ReviewProgress {
  /**
   * Shows `stage` with the steps done and left and the estimated time left, refreshed about once a
   * minute until the review ends. Returns at once and never throws.
   */
  update(stage: ReviewStage): void
  /** Removes the note (or, on forges that cannot delete notes, says the review finished). */
  finish(): Promise<void>
  /** Replaces the note with one saying the review could not finish. */
  fail(): Promise<void>
}

const quiet: ReviewProgress = { update: () => {}, finish: async () => {}, fail: async () => {} }

/**
 * Rough minutes each step takes, for the time left in the progress note: a pass over a part on the
 * main tier, a single pass, the cross-part pass and the verification (main and deep), and posting.
 * Measured on a split review of about 2 000 changed lines in four parts.
 */
export const STAGE_MINUTES = {
  part: 2,
  single: { main: 3, deep: 6 },
  cross: { main: 2, deep: 3 },
  verify: 1,
  post: 1,
} as const

/** Parts of a split review that run at once, as `SPLIT_CONCURRENCY` in the agent. */
const WAVE = 6

const tierOf = (deep: boolean) => (deep ? 'deep' : 'main')

/** Minutes the review stage takes in full: one wave of parts per `WAVE` parts. */
const reviewMinutes = (stage: { parts: number; deep: boolean }) =>
  stage.parts > 1
    ? Math.ceil(stage.parts / WAVE) * STAGE_MINUTES.part
    : STAGE_MINUTES.single[tierOf(stage.deep)]

/**
 * The estimated minutes left at `stage`, `elapsed` minutes after it started: what is left of it
 * (at least 1) plus the steps after it. `verify` is false when findings are not verified.
 */
export function minutesLeft(stage: ReviewStage, elapsed: number, verify: boolean): number {
  const after = {
    verify: verify ? STAGE_MINUTES.verify : 0,
    post: STAGE_MINUTES.post,
  }
  const rest = (total: number) => Math.max(1, Math.ceil(total - elapsed))
  switch (stage.stage) {
    case 'review': {
      const cross = stage.parts > 1 ? STAGE_MINUTES.cross[tierOf(stage.deep)] : 0
      return rest(reviewMinutes(stage)) + cross + after.verify + after.post
    }
    case 'cross':
      return rest(STAGE_MINUTES.cross[tierOf(stage.deep)]) + after.verify + after.post
    case 'verify':
      return rest(STAGE_MINUTES.verify) + after.post
    default:
      return rest(STAGE_MINUTES.post)
  }
}

/** The progress note's text for `stage`, `elapsed` minutes after it started. */
export function progressText(
  stage: ReviewStage,
  elapsed: number,
  messages: ReviewMessages,
  verify = true,
): string {
  const { t } = messages
  const order = ['review', 'cross', 'verify', 'post'] as const
  const at = order.indexOf(stage.stage)
  const parts = 'parts' in stage ? stage.parts : undefined
  const mark = (step: (typeof order)[number]) => {
    const index = order.indexOf(step)
    return index < at ? '✅' : index === at ? '⏳' : '▫️'
  }
  const steps = [
    `- ${mark('review')} ${
      stage.stage === 'review' && stage.parts > 1
        ? t('progress.step.parts', { count: stage.parts, done: stage.done })
        : t('progress.step.review')
    }`,
    // A single pass has no cross-part step; before the stage is known, assume none.
    parts !== undefined && parts > 1 ? `- ${mark('cross')} ${t('progress.step.cross')}` : '',
    verify
      ? `- ${mark('verify')} ${
          stage.stage === 'verify'
            ? t('progress.step.verifying', { count: stage.findings })
            : t('progress.step.verify')
        }`
      : '',
    `- ${mark('post')} ${t('progress.step.post')}`,
  ]
  return [
    `${t('progress.title')} ${t('progress.left', {
      time: formatDuration(minutesLeft(stage, elapsed, verify), messages),
    })}`,
    steps.filter(Boolean).join('\n'),
    t('progress.wait'),
  ].join('\n\n')
}

/** How often the note's time left is refreshed while a stage runs. */
const REFRESH_MS = 60_000

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const body = (text: string) => `${text.trim()}\n\n${PROGRESS_MARKER}`

/**
 * Posts the "review is running" note on a merge request, first deleting progress notes `owner`
 * left behind (a run that crashed or failed before). Needs `postMergeRequestNote`; without it, or
 * when posting fails, nothing is posted and the returned handle does nothing. Never throws: every
 * forge failure is logged and the review goes on.
 */
export async function startProgress(options: {
  forge: GitForge
  repo: string
  mergeRequest: number
  messages: ReviewMessages
  /** The forge account Holtkeeper posts as; leftover notes are deleted only when it is known. */
  owner?: string
  /** Whether the review verifies its findings, which adds a step; default true. */
  verify?: boolean
  log?: (line: string) => void
}): Promise<ReviewProgress> {
  const { forge, repo, mergeRequest, messages, log } = options
  if (!forge.postMergeRequestNote) return quiet
  const owner = options.owner?.toLowerCase()
  if (owner && forge.deleteMergeRequestNote && forge.listDiscussions) {
    try {
      const leftovers = (await forge.listDiscussions(repo, mergeRequest)).flatMap((discussion) =>
        discussion.notes.filter(
          (note) =>
            !note.system &&
            note.author.toLowerCase() === owner &&
            note.body.includes(PROGRESS_MARKER),
        ),
      )
      for (const note of leftovers)
        // oxlint-disable-next-line no-await-in-loop
        await forge.deleteMergeRequestNote(repo, mergeRequest, Number(note.id))
    } catch (error) {
      log?.(`removing earlier progress notes failed: ${errorText(error)}`)
    }
  }
  let noteId: number
  try {
    noteId = (
      await forge.postMergeRequestNote(repo, mergeRequest, body(messages.t('progress.running')))
    ).noteId
  } catch (error) {
    log?.(`posting the progress note failed: ${errorText(error)}`)
    return quiet
  }
  const update = async (text: string) => {
    if (!forge.updateMergeRequestNote) return
    await forge.updateMergeRequestNote(repo, mergeRequest, noteId, body(text))
  }
  // Updates go out one at a time and stop once the review ends, so a late edit never overwrites
  // the final state.
  let current: { stage: ReviewStage; since: number } | undefined
  let shown = ''
  let ended = false
  let queue = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | undefined
  const show = () => {
    if (!current || ended) return
    const text = progressText(
      current.stage,
      (Date.now() - current.since) / 60_000,
      messages,
      options.verify !== false,
    )
    if (text === shown) return
    shown = text
    queue = queue
      .then(() => (ended ? undefined : update(text)))
      .catch((error: unknown) => log?.(`updating the progress note failed: ${errorText(error)}`))
  }
  const end = async () => {
    ended = true
    if (timer) clearInterval(timer)
    await queue
  }
  return {
    update(stage) {
      if (ended || !forge.updateMergeRequestNote) return
      const sameStage = current?.stage.stage === stage.stage
      current = { stage, since: sameStage && current ? current.since : Date.now() }
      if (!timer) {
        timer = setInterval(show, REFRESH_MS)
        timer.unref?.()
      }
      show()
    },
    async finish() {
      await end()
      try {
        if (forge.deleteMergeRequestNote)
          await forge.deleteMergeRequestNote(repo, mergeRequest, noteId)
        else await update(messages.t('progress.done'))
      } catch (error) {
        log?.(`removing the progress note failed: ${errorText(error)}`)
      }
    },
    async fail() {
      await end()
      try {
        await update(messages.t('progress.failed'))
      } catch (error) {
        log?.(`updating the progress note failed: ${errorText(error)}`)
      }
    },
  }
}
