import { z } from 'zod'

import { notOpen, outOfScope } from './guards.ts'
import { defineAction, headShaKey } from './provider.ts'

const schema = z.object({
  type: z.literal('merge'),
  squash: z.boolean().optional(),
  removeSourceBranch: z.boolean().optional(),
  /** Merge when the pipeline succeeds instead of right away. Default `true`. */
  whenPipelineSucceeds: z.boolean().default(true),
})

/** Merges the merge request, by default once its pipeline succeeds; once per head commit. */
export const mergeAction = defineAction({
  type: 'merge',
  schema,
  onceKey: headShaKey,
  async run(action, context) {
    const { forge, event } = context
    const blocked = outOfScope(context) ?? notOpen(context)
    if (blocked) return blocked
    if (event.mr.draft) return { status: 'skipped', detail: 'merge request is a draft' }
    const options = {
      squash: action.squash,
      removeSourceBranch: action.removeSourceBranch,
      whenPipelineSucceeds: action.whenPipelineSucceeds,
    }
    return context.perform(
      action.whenPipelineSucceeds ? 'set to merge when the pipeline succeeds' : 'merged',
      () => forge.mergeMergeRequest(event.repo.path, event.mr.id, options),
      options,
    )
  },
})
