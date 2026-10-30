import { z } from 'zod'

import { documentSectionOutput } from './document-section.ts'
import { notifyOutput } from './notify.ts'
import { repoFileOutput } from './repo-file.ts'
import type { OutputProvider } from './types.ts'

/** Validates an output config of any registered kind. */
export const outputSchema = z.discriminatedUnion('kind', [
  documentSectionOutput.schema,
  repoFileOutput.schema,
  notifyOutput.schema,
])

/** An output config: `document-section`, `repo-file` or `notify`. */
export type OutputConfig = z.output<typeof outputSchema>

/** Output providers by kind. */
export const outputs: Record<OutputConfig['kind'], OutputProvider> = {
  'document-section': documentSectionOutput,
  'repo-file': repoFileOutput,
  notify: notifyOutput,
}

export type { DocumentSectionConfig } from './document-section.ts'
export { fileEdits, type RepoFileConfig } from './repo-file.ts'
export { summaryText, type NotifyConfig } from './notify.ts'
export * from './template.ts'
export type { OutputContext, OutputProvider, OutputResult } from './types.ts'
