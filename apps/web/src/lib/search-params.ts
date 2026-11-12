/** A non-empty string search value, or `undefined`. */
export const searchText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** `value` when it is one of `options`, otherwise `undefined`. */
export const searchEnum = <T extends string>(
  value: unknown,
  options: readonly T[],
): T | undefined => options.find((option) => option === value)

/**
 * Distinct non-empty strings from an array or a comma list, keeping only `options` when given;
 * order of first appearance is kept.
 */
export function searchList<T extends string = string>(value: unknown, options?: readonly T[]): T[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [
    ...new Set(
      list.filter(
        (item): item is T =>
          typeof item === 'string' &&
          item !== '' &&
          (!options || options.some((option) => option === item)),
      ),
    ),
  ]
}

/** `{ [key]: value }` when `value` is set and, for a list, not empty; `{}` otherwise. */
export function searchEntry<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  const entry: { [P in K]?: V } = {}
  if (value !== undefined && !(Array.isArray(value) && value.length === 0)) entry[key] = value
  return entry
}

/** `prev` with `patch` applied; a key set to `undefined` in either is left out. */
export function patchSearch<T extends object>(prev: T, patch: Partial<T>): T {
  const next: T = { ...prev, ...patch }
  for (const [key, value] of Object.entries(next))
    if (value === undefined) Reflect.deleteProperty(next, key)
  return next
}
