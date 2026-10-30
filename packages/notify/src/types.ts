import type { Tone } from '@holtkeeper/report'
import { z } from 'zod'

/** A label and value shown side by side, e.g. a metric with its change. */
export interface NotificationField {
  label: string
  value: string
}

/**
 * A message for people, independent of where it goes. Notifiers render it for their channel and
 * may shorten it to fit the channel's limits.
 */
export interface Notification {
  title: string
  /**
   * Markdown-ish body: paragraphs, `- ` lists, `**bold**`, `` `code` `` and `[label](url)` links.
   * Notifiers convert what their channel supports and show the rest as text.
   */
  text: string
  /** Where to read more, e.g. the report page. */
  url?: string
  tone?: Tone
  fields?: NotificationField[]
}

/** Validates a `Notification`, e.g. one sent through the API. */
export const notificationSchema: z.ZodType<Notification> = z.object({
  title: z.string().min(1),
  text: z.string(),
  url: z.url().optional(),
  tone: z.enum(['neutral', 'info', 'good', 'warning', 'bad']).optional(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
})

/**
 * Delivers notifications to one channel (a Slack webhook, a generic webhook, ...). `send` resolves
 * once the channel accepted the message and rejects otherwise; errors never contain secrets.
 */
export interface Notifier {
  readonly name: string
  send(message: Notification): Promise<void>
}

/** The part of `fetch` notifiers use; injected so tests never reach the network. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>
