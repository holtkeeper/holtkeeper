import { expect, test } from 'bun:test'

import { parsePath, selectPath } from './jsonpath.ts'

test('parses and selects the supported subset', () => {
  expect(parsePath("$.a['b c'][0][*].*")).toEqual([
    { kind: 'prop', name: 'a' },
    { kind: 'prop', name: 'b c' },
    { kind: 'index', index: 0 },
    { kind: 'wildcard' },
    { kind: 'wildcard' },
  ])
  const doc = { flags: { a: true, b: false }, features: [{ name: 'x' }, { name: 'y' }] }
  expect(selectPath(doc, '$.flags.*').map((match) => match.member)).toEqual(['a', 'b'])
  expect(selectPath(doc, '$.features[*].name').map((match) => match.value)).toEqual(['x', 'y'])
  expect(selectPath(doc, '$.features[1]')[0]?.path).toEqual(['features', 1])
  expect(selectPath(doc, '$.missing.*')).toEqual([])
  expect(() => parsePath('flags')).toThrow()
  expect(() => parsePath('$..flags')).toThrow()
})
