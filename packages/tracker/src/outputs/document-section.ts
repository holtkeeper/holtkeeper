import { z } from 'zod'

import { renderTemplate, templateSchema } from './template.ts'
import type { OutputProvider, OutputResult } from './types.ts'

const schema = z.object({
  kind: z.literal('document-section'),
  id: z.string().min(1).optional(),
  /** `DocumentSink.provider`, e.g. `confluence`. */
  provider: z.string().min(1),
  /** Page id or URL. */
  ref: z.string().min(1),
  /** Marker pair to replace between; omitted replaces the whole page. */
  markerId: z.string().min(1).optional(),
  /** Body format written. Default `storage` (Confluence XHTML); `html` renders the same markup. */
  format: z.enum(['storage', 'markdown', 'html']).default('storage'),
  /** Change note. */
  message: z.string().min(1).optional(),
  template: templateSchema.default({ findings: false }),
})

/** A `document-section` output as configured. */
export type DocumentSectionConfig = z.output<typeof schema>

/** Renders a section of a document and plans writing it through a `DocumentSink`. */
export const documentSectionOutput = {
  kind: 'document-section',
  schema,
  async plan(config, context): Promise<OutputResult> {
    const content = renderTemplate(
      context.entities,
      context.findings,
      config.template,
      config.format === 'markdown' ? 'markdown' : 'html',
    )
    const expectedVersion = context.documentVersions.get(`${config.provider}:${config.ref}`)
    const errors =
      context.sinkProviders && !context.sinkProviders.includes(config.provider)
        ? [
            {
              output: context.id,
              document: `${config.provider}:${config.ref}`,
              message: `no document sink for provider ${config.provider}; the section cannot be published`,
            },
          ]
        : []
    return {
      publications: [
        {
          output: context.id,
          kind: 'document-section',
          provider: config.provider,
          ref: config.ref,
          markerId: config.markerId ?? '',
          format: config.format,
          content,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
          title: config.message ?? `Update ${context.tracker.name}`,
        },
      ],
      changes: [],
      errors,
    }
  },
} satisfies OutputProvider<DocumentSectionConfig>
