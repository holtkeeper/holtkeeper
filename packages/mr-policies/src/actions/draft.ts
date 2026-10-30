import { z } from 'zod'

import { notOpen } from './guards.ts'
import { defineAction } from './provider.ts'

const schema = z.object({
  type: z.literal('draft'),
  /** `true` marks the merge request as draft, `false` as ready. Default `true`. */
  draft: z.boolean().default(true),
})

/** Marks the merge request as draft or ready. */
export const draftAction = defineAction({
  type: 'draft',
  schema,
  async run(action, context) {
    const { forge, event } = context
    const blocked = notOpen(context)
    if (blocked) return blocked
    const detail = action.draft ? 'marked as draft' : 'marked as ready'
    if (event.mr.draft === action.draft) return { status: 'skipped', detail: `already ${detail}` }
    return context.perform(detail, async () => {
      await forge.updateMergeRequest(event.repo.path, event.mr.id, { draft: action.draft })
      event.mr.draft = action.draft
    })
  },
})
