import { z } from 'zod'

import type { Extracted } from '../types.ts'
import { astGrepExtractor } from './ast-grep.ts'
import { envExtractor } from './env.ts'
import { jsonPathExtractor } from './json-path.ts'
import { linesExtractor } from './lines.ts'
import { regexExtractor } from './regex.ts'
import type { ExtractContext, Extractor } from './types.ts'
import { yamlPathExtractor } from './yaml-path.ts'

/** Validates an extractor config of any registered kind. */
export const extractorSchema = z.discriminatedUnion('kind', [
  jsonPathExtractor.schema,
  yamlPathExtractor.schema,
  regexExtractor.schema,
  envExtractor.schema,
  astGrepExtractor.schema,
  linesExtractor.schema,
])

/** A file extractor config: `json-path`, `yaml-path`, `regex`, `env`, `ast-grep` or `lines`. */
export type ExtractorConfig = z.output<typeof extractorSchema>

/** File extractors by kind. */
export const extractors: Record<ExtractorConfig['kind'], Extractor> = {
  'json-path': jsonPathExtractor,
  'yaml-path': yamlPathExtractor,
  regex: regexExtractor,
  env: envExtractor,
  'ast-grep': astGrepExtractor,
  lines: linesExtractor,
}

/** Runs the extractor `config.kind` names; throws when it fails. */
export function extract(
  text: string,
  config: ExtractorConfig,
  context: ExtractContext,
): Extracted[] {
  return extractors[config.kind].extract(text, config, context)
}

export type { ExtractContext, Extractor } from './types.ts'
