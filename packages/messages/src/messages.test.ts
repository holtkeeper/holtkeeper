import { describe, expect, test } from 'bun:test'

import type { Agent, AgentTask } from '@holtkeeper/agent'

import { defineCatalog, formatMessage, placeholdersOf, sourceHash } from './catalog.ts'
import { detectLocale, localeLabel, normalizeLocale } from './locale.ts'
import { messageRows, resolveMessages, termsOf } from './resolve.ts'
import { DEFAULT_MESSAGE_SETTINGS, kvMessageStore, memoryMessageStore } from './store.ts'
import { type Translator, agentTranslator } from './translate.ts'
import { translationProblem } from './validate.ts'

const catalog = defineCatalog({
  id: 'widgets',
  title: 'Widgets',
  messages: {
    hello: { text: 'Hello, {name}!', note: 'Greeting' },
    count: { text: 'Found {count} widgets in the Package `{file}`.' },
  },
})

const at = (iso: string) => () => new Date(iso)

/** A translator that prefixes every text with `locale:` and records its calls. */
function recordingTranslator(change: (text: string) => string = (text) => `[t] ${text}`) {
  const calls: { locale: string; keys: string[]; previous: (string | undefined)[] }[] = []
  const translator: Translator = {
    async translate({ locale, items }) {
      calls.push({ locale, keys: items.map((i) => i.key), previous: items.map((i) => i.previous) })
      return Object.fromEntries(items.map((item) => [item.key, change(item.text)]))
    },
  }
  return { translator, calls }
}

describe('catalog helpers', () => {
  test('formatMessage fills known placeholders and keeps unknown ones', () => {
    expect(formatMessage('{a} and {b}', { a: 1 })).toBe('1 and {b}')
    expect(placeholdersOf('{a} {b} {a}')).toEqual(['a', 'b', 'a'])
  })

  test('sourceHash changes with the text and with the terms the text uses', () => {
    const base = sourceHash('Check the Package', ['Package'])
    expect(sourceHash('Check the Package', ['Package'])).toBe(base)
    expect(sourceHash('Check the Package!', ['Package'])).not.toBe(base)
    expect(sourceHash('Check the Package', [])).not.toBe(base)
    expect(sourceHash('Check the Package', ['Package', 'Unrelated'])).toBe(base)
  })
})

describe('translationProblem', () => {
  test('accepts a faithful translation', () => {
    expect(
      translationProblem(
        'Found {count} in `a.ts`, see Package',
        'Найдено {count} в `a.ts`, см. Package',
        ['Package'],
      ),
    ).toBeUndefined()
  })

  test.each([
    ['', 'empty'],
    ['Найдено', 'placeholders'],
    ['Найдено {count} {count}', 'placeholders'],
    ['Найдено {count} в a.ts', 'code'],
    ['Найдено {count} в `a.ts` <!-- x -->', 'HTML comments'],
    ['Найдено {count} в `a.ts` @all', 'mention'],
    ['Найдено {count} в `a.ts` https://example.test', 'links'],
    ['Найдено {count} в `a.ts`, см. пакет', 'Package'],
  ])('rejects %p', (translation, reason) => {
    expect(
      translationProblem('Found {count} in `a.ts`, see Package', translation, ['Package']),
    ).toContain(reason)
  })
})

describe('locales', () => {
  test('normalizeLocale reads codes and names', () => {
    expect(normalizeLocale('ru')).toBe('ru')
    expect(normalizeLocale('pt_BR')).toBe('pt')
    expect(normalizeLocale('Russian')).toBe('ru')
    expect(normalizeLocale('русский')).toBe('ru')
    expect(normalizeLocale('German')).toBe('de')
    expect(normalizeLocale('Klingon-ish prose')).toBeUndefined()
    expect(normalizeLocale(' ')).toBeUndefined()
    expect(localeLabel('ru')).toBe('Russian')
  })

  test('detectLocale tells scripts and common Latin languages apart', () => {
    expect(
      detectLocale('Добавляет кеширование для `fetchWidget` и retry при ошибках API сервера'),
    ).toBe('ru')
    expect(detectLocale('Додає кешування віджетів і повторні спроби для запитів')).toBe('uk')
    expect(detectLocale('Adds caching for the widget list and retries on errors')).toBe('en')
    expect(
      detectLocale('Fügt einen Cache für die Liste hinzu und das ist nicht mit der alten API'),
    ).toBe('de')
    expect(detectLocale('ok')).toBeUndefined()
    expect(detectLocale('```\nconst a = 1\n```')).toBeUndefined()
  })
})

