import { resolveSecret } from '@holtkeeper/forge'
import { z } from 'zod'

import { defineAction } from './provider.ts'

/** A literal value or `{ env }`, as `Secret` from `@holtkeeper/forge`. */
export const secretSchema = z.union([z.string().min(1), z.object({ env: z.string().min(1) })])

const schema = z.object({
  type: z.literal('webhook'),
  url: secretSchema,
  headers: z.record(z.string(), secretSchema).optional(),
  /** Extra fields sent under `payload`. */
  payload: z.record(z.string(), z.unknown()).optional(),
})

/**
 * POSTs `{ policy, event, payload, at }` as JSON. The URL and headers are secrets and never appear
 * in the outcome.
 */
export const webhookAction = defineAction({
  type: 'webhook',
  schema,
  async run(action, context) {
    const { event, policy, now } = context
    const body = {
      policy: policy.id,
      at: now.toISOString(),
      event: {
        repo: event.repo,
        action: event.action,
        actor: event.actor,
        command: event.command,
        mergeRequest: event.mr,
      },
      payload: action.payload ?? {},
    }
    return context.perform('posted to webhook', async () => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      for (const [name, value] of Object.entries(action.headers ?? {})) {
        headers[name] = resolveSecret(value)
      }
      const response = await context.fetch(resolveSecret(action.url), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`webhook answered ${response.status}`)
    })
  },
})
