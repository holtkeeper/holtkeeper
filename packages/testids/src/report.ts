import { defineAnalysis, metric } from '@holtkeeper/report'
import type { Block, Cell, Column, Metric, Report, Section } from '@holtkeeper/report'

import {
  type TestAttribute,
  type TestIdComponent,
  type TestIdsData,
  attributeUsage,
  testIdsDataSchema,
} from './model.ts'

const limits = { rows: 3000, columns: 8, examples: 6, changes: 200 }

const elementCount = (components: readonly TestIdComponent[]) =>
  components.reduce((sum, component) => sum + component.total, 0)

function metrics(data: TestIdsData, previous?: TestIdsData): Metric[] {
  const used = attributeUsage(data.components)
  return [
    metric('components', 'Components', data.components.length, {
      previous: previous?.components.length,
      hint: 'Template files with at least one test attribute',
    }),
    metric('elements', 'Elements with test attributes', elementCount(data.components), {
      previous: previous ? elementCount(previous.components) : undefined,
    }),
    metric('attributes', 'Attributes in use', used.length, {
      previous: previous ? attributeUsage(previous.components).length : undefined,
      hint: used
        .slice(0, 4)
        .map((attribute) => attribute.name)
        .join(', '),
    }),
  ]
}

const shown = (attribute: TestAttribute) =>
  attribute.dynamic ? `{${attribute.value}}` : attribute.value || '(no value)'

function attributesSection(data: TestIdsData): Section {
  const used = attributeUsage(data.components)
  return {
    id: 'attributes',
    title: 'Attributes',
    description: `Attributes named ${data.attributes.join(', ')} or extending one of them with \`-\`.`,
    blocks: used.length
      ? [
          {
            type: 'table',
            columns: [
              { key: 'attribute', label: 'Attribute', format: 'code' },
              { key: 'elements', label: 'Elements', unit: 'count', align: 'end' },
              { key: 'components', label: 'Components', unit: 'count', align: 'end' },
              { key: 'values', label: 'Values', unit: 'count', align: 'end' },
              { key: 'examples', label: 'Examples', format: 'tags' },
            ],
            rows: used.map((attribute) => ({
              attribute: attribute.name,
              elements: attribute.elements,
              components: attribute.components,
              values: attribute.values.length,
              examples: attribute.values.slice(0, limits.examples).join(', '),
            })),
          },
        ]
      : [{ type: 'markdown', text: 'No test attributes were found in templates.' }],
  }
}

const groupOf = (component: TestIdComponent) => `${component.name} · ${component.file}`

function componentsSection(data: TestIdsData): Section {
  const named = attributeUsage(data.components).map((attribute) => attribute.name)
  const own = named.slice(0, limits.columns)
  const rest = new Set(named.slice(limits.columns))
  const sorted = data.components.toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file),
  )
  const rows: Record<string, Cell>[] = sorted.flatMap((component) =>
    component.elements.map((element) => {
      const row: Record<string, Cell> = {
        component: groupOf(component),
        element: `<${element.tag}>`,
        location: `${component.file}:${element.line}`,
      }
      const other: string[] = []
      for (const attribute of element.attributes) {
        if (rest.has(attribute.name)) other.push(`${attribute.name}=${shown(attribute)}`)
        else row[attribute.name] = shown(attribute)
      }
      if (other.length) row.other = other.join(', ')
      return row
    }),
  )
  const columns: Column[] = [
    { key: 'component', label: 'Component' },
    { key: 'element', label: 'Element', format: 'code' },
    ...own.map((name): Column => ({ key: name, label: name, format: 'code' })),
    ...(rest.size ? [{ key: 'other', label: 'Other', format: 'code' } satisfies Column] : []),
    { key: 'location', label: 'Line', format: 'code', path: true },
  ]
  const capped = data.components.filter((component) => component.total > component.elements.length)
  const notes = [
    rows.length > limits.rows ? `…and ${rows.length - limits.rows} more elements.` : '',
    capped.length
      ? `${capped.length} components list only their first ${capped[0]?.elements.length} elements.`
      : '',
  ].filter(Boolean)
  const blocks: Block[] = rows.length
    ? [
        { type: 'table', columns, rows: rows.slice(0, limits.rows), groupBy: 'component' },
        ...notes.map((text) => ({ type: 'markdown' as const, text })),
      ]
    : [{ type: 'markdown', text: 'No test attributes were found in templates.' }]
  return {
    id: 'components',
    title: 'By component',
    description: 'Every element with a test attribute; `{…}` values are set at runtime.',
    blocks,
  }
}

