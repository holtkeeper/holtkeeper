import { approveAction } from './approve.ts'
import { closeAction } from './close.ts'
import { commentAction } from './comment.ts'
import { draftAction } from './draft.ts'
import { enqueueAction } from './enqueue.ts'
import { labelAction } from './label.ts'
import { mergeAction } from './merge.ts'
import type { ActionProvider } from './provider.ts'
import { assignReviewersAction } from './reviewers.ts'
import { webhookAction } from './webhook.ts'

export { renderTemplate } from './template.ts'
export {
  approveAction,
  assignReviewersAction,
  closeAction,
  commentAction,
  draftAction,
  enqueueAction,
  labelAction,
  mergeAction,
  webhookAction,
}
export type { ReviewerAssignment } from './reviewers.ts'
export { secretSchema } from './webhook.ts'
export * from './provider.ts'

/** Actions available out of the box. */
export const builtinActions: readonly ActionProvider[] = [
  approveAction,
  mergeAction,
  labelAction,
  commentAction,
  closeAction,
  draftAction,
  assignReviewersAction,
  enqueueAction,
  webhookAction,
]
