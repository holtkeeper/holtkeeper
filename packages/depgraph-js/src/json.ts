/** A parsed JSON or YAML object. */
export type JsonObject = Record<string, unknown>

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `value` when it is an object, otherwise an empty one: lockfile fields are read defensively. */
export const objectOf = (value: unknown): JsonObject => (isObject(value) ? value : {})

export const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

/** The string-valued entries of an object, e.g. a `dependencies` map. */
export function stringsOf(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(objectOf(value)))
    if (typeof item === 'string') result[key] = item
  return result
}

/** Entries of an object whose values are objects. */
export const objectsOf = (value: unknown): [string, JsonObject][] =>
  Object.entries(objectOf(value)).flatMap(([key, item]) => (isObject(item) ? [[key, item]] : []))
