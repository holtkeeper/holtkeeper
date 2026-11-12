import type { ForgeDefinition, GitForge } from './types.ts'

/** Whether Holtkeeper must not comment on merge requests of the repository at `repo` (full path). */
export type CommentsOffCheck = (repo: string) => boolean | Promise<boolean>

/** Thrown instead of a comment, review or thread change on a merge request whose comments are off. */
export class MergeRequestCommentsOffError extends Error {
  readonly repo: string
  readonly operation: string

  constructor(repo: string, operation: string) {
    super(`merge request comments are off in ${repo}: ${operation} is not allowed`)
    this.name = 'MergeRequestCommentsOffError'
    this.repo = repo
    this.operation = operation
  }
}

const bareApproval = (args: readonly unknown[]) => {
  const review = args[2]
  if (typeof review !== 'object' || review === null) return false
  const comments: unknown = Reflect.get(review, 'comments')
  return (
    Reflect.get(review, 'event') === 'approve' &&
    !Reflect.get(review, 'summary') &&
    Array.isArray(comments) &&
    comments.length === 0
  )
}

const posts: Record<string, (args: readonly unknown[]) => boolean> = {
  commentOnMergeRequest: () => true,
  submitReview: (args) => !bareApproval(args),
  replyToDiscussion: () => true,
  postMergeRequestNote: () => true,
  updateMergeRequestNote: () => true,
  resolveDiscussion: () => true,
}

/**
 * `forge` with every note on a merge request of a repository whose comments are off rejected with
 * `MergeRequestCommentsOffError` before it reaches the forge: comments, reviews, thread replies,
 * note edits and resolved threads. A bare approval (a review with no comments and no summary), merge requests themselves (create, update, merge, labels),
 * account changes such as the avatar and everything else pass through. Optional methods stay absent when `forge` lacks them.
 */
export function commentsOffForge(forge: GitForge, isOff: CommentsOffCheck): GitForge {
  return new Proxy(forge, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      const postsNote = typeof key === 'string' ? posts[key] : undefined
      if (!postsNote) return value.bind(target)
      return async (...args: unknown[]) => {
        const repo = args[0]
        if (typeof repo === 'string' && postsNote(args) && (await isOff(repo)))
          throw new MergeRequestCommentsOffError(repo, String(key))
        return Reflect.apply(value, target, args)
      }
    },
  })
}

/** `definition` whose clients, also those of `withFetch` copies, go through `commentsOffForge`. */
export function commentsOffDefinition(
  definition: ForgeDefinition,
  isOff: CommentsOffCheck,
): ForgeDefinition {
  return {
    ...definition,
    create: () => commentsOffForge(definition.create(), isOff),
    ...(definition.withFetch && {
      withFetch: (wrap) => commentsOffDefinition(definition.withFetch?.(wrap) ?? definition, isOff),
    }),
  }
}
