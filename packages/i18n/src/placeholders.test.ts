import { describe, expect, test } from 'bun:test'

import { comparePlaceholders, messageShape } from './placeholders.ts'
import { pluralCategories, pluralSuffix } from './plurals.ts'

describe('messageShape', () => {
  test('finds i18next, ICU, printf and Trans tag placeholders', () => {
    expect(messageShape('Hi {{name}}, {{ count, number }}').tokens).toEqual([
      '{{name}}',
      '{{count}}',
    ])
    expect(messageShape('Hello {user}').tokens).toEqual(['{user}'])
    expect(messageShape('%s has %d items, 100% sure').tokens).toEqual(['%s', '%d'])
    expect(messageShape('Click <0>here</0> or <br/>').tokens).toEqual(['<0>', '<br>'])
  })

  test('reads ICU plural branches and nested arguments', () => {
    const shape = messageShape('{count, plural, offset:1 one {# item for {name}} other {# items}}')
    expect(shape.plurals).toEqual([
      { argument: 'count', kind: 'plural', selectors: ['one', 'other'] },
    ])
    expect(shape.tokens.toSorted()).toEqual(['{count}', '{name}'])
  })

  test('ignores quoted braces', () => {
    expect(messageShape("Use '{literal}' here").tokens).toEqual([])
  })
})

describe('comparePlaceholders', () => {
  test('reports missing and unexpected tokens', () => {
    expect(comparePlaceholders(['{{name}}', '%s', '%s'], ['%s', '{{nam}}'])).toEqual({
      missing: ['{{name}}', '%s'],
      unexpected: ['{{nam}}'],
    })
  })

  test('lets named placeholders repeat', () => {
    expect(comparePlaceholders(['{name}'], ['{name}', '{name}'])).toEqual({
      missing: [],
      unexpected: [],
    })
  })
})

describe('plurals', () => {
  test('embedded CLDR table and Intl fallback', () => {
    expect(pluralCategories('ru')).toEqual(['one', 'few', 'many', 'other'])
    expect(pluralCategories('pt-BR')).toEqual(['one', 'many', 'other'])
    expect(pluralCategories('ja')).toEqual(['other'])
    expect(pluralCategories('ro')).toContain('few')
  })

  test('splits i18next plural suffixes', () => {
    expect(pluralSuffix('items_few')).toEqual({ stem: 'items', category: 'few', ordinal: false })
    expect(pluralSuffix('place_ordinal_two')).toEqual({
      stem: 'place_ordinal',
      category: 'two',
      ordinal: true,
    })
    expect(pluralSuffix('items')).toBeUndefined()
  })
})
