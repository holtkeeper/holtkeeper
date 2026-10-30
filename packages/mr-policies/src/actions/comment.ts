import { z } from 'zod'

import { defineAction, headShaKey, mergeRequestKey } from './provider.ts'
import { renderTemplate } from './template.ts'

const schema = z.object({
  type: z.literal('comment'),
  /** Markdown; supports template placeholders such as `{author}`. */
  body: z.string().min(1),
  /** Post once per head commit (default), once per merge request, or on every match. */
  once: z.enum(['headSha', 'mergeRequest', 'never']).default('headSha'),
})

/** Posts a comment rendered from a template. */
export const commentAction = defineAction({
  type: 'comment',
  schema,
  async onceKey(action, context) {
    if (action.once === 'never') return undefined
    if (action.once === 'mergeRequest') return mergeRequestKey(action, context)
    return headShaKey(action, context)
  },
  async run(action, context) {
    const { forge, event } = context
    const body = renderTemplate(action.body, event)
    return context.perform(
      'commented',
      () => forge.commentOnMergeRequest(event.repo.path, event.mr.id, body),
      { body },
    )
  },
})
