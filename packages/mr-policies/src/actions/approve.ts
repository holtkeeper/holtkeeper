import { z } from 'zod'

import { notOpen, outOfScope } from './guards.ts'
import { defineAction, headShaKey } from './provider.ts'
import { renderTemplate } from './template.ts'

const schema = z.object({
  type: z.literal('approve'),
  /** Review text posted with the approval; supports template placeholders. */
  summary: z.string().optional(),
  /** Approve only once the head pipeline succeeded; defers while it runs. */
  requirePipeline: z.literal('success').optional(),
  /** Allow approving merge requests authored by Holtkeeper's own user. */
  allowSelfApprove: z.boolean().optional(),
})

/** Approves the merge request through `submitReview` with `event: 'approve'`, once per head commit. */
export const approveAction = defineAction({
  type: 'approve',
  schema,
  onceKey: headShaKey,
  async run(action, context) {
    const { forge, event, facts, botUser } = context
    const blocked = outOfScope(context) ?? notOpen(context)
    if (blocked) return blocked
    if (botUser && event.mr.author === botUser && !action.allowSelfApprove) {
      return {
        status: 'skipped',
        detail: `refusing to approve a merge request authored by ${botUser} itself`,
      }
    }
    if (!forge.submitReview) return { status: 'unsupported', detail: 'the forge cannot approve' }
    if (action.requirePipeline) {
      const { state, pipeline } = await facts.pipeline()
      const data = pipeline ? { pipeline: pipeline.id } : undefined
      if (state === 'running') {
        return { status: 'deferred', detail: 'pipeline is still running', data }
      }
      if (state !== 'success') {
        return { status: 'skipped', detail: `pipeline is ${state}, approval needs success`, data }
      }
    }
    const diff = await facts.diff()
    if (!diff) return { status: 'unsupported', detail: 'the forge cannot load diff refs' }
    const submitReview = forge.submitReview.bind(forge)
    const summary = action.summary === undefined ? undefined : renderTemplate(action.summary, event)
    return context.perform(
      'approved',
      () =>
        submitReview(event.repo.path, event.mr.id, {
          refs: diff.refs,
          comments: [],
          summary,
          event: 'approve',
        }),
      { headSha: diff.refs.headSha },
    )
  },
})
