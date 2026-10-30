import { z } from 'zod'

import { globToRegExp } from '../glob.ts'
import type { Extracted } from '../types.ts'
import type { Extractor } from './types.ts'

const schema = z.object({
  kind: z.literal('env'),
  /** Glob the variable name must match, e.g. `FEATURE_*`. Default: every variable. */
  keys: z.string().min(1).optional(),
})

function unquote(raw: string): string {
  const value = raw.trim()
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(value)
  if (quoted) return quoted[2]!
  return value.replace(/\s+#.*$/, '')
}

/** `NAME=value` lines of dotenv files and shell exports; the value becomes attribute `value`. */
export const envExtractor = {
  kind: 'env',
  schema,
  extract(text, config) {
    const filter = config.keys ? globToRegExp(config.keys) : undefined
    const results: Extracted[] = []
    text.split('\n').forEach((line, index) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(line)
      if (!match || (filter && !filter.test(match[1]!))) return
      results.push({ key: match[1]!, line: index + 1, attrs: { value: unquote(match[2]!) } })
    })
    return results
  },
} satisfies Extractor<z.output<typeof schema>>
