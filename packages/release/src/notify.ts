import { type Notification, type Notifier, genericWebhook, slackWebhook } from '@holtkeeper/notify'

import type { ReleaseNotifySettings } from './settings.ts'
import type { ReleaseEvent } from './types.ts'

const titles: Record<ReleaseEvent['kind'], (event: ReleaseEvent) => string> = {
  proposed: (event) => `Release candidate proposed for ${event.repo.path}`,
  merged: (event) => `Release candidate merged in ${event.repo.path}`,
  accepted: (event) => `Changes accepted for release in ${event.repo.path}`,
  versioned: (event) => `${event.repo.path} ${event.tag ?? event.version ?? ''} released`.trim(),
  'deploy-started': (event) => `Deploying ${event.repo.path} ${event.tag} to ${event.environment}`,
  'deploy-succeeded': (event) => `${event.repo.path} ${event.tag} deployed to ${event.environment}`,
  'deploy-failed': (event) =>
    `Deploy of ${event.repo.path} ${event.tag} to ${event.environment} failed`,
}

const tones: Record<ReleaseEvent['kind'], Notification['tone']> = {
  proposed: 'info',
  merged: 'info',
  accepted: 'good',
  versioned: 'good',
  'deploy-started': 'info',
  'deploy-succeeded': 'good',
  'deploy-failed': 'bad',
}

/** A channel-independent message for a release event. */
export function releaseNotification(event: ReleaseEvent): Notification {
  const fields = [
    { label: 'Repository', value: event.repo.path },
    ...(event.tag ? [{ label: 'Version', value: event.tag }] : []),
    ...(event.environment ? [{ label: 'Environment', value: event.environment }] : []),
    { label: 'By', value: event.actor },
  ]
  return {
    title: titles[event.kind](event),
    text: event.detail ?? '',
    ...(event.url ? { url: event.url } : {}),
    tone: tones[event.kind],
    fields,
  }
}

/** Notifiers of the targets that subscribe to `kind`. */
export function releaseNotifiers(
  settings: ReleaseNotifySettings | undefined,
  kind: ReleaseEvent['kind'],
): Notifier[] {
  return (settings?.targets ?? [])
    .filter((target) => !target.events?.length || target.events.includes(kind))
    .map((target) =>
      target.kind === 'slack'
        ? slackWebhook({ url: target.url, button: 'Open' })
        : genericWebhook({ url: target.url }),
    )
}

/** Sends an event to every subscribed target; failures are returned, never thrown. */
export async function announce(
  settings: ReleaseNotifySettings | undefined,
  event: ReleaseEvent,
): Promise<string[]> {
  const message = releaseNotification(event)
  const results = await Promise.allSettled(
    releaseNotifiers(settings, event.kind).map((notifier) => notifier.send(message)),
  )
  return results.flatMap((result) =>
    result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  )
}
