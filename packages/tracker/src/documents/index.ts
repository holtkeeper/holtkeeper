import { z } from 'zod'

import type { DocumentContent } from '../contracts.ts'
import type { Extracted } from '../types.ts'
import { listExtractor } from './list.ts'
import { tableExtractor } from './table.ts'
import type { DocumentExtractor } from './types.ts'

/** Validates a document extractor config of any registered kind. */
export const documentExtractorSchema = z.discriminatedUnion('kind', [
  tableExtractor.schema,
  listExtractor.schema,
])

/** A document extractor config: `table` or `list`. */
export type DocumentExtractorConfig = z.output<typeof documentExtractorSchema>

/** Document extractors by kind. */
export const documentExtractors: Record<DocumentExtractorConfig['kind'], DocumentExtractor> = {
  table: tableExtractor,
  list: listExtractor,
}

/** Runs the document extractor `config.kind` names. */
export function extractDocument(
  document: DocumentContent,
  config: DocumentExtractorConfig,
): Extracted[] {
  return documentExtractors[config.kind].extract(document, config)
}

export { documentTables } from './table.ts'
export type { DocumentExtractor } from './types.ts'
