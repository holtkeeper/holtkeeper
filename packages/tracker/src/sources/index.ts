import { z } from 'zod'

import { documentSource } from './document.ts'
import { filesSource } from './files.ts'
import type { SourceProvider } from './types.ts'

/** Validates a source config of any registered kind. */
export const sourceSchema = z.discriminatedUnion('kind', [
  filesSource.schema,
  documentSource.schema,
])

/** A source config: `files` or `document`. */
export type SourceConfig = z.output<typeof sourceSchema>

/** Source providers by kind. */
export const sources: Record<SourceConfig['kind'], SourceProvider> = {
  files: filesSource,
  document: documentSource,
}

export { environmentOf, selectRepos, type FilesSourceConfig } from './files.ts'
export type { DocumentSourceConfig } from './document.ts'
export type {
  SourceContext,
  SourceHit,
  SourceProvider,
  SourceResult,
  TrackerForge,
} from './types.ts'
