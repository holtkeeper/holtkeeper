import { z } from 'zod'

import { notOpen } from './guards.ts'
import { defineAction } from './provider.ts'

const schema = z
  .object({
    type: z.literal('label'),
    add: z.array(z.string().min(1)).optional(),
    remove: z.array(z.string().min(1)).optional(),
  })
  .refine((action) => action.add?.length || action.remove?.length, {
    message: 'label needs add or remove',
  })

/** Adds and removes labels; does nothing when the labels are already as wanted. */
export const labelAction = defineAction({
  type: 'label',
  schema,
  async run(action, context) {
    const { forge, event } = context
    const blocked = notOpen(context)
    if (blocked) return blocked
    const current = event.mr.labels
    const remove = new Set(action.remove)
    const next = [
      ...new Set([...current.filter((label) => !remove.has(label)), ...(action.add ?? [])]),
    ]
    const added = next.filter((label) => !current.includes(label))
    const removed = current.filter((label) => !next.includes(label))
    if (added.length === 0 && removed.length === 0) {
      return { status: 'skipped', detail: 'labels are already set' }
    }
    const parts = [
      added.length ? `added ${added.join(', ')}` : '',
      removed.length ? `removed ${removed.join(', ')}` : '',
    ].filter(Boolean)
    return context.perform(
      parts.join('; '),
      async () => {
        await forge.updateMergeRequest(event.repo.path, event.mr.id, { labels: next })
        event.mr.labels = next
      },
      { added, removed },
    )
  },
})
