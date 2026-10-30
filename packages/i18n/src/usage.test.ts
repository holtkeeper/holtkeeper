import { expect, test } from 'bun:test'

import { DEFAULT_FUNCTIONS, parsePattern, scanSource, type UsagePattern } from './usage.ts'

const patterns = DEFAULT_FUNCTIONS.map((spec) => parsePattern(spec)!) satisfies UsagePattern[]

test('parses function patterns', () => {
  expect(parsePattern('useTranslation().t')).toEqual({ kind: 'call', callee: 't' })
  expect(parsePattern('formatMessage({ id })')).toEqual({ kind: 'call', callee: 'formatMessage' })
  expect(parsePattern('<Trans i18nKey>')).toEqual({
    kind: 'jsx',
    element: 'Trans',
    attribute: 'i18nKey',
  })
})

test('finds static keys, namespaces and dynamic calls in TSX', () => {
  const code = [
    "const { t } = useTranslation('common')",
    "t('home.title')",
    "i18n.t('auth:login', { count: 2 })",
    "t('menu.open', { ns: 'nav' })",
    't(`errors.${code}`)',
    "t('prefix.' + name)",
    't(key)',
    "intl.formatMessage({ id: 'app.greeting' })",
    'const el = <Trans i18nKey="welcome" values={{ name }} />',
    "const other = <Trans i18nKey={'bye'}>x</Trans>",
    "foo.t('not.this')",
  ].join('\n')
  const found = scanSource('src/App.tsx', code, patterns)
  expect(found.keys.map((k) => [k.key, k.namespace ?? '', k.line])).toEqual([
    ['home.title', '', 2],
    ['auth:login', '', 3],
    ['menu.open', 'nav', 4],
    ['app.greeting', '', 8],
    ['welcome', '', 9],
    ['bye', '', 10],
  ])
  expect(found.dynamic.map((d) => [d.text, d.prefix ?? ''])).toEqual([
    ['`errors.${code}`', 'errors.'],
    ["'prefix.' + name", 'prefix.'],
    ['key', ''],
  ])
})

test('scans Vue templates by text', () => {
  const found = scanSource(
    'src/App.vue',
    '<p>{{ $t("hello.world") }}</p>\n<p>{{ $t(`x.${y}`) }}</p>',
    patterns,
  )
  expect(found.keys).toEqual([{ key: 'hello.world', file: 'src/App.vue', line: 1, column: 7 }])
  expect(found.dynamic[0]?.prefix).toBe('x.')
})
