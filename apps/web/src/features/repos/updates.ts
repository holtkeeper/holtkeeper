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
