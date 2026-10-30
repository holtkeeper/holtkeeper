import type { z } from 'zod'

import type { DocumentContent } from '../contracts.ts'
import type { Extracted } from '../types.ts'

/** Turns a document into keys with attributes; pure, throws on a bad config. */
export interface DocumentExtractor<Config extends { kind: string } = { kind: string }> {
  kind: Config['kind']
  schema: z.ZodType<Config>
  extract(document: DocumentContent, config: Config): Extracted[]
}

/** Whether `heading` contains the configured text, ignoring case; true when nothing is configured. */
export function headingMatches(heading: string | undefined, wanted: string | undefined): boolean {
  if (!wanted) return true
  if (!heading) return false
  return heading.toLowerCase().includes(wanted.trim().toLowerCase())
}
