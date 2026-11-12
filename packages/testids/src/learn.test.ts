import { describe, expect, test } from 'bun:test'

import {
  learnTestIdOptions,
  renderTestIdConvention,
  suggestTestId,
  testIdConvention,
  testIdOverridesOf,
} from './learn.ts'
import type { TestIdComponent, TestIdsData } from './model.ts'

const component = (name: string, values: [string, string][]): TestIdComponent => ({
  name,
  file: `src/${name}.tsx`,
  source: 'jsx',
  total: values.length,
  elements: values.map(([tag, value], i) => ({
    line: i + 1,
    tag,
    attributes: [{ name: 'data-qa', value }],
  })),
})

const element = (line: number, name: string, value: string, dynamic?: boolean) => ({
  line,
  tag: 'div',
  attributes: [{ name, value, ...(dynamic ? { dynamic } : {}) }],
})

const catalog = (components: TestIdComponent[]): TestIdsData => ({
  attributes: ['data-qa'],
  components,
})

describe('learnTestIdOptions', () => {
  test('learns the attribute, kebab names prefixed with the component and element kinds', () => {
    const many = Array.from({ length: 10 }, (_, i): [string, string] => [
      i % 2 ? 'button' : 'S.Input',
      `widget-card-part-${i}`,
    ])
    const learned = learnTestIdOptions(
      catalog([
        component('WidgetCard', many),
        component('ShapeList', [
          ['a', 'shape-list-row'],
          ...many.map(([tag], i): [string, string] => [tag, `shape-list-item-${i}`]),
        ]),
      ]),
    )
    expect(learned).toEqual({
      attribute: 'data-qa',
      attributes: ['data-qa'],
      elements: ['a', 'button', 'input'],
      naming: { separator: '-', case: 'lower', prefix: 'component' },
      examples: ['widget-card-part-0', 'widget-card-part-1', 'widget-card-part-2'],
      tagged: 21,
    })
  })

  test('keeps default elements for small catalogs and reads names written after the component', () => {
    const learned = learnTestIdOptions(
      catalog([
        component('WidgetCard', [
          ['button', 'WidgetCard-saveButton'],
          ['input', 'WidgetCard-titleInput'],
        ]),
      ]),
    )
    expect(learned?.elements).toBeUndefined()
    expect(learned?.naming).toEqual({ separator: '', case: 'camel', prefix: 'name' })
  })

  test('prefers an id attribute over more used names extending it', () => {
    const widget: TestIdComponent = {
      name: 'WidgetCard',
      file: 'src/WidgetCard.tsx',
      source: 'jsx',
      total: 6,
      elements: [
        element(1, 'data-test-id', 'widget-card'),
        element(2, 'data-test-id', 'widget-card-title'),
        ...[3, 4, 5, 6].map((line) => element(line, 'data-test-shape-size', 'large')),
      ],
    }
    const learned = learnTestIdOptions({ attributes: ['data-test'], components: [widget] })
    expect(learned?.attribute).toBe('data-test-id')
    expect(learned?.examples).toEqual(['widget-card', 'widget-card-title'])
    expect(learned?.attributes).toEqual(['data-test-shape-size', 'data-test-id'])

    const dynamicOnly: TestIdComponent = {
      ...widget,
      elements: [
        element(1, 'data-test-id', 'shapeId', true),
        element(2, 'data-test-shape-size', 'large'),
        element(3, 'data-test-shape-size', 'small'),
      ],
    }
    expect(
      learnTestIdOptions({ attributes: ['data-test'], components: [dynamicOnly] })?.attribute,
    ).toBe('data-test-id')
  })

  test('learns nothing from an empty catalog', () => {
    expect(learnTestIdOptions(catalog([]))).toBeUndefined()
  })
})

describe('testIdConvention', () => {
  const learned = learnTestIdOptions(
    catalog([component('WidgetCard', [['button', 'save_button']])]),
  )

  test('team overrides win field by field', () => {
    const convention = testIdConvention(
      learned,
      testIdOverridesOf({ attributes: 'data-e2e, data-cy', exclude: ['legacy/**'] }),
    )
    expect(convention).toMatchObject({
      attribute: 'data-e2e',
      attributes: ['data-e2e', 'data-cy'],
      exclude: ['legacy/**'],
      naming: { separator: '_', case: 'lower', prefix: 'none' },
      examples: [],
      overridden: ['attributes', 'exclude'],
    })
    expect(convention && renderTestIdConvention(convention)).toContain(
      '- New ids use `data-e2e` (set by the team).',
    )
  })

  test('new ids use the team attribute the repository uses most', () => {
    const convention = testIdConvention(
      learned,
      testIdOverridesOf({ attributes: ['data-e2e', 'data-qa'] }),
    )
    expect(convention).toMatchObject({
      attribute: 'data-qa',
      attributes: ['data-e2e', 'data-qa'],
      examples: ['save_button'],
    })
    expect(convention && renderTestIdConvention(convention)).toContain(
      '- New ids use `data-qa` (set by the team).',
    )
  })

  test('needs an attribute from the catalog or the team', () => {
    expect(testIdConvention(undefined)).toBeUndefined()
    expect(testIdConvention(undefined, { attributes: ['data-qa'] })?.attribute).toBe('data-qa')
    expect(testIdOverridesOf({ attributes: 3 })).toEqual({})
  })
})

describe('suggestTestId', () => {
  test('names an element by its label, handler or component name in the given style', () => {
    const kebab = { separator: '-', case: 'lower', prefix: 'none' } as const
    expect(
      suggestTestId(
        { tag: 'input', attributes: [{ name: 'aria-label', value: 'Search shapes' }] },
        'ShapeList',
        kebab,
      ),
    ).toBe('search-shapes-input')
    expect(
      suggestTestId(
        {
          tag: 'Clickable',
          attributes: [{ name: 'onClick', expression: '() => onRemoveShape(id)' }],
        },
        'ShapeList',
        { separator: '', case: 'camel', prefix: 'component' },
      ),
    ).toBe('shapeListRemoveShapeClickable')
    expect(
      suggestTestId({ tag: 'a', attributes: [] }, 'ShapeList', { ...kebab, prefix: 'name' }),
    ).toBe('ShapeList-link')
  })
})
