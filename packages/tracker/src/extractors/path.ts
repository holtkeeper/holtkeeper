import { z } from 'zod'

import { parsePath, scalarText, selectPath } from '../jsonpath.ts'
import type { Extracted } from '../types.ts'

/** Config fields shared by `json-path` and `yaml-path`. */
export const pathFields = {
  /** JSONPath subset selecting one node per entity, e.g. `$.flags.*` or `$.features[*]`. */
  path: z.string().min(1),
  /**
   * `key`: the member name a `.*` matched; `value`: the selected scalar. Default: `key` for
   * members of an object, `value` otherwise.
   */
  select: z.enum(['key', 'value']).optional(),
  /** Path relative to the selected node giving the key, e.g. `$.name`; overrides `select`. */
  key: z.string().min(1).optional(),
  /** Attribute name → path relative to the selected node; `$` is the node itself. */
  attrs: z.record(z.string().min(1), z.string().min(1)).optional(),
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 1-based line of the first place `key` appears as a quoted string or a YAML/JSON key. */
function lineOfKey(text: string, key: string, from = 0): number | undefined {
  const pattern = new RegExp(`(["'])${escape(key)}\\1|(^|[\\s{,-])${escape(key)}\\s*:`, 'm')
  const lines = text.split('\n')
  for (let index = from; index < lines.length; index++)
    if (pattern.test(lines[index]!)) return index + 1
  for (let index = 0; index < Math.min(from, lines.length); index++)
    if (pattern.test(lines[index]!)) return index + 1
  return undefined
}

/** Entities of a parsed JSON or YAML document according to a path config. */
export function extractFromTree(
  tree: unknown,
  text: string,
  config: { path: string; select?: 'key' | 'value'; key?: string; attrs?: Record<string, string> },
): Extracted[] {
  const keyPath = config.key ? parsePath(config.key) : undefined
  const attrPaths = Object.entries(config.attrs ?? {}).map(
    ([name, path]) => [name, parsePath(path)] as const,
  )
  const results: Extracted[] = []
  let cursor = 0
  for (const match of selectPath(tree, config.path)) {
    const select = config.select ?? (match.member === undefined ? 'value' : 'key')
    const key = keyPath
      ? scalarText(selectPath(match.value, keyPath)[0]?.value)
      : select === 'key'
        ? (match.member ??
          (typeof match.path.at(-1) === 'string' ? String(match.path.at(-1)) : undefined))
        : scalarText(match.value)
    if (key === undefined || key === '') continue
    const attrs: Record<string, string> = {}
    if (attrPaths.length) {
      for (const [name, path] of attrPaths) {
        const value = scalarText(selectPath(match.value, path)[0]?.value)
        if (value !== undefined) attrs[name] = value
      }
    } else if (select === 'key' && !keyPath) {
      const value =
        typeof match.value === 'object' && match.value !== null
          ? undefined
          : scalarText(match.value)
      if (value !== undefined) attrs.value = value
    }
    const line = lineOfKey(text, key, cursor)
    if (line !== undefined) cursor = line
    results.push({ key, ...(line === undefined ? {} : { line }), attrs })
  }
  return results
}
