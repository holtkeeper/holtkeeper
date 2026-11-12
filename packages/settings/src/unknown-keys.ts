import { z } from 'zod'

import type { SettingDefinition } from './definitions.ts'

/** A key of a stored value the setting's schema does not know, so reading the value drops it. */
export interface UnknownSettingKey {
  /** Dotted path within the value, e.g. `ignore` or `maxBytes.extra`. */
  key: string
  /** Where the option lives now, from `SettingDefinition.movedKeys`; absent when it was removed. */
  movedTo?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const objectOf = (schema: z.ZodType): z.ZodObject | undefined => {
  let current = schema
  for (let depth = 0; depth < 10; depth++) {
    if (current instanceof z.ZodObject) return current
    const def: object = current.def
    const inner = 'innerType' in def ? def.innerType : 'in' in def ? def.in : undefined
    if (!(inner instanceof z.ZodType)) return undefined
    current = inner
  }
  return undefined
}

const collect = (schema: z.ZodType, value: unknown, prefix: string): string[] => {
  const object = objectOf(schema)
  if (!object || !isRecord(value) || object.def.catchall) return []
  const { shape } = object
  return Object.entries(value).flatMap(([key, field]) => {
    const path = prefix ? `${prefix}.${key}` : key
    const known = shape[key]
    return known ? collect(known, field, path) : [path]
  })
}

/**
 * Keys of `value` that `definition` no longer knows: object fields its schema (or `form`, when
 * set) strips on parse, nested objects included, each with where it moved when
 * `definition.movedKeys` says. Empty for secret settings, non-object values and schemas that keep
 * or refuse unknown keys. Never changes the value.
 */
export function unknownSettingKeys(
  definition: Pick<SettingDefinition, 'schema' | 'form' | 'secret' | 'movedKeys'>,
  value: unknown,
): UnknownSettingKey[] {
  if (definition.secret) return []
  return collect(definition.form ?? definition.schema, value, '').map((key) => {
    const movedTo = definition.movedKeys?.[key]
    return movedTo ? { key, movedTo } : { key }
  })
}
