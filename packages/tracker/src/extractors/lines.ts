import { z } from 'zod'

import type { Extracted } from '../types.ts'
import type { Extractor } from './types.ts'

const schema = z.object({
  kind: z.literal('lines'),
  /** Lines must match; named group `key` (or group 1) is the key, other named groups attributes. */
  pattern: z.string().min(1).optional(),
  /** Lines starting with this are skipped. Default `#`. */
  comment: z.string().optional(),
})

/** One key per non-empty line, e.g. a plain list of flag names. */
export const linesExtractor = {
  kind: 'lines',
  schema,
  extract(text, config) {
    const pattern = config.pattern ? new RegExp(config.pattern) : undefined
    const comment = config.comment ?? '#'
    const results: Extracted[] = []
    text.split('\n').forEach((raw, index) => {
      const line = raw.trim()
      if (!line || (comment && line.startsWith(comment))) return
      if (!pattern) {
        results.push({ key: line, line: index + 1, attrs: {} })
        return
      }
      const match = pattern.exec(line)
      if (!match) return
      const { key: named, ...groups } = match.groups ?? {}
      const key = (named ?? match[1] ?? match[0]).trim()
      if (!key) return
      const attrs: Record<string, string> = {}
      for (const [name, value] of Object.entries(groups))
        if (value !== undefined) attrs[name] = value
      results.push({ key, line: index + 1, attrs })
    })
    return results
  },
} satisfies Extractor<z.output<typeof schema>>
