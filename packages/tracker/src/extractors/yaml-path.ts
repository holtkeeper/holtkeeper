import { z } from 'zod'

import { extractFromTree, pathFields } from './path.ts'
import type { Extractor } from './types.ts'

const schema = z.object({ kind: z.literal('yaml-path'), ...pathFields })

/** Keys selected by a JSONPath subset from YAML files; multi-document files use the first document. */
export const yamlPathExtractor = {
  kind: 'yaml-path',
  schema,
  extract(text, config) {
    const parsed: unknown = Bun.YAML.parse(text)
    return extractFromTree(
      Array.isArray(parsed) && text.includes('\n---') ? parsed[0] : parsed,
      text,
      config,
    )
  },
} satisfies Extractor<z.output<typeof schema>>
