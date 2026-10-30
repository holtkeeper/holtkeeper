import { z } from 'zod'

import { notOpen } from './guards.ts'
import { defineAction } from './provider.ts'

const schema = z.object({ type: z.literal('close') })

/** Closes the merge request. */
export const closeAction = defineAction({
  type: 'close',
  schema,
  async run(_action, context) {
    const { forge, event } = context
    const blocked = notOpen(context)
    if (blocked) return blocked
    return context.perform('closed', async () => {
      await forge.updateMergeRequest(event.repo.path, event.mr.id, { state: 'closed' })
      event.mr.state = 'closed'
    })
  },
})
