import type { WebhookHealthSummary, WebhookHealthView } from '@holtkeeper/api'

import { formatRelative, plural } from './format.ts'

const isDisabled = (entry: WebhookHealthView) =>
  entry.state === 'disabled' || entry.state === 'temporarily_disabled'

/** Holtkeeper's hooks that GitLab currently keeps from delivering. */
export const disabledHooks = (health: readonly WebhookHealthView[] | undefined) =>
  (health ?? []).filter(isDisabled)

type LabelTone = 'success' | 'warning' | 'danger' | 'default'

const stateLabels: Record<WebhookHealthView['state'], { text: string; tone: LabelTone }> = {
  enabled: { text: 'Delivering', tone: 'success' },
  temporarily_disabled: { text: 'Paused by GitLab', tone: 'warning' },
  disabled: { text: 'Disabled by GitLab', tone: 'danger' },
  missing: { text: 'Gone from GitLab', tone: 'warning' },
  unknown: { text: 'Not checked', tone: 'default' },
}

/** A hook's state as a short label with its tone. */
export function hookStateLabel(
  entry: WebhookHealthView,
  now: Date = new Date(),
): { text: string; tone: LabelTone } {
  if (entry.state === 'enabled' && entry.reenabledAt)
    return { text: `Re-enabled ${formatRelative(entry.reenabledAt, now)}`, tone: 'success' }
  return stateLabels[entry.state]
}

/**
 * What the repository's Updates panel says while GitLab keeps one of Holtkeeper's hooks from
 * delivering; `undefined` when none is disabled. A disabled hook with no `retryAt`,
 * `reenabledAt` or `lastError` is one Holtkeeper cannot re-enable, so the notice sends the user to
 * GitLab; without `polling` it says nothing picks up changes meanwhile.
 */
export function webhookDisabledNotice(
  health: readonly WebhookHealthView[] | undefined,
  polling: boolean,
  now: Date = new Date(),
): { title: string; detail: string; tone: 'warning' | 'danger' } | undefined {
  const disabled = disabledHooks(health)
  if (disabled.length === 0) return undefined
  const meanwhile = polling
    ? 'Polling stands in meanwhile.'
    : 'Polling is off for this repository, so no updates arrive until the hook is back.'
  const reenabling = disabled.some(
    (entry) =>
      entry.retryAt !== undefined ||
      entry.reenabledAt !== undefined ||
      entry.lastError !== undefined,
  )
  if (!reenabling)
    return {
      title: 'Webhook disabled by GitLab',
      detail: `${meanwhile} Holtkeeper cannot turn it back on; re-enable it in GitLab under Settings › Webhooks.`,
      tone: polling ? 'warning' : 'danger',
    }
  const failing = disabled.find((entry) => entry.lastError !== undefined)
  const next = disabled
    .map((entry) => entry.retryAt)
    .filter((at) => at !== undefined)
    .toSorted()[0]
  const stuck = (failing?.failures ?? 0) >= 3
  const parts = [meanwhile]
  if (failing) parts.push(`The last attempt failed: ${failing.lastError}.`)
  parts.push(
    next
      ? `Next try ${formatRelative(next, now)}.`
      : 'Holtkeeper turns the hook back on within 15 minutes.',
  )
  return {
    title: stuck ? 'Webhook disabled by GitLab' : 'Webhook disabled by GitLab — re-enabling',
    detail: parts.join(' '),
    tone: stuck || !polling ? 'danger' : 'warning',
  }
}

/** The forge card's line about Holtkeeper's hooks; `undefined` before the first check. */
export function webhookHealthLine(
  summary: WebhookHealthSummary | undefined,
  now: Date = new Date(),
): { text: string; tone: 'muted' | 'warning' } | undefined {
  if (!summary || summary.total === 0) return undefined
  const parts = [
    `${plural(summary.total, 'hook')} checked ${formatRelative(summary.checkedAt, now)}`,
  ]
  if (summary.disabled) parts.push(`${summary.disabled} disabled by GitLab`)
  if (summary.reenabled24h) parts.push(`${summary.reenabled24h} re-enabled today`)
  if (summary.missing) parts.push(`${summary.missing} gone`)
  if (summary.unknown) parts.push(`${summary.unknown} not readable`)
  return {
    text: parts.join(' · '),
    tone: summary.disabled || summary.unknown || summary.missing ? 'warning' : 'muted',
  }
}
