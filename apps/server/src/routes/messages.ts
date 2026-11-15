import type {
  BotMessageLocale,
  BotMessageLocaleSummary,
  BotMessagesOverview,
  BotMessageState,
} from '@holtkeeper/api'
import {
  DEFAULT_MESSAGE_SETTINGS,
  DEFAULT_TERMS,
  type MessageCatalog,
  type MessageStore,
  SOURCE_LOCALE,
  kvMessageStore,
  localeLabel,
  messageRows,
  messageSettingsSchema,
  normalizeLocale,
  sourceHash,
  termsOf,
  translationProblem,
} from '@holtkeeper/messages'
import { reviewMessageCatalog } from '@holtkeeper/review'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'

import { type Env, type ServerDeps, authorize } from '../context.ts'

const GLOBAL = { kind: 'global' } as const

/** Every catalog of fixed texts the server's modules post. */
const messageCatalogs: readonly MessageCatalog[] = [reviewMessageCatalog]

/** The store of bot message translations; `undefined` without a key-value store. */
const messageStoreOf = (deps: Pick<ServerDeps, 'store'>): MessageStore | undefined =>
  deps.store.kv ? kvMessageStore(deps.store.kv) : undefined

const inputSchema = z.object({ text: z.string().trim().min(1).max(4000) })

const emptyCounts = (): Record<BotMessageState, number> => ({
  translated: 0,
  manual: 0,
  outdated: 0,
  missing: 0,
})

/** The catalog `id` names; 404 when there is none. */
const catalogOf = (id: string) => {
  const catalog = messageCatalogs.find((candidate) => candidate.id === id)
  if (!catalog) throw new HTTPException(404, { message: `unknown message catalog ${id}` })
  return catalog
}
/** A translatable locale given as its base language code; 400 otherwise. */
const localeOf = (value: string) => {
  const locale = normalizeLocale(value)
  if (!locale || locale !== value)
    throw new HTTPException(400, { message: 'locale must be a language code such as ru' })
  if (locale === SOURCE_LOCALE)
    throw new HTTPException(400, { message: 'English is the source language' })
  return locale
}

/**
 * Bot messages admin: the fixed texts Holtkeeper posts on merge requests (`messageCatalogs`) and
 * their translations. `GET /messages` and `GET /messages/:catalog/:locale` need a global
 * `settings:read`; `PUT /messages/settings` (automatic translation, extra terms),
 * `PUT|DELETE /messages/:catalog/:locale/:key` (a person's translation, or dropping one so it is
 * translated again) and `POST /messages/:catalog/:locale/retranslate` (drops every automatic
 * translation of the locale) need a global `settings:write` and are audited.
 */
