import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  analyzeI18n,
  diskCatalogFiles,
  i18nAnalysis,
  i18nAnalyzer,
  i18nDataSchema,
  i18nOptions,
} from '../src/index.ts'
import type { I18nData } from '../src/index.ts'
import { applied, project } from './fixtures.ts'

const repo = { forge: 'work', path: 'web/shop' }

const files = {
  'public/locales/en/common.json': {
    home: { title: 'Home', greeting: 'Hello {{name}}' },
    items_one: '{{count}} item',
    items_other: '{{count}} items',
    welcome: 'Welcome <1>back</1>',
    errors: { network: 'Network error' },
    old: { unused: 'Unused text' },
  },
  'public/locales/en/auth.json': { login: 'Log in to your account' },
  'public/locales/ru/common.json': {
    home: { title: 'Главная', greeting: 'Привет {{nam}}' },
    items_one: '{{count}} товар',
    items_few: '{{count}} товара',
    items_other: '{{count}} товаров',
    errors: { network: 'Ошибка сети' },
    old: { unused: 'Не используется' },
    only: { ru: 'Только тут' },
  },
  'public/locales/ru/auth.json': { login: 'Log in to your account' },
  'public/locales/de/common.json':
    '{\n    "home": {\n        "title": "Startseite"\n    },\n    "items_one": "{{count}} Artikel",\n    "items_other": "{{count}} Artikel",\n    "errors": {\n        "network": "Netzwerkfehler"\n    }\n}\n',
  'locale/en.po':
    'msgid ""\nmsgstr ""\n"Language: en\\n"\n\nmsgid "Hello"\nmsgstr "Hello"\n\nmsgid "Goodbye %s"\nmsgstr "Goodbye %s"\n\nmsgid "%d file"\nmsgid_plural "%d files"\nmsgstr[0] "%d file"\nmsgstr[1] "%d files"\n',
  'locale/ru.po':
    'msgid ""\nmsgstr ""\n"Language: ru\\n"\n"Plural-Forms: nplurals=3;\\n"\n\nmsgid "Hello"\nmsgstr "Привет"\n\nmsgid "%d file"\nmsgid_plural "%d files"\nmsgstr[0] "%d файл"\nmsgstr[1] "%d файла"\nmsgstr[2] ""\n',
  'src/App.tsx': [
    "import { Trans, useTranslation } from 'react-i18next'",
    'export function App({ code, n }: { code: string; n: number }) {',
    '  const { t } = useTranslation()',
    '  return (',
    '    <main>',
    "      <h1>{t('home.title')}</h1>",
    "      <p>{t('home.greeting', { name: 'x' })}</p>",
    "      <p>{t('items', { count: n })}</p>",
    '      <Trans i18nKey="welcome">Welcome <b>back</b></Trans>',
    "      <a>{t('auth:login')}</a>",
    "      <i>{t('missing.inBase')}</i>",
    '      <s>{t(`errors.${code}`)}</s>',
    '    </main>',
    '  )',
    '}',
  ].join('\n'),
  'package.json': { name: 'shop' },
}

const record = (d: I18nData, createdAt: string) => ({
  id: createdAt,
  repo,
  kind: 'i18n',
  createdAt,
  data: d,
})

let fixture: Awaited<ReturnType<typeof project>>
let data: I18nData

beforeAll(async () => {
  fixture = await project(files)
  data = await analyzeI18n({ repo, code: diskCatalogFiles(fixture.dir), mode: 'suggest' })
})
afterAll(() => fixture.cleanup())

