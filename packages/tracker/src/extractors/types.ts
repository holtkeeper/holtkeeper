import type { z } from 'zod'

import type { Extracted } from '../types.ts'

/** Where the text an extractor reads comes from. */
export interface ExtractContext {
  /** File path inside the repository, used e.g. to pick a parser language. */
  file: string
}

/**
 * Turns one file's text into keys with attributes. Pure and synchronous; throws on a bad config
 * or unparsable text, which the engine records as an error of that file.
 */
export interface Extractor<Config extends { kind: string } = { kind: string }> {
  kind: Config['kind']
  /** Validates the extractor's config inside a source definition. */
  schema: z.ZodType<Config>
  extract(text: string, config: Config, context: ExtractContext): Extracted[]
}
