import type { GitForge } from '@holtkeeper/forge'
import { z } from 'zod'

import { notOpen } from './guards.ts'
import { defineAction } from './provider.ts'

/** An optional forge capability: setting merge request reviewers. */
export interface ReviewerAssignment {
  assignReviewers(repo: string, id: number, reviewers: string[]): Promise<void>
}

const canAssign = (forge: GitForge): forge is GitForge & ReviewerAssignment =>
  'assignReviewers' in forge && typeof forge.assignReviewers === 'function'

const schema = z.object({
  type: z.literal('assignReviewers'),
  reviewers: z.array(z.string().min(1)).min(1),
})

/** Assigns reviewers where the forge implements `ReviewerAssignment`; `unsupported` otherwise. */
export const assignReviewersAction = defineAction({
  type: 'assignReviewers',
  schema,
  async run(action, context) {
    const { forge, event } = context
    const blocked = notOpen(context)
    if (blocked) return blocked
    if (!canAssign(forge)) {
      return { status: 'unsupported', detail: `the ${forge.kind} forge cannot assign reviewers` }
    }
    const reviewers = action.reviewers.filter((reviewer) => reviewer !== event.mr.author)
    if (reviewers.length === 0) return { status: 'skipped', detail: 'only the author was listed' }
    return context.perform(
      `assigned ${reviewers.join(', ')}`,
      () => forge.assignReviewers(event.repo.path, event.mr.id, reviewers),
      { reviewers },
    )
  },
})
