import { describe, expect, test } from 'bun:test'

import type { RepoUpdatesView } from '@holtkeeper/api'

import { deliveryResult, pollingCadence, updateEvents } from './updates.ts'

const view = (
  polling: Partial<RepoUpdatesView['polling']>,
  viaWebhook = false,
): RepoUpdatesView => ({
  repo: { forge: 'work', path: 'acme/widget-kit' },
  polling: {
    enabled: true,
    intervalMs: 300_000,
    events: ['mergeRequests'],
    withWebhookMs: 3_600_000,
    key: 'forge:work',
    attempts: [],
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

describe('updateEvents', () => {
  test('merges deliveries and polls newest first', () => {
    const events = updateEvents({
      ...view({
        attempts: [
          { at: '2026-11-10T10:00:00.000Z', trigger: 'scheduled', durationMs: 120, events: 1 },
          { at: '2026-11-10T08:00:00.000Z', trigger: 'manual', durationMs: 90, error: 'timeout' },
        ],
      }),
      webhook: {
        createdAt: '2026-11-01T00:00:00.000Z',
        deliveries24h: { total: 2, failed: 1 },
        deliveries: [
          {
            at: '2026-11-10T11:00:00.000Z',
            event: 'Push Hook',
            summary: 'push to main, 2 commits',
            enqueued: 2,
            durationMs: 8,
          },
          {
            at: '2026-11-10T09:00:00.000Z',
            event: 'Note Hook',
            enqueued: 0,
            error: 'unreadable body',
            durationMs: 1,
          },
        ],
      },
    })
    expect(events.map((e) => [e.via, e.event, e.result, e.failed])).toEqual([
      ['webhook', 'push to main, 2 commits', '2 jobs queued', false],
      ['poll', 'Scheduled poll', '1 change, 0 jobs', false],
      ['webhook', 'Note Hook', 'Rejected: unreadable body', true],
      ['poll', 'Poll by hand', 'Failed: timeout', true],
    ])
  })

  test('says why a delivery queued nothing', () => {
    expect(
      deliveryResult({
        at: '',
        event: 'Tag Push Hook',
        enqueued: 0,
        ignored: 'tag was deleted',
        durationMs: 0,
      }),
    ).toBe('Ignored: tag was deleted')
  })
})
