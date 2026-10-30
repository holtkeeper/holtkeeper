import { z } from 'zod'

import type { Extracted } from '../types.ts'
import type { Extractor } from './types.ts'

const schema = z.object({
  kind: z.literal('regex'),
  /** Named group `key` is the key (else group 1, else the whole match); other named groups become attributes. */
  pattern: z.string().min(1),
  /** Extra flags such as `i` or `m`; `g` is always added. */
  flags: z
    .string()
    .regex(/^[imsuy]*$/)
    .optional(),
})

/** 1-based line of a character offset. */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index++)
    if (text[index] === '\n') line++
  return line
}

/** Every match of a regular expression, with its line. */
export const regexExtractor = {
  kind: 'regex',
  schema,
  extract(text, config) {
    const flags = `${config.flags ?? ''}g`
    const pattern = new RegExp(config.pattern, flags.includes('m') ? flags : `${flags}m`)
    const results: Extracted[] = []
    let offset = 0
    let line = 1
    for (const match of text.matchAll(pattern)) {
      const { key: named, ...groups } = match.groups ?? {}
      const key = (named ?? match[1] ?? match[0]).trim()
      if (!key) continue
      line += lineAt(text.slice(offset, match.index), match.index - offset) - 1
      offset = match.index
      const attrs: Record<string, string> = {}
      for (const [name, value] of Object.entries(groups))
        if (value !== undefined) attrs[name] = value
      results.push({ key, line, attrs })
    }
    return results
  },
} satisfies Extractor<z.output<typeof schema>>
