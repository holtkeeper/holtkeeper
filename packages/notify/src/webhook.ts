import { type Secret, resolveSecret } from '@holtkeeper/forge'

import { defaultSleep, post } from './http.ts'
import type { Fetch, Notifier } from './types.ts'

export interface GenericWebhookOptions {
  url: Secret
  /** Extra headers, e.g. an `authorization` token; values are secrets resolved on every send. */
  headers?: Record<string, Secret>
  /** Default `webhook`. */
  name?: string
  fetch?: Fetch
  sleep?: (ms: number) => Promise<void>
}

/** A notifier POSTing the `Notification` itself as JSON to any URL. */
export function genericWebhook(options: GenericWebhookOptions): Notifier {
  const { name = 'webhook', fetch = globalThis.fetch, sleep = defaultSleep } = options
  return {
    name,
    async send(message) {
      const headers = Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([key, value]) => [
          key.toLowerCase(),
          resolveSecret(value),
        ]),
      )
      await post({
        name,
        url: resolveSecret(options.url),
        body: JSON.stringify(message),
        headers: { ...headers, 'content-type': 'application/json' },
        fetch,
        sleep,
      })
    },
  }
}
