import { describe, expect, test } from 'bun:test'

import type { RepoUpdatesView } from '@holtkeeper/api'

import { pollingCadence } from './updates.ts'

const view = (
  polling: Partial<RepoUpdatesView['polling']>,
  viaWebhook = false,
): RepoUpdatesView => ({
  repo: { forge: 'work', path: 'games/a' },
  polling: {
    enabled: true,
    intervalMs: 300_000,
    events: ['mergeRequests'],
    withWebhookMs: 3_600_000,
    key: 'forge:work',
    ...polling,
  },
  viaWebhook,
  canRegister: true,
})

describe('pollingCadence', () => {
  test('says when polling is off or paused by webhooks', () => {
    expect(pollingCadence(view({ enabled: false })).text).toBe('Off')
    expect(pollingCadence(view({ withWebhookMs: undefined }, true))).toMatchObject({
      text: 'Paused',
      tone: 'success',
    })
  })

  test('warns when the token budget slows polling down', () => {
    const cadence = pollingCadence(view({ effectiveIntervalMs: 900_000, stretch: 3 }))
    expect(cadence.tone).toBe('warning')
    expect(cadence.detail).toContain('×3.0')
  })
})
