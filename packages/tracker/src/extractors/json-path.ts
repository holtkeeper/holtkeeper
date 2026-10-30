import { z } from 'zod'

import { extractFromTree, pathFields } from './path.ts'
import type { Extractor } from './types.ts'

const schema = z.object({ kind: z.literal('json-path'), ...pathFields })

/** Keys selected by a JSONPath subset from JSON or JSONC files. */
export const jsonPathExtractor = {
  kind: 'json-path',
  schema,
  extract: (text, config) => extractFromTree(Bun.JSONC.parse(text), text, config),
} satisfies Extractor<z.output<typeof schema>>