describe('single repository', () => {
  test('detects catalogs and the base locale', () => {
    expect(data.baseLocale).toBe('en')
    expect(data.formats).toEqual(['json', 'po'])
    expect(data.bundles.map((b) => b.id)).toEqual([
      'locale/{locale}.po',
      'public/locales/{locale}/auth.json',
      'public/locales/{locale}/common.json',
    ])
    expect(data.locales.map((l) => l.locale)).toEqual(['en', 'de', 'ru'])
    expect(i18nDataSchema.safeParse(data).success).toBe(true)
  })

  test('finds missing, extra, untranslated, placeholder and plural gaps', () => {
    const missing = data.missing.map((m) => `${m.locale}:${m.key}`).toSorted()
    expect(missing).toEqual([
      'de:%d file',
      'de:Goodbye %s',
      'de:Hello',
      'de:home.greeting',
      'de:login',
      'de:old.unused',
      'de:welcome',
      'ru:Goodbye %s',
      'ru:welcome',
    ])
    expect(data.missing.find((m) => m.locale === 'de' && m.key === 'login')?.file).toBe(
      'public/locales/de/auth.json',
    )
    expect(data.extra.map((e) => `${e.locale}:${e.key}`)).toEqual(['ru:only.ru'])
    expect(data.untranslated.map((u) => `${u.locale}:${u.key}:${u.reason}`)).toEqual([
      'ru:login:identical',
    ])
    expect(data.placeholders).toEqual([
      expect.objectContaining({
        key: 'home.greeting',
        locale: 'ru',
        missing: ['{{name}}'],
        unexpected: ['{{nam}}'],
      }),
    ])
    expect(
      data.plurals.map((p) => `${p.locale}:${p.key}:${p.missing.join(',')}`).toSorted(),
    ).toEqual(['ru:%d file:[2]', 'ru:items:many'])
    const ru = data.locales.find((l) => l.locale === 'ru')!
    expect(ru.missing).toBe(2)
    expect(ru.completeness).toBe(Math.round(((data.keys - 2 - 1) / data.keys) * 1000) / 10)
  })

  test('reports usage against the base catalogs', () => {
    expect(data.usage.missingInBase.map((u) => [u.key, u.file, u.line])).toEqual([
      ['missing.inBase', 'src/App.tsx', 11],
    ])
    expect(data.usage.dynamic.map((d) => d.prefix)).toEqual(['errors.'])
    expect(data.usage.unused.map((u) => u.key).toSorted()).toEqual([
      '%d file',
      'Goodbye %s',
      'Hello',
      'old.unused',
    ])
    expect(data.usage.unused.every((u) => u.layer === 'local' && !u.shared)).toBe(true)
  })

  test('missing-key changes apply cleanly and keep each file’s formatting', async () => {
    const missingChanges = data.changes.filter((c) => c.id.startsWith('i18n:missing:'))
    expect(missingChanges.every((c) => c.confidence === 'review' && !c.target)).toBe(true)
    const { plan, files: out } = await applied(fixture.dir, missingChanges)
    expect(plan.conflicts).toEqual([])

    const ru = out.get('public/locales/ru/common.json')!
    expect(JSON.parse(ru).welcome).toBe('TODO: Welcome <1>back</1>')
    expect(JSON.parse(ru).items_many).toBe('TODO: {{count}} items')
    expect(ru.indexOf('"items_many"')).toBeLessThan(ru.indexOf('"items_other"'))
    expect(ru.indexOf('"items_other"')).toBeLessThan(ru.indexOf('"welcome"'))
    expect(ru.indexOf('"welcome"')).toBeLessThan(ru.indexOf('"errors"'))

    const de = out.get('public/locales/de/common.json')!
    expect(de).toBe(
      '{\n    "home": {\n        "title": "Startseite",\n        "greeting": "TODO: Hello {{name}}"\n    },\n    "items_one": "{{count}} Artikel",\n    "items_other": "{{count}} Artikel",\n    "welcome": "TODO: Welcome <1>back</1>",\n    "errors": {\n        "network": "Netzwerkfehler"\n    },\n    "old": {\n        "unused": "TODO: Unused text"\n    }\n}\n',
    )
    expect(JSON.parse(out.get('public/locales/de/auth.json')!)).toEqual({
      login: 'TODO: Log in to your account',
    })
    expect(
      data.changes.find((c) => c.id === 'i18n:missing:public/locales/de/auth.json')?.edits[0]?.kind,
    ).toBe('create')

    const po = out.get('locale/ru.po')!
    expect(po).toContain(
      'msgstr "Привет"\n\n#, fuzzy\nmsgid "Goodbye %s"\nmsgstr "TODO: Goodbye %s"\n\nmsgid "%d file"',
    )
    const de_po = out.get('locale/de.po')!
    expect(de_po).toContain(
      'msgid_plural "%d files"\nmsgstr[0] "TODO: %d file"\nmsgstr[1] "TODO: %d file"',
    )

    for (const [file, content] of out)
      if (file.endsWith('.json')) expect(() => JSON.parse(content!)).not.toThrow()
  })

  test('applying the changes closes the gaps', async () => {
    const { files: out } = await applied(
      fixture.dir,
      data.changes.filter((c) => c.id.startsWith('i18n:missing:')),
    )
    const next = await project({
      ...files,
      ...Object.fromEntries([...out].map(([f, c]) => [f, c!])),
    })
    try {
      const again = await analyzeI18n({ repo, code: diskCatalogFiles(next.dir), mode: 'suggest' })
      expect(again.missing).toEqual([])
      expect(again.changes.filter((c) => c.id.startsWith('i18n:missing:'))).toEqual([])
      expect(again.untranslated.filter((u) => u.reason === 'fuzzy').length).toBeGreaterThan(0)
    } finally {
      await next.cleanup()
    }
  })

  test('unused-key removal is a separate change', async () => {
    const removal = data.changes.filter((c) => c.id.startsWith('i18n:unused:'))
    expect(removal.map((c) => c.id).toSorted()).toEqual([
      'i18n:unused:locale/{locale}.po',
      'i18n:unused:public/locales/{locale}/common.json',
    ])
    const { files: out } = await applied(fixture.dir, removal)
    expect(JSON.parse(out.get('public/locales/en/common.json')!).old).toBeUndefined()
    expect(JSON.parse(out.get('public/locales/ru/common.json')!).old).toBeUndefined()
  })

  test('report mode produces no changes', async () => {
    const report = await analyzeI18n({ repo, code: diskCatalogFiles(fixture.dir) })
    expect(report.mode).toBe('report')
    expect(report.changes).toEqual([])
    expect(report.missing.length).toBe(data.missing.length)
  })

  test('the report compares with the previous record', () => {
    const previous = {
      ...data,
      missing: data.missing.slice(1),
      locales: data.locales.map((l) => ({ ...l, completeness: l.completeness - 10 })),
    }
    const report = i18nAnalysis.toReport(
      record(data, '2026-10-30T00:00:00Z'),
      record(previous, '2026-10-01T00:00:00Z'),
    )
    expect(report.sections.map((s) => s.id)).toEqual([
      'completeness',
      'missing',
      'placeholders',
      'usage',
      'changes',
    ])
    expect(report.metrics.find((m) => m.id === 'missing')?.delta).toBe(1)
    expect(report.metrics.find((m) => m.id === 'completeness')?.delta).toBe(10)
    const changes = report.sections.at(-1)!.blocks[0]!
    expect(changes.type === 'changes' && changes.applicable && changes.items.length).toBe(
      data.changes.length,
    )
    expect(i18nAnalysis.changes?.(data)).toBe(data.changes)
  })

  test('the analyzer runs on a checkout with parsed options', async () => {
    const options = i18nOptions.parse({ mode: 'suggest', fill: 'empty', ignoreKeys: 'old.*' })
    const { data: result } = await i18nAnalyzer.run({
      repo,
      dir: fixture.dir,
      runner: undefined as never,
      options,
    })
    expect(result.usage.unused.map((u) => u.key)).not.toContain('old.unused')
    const ru = result.changes.find((c) => c.id === 'i18n:missing:public/locales/ru/common.json')!
    const edit = ru.edits[0]!
    expect(edit.kind === 'replace' && JSON.parse(edit.newText).welcome).toBe('')
  })
})
