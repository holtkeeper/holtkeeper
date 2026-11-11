/** Object keys from the document root. */
export type KeyPath = string[]

/**
 * One way a document fails to contain a template:
 * - `missing`: the key at `path` does not exist; its parent is an object.
 * - `mismatch`: the value at `path` differs in type or value.
 * - `missing-item`: the array at `path` has no item matching `expected`.
 */
export interface Difference {
  kind: 'missing' | 'mismatch' | 'missing-item'
  path: KeyPath
  expected: unknown
  found?: unknown
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Differences between `actual` and the subset `template` describes. Only keys the template
 * defines are compared; arrays match when every template item matches some actual item.
 */
export function subsetDifferences(
  template: unknown,
  actual: unknown,
  path: KeyPath = [],
): Difference[] {
  if (isObject(template)) {
    if (!isObject(actual)) return [{ kind: 'mismatch', path, expected: template, found: actual }]
    return Object.entries(template).flatMap(([key, value]) =>
      Object.hasOwn(actual, key)
        ? subsetDifferences(value, actual[key], [...path, key])
        : [{ kind: 'missing' as const, path: [...path, key], expected: value }],
    )
  }
  if (Array.isArray(template)) {
    if (!Array.isArray(actual))
      return [{ kind: 'mismatch', path, expected: template, found: actual }]
    return template
      .filter(
        (item) => !actual.some((candidate) => subsetDifferences(item, candidate).length === 0),
      )
      .map((item) => ({ kind: 'missing-item' as const, path, expected: item }))
  }
  return Object.is(template, actual)
    ? []
    : [{ kind: 'mismatch', path, expected: template, found: actual }]
}

const show = (value: unknown) => (value === undefined ? 'nothing' : JSON.stringify(value))

/** `engines.node: expected "22.x", found "18.x"`. */
export function describeDifference(difference: Difference): string {
  const where = difference.path.length ? difference.path.join('.') : '(root)'
  if (difference.kind === 'missing')
    return `${where}: missing, expected ${show(difference.expected)}`
  if (difference.kind === 'missing-item')
    return `${where}: missing item ${show(difference.expected)}`
  return `${where}: expected ${show(difference.expected)}, found ${show(difference.found)}`
}
