import { describe, expect, test } from 'bun:test'

import type { ApiSymbol, PublicApiPackageSummary, PublicApiSymbolHit } from '@holtkeeper/api'

import {
  catalogTotals,
  docSummary,
  documentedShare,
  documentedTone,
  filterHits,
  groupSymbols,
  hitCounts,
  openedSymbol,
  parseDocTags,
  parsePublicApiSearch,
  parseSymbolKey,
  publicApiTab,
  splitImportPath,
  symbolKey,
  versionKey,
  versionLabel,
} from './public-api.ts'

const symbol = (name: string, kind: ApiSymbol['kind'], doc?: string): ApiSymbol => ({
  name,
  kind,
  signature: name,
  file: 'src/index.ts',
  line: 1,
  ...(doc ? { doc } : {}),
})

const hit = (
  name: string,
  importPath: string,
  fields: Partial<PublicApiSymbolHit> = {},
): PublicApiSymbolHit => ({
  package: splitImportPath(importPath).package,
  repo: { forge: 'work', path: 'acme/widget-kit' },
  subpath: splitImportPath(importPath).subpath,
  importPath,
  match: 'prefix',
  deprecated: false,
  removed: false,
  symbol: symbol(name, 'function'),
  ...fields,
})

test('groupSymbols filters by name or doc and orders kinds', () => {
  const symbols = [
    symbol('Props', 'interface'),
    symbol('render', 'function', 'Draws a button'),
    symbol('Button', 'class'),
  ]
  expect(groupSymbols(symbols).map((group) => [group.label, group.symbols.length])).toEqual([
    ['Functions', 1],
    ['Classes', 1],
    ['Interfaces', 1],
  ])
  expect(groupSymbols(symbols, 'button').flatMap((g) => g.symbols.map((s) => s.name))).toEqual([
    'render',
    'Button',
  ])
})

test('versionLabel shows refs that differ from the version', () => {
  const base = { analysisId: 'a', analyzedAt: '2026-10-01T00:00:00Z', exports: 3 }
  expect(versionLabel({ ...base, version: '1.4.0', ref: 'v1.4.0', head: false })).toBe('1.4.0')
  expect(versionLabel({ ...base, version: 'head', head: true, ecosystem: 'Go' })).toBe('head')
  expect(
    versionLabel({
      ...base,
      version: 'v1.3.0',
      ref: 'v1.3.0',
      head: false,
      ecosystem: 'Go',
      package: 'example.com/acme/widgets',
    }),
  ).toBe('v1.3.0 · example.com/acme/widgets')
  expect(versionLabel({ ...base, version: '1.4.0', ref: '@acme/ui@1.4.0', head: false })).toBe(
    '1.4.0 · @acme/ui@1.4.0',
  )
  expect(
    versionLabel({
      ...base,
      version: '3.9.0',
      ref: '8628d6816e870c8a863b98066a30121df1862839',
      head: false,
    }),
  ).toBe('3.9.0 · 8628d681')
  expect(versionLabel({ ...base, version: '1.5.0', head: true })).toBe('head · 1.5.0')
  expect(versionKey({ ...base, version: '1.5.0', head: true })).toBe('head')
})

test('documented share and its tone', () => {
  expect(documentedShare(1, 3)).toBe(33)
  expect(documentedShare(0, 0)).toBeUndefined()
  expect([documentedTone(80), documentedTone(40), documentedTone(39)]).toEqual([
    'success',
    'warning',
    'danger',
  ])
})

const pkg = (name: string, path: string, exports: number, documented: number) =>
  ({
    name,
    private: false,
    repo: { forge: 'work', path },
    dir: '.',
    analysisId: 'a',
    analyzedAt: '2026-11-01T00:00:00Z',
    subpaths: ['.'],
    exports,
    documented,
    deprecated: 0,
    versions: 3,
  }) satisfies PublicApiPackageSummary

test('catalogTotals sums exports, versions and the documented share', () => {
  expect(
    catalogTotals([
      pkg('@acme/widget-kit', 'acme/widget-kit', 30, 27),
      pkg('@acme/test-utils', 'acme/widget-kit', 10, 3),
    ]),
  ).toEqual({ packages: 2, repos: 1, exports: 40, documented: 75, versions: 6 })
})