export function messageRoutes(deps: ServerDeps) {
  const app = new Hono<Env>()

  const storeOf = () => {
    const store = messageStoreOf(deps)
    if (!store) throw new HTTPException(503, { message: 'no key-value store is configured' })
    return store
  }

  app.get('/messages', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const store = messageStoreOf(deps)
    const settings = store ? await store.settings() : DEFAULT_MESSAGE_SETTINGS
    const catalogs = await Promise.all(
      messageCatalogs.map(async (catalog) => {
        const terms = termsOf(catalog, settings)
        const summaries = !store
          ? []
          : await Promise.all(
              (await store.locales(catalog.id)).map(
                async (locale): Promise<BotMessageLocaleSummary> => {
                  const stored = await store.read(catalog.id, locale)
                  const counts = emptyCounts()
                  for (const row of messageRows(catalog, stored, terms)) counts[row.state]++
                  return {
                    locale,
                    label: localeLabel(locale),
                    counts,
                    ...(stored.failedAt && { failedAt: stored.failedAt }),
                    ...(stored.failure && { failure: stored.failure }),
                  }
                },
              ),
            )
        return {
          id: catalog.id,
          title: catalog.title,
          messages: Object.keys(catalog.messages).length,
          locales: summaries,
        }
      }),
    )
    return c.json<BotMessagesOverview>({
      available: store !== undefined,
      settings,
      builtInTerms: [...DEFAULT_TERMS],
      catalogs,
    })
  })

  app.put('/messages/settings', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const store = storeOf()
    const parsed = messageSettingsSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message })
    const before = await store.settings()
    const settings = { ...parsed.data, terms: [...new Set(parsed.data.terms)] }
    await store.saveSettings(settings)
    c.set('audit', {
      action: 'messages.settings',
      target: { type: 'messages', id: 'settings' },
      changes: [
        { field: 'autoTranslate', before: before.autoTranslate, after: settings.autoTranslate },
        { field: 'terms', before: before.terms, after: settings.terms },
      ],
    })
    return c.json(settings)
  })

  app.get('/messages/:catalog/:locale', async (c) => {
    authorize(c, 'settings:read', GLOBAL)
    const store = storeOf()
    const catalog = catalogOf(c.req.param('catalog'))
    const locale = localeOf(c.req.param('locale'))
    const terms = termsOf(catalog, await store.settings())
    return c.json<BotMessageLocale>({
      catalog: catalog.id,
      title: catalog.title,
      locale,
      label: localeLabel(locale),
      terms,
      rows: messageRows(catalog, await store.read(catalog.id, locale), terms),
    })
  })

  app.put('/messages/:catalog/:locale/:key', async (c) => {
    const principal = authorize(c, 'settings:write', GLOBAL)
    const store = storeOf()
    const catalog = catalogOf(c.req.param('catalog'))
    const locale = localeOf(c.req.param('locale'))
    const key = c.req.param('key')
    const definition = Object.hasOwn(catalog.messages, key) ? catalog.messages[key] : undefined
    if (!definition) throw new HTTPException(404, { message: `unknown message ${key}` })
    const input = inputSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!input.success) throw new HTTPException(400, { message: 'text is required' })
    // Terms are a rule for the model; a person may deliberately word a term differently.
    const problem = translationProblem(definition.text, input.data.text)
    if (problem) throw new HTTPException(400, { message: problem })
    const terms = termsOf(catalog, await store.settings())
    const before = (await store.read(catalog.id, locale)).entries[key]
    await store.update(catalog.id, locale, (current) => ({
      ...current,
      entries: {
        ...current.entries,
        [key]: {
          text: input.data.text,
          sourceHash: sourceHash(definition.text, terms),
          origin: 'manual',
          updatedAt: deps.now().toISOString(),
          by: principal.name || principal.id,
        },
      },
    }))
    c.set('audit', {
      action: 'messages.translate',
      target: { type: 'messages', id: `${catalog.id}/${locale}/${key}` },
      changes: [{ field: 'text', before: before?.text, after: input.data.text }],
    })
    return c.json({ ok: true })
  })

  app.delete('/messages/:catalog/:locale/:key', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const store = storeOf()
    const catalog = catalogOf(c.req.param('catalog'))
    const locale = localeOf(c.req.param('locale'))
    const key = c.req.param('key')
    const before = (await store.read(catalog.id, locale)).entries[key]
    await store.update(catalog.id, locale, (current) => ({
      ...current,
      entries: Object.fromEntries(
        Object.entries(current.entries).filter(([entry]) => entry !== key),
      ),
    }))
    c.set('audit', {
      action: 'messages.reset',
      target: { type: 'messages', id: `${catalog.id}/${locale}/${key}` },
      changes: [{ field: 'text', before: before?.text, after: undefined }],
    })
    return c.json({ ok: true })
  })

  app.post('/messages/:catalog/:locale/retranslate', async (c) => {
    authorize(c, 'settings:write', GLOBAL)
    const store = storeOf()
    const catalog = catalogOf(c.req.param('catalog'))
    const locale = localeOf(c.req.param('locale'))
    let dropped = 0
    await store.update(catalog.id, locale, (current) => {
      const kept = Object.entries(current.entries).filter(([, entry]) => entry.origin === 'manual')
      dropped = Object.keys(current.entries).length - kept.length
      return { entries: Object.fromEntries(kept) }
    })
    c.set('audit', {
      action: 'messages.retranslate',
      target: { type: 'messages', id: `${catalog.id}/${locale}` },
      details: { dropped },
    })
    return c.json({ dropped })
  })

  return app
}
