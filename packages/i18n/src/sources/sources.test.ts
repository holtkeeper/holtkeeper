import { describe, expect, test } from 'bun:test'

import { locateCatalog } from '../locate.ts'
import { insertJson, jsonEntries, removeJson } from './json.ts'
import { parsePo, poSource } from './po.ts'
import { propertiesSource } from './properties.ts'
import { yamlEntries } from './yaml.ts'

describe('locateCatalog', () => {
  test('recognizes the usual layouts', () => {
    expect(locateCatalog('public/locales/pt_BR/common.json')).toEqual({
      locale: 'pt-BR',
      namespace: 'common',
      bundle: 'public/locales/{locale}/common.json',
    })
    expect(locateCatalog('src/i18n/de.json')).toEqual({
      locale: 'de',
      bundle: 'src/i18n/{locale}.json',
    })
    expect(locateCatalog('res/messages_ru.properties')).toEqual({
      locale: 'ru',
      namespace: 'messages',
      bundle: 'res/messages_{locale}.properties',
    })
    expect(locateCatalog('src/config/settings.json')).toBeUndefined()
  })
})

describe('json', () => {
  const nested = '{\n    "a": "A",\n    "group": {\n        "x": "X",\n        "z": "Z"\n    }\n}\n'

  test('flattens nested, flat and formatjs catalogs', () => {
    expect(jsonEntries(nested).map((e) => [e.key, e.value, e.line])).toEqual([
      ['a', 'A', 2],
      ['group.x', 'X', 4],
      ['group.z', 'Z', 5],
    ])
    expect(jsonEntries('{"a.b": "1"}').map((e) => e.key)).toEqual(['a.b'])
    expect(jsonEntries('{"hi": {"defaultMessage": "Hi", "description": "d"}}')[0]?.value).toBe('Hi')
    expect(
      jsonEntries('{"hi": [{"type": 0, "value": "Hi "}, {"type": 1, "value": "name"}]}')[0]?.value,
    ).toBe('Hi {name}')
  })

  test('inserts next to the nearest sibling with the file indentation', () => {
    const order = ['a', 'b', 'group.x', 'group.y', 'group.z', 'other.deep']
    const result = insertJson(
      nested,
      [
        { key: 'group.y', value: 'Y' },
        { key: 'b', value: 'B' },
        { key: 'other.deep', value: 'D' },
      ],
      order,
    )
    expect(result).toBe(
      '{\n    "a": "A",\n    "b": "B",\n    "group": {\n        "x": "X",\n        "y": "Y",\n        "z": "Z"\n    },\n    "other": {\n        "deep": "D"\n    }\n}\n',
    )
    expect(JSON.parse(result)).toBeTruthy()
  })

  test('keeps flat keys flat and compact files compact', () => {
    expect(insertJson('{"a.b":"1"}', [{ key: 'a.c', value: '2' }], ['a.b', 'a.c'])).toBe(
      '{"a.b":"1","a.c":"2"}',
    )
    expect(insertJson('{}\n', [{ key: 'x.y', value: '1' }], ['x.y'])).toBe(
      '{\n  "x": {\n    "y": "1"\n  }\n}\n',
    )
    expect(insertJson('{\n  "first": {}\n}', [{ key: 'first.k', value: 'v' }], ['first.k'])).toBe(
      '{\n  "first": {\n    "k": "v"\n  }\n}',
    )
  })

  test('mirrors formatjs message objects', () => {
    const text = '{\n  "a": {\n    "defaultMessage": "A"\n  }\n}'
    expect(insertJson(text, [{ key: 'b', value: 'B' }], ['a', 'b'])).toBe(
      '{\n  "a": {\n    "defaultMessage": "A"\n  },\n  "b": {\n    "defaultMessage": "B"\n  }\n}',
    )
  })

  test('removes keys and the objects they leave empty', () => {
    expect(removeJson(nested, ['group.x', 'group.z'])).toBe('{\n    "a": "A"\n}\n')
    expect(removeJson(nested, ['a'])).toBe(
      '{\n    "group": {\n        "x": "X",\n        "z": "Z"\n    }\n}\n',
    )
    expect(removeJson('{"only":"1"}', ['only'])).toBe('{}')
  })
})

describe('po', () => {
  const po = [
    'msgid ""',
    'msgstr ""',
    '"Language: ru\\n"',
    '"Plural-Forms: nplurals=3; plural=(n%10==1 ? 0 : 1);\\n"',
    '',
    '#: app.py:1',
    'msgid "Hello"',
    'msgstr "Привет"',
    '',
    '#, fuzzy',
    'msgctxt "menu"',
    'msgid "Open"',
    'msgstr "Открыть"',
    '',
    'msgid "%d file"',
    'msgid_plural "%d files"',
    'msgstr[0] "%d файл"',
    'msgstr[1] "%d файла"',
    'msgstr[2] ""',
    '',
  ].join('\n')

  test('parses entries, contexts, plurals and the header', () => {
    const parsed = parsePo(po)
    expect(parsed.pluralForms).toBe(3)
    expect(parsed.locale).toBe('ru')
    expect(parsed.entries.map((e) => e.key)).toEqual(['Hello', 'menu\u0004Open', '%d file'])
    expect(parsed.entries[1]?.fuzzy).toBe(true)
    expect(parsed.entries[2]?.forms).toEqual(['%d файл', '%d файла', ''])
  })

  test('inserts entries after their sibling and removes them', () => {
    const source = poSource()
    const base = parsePo('msgid "Bye"\nmsgstr ""\n').entries[0]!
    const inserted = source.insert!(
      po,
      [{ key: 'Bye', value: 'TODO: Bye', base }],
      ['Hello', 'Bye', 'menu\u0004Open'],
    )
    expect(inserted).toContain(
      'msgstr "Привет"\n\n#, fuzzy\nmsgid "Bye"\nmsgstr "TODO: Bye"\n\n#, fuzzy\nmsgctxt',
    )
    expect(parsePo(inserted).entries.map((e) => e.key)).toEqual([
      'Hello',
      'Bye',
      'menu\u0004Open',
      '%d file',
    ])
    expect(source.remove!(inserted, ['Bye'])).toBe(po)
  })
})

describe('properties and yaml', () => {
  test('properties round trip with continuation lines', () => {
    const source = propertiesSource()
    const text = '# comment\ngreeting = Hello \\\n  world\nbye = Bye\n'
    expect(source.parse(text, 'messages.properties').entries.map((e) => [e.key, e.value])).toEqual([
      ['greeting', 'Hello world'],
      ['bye', 'Bye'],
    ])
    const added = source.insert!(
      text,
      [{ key: 'mid', value: 'Привет' }],
      ['greeting', 'mid', 'bye'],
    )
    expect(added).toBe(
      '# comment\ngreeting = Hello \\\n  world\nmid = \\u041f\\u0440\\u0438\\u0432\\u0435\\u0442\nbye = Bye\n',
    )
    expect(source.remove!(added, ['mid'])).toBe(text)
    expect(source.locate!('src/messages.properties')?.bundle).toBe(
      'src/messages_{locale}.properties',
    )
  })

  test('yaml unwraps a Rails locale root', () => {
    expect(
      yamlEntries('ru:\n  menu:\n    open: Открыть\n  count: 3\n').map((e) => [
        e.key,
        e.value,
        e.line,
      ]),
    ).toEqual([
      ['menu.open', 'Открыть', 3],
      ['count', '3', 4],
    ])
  })
})
