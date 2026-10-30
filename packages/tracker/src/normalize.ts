import { z } from 'zod'

/** One key normalization step; steps apply in order. */
export type NormalizeStep =
  | 'lower'
  | 'upper'
  | 'snake'
  | 'kebab'
  | 'camel'
  | `trim-prefix:${string}`
  | `trim-suffix:${string}`

/** Validates one normalization step. */
export const normalizeStepSchema = z.custom<NormalizeStep>(
  (step) =>
    typeof step === 'string' &&
    /^(lower|upper|snake|kebab|camel|trim-prefix:.+|trim-suffix:.+)$/.test(step),
  'expected lower, upper, snake, kebab, camel, trim-prefix:<p> or trim-suffix:<s>',
)

/** Words of an identifier in any casing: `newHubV2`, `NEW_HUB_V2`, `new-hub-v2` → `new hub v2`. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

function applyStep(key: string, step: NormalizeStep): string {
  if (step.startsWith('trim-prefix:')) {
    const prefix = step.slice('trim-prefix:'.length)
    return key.toLowerCase().startsWith(prefix.toLowerCase()) ? key.slice(prefix.length) : key
  }
  if (step.startsWith('trim-suffix:')) {
    const suffix = step.slice('trim-suffix:'.length)
    return key.toLowerCase().endsWith(suffix.toLowerCase())
      ? key.slice(0, key.length - suffix.length)
      : key
  }
  switch (step) {
    case 'lower':
      return key.toLowerCase()
    case 'upper':
      return key.toUpperCase()
    case 'snake':
      return keyWords(key)
        .map((word) => word.toLowerCase())
        .join('_')
    case 'kebab':
      return keyWords(key)
        .map((word) => word.toLowerCase())
        .join('-')
    default:
      return keyWords(key)
        .map((word, index) =>
          index === 0
            ? word.toLowerCase()
            : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join('')
  }
}

/** The key every source's spelling maps to; surrounding whitespace is always trimmed. */
export function normalizeKey(key: string, steps: readonly NormalizeStep[] = []): string {
  return steps.reduce(applyStep, key.trim())
}
