import { describe, expect, test } from 'bun:test'

import type { BotMessageLocale, BotMessagesOverview } from '@holtkeeper/api'
import { headerAuth } from '@holtkeeper/auth-header'
import { parseConfig } from '@holtkeeper/core'
import { createCredentialService } from '@holtkeeper/credentials'
import { kvMessageStore, resolveMessages } from '@holtkeeper/messages'
import { reviewMessageCatalog } from '@holtkeeper/review'
import { builtinSettings } from '@holtkeeper/settings'
import { memoryStore } from '@holtkeeper/store/memory'
import { aesVault } from '@holtkeeper/vault'

import { createApp } from '../src/app.ts'

const now = () => new Date('2026-11-15T12:00:00.000Z')

const as = (role: string, init: RequestInit = {}) => ({
  ...init,
  headers: {
    'x-forwarded-user': role,
    'x-forwarded-groups': role,
    'content-type': 'application/json',
  },
})

function setup() {
  const store = memoryStore()
  const vault = aesVault('v'.repeat(32))
  const app = createApp({
    config: parseConfig({
      forges: { work: { kind: 'fake', url: 'https://forge.test', create: () => ({}) as never } },
    }),
    auth: headerAuth({
      roles: {
        admin: [{ scope: { all: true }, actions: ['*'] }],
        reader: [{ scope: { all: true }, actions: ['settings:read'] }],
      },
    }),
    store,
    vault,
    credentials: createCredentialService({ credentials: store.credentials, vault }),
    settings: builtinSettings,
    analyses: [],
    now,
  })
  return { app, store }
}

describe('bot message routes', () => {
  test('lists catalogs and translated locales with their states', async () => {
    const { app, store } = setup()
    const kv = store.kv
    if (!kv) throw new Error('the memory store has a key-value store')
    await resolveMessages({
      catalog: reviewMessageCatalog,
      locale: 'ru',
      store: kvMessageStore(kv),
      translator: {
        translate: async ({ items }) =>
          Object.fromEntries(items.slice(1).map((item) => [item.key, `RU ${item.text}`])),
      },
    })
    const overview = (await (
      await app.request('/api/messages', as('reader'))
    ).json()) as BotMessagesOverview
    expect(overview.available).toBe(true)
    expect(overview.settings).toEqual({ autoTranslate: true, terms: [] })
    const review = overview.catalogs.find((catalog) => catalog.id === 'review')
    const total = Object.keys(reviewMessageCatalog.messages).length
    expect(review?.locales).toEqual([
      {
        locale: 'ru',
        label: 'Russian',
        counts: { translated: total - 1, manual: 0, outdated: 0, missing: 1 },
      },
    ])
    const locale = (await (
      await app.request('/api/messages/review/ru', as('reader'))
    ).json()) as BotMessageLocale
    expect(locale.rows[0]?.state).toBe('missing')
    expect(locale.terms).toContain('Severity')
  })

  test('saves a person’s translation after checking it and resets it', async () => {
    const { app } = setup()
    const put = (text: string, role = 'admin') =>
      app.request(
        '/api/messages/review/ru/summary.nothingNew',
        as(role, { method: 'PUT', body: JSON.stringify({ text }) }),
      )
    expect((await put('Ничего нового', 'reader')).status).toBe(403)
    const bad = await app.request(
      '/api/messages/review/ru/scope.full',
      as('admin', { method: 'PUT', body: JSON.stringify({ text: 'Проверено' }) }),
    )
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('placeholders')
    expect((await put('Ничего нового для проверки.')).status).toBe(200)
    const view = (await (
      await app.request('/api/messages/review/ru', as('admin'))
    ).json()) as BotMessageLocale
    expect(view.rows.find((row) => row.key === 'summary.nothingNew')).toMatchObject({
      state: 'manual',
      text: 'Ничего нового для проверки.',
      by: 'admin',
    })
    const retranslate = await app.request(
      '/api/messages/review/ru/retranslate',
      as('admin', { method: 'POST' }),
    )
    expect(await retranslate.json()).toEqual({ dropped: 0 })
    await app.request(
      '/api/messages/review/ru/summary.nothingNew',
      as('admin', { method: 'DELETE' }),
    )
    const after = (await (
      await app.request('/api/messages/review/ru', as('admin'))
    ).json()) as BotMessageLocale
    expect(after.rows.find((row) => row.key === 'summary.nothingNew')?.state).toBe('missing')
  })

  test('validates locales and settings', async () => {
    const { app } = setup()
    expect((await app.request('/api/messages/review/en', as('admin'))).status).toBe(400)
    expect((await app.request('/api/messages/review/Russian', as('admin'))).status).toBe(400)
    expect((await app.request('/api/messages/widgets/ru', as('admin'))).status).toBe(404)
    const saved = await app.request(
      '/api/messages/settings',
      as('admin', {
        method: 'PUT',
        body: JSON.stringify({ autoTranslate: false, terms: ['Shelf', 'Shelf'] }),
      }),
    )
    expect(await saved.json()).toEqual({ autoTranslate: false, terms: ['Shelf'] })
    const invalid = await app.request(
      '/api/messages/settings',
      as('admin', { method: 'PUT', body: JSON.stringify({ autoTranslate: 'yes' }) }),
    )
    expect(invalid.status).toBe(400)
  })
})
