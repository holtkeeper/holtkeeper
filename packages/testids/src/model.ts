import { z } from 'zod'

/** One test attribute on an element, e.g. `data-test-id="submit"` or `data-test-state={status}`. */
export interface TestAttribute {
  /** Bare name as written, binding syntax stripped: `data-test-state`. */
  name: string
  /** The literal value, or the expression as written when `dynamic`; empty without a value. */
  value: string
  /** Set at runtime: a bound expression or a template with placeholders. */
  dynamic?: boolean
}

/** An element that carries at least one test attribute. */
export interface TestIdElement {
  line: number
  /** As written, e.g. `button`, `S.Submit`, `el-button`. */
  tag: string
  attributes: TestAttribute[]
}

/** The test attributes one template file exposes. */
export interface TestIdComponent {
  /** Component name taken from the file: `LoginForm`; `index` files take their folder's name. */
  name: string
  /** Relative to the checkout, `/`-separated. */
  file: string
  /** Template source that read it: `jsx`, `vue`, `svelte`, `html`. */
  source: string
  /** Elements with test attributes in line order; capped, `total` stays exact. */
  elements: TestIdElement[]
  /** Elements with test attributes found. */
  total: number
}

/** Everything a `testids` analysis found; serializable, stored as analysis data. */
export interface TestIdsData {
  /** Configured test attribute names; each also covers names extending it with `-`. */
  attributes: string[]
  /** Components with at least one test attribute, by file path. */
  components: TestIdComponent[]
}

/** Validates `TestIdsData` uploads. */
export const testIdsDataSchema: z.ZodType<TestIdsData> = z.object({
  attributes: z.array(z.string()),
  components: z.array(
    z.object({
      name: z.string(),
      file: z.string(),
      source: z.string(),
      total: z.number(),
      elements: z.array(
        z.object({
          line: z.number(),
          tag: z.string(),
          attributes: z.array(
            z.object({ name: z.string(), value: z.string(), dynamic: z.boolean().optional() }),
          ),
        }),
      ),
    }),
  ),
})

/** Test attribute names in use with how many elements and components carry each, most used first. */
export function attributeUsage(components: readonly TestIdComponent[]) {
  const usage = new Map<
    string,
    { elements: number; components: Set<string>; values: Set<string> }
  >()
  for (const component of components)
    for (const element of component.elements)
      for (const attribute of element.attributes) {
        let entry = usage.get(attribute.name)
        if (!entry) {
          entry = { elements: 0, components: new Set(), values: new Set() }
          usage.set(attribute.name, entry)
        }
        entry.elements++
        entry.components.add(component.file)
        if (!attribute.dynamic && attribute.value) entry.values.add(attribute.value)
      }
  return [...usage]
    .map(([name, entry]) => ({
      name,
      elements: entry.elements,
      components: entry.components.size,
      values: [...entry.values],
    }))
    .toSorted((a, b) => b.elements - a.elements || a.name.localeCompare(b.name))
}