describe('parsePublicApiSearch', () => {
  test('keeps known values', () => {
    expect(
      parsePublicApiSearch({
        tab: 'search',
        q: 'createWidget',
        sort: 'name',
        package: '@acme/widget-kit',
        repo: 'gitlab:acme/widget-kit',
        subpath: './testing',
        kind: 'function',
        match: 'prefix',
        ref: 'release',
        deprecated: 'true',
        removed: true,
        version: '4.2.0',
        symbol: '@acme/widget-kit:createWidget',
        pane: 'history',
      }),
    ).toEqual({
      tab: 'search',
      q: 'createWidget',
      sort: 'name',
      package: '@acme/widget-kit',
      repo: 'gitlab:acme/widget-kit',
      subpath: './testing',
      kind: 'function',
      match: 'prefix',
      ref: 'release',
      deprecated: true,
      removed: true,
      version: '4.2.0',
      symbol: '@acme/widget-kit:createWidget',
      pane: 'history',
    })
  })

  test('drops unknown values and defaults', () => {
    expect(
      parsePublicApiSearch({
        tab: 'api',
        sort: 'match',
        kind: 'widget',
        match: 'fuzzy',
        ref: 'all',
        deprecated: 'no',
        pane: 'usages',
      }),
    ).toEqual({})
  })

  test('search text opens symbol search unless the catalog was chosen', () => {
    expect(publicApiTab({})).toBe('packages')
    expect(publicApiTab({ q: 'create' })).toBe('search')
    expect(publicApiTab({ q: 'create', tab: 'packages' })).toBe('packages')
  })
})

test('import paths and symbol keys split into package, entry point and name', () => {
  expect(splitImportPath('@acme/widget-kit/testing')).toEqual({
    package: '@acme/widget-kit',
    subpath: './testing',
  })
  expect(splitImportPath('some-lib')).toEqual({ package: 'some-lib', subpath: '.' })
  expect(splitImportPath('some-lib/a/b')).toEqual({ package: 'some-lib', subpath: './a/b' })
  expect(splitImportPath('gitlab.example/shapes/geom/v2')).toEqual({
    package: 'gitlab.example/shapes/geom/v2',
    subpath: '.',
  })
  expect(parseSymbolKey('example.com/acme/widgets:Draw')).toEqual({
    package: 'example.com/acme/widgets',
    subpath: '.',
    name: 'Draw',
  })
  const key = symbolKey(hit('createWidget', '@acme/widget-kit/legacy'))
  expect(key).toBe('@acme/widget-kit/legacy:createWidget')
  expect(parseSymbolKey(key)).toEqual({
    package: '@acme/widget-kit',
    subpath: './legacy',
    name: 'createWidget',
  })
  expect(parseSymbolKey('createWidget')).toBeUndefined()
  expect(parseSymbolKey(undefined)).toBeUndefined()
  expect(parseSymbolKey('widgets/internal/log:Info', 'Go')).toEqual({
    package: 'widgets/internal/log',
    subpath: '.',
    name: 'Info',
  })
  expect(splitImportPath('acme.ui/button', 'npm')).toEqual({
    package: 'acme.ui',
    subpath: './button',
  })
})

test('an opened symbol takes package and ecosystem from its hit, not from the path shape', () => {
  const dotless = hit('Info', 'widgets/internal/log', {
    package: 'widgets/internal/log',
    subpath: '.',
    ecosystem: 'Go',
  })
  expect(openedSymbol(symbolKey(dotless), dotless)).toEqual({
    package: 'widgets/internal/log',
    subpath: '.',
    name: 'Info',
    ecosystem: 'Go',
  })
  const dotted = hit('Button', 'acme.ui/button', { package: 'acme.ui', subpath: './button' })
  expect(openedSymbol(symbolKey(dotted), dotted)).toEqual({
    package: 'acme.ui',
    subpath: './button',
    name: 'Button',
    ecosystem: 'npm',
  })
  expect(openedSymbol('example.com/acme/widgets:Draw', undefined)).toMatchObject({
    package: 'example.com/acme/widgets',
    ecosystem: 'Go',
  })
})

