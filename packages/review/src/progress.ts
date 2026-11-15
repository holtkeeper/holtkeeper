import type { GitForge } from '@holtkeeper/forge'

import { MARKER_PREFIX } from './dedupe.ts'
import type { ReviewMessages } from './messages.ts'

/** The hidden marker of the note that says a review is running. */
export const PROGRESS_MARKER = `<!-- ${MARKER_PREFIX} progress -->`

/** The note that says a review is running, once posted. */
export interface ReviewProgress {
  /** Removes the note (or, on forges that cannot delete notes, says the review finished). */
  finish(): Promise<void>
  /** Replaces the note with one saying the review could not finish. */
  fail(): Promise<void>
}

const quiet: ReviewProgress = { finish: async () => {}, fail: async () => {} }

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
  return {
    async finish() {
      try {
        if (forge.deleteMergeRequestNote)
          await forge.deleteMergeRequestNote(repo, mergeRequest, noteId)
        else await update(messages.t('progress.done'))
      } catch (error) {
        log?.(`removing the progress note failed: ${errorText(error)}`)
      }
    },
    async fail() {
      try {
        await update(messages.t('progress.failed'))
      } catch (error) {
        log?.(`updating the progress note failed: ${errorText(error)}`)
      }
    },
  }
}
