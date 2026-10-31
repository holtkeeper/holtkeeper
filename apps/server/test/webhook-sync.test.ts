import { describe, expect, test } from 'bun:test'

import { parseConfig } from '@holtkeeper/core'
import { type WebhookSpec, type WebhookTarget, webhookEvents } from '@holtkeeper/forge'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { repoHooks } from '../src/repo-hooks.ts'
import { syncWebhooks } from '../src/webhook-sync.ts'

const vault = aesVault('v'.repeat(32))
const at = '2026-10-31T12:00:00.000Z'

describe('syncWebhooks', () => {
  test('re-registers hooks missing events with their URL and secret, once', async () => {
    const store = memoryStore()
    const calls: { target: WebhookTarget; hook: WebhookSpec }[] = []
    const forge = {
      kind: 'gitlab',
      url: 'https://gitlab.test',
      create: () => ({
        ensureWebhook: async (target: WebhookTarget, hook: WebhookSpec) => {
          calls.push({ target, hook })
          return { id: '1', hooks: [] }
        },
      }),
    }
    const config = parseConfig({
      forges: { work: forge },
      groups: { libs: { forge: 'work', include: ['games/libs'] } },
    })
    if (!store.kv || !store.config) throw new Error('memory store has kv and config')
    const hooks = repoHooks(store.kv, vault)
    const repo = { forge: 'work', path: 'games/libs' }
    const { token, hook } = await hooks.rotate(repo, at)
    const url = `https://hk.test/api/webhooks/r/${token}`
    await hooks.save(repo, {
      ...hook,
      registered: [{ hookId: '7', scope: 'project', target: 'games/libs', url }],
    })
    await store.config.put({
      type: 'forge',
      id: 'work',
      updatedAt: at,
      data: {
        kind: 'gitlab',
        url: 'https://gitlab.test',
        credentialId: 'c',
        webhook: {
          secret: await vault.seal('forge-secret'),
          createdAt: at,
          registered: [
            {
              hookId: '1',
              scope: 'group',
              target: 'games',
              url: 'https://hk.test/api/webhooks/work',
            },
            {
              hookId: '2',
              scope: 'group',
              target: 'tools',
              url: 'https://hk.test/api/webhooks/work',
              events: [...webhookEvents],
            },
          ],
        },
      },
    })
    const deps = { config, store, vault, now: () => new Date(at) }

    expect(await syncWebhooks(deps)).toEqual({ updated: 2, failed: 0 })
    expect(calls.map((call) => [call.target, call.hook.url, call.hook.secret])).toEqual([
      [{ group: 'games' }, 'https://hk.test/api/webhooks/work', 'forge-secret'],
      [{ project: 'games/libs' }, url, token],
    ])
    expect(calls[0]?.hook.events).toEqual([...webhookEvents])
    expect((await hooks.get(repo))?.registered?.[0]?.events).toEqual([...webhookEvents])

    expect(await syncWebhooks(deps)).toEqual({ updated: 0, failed: 0 })
    expect(calls).toHaveLength(2)
  })
})
