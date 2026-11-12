import { describe, expect, test } from 'bun:test'

import type { WebhookHealthView } from '@holtkeeper/api'

import {
  disabledHooks,
  hookStateLabel,
  webhookDisabledNotice,
  webhookHealthLine,
} from './webhook-health.ts'

const now = new Date('2026-11-12T10:00:00.000Z')

const entry = (fields: Partial<WebhookHealthView>): WebhookHealthView => ({
  owner: 'forge',
  scope: 'group',
  target: 'shapes',
  hookId: '1',
  state: 'enabled',
  checkedAt: '2026-11-12T09:55:00.000Z',
  ...fields,
})

describe('webhook health', () => {
  test('labels each state', () => {
    expect(hookStateLabel(entry({}), now)).toEqual({ text: 'Delivering', tone: 'success' })
    expect(hookStateLabel(entry({ reenabledAt: '2026-11-12T09:55:00.000Z' }), now).text).toBe(
      'Re-enabled 5 minutes ago',
    )
    expect(hookStateLabel(entry({ state: 'temporarily_disabled' }), now).tone).toBe('warning')
    expect(hookStateLabel(entry({ state: 'disabled' }), now).text).toBe('Disabled by GitLab')
    expect(hookStateLabel(entry({ state: 'missing' }), now).text).toBe('Gone from GitLab')
    expect(hookStateLabel(entry({ state: 'unknown' }), now).text).toBe('Not checked')
  })

  test('the Updates notice appears only while a hook is disabled', () => {
    expect(webhookDisabledNotice(undefined, true, now)).toBeUndefined()
    expect(webhookDisabledNotice([entry({})], true, now)).toBeUndefined()
    expect(disabledHooks([entry({}), entry({ state: 'disabled' })])).toHaveLength(1)
    expect(
      webhookDisabledNotice(
        [entry({ state: 'temporarily_disabled', reenabledAt: '2026-11-12T08:00:00.000Z' })],
        true,
        now,
      ),
    ).toEqual({
      title: 'Webhook disabled by GitLab — re-enabling',
      detail: 'Polling stands in meanwhile. Holtkeeper turns the hook back on within 15 minutes.',
      tone: 'warning',
    })
    expect(
      webhookDisabledNotice(
        [
          entry({
            state: 'disabled',
            failures: 3,
            lastError: 'Hook execution failed',
            retryAt: '2026-11-12T11:00:00.000Z',
          }),
        ],
        true,
        now,
      ),
    ).toEqual({
      title: 'Webhook disabled by GitLab',
      detail:
        'Polling stands in meanwhile. The last attempt failed: Hook execution failed. Next try in 1 hour.',
      tone: 'danger',
    })
  })

  test('the Updates notice sends the user to GitLab when Holtkeeper cannot re-enable', () => {
    expect(webhookDisabledNotice([entry({ state: 'disabled' })], true, now)).toEqual({
      title: 'Webhook disabled by GitLab',
      detail:
        'Polling stands in meanwhile. Holtkeeper cannot turn it back on; re-enable it in GitLab under Settings › Webhooks.',
      tone: 'warning',
    })
  })

  test('the Updates notice does not promise polling when it is off', () => {
    expect(
      webhookDisabledNotice(
        [entry({ state: 'disabled', retryAt: '2026-11-12T10:15:00.000Z' })],
        false,
        now,
      ),
    ).toEqual({
      title: 'Webhook disabled by GitLab — re-enabling',
      detail:
        'Polling is off for this repository, so no updates arrive until the hook is back. Next try in 15 minutes.',
      tone: 'danger',
    })
  })

  test('the forge card line counts disabled and re-enabled hooks', () => {
    expect(webhookHealthLine(undefined, now)).toBeUndefined()
    const summary = {
      checkedAt: '2026-11-12T09:55:00.000Z',
      total: 4,
      disabled: 0,
      missing: 0,
      unknown: 0,
      reenabled24h: 0,
    }
    expect(webhookHealthLine({ ...summary, total: 0 }, now)).toBeUndefined()
    expect(webhookHealthLine(summary, now)).toEqual({
      text: '4 hooks checked 5 minutes ago',
      tone: 'muted',
    })
    expect(webhookHealthLine({ ...summary, disabled: 1, reenabled24h: 3 }, now)).toEqual({
      text: '4 hooks checked 5 minutes ago · 1 disabled by GitLab · 3 re-enabled today',
      tone: 'warning',
    })
  })
})