describe('hits', () => {
  const hits = [
    hit('createWidget', '@acme/widget-kit', { ref: 'v4.2.0', match: 'exact' }),
    hit('createWidget', '@acme/widget-kit/legacy', { ref: 'v4.2.0', deprecated: true }),
    hit('buildWidget', '@acme/legacy-forms', { removed: true }),
    hit('applyTheme', '@acme/design-tokens'),
  ]

  test('deprecated and removed stay out unless included; ref narrows to releases or branches', () => {
    expect(filterHits(hits, {}).map(symbolKey)).toEqual([
      '@acme/widget-kit:createWidget',
      '@acme/design-tokens:applyTheme',
    ])
    expect(filterHits(hits, { deprecated: true, removed: true })).toHaveLength(4)
    expect(filterHits(hits, { deprecated: true, ref: 'release' })).toHaveLength(2)
    expect(filterHits(hits, { removed: true, ref: 'head' }).map(symbolKey)).toEqual([
      '@acme/legacy-forms:buildWidget',
      '@acme/design-tokens:applyTheme',
    ])
  })

  test('sorts by name or package on request', () => {
    const all = { deprecated: true, removed: true }
    expect(filterHits(hits, all, 'name').map((h) => h.symbol.name)).toEqual([
      'applyTheme',
      'buildWidget',
      'createWidget',
      'createWidget',
    ])
    expect(filterHits(hits, all, 'package').map((h) => h.importPath)).toEqual([
      '@acme/design-tokens',
      '@acme/legacy-forms',
      '@acme/widget-kit',
      '@acme/widget-kit/legacy',
    ])
  })

  test('counts', () => {
    expect(hitCounts(hits)).toEqual({ deprecated: 1, removed: 1, release: 2, head: 2 })
  })
})

describe('parseDocTags', () => {
  const doc = [
    'Creates a widget and registers it with the nearest {@link WidgetProvider}.',
    '',
    'Pass `options.lazy` to defer mounting.',
    '@param kind - One of the registered {@link WidgetKind | widget kinds}.',
    '@param {WidgetProps} props Initial props;',
    '  later changes go through `widget.update`.',
    '@param [options] - Optional settings.',
    '@typeParam T - The props type.',
    '@returns The widget handle.',
    '@throws {@link WidgetError} outside a provider',
    '@since 3.0.0',
    '@deprecated',
    '@example',
    '```ts',
    "const w = createWidget('card', {})",
    '// @param in a fence is code',
    '```',
    '@see registerWidget',
    '@remarks Lower level than the hook.',
  ].join('\n')

  test('splits the description and block tags', () => {
    const tags = parseDocTags(doc)
    expect(tags.summary).toBe(
      'Creates a widget and registers it with the nearest `WidgetProvider`.\n\nPass `options.lazy` to defer mounting.',
    )
    expect(tags.params).toEqual([
      { name: 'kind', text: 'One of the registered widget kinds.' },
      { name: 'props', text: 'Initial props;\n  later changes go through `widget.update`.' },
      { name: 'options', text: 'Optional settings.' },
    ])
    expect(tags.typeParams).toEqual([{ name: 'T', text: 'The props type.' }])
    expect(tags.returns).toBe('The widget handle.')
    expect(tags.throws).toEqual(['`WidgetError` outside a provider'])
    expect(tags.since).toBe('3.0.0')
    expect(tags.deprecated).toBe('')
    expect(tags.examples).toEqual([
      "```ts\nconst w = createWidget('card', {})\n// @param in a fence is code\n```",
    ])
    expect(tags.see).toEqual(['registerWidget'])
    expect(tags.other).toEqual([{ tag: 'remarks', text: 'Lower level than the hook.' }])
  })

  test('no comment, no tags; the summary preview is the first paragraph on one line', () => {
    expect(parseDocTags(undefined)).toMatchObject({ summary: '', params: [], examples: [] })
    expect(parseDocTags(undefined).deprecated).toBeUndefined()
    expect(docSummary(doc)).toBe(
      'Creates a widget and registers it with the nearest `WidgetProvider`.',
    )
    expect(docSummary('Line one\nline two\n\nMore.')).toBe('Line one line two')
  })
})
