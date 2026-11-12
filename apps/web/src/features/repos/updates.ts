import type { RepoUpdatesView } from '@holtkeeper/api'

import { formatDuration } from '../../lib/format.ts'

const eventLabels: Record<RepoUpdatesView['polling']['events'][number], string> = {
  mergeRequests: 'Merge requests',
  notes: 'Comments',
  pipelines: 'Pipelines',
  tags: 'Tags',
  pushes: 'Branch pushes',
}

export const pollEventLabel = (event: RepoUpdatesView['polling']['events'][number]) =>
  eventLabels[event]

/** What the repository page says about polling cadence, and whether it deserves attention. */
export function pollingCadence(view: RepoUpdatesView): {
  text: string
  tone: 'default' | 'success' | 'warning'
  detail?: string
} {
  const { polling } = view
  if (!polling.enabled) return { text: 'Off', tone: 'default' }
  if (view.viaWebhook && polling.withWebhookMs === undefined)
    return { text: 'Paused', tone: 'success', detail: 'Webhooks reach this repository.' }
  const effective = polling.effectiveIntervalMs
  const stretch = polling.stretch ?? 1
  const text = `Every ${formatDuration(effective ?? polling.intervalMs)}`
  if (stretch > 1.05)
    return {
      text,
      tone: 'warning',
      detail: `Slowed ×${stretch.toFixed(1)} from ${formatDuration(view.viaWebhook ? (polling.withWebhookMs ?? polling.intervalMs) : polling.intervalMs)}: the token's polling budget is shared with other repositories.`,
    }
  if (view.viaWebhook)
    return {
      text,
      tone: 'success',
      detail: 'Webhooks reach this repository; polling only catches lost deliveries.',
    }
  return { text, tone: 'default' }
}

/** One row of the Updates section's event list: a webhook delivery or a poll. */
export interface UpdateEvent {
  at: string
  via: 'webhook' | 'poll'
  /** What arrived or how the poll started. */
  event: string
  result: string
  failed: boolean
  durationMs: number
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** What a webhook delivery did, in words. */
export function deliveryResult(
  delivery: NonNullable<RepoUpdatesView['webhook']>['deliveries'][number],
): string {
  if (delivery.error) return `Rejected: ${delivery.error}`
  if (delivery.ignored) return `Ignored: ${delivery.ignored}`
  return `${plural(delivery.enqueued, 'job')} queued`
}

/** Webhook deliveries and polls of a repository in one list, newest first. */
export function updateEvents(view: RepoUpdatesView): UpdateEvent[] {
  const deliveries = (view.webhook?.deliveries ?? []).map((delivery): UpdateEvent => ({
    at: delivery.at,
    via: 'webhook',
    event: delivery.summary ?? delivery.event,
    result: deliveryResult(delivery),
    failed: delivery.error !== undefined,
    durationMs: delivery.durationMs,
  }))
  const polls = view.polling.attempts.map((attempt): UpdateEvent => ({
    at: attempt.at,
    via: 'poll',
    event: attempt.trigger === 'manual' ? 'Poll by hand' : 'Scheduled poll',
    result: attempt.error
      ? `Failed: ${attempt.error}`
      : `${plural(attempt.events ?? 0, 'change')}, ${plural(attempt.enqueued ?? 0, 'job')}`,
    failed: attempt.error !== undefined,
    durationMs: attempt.durationMs,
  }))
  return [...deliveries, ...polls].toSorted((a, b) => b.at.localeCompare(a.at))
}