describe('resolveMessages', () => {
  test('English needs no store or translator', async () => {
    const messages = await resolveMessages({ catalog, locale: 'en' })
    expect(messages.t('hello', { name: 'Ann' })).toBe('Hello, Ann!')
  })

  test('translates missing messages once, stores them and reuses them', async () => {
    const store = memoryMessageStore()
    const { translator, calls } = recordingTranslator()
    const first = await resolveMessages({ catalog, locale: 'ru', store, translator })
    expect(first.t('hello', { name: 'Ann' })).toBe('[t] Hello, Ann!')
    const second = await resolveMessages({ catalog, locale: 'ru', store, translator })
    expect(second.t('count', { count: 2, file: 'x' })).toBe(
      '[t] Found 2 widgets in the Package `x`.',
    )
    expect(calls).toHaveLength(1)
    expect(await store.locales('widgets')).toEqual(['ru'])
  })

  test('a changed English text outdates its translation and is translated again', async () => {
    const store = memoryMessageStore()
    const terms = termsOf(catalog, DEFAULT_MESSAGE_SETTINGS)
    await store.update('widgets', 'ru', () => ({
      entries: {
        hello: {
          text: 'Привет, {name}!',
          sourceHash: sourceHash('Hi, {name}!', terms),
          origin: 'manual',
          updatedAt: '2026-01-01T00:00:00.000Z',
          by: 'ann',
        },
      },
    }))
    expect(messageRows(catalog, await store.read('widgets', 'ru'), terms)[0]?.state).toBe(
      'outdated',
    )
    const offline = await resolveMessages({ catalog, locale: 'ru', store })
    expect(offline.t('hello', { name: 'Ann' })).toBe('Hello, Ann!')

    const { translator, calls } = recordingTranslator()
    const messages = await resolveMessages({ catalog, locale: 'ru', store, translator })
    expect(calls[0]?.keys).toEqual(['hello', 'count'])
    expect(calls[0]?.previous[0]).toBe('Привет, {name}!')
    expect(messages.t('hello', { name: 'Ann' })).toBe('[t] Hello, Ann!')
    const entry = (await store.read('widgets', 'ru')).entries.hello
    expect(entry).toMatchObject({ origin: 'auto', previous: 'Привет, {name}!' })
  })

  test('keeps current manual translations and skips invalid answers', async () => {
    const store = memoryMessageStore()
    const terms = termsOf(catalog, DEFAULT_MESSAGE_SETTINGS)
    await store.update('widgets', 'ru', () => ({
      entries: {
        hello: {
          text: 'Привет, {name}!',
          sourceHash: sourceHash('Hello, {name}!', terms),
          origin: 'manual',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }))
    const { translator, calls } = recordingTranslator(() => 'без плейсхолдеров')
    const logs: string[] = []
    const messages = await resolveMessages({
      catalog,
      locale: 'ru',
      store,
      translator,
      log: (line) => logs.push(line),
    })
    expect(calls[0]?.keys).toEqual(['count'])
    expect(messages.t('hello', { name: 'Ann' })).toBe('Привет, Ann!')
    expect(messages.t('count', { count: 1, file: 'f' })).toBe('Found 1 widgets in the Package `f`.')
    expect(logs.join('\n')).toContain('placeholders')
  })

  test('a person’s edit made during a translation wins', async () => {
    const store = memoryMessageStore()
    const translator: Translator = {
      async translate({ items }) {
        await store.update('widgets', 'ru', (current) => ({
          entries: {
            ...current.entries,
            hello: {
              text: 'Здравствуйте, {name}!',
              sourceHash: 'whatever',
              origin: 'manual',
              updatedAt: '2026-02-02T00:00:00.000Z',
            },
          },
        }))
        return Object.fromEntries(items.map((item) => [item.key, item.text]))
      },
    }
    await resolveMessages({ catalog, locale: 'ru', store, translator })
    expect((await store.read('widgets', 'ru')).entries.hello?.text).toBe('Здравствуйте, {name}!')
  })

  test('a failed translation is not retried within the hour', async () => {
    const store = memoryMessageStore()
    let calls = 0
    const translator: Translator = {
      async translate() {
        calls++
        throw new Error('model unavailable')
      },
    }
    const english = await resolveMessages({
      catalog,
      locale: 'de',
      store,
      translator,
      now: at('2026-03-01T10:00:00Z'),
    })
    expect(english.t('hello', { name: 'A' })).toBe('Hello, A!')
    await resolveMessages({
      catalog,
      locale: 'de',
      store,
      translator,
      now: at('2026-03-01T10:30:00Z'),
    })
    expect(calls).toBe(1)
    await resolveMessages({
      catalog,
      locale: 'de',
      store,
      translator,
      now: at('2026-03-01T11:01:00Z'),
    })
    expect(calls).toBe(2)
    expect((await store.read('widgets', 'de')).failure).toBe('model unavailable')
  })

  test('with automatic translation off nothing is translated', async () => {
    const store = memoryMessageStore()
    await store.saveSettings({ autoTranslate: false, terms: [] })
    const { translator, calls } = recordingTranslator()
    const messages = await resolveMessages({ catalog, locale: 'ru', store, translator })
    expect(messages.t('hello', { name: 'A' })).toBe('Hello, A!')
    expect(calls).toHaveLength(0)
  })

  test('a new term outdates only the messages using it', async () => {
    const store = memoryMessageStore()
    const { translator, calls } = recordingTranslator()
    await resolveMessages({ catalog, locale: 'ru', store, translator })
    await store.saveSettings({ autoTranslate: true, terms: ['widgets'] })
    await resolveMessages({ catalog, locale: 'ru', store, translator })
    expect(calls.map((call) => call.keys)).toEqual([['hello', 'count'], ['count']])
  })
})

describe('kvMessageStore', () => {
  test('retries an update when compareAndSet loses a race', async () => {
    const values = new Map<string, unknown>()
    let conflicts = 1
    const store = kvMessageStore({
      get: async (key) => values.get(key),
      set: async (key, value) => {
        values.set(key, value)
      },
      compareAndSet: async (key, _expected, value) => {
        if (conflicts-- > 0) return false
        values.set(key, value)
        return true
      },
    })
    let runs = 0
    await store.update('widgets', 'ru', (current) => {
      runs++
      return current
    })
    expect(runs).toBe(2)
    expect(await store.settings()).toEqual(DEFAULT_MESSAGE_SETTINGS)
  })
})

describe('agentTranslator', () => {
  test('asks the fast tier once without tools and maps the answer by key', async () => {
    const tasks: AgentTask[] = []
    const agent: Agent = {
      name: 'fake',
      async run<Output>(task: AgentTask<Output>) {
        tasks.push(task)
        return {
          text: '',
          output: { items: [{ key: 'hello', text: 'Привет, {name}!' }] } as Output,
          turns: 1,
        }
      },
    }
    let tracked = 0
    const translated = await agentTranslator({ agent, track: () => tracked++ }).translate({
      locale: 'ru',
      items: [{ key: 'hello', text: 'Hello, {name}!' }],
      terms: ['Package'],
    })
    expect(translated).toEqual({ hello: 'Привет, {name}!' })
    expect(tasks[0]).toMatchObject({
      tier: 'fast',
      maxTurns: 1,
      capabilities: [],
      taskKind: 'translate',
    })
    expect(tasks[0]?.system).toContain('Russian (ru)')
    expect(tasks[0]?.system).toContain('Package')
    expect(tracked).toBe(1)
  })
})
