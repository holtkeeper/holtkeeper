import type { GitForge, RepoRef } from '@holtkeeper/forge'

import type { Card } from './card.ts'
import type { ChatSurface, ChatThread, PostedMessage } from './command.ts'
import { renderMarkdown } from './markdown.ts'

/** A merge request conversation; `discussionId` is the thread replies go to. */
export interface MergeRequestThread {
  forge: string
  path: string
  mergeRequest: number
  discussionId?: string
}

/** The thread of a merge request, optionally inside one of its discussions. */
export const mergeRequestThread = (
  repo: RepoRef,
  mergeRequest: number,
  discussionId?: string,
): ChatThread => ({
  forge: repo.forge,
  path: repo.path,
  mergeRequest,
  ...(discussionId !== undefined && { discussionId }),
})

const threadOf = (thread: ChatThread): MergeRequestThread => {
  const { forge, path, mergeRequest, discussionId } = thread
  if (typeof forge !== 'string' || typeof path !== 'string' || typeof mergeRequest !== 'number')
    throw new Error('not a merge request thread')
  return {
    forge,
    path,
    mergeRequest,
    ...(typeof discussionId === 'string' && { discussionId }),
  }
}

export interface MergeRequestSurfaceOptions {
  /** Surface id; default `merge-requests`. */
  id?: string
  /** The client of a forge id, or `undefined` when it is not configured. */
  forgeOf(forge: string): GitForge | undefined
  prefix?: string
  /**
   * Hidden text appended to every note as an HTML comment, so the event handler can tell
   * Holtkeeper's own notes apart.
   */
  marker: string
}

/**
 * Merge request notes as a chat surface. Cards become markdown notes (`renderMarkdown`) in the
 * thread of the message, or a new thread; with `postMergeRequestNote` and
 * `updateMergeRequestNote` posted notes can be updated in place, otherwise every update is a new
 * reply.
 */
export function mergeRequestSurface(options: MergeRequestSurfaceOptions): ChatSurface {
  const id = options.id ?? 'merge-requests'
  const body = (card: Card) =>
    `${renderMarkdown(card, options.prefix ? { prefix: options.prefix } : {})}\n\n<!-- ${options.marker} -->`
  const client = (thread: MergeRequestThread) => {
    const forge = options.forgeOf(thread.forge)
    if (!forge) throw new Error(`forge ${thread.forge} is not configured`)
    return forge
  }

  return {
    id,
    async post(raw, card): Promise<PostedMessage> {
      const thread = threadOf(raw)
      const forge = client(thread)
      const text = body(card)
      if (forge.postMergeRequestNote) {
        const posted = await forge.postMergeRequestNote(
          thread.path,
          thread.mergeRequest,
          text,
          thread.discussionId ? { discussionId: thread.discussionId } : {},
        )
        return {
          surface: id,
          thread: posted.discussionId ? { ...raw, discussionId: posted.discussionId } : raw,
          id: String(posted.noteId),
        }
      }
      if (thread.discussionId && forge.replyToDiscussion)
        await forge.replyToDiscussion(thread.path, thread.mergeRequest, thread.discussionId, text)
      else await forge.commentOnMergeRequest(thread.path, thread.mergeRequest, text)
      return { surface: id, thread: raw }
    },
    async update(message, card) {
      const thread = threadOf(message.thread)
      const forge = client(thread)
      if (!forge.updateMergeRequestNote || message.id === undefined)
        throw new Error('the forge cannot edit notes')
      await forge.updateMergeRequestNote(
        thread.path,
        thread.mergeRequest,
        Number(message.id),
        body(card),
      )
    },
  }
}
