import { describe, expect, test } from 'bun:test'

import { extract, extractorSchema } from './index.ts'

const file = { file: 'x' }

describe('json-path', () => {
  test('member names of an object, scalar values as attribute value', () => {
    const text = '{\n  "flags": {\n    "a": true,\n    "b": { "default": false }\n  }\n}\n'
    expect(extract(text, { kind: 'json-path', path: '$.flags.*' }, file)).toEqual([
      { key: 'a', line: 3, attrs: { value: 'true' } },
      { key: 'b', line: 4, attrs: {} },
    ])
  })

  test('array items with key and attribute mapping', () => {
    const text = JSON.stringify(
      { features: [{ name: 'x', default: true, description: 'X' }, { name: 'y' }] },
      null,
      2,
    )
    const config = extractorSchema.parse({
      kind: 'json-path',
      path: '$.features[*]',
      key: '$.name',
      attrs: { default: '$.default', description: '$.description' },
    })
    expect(extract(text, config, file).map(({ key, attrs }) => ({ key, attrs }))).toEqual([
      { key: 'x', attrs: { default: 'true', description: 'X' } },
      { key: 'y', attrs: {} },
    ])
  })

  test('selected values and forced keys', () => {
    const text =
      '{ "features": [{ "name": "x" }, { "name": "y" }], "list": ["p", "q"], "m": { "k": "v" } }'
    expect(
      extract(text, { kind: 'json-path', path: '$.features[*].name' }, file).map(
        (found) => found.key,
      ),
    ).toEqual(['x', 'y'])
    expect(
      extract(text, { kind: 'json-path', path: '$.list[*]' }, file).map((found) => found.key),
    ).toEqual(['p', 'q'])
    expect(
      extract(text, { kind: 'json-path', path: '$.m.*', select: 'value' }, file).map(
        (found) => found.key,
      ),
    ).toEqual(['v'])
  })

  test('accepts JSONC and throws on invalid JSON', () => {
    expect(
      extract('{ // c\n "a": { "x": 1, }, }', { kind: 'json-path', path: '$.a.*' }, file)[0]?.key,
    ).toBe('x')
    expect(() => extract('{', { kind: 'json-path', path: '$.*' }, file)).toThrow()
  })
})

test('yaml-path', () => {
  const text = 'featureFlags:\n  new_lobby: true\n  turbo: "off"\nother: 1\n'
  expect(extract(text, { kind: 'yaml-path', path: '$.featureFlags.*' }, file)).toEqual([
    { key: 'new_lobby', line: 2, attrs: { value: 'true' } },
    { key: 'turbo', line: 3, attrs: { value: 'off' } },
  ])
})

test('regex with named groups and lines', () => {
  const text = 'a\nFLAG(new_lobby, on)\nb\nFLAG(turbo, off) FLAG(x, on)\n'
  expect(
    extract(text, { kind: 'regex', pattern: 'FLAG\\((?<key>\\w+), (?<state>\\w+)\\)' }, file),
  ).toEqual([
    { key: 'new_lobby', line: 2, attrs: { state: 'on' } },
    { key: 'turbo', line: 4, attrs: { state: 'off' } },
    { key: 'x', line: 4, attrs: { state: 'on' } },
  ])
  expect(
    extract('v1 v2', { kind: 'regex', pattern: 'v(\\d)' }, file).map((found) => found.key),
  ).toEqual(['1', '2'])
})

test('env', () => {
  const text = '# comment\nFEATURE_A=true\nexport FEATURE_B="x y" \nOTHER=1\nFEATURE_C=on # note\n'
  expect(extract(text, { kind: 'env', keys: 'FEATURE_*' }, file)).toEqual([
    { key: 'FEATURE_A', line: 2, attrs: { value: 'true' } },
    { key: 'FEATURE_B', line: 3, attrs: { value: 'x y' } },
    { key: 'FEATURE_C', line: 5, attrs: { value: 'on' } },
  ])
})

describe('ast-grep', () => {
  const code =
    'if (isEnabled(\'new_lobby\')) {}\nconst t = isEnabled("turbo", true)\nisEnabled(name)\nflags.bonus\n'

  test('captures string literal keys with lines and attributes', () => {
    expect(
      extract(code, { kind: 'ast-grep', pattern: 'isEnabled($KEY)' }, { file: 'a.ts' }),
    ).toEqual([
      { key: 'new_lobby', line: 1, attrs: {} },
      { key: 'name', line: 3, attrs: {} },
    ])
    expect(
      extract(
        code,
        { kind: 'ast-grep', pattern: 'isEnabled($KEY, $DEFAULT)', attrs: { fallback: 'DEFAULT' } },
        { file: 'a.ts' },
      ),
    ).toEqual([{ key: 'turbo', line: 2, attrs: { fallback: 'true' } }])
    expect(
      extract(code, { kind: 'ast-grep', pattern: 'flags.$KEY' }, { file: 'a.js' }).map(
        (found) => found.key,
      ),
    ).toEqual(['bonus'])
  })

  test('picks the language from the extension or config', () => {
    expect(
      extract(
        'const a = <A on={isEnabled("x")} />',
        { kind: 'ast-grep', pattern: 'isEnabled($KEY)' },
        { file: 'a.tsx' },
      )[0]?.key,
    ).toBe('x')
    expect(
      extract(
        'isEnabled("x")',
        { kind: 'ast-grep', pattern: 'isEnabled($KEY)', language: 'javascript' },
        { file: 'a.txt' },
      ),
    ).toHaveLength(1)
    expect(() => extract('x', { kind: 'ast-grep', pattern: 'x' }, { file: 'a.rb' })).toThrow(
      /no parser/,
    )
  })
})

test('lines', () => {
  const text = '# flags\nnew_lobby\n\n  turbo  \n'
  expect(extract(text, { kind: 'lines' }, file)).toEqual([
    { key: 'new_lobby', line: 2, attrs: {} },
    { key: 'turbo', line: 4, attrs: {} },
  ])
  expect(
    extract(
      'a = 1\nb = 2\nnope\n',
      { kind: 'lines', pattern: '^(?<key>\\w+) = (?<value>\\d+)$' },
      file,
    ),
  ).toEqual([
    { key: 'a', line: 1, attrs: { value: '1' } },
    { key: 'b', line: 2, attrs: { value: '2' } },
  ])
})