/** Static `name="value"` selectors per component, for comparing two analyses. */
function selectors(data: TestIdsData) {
  const result = new Map<string, { component: string; selector: string }>()
  for (const component of data.components)
    for (const element of component.elements)
      for (const attribute of element.attributes) {
        if (attribute.dynamic || !attribute.value) continue
        const selector = `[${attribute.name}="${attribute.value}"]`
        result.set(`${component.file}\u0000${selector}`, {
          component: groupOf(component),
          selector,
        })
      }
  return result
}

function changesSection(data: TestIdsData, previous: TestIdsData, compareTo?: string): Section {
  const now = selectors(data)
  const before = selectors(previous)
  const rows: Record<string, Cell>[] = [
    ...[...now]
      .filter(([key]) => !before.has(key))
      .map(([, entry]) => ({ ...entry, change: { text: 'added', tone: 'good' as const } })),
    ...[...before]
      .filter(([key]) => !now.has(key))
      .map(([, entry]) => ({ ...entry, change: { text: 'removed', tone: 'bad' as const } })),
  ].toSorted((a, b) => a.component.localeCompare(b.component))
  const since = compareTo ?? 'the previous analysis'
  return {
    id: 'changes',
    title: 'Changes',
    blocks: rows.length
      ? [
          {
            type: 'table',
            title: `Selectors added or removed since ${since}`,
            columns: [
              { key: 'component', label: 'Component' },
              { key: 'selector', label: 'Selector', format: 'code' },
              { key: 'change', label: 'Change' },
            ],
            rows: rows.slice(0, limits.changes),
          },
        ]
      : [{ type: 'markdown', text: `No selector was added or removed since ${since}.` }],
  }
}

/** Turns `TestIdsData` into a report. Exported for tests and for clients that render locally. */
export function testIdsReport(
  data: TestIdsData,
  options: { previous?: TestIdsData; ref?: string; compareTo?: string; generatedAt?: string } = {},
): Omit<Report, 'subject'> {
  const { previous, compareTo } = options
  return {
    kind: 'testids',
    title: 'Test ids',
    ...(options.ref ? { subtitle: options.ref } : {}),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    metrics: metrics(data, previous),
    sections: [
      attributesSection(data),
      componentsSection(data),
      ...(previous ? [changesSection(data, previous, compareTo)] : []),
    ],
  }
}

/** Analyses stored before the catalog have no `components`; they read as empty. */
const catalogOf = (data: TestIdsData): TestIdsData =>
  Array.isArray(data.components) ? data : { attributes: data.attributes ?? [], components: [] }

/**
 * The `testids` analysis kind: the test attributes a repository's templates expose, per
 * component, for writing end-to-end tests against them.
 */
export const testIdsAnalysis = defineAnalysis<TestIdsData>({
  kind: 'testids',
  label: 'Test ids',
  schema: testIdsDataSchema,
  summarize: (data) => metrics(catalogOf(data)),
  toReport(current, previous) {
    const prior = previous && Array.isArray(previous.data.components) ? previous : undefined
    return {
      ...testIdsReport(catalogOf(current.data), {
        previous: prior?.data,
        ref: current.ref,
        compareTo: prior?.ref,
      }),
      subject: {
        repo: current.repo,
        ...(current.ref ? { ref: current.ref } : {}),
        ...(prior?.ref ? { compareTo: prior.ref } : {}),
      },
    }
  },
})
