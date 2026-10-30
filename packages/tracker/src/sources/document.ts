import { z } from 'zod'

import { documentExtractorSchema, extractDocument } from '../documents/index.ts'
import { errorMessage, type SourceProvider, type SourceResult } from './types.ts'

const schema = z.object({
  kind: z.literal('document'),
  id: z.string().min(1).optional(),
  role: z.string().min(1).meta({ 'x-role': 'provides' }),
  /** `DocumentSource.provider` to read with, e.g. `confluence`. */
  provider: z.string().min(1),
  /** Page id or URL, as the provider understands it. */
  ref: z.string().min(1),
  extract: documentExtractorSchema,
  environment: z.string().min(1).optional(),
})

/** A `document` source as configured. */
export type DocumentSourceConfig = z.output<typeof schema>

/** A page of a document provider, read through an injected `DocumentSource`. */
export const documentSource = {
  kind: 'document',
  schema,
  async read(config, context): Promise<SourceResult> {
    const result: SourceResult = { hits: [], reads: [], errors: [], documents: [] }
    const source = context.documents[config.provider]
    const where = `${config.provider}:${config.ref}`
    if (!source) {
      result.errors.push({
        source: context.id,
        document: where,
        message: `no document source for provider ${config.provider}`,
      })
      return result
    }
    let document
    try {
      document = await source.read(config.ref)
    } catch (error) {
      result.errors.push({ source: context.id, document: where, message: errorMessage(error) })
      return result
    }
    result.documents.push({ provider: config.provider, document })
    const ref = {
      provider: config.provider,
      ref: config.ref,
      title: document.title,
      url: document.url,
    }
    const read = {
      source: context.id,
      kind: 'document',
      role: config.role,
      document: { ...ref, version: document.version },
      files: 0,
      bytes: Buffer.byteLength(document.body),
      extracted: 0,
    }
    result.reads.push(read)
    try {
      for (const found of extractDocument(document, config.extract)) {
        read.extracted++
        result.hits.push({
          ...found,
          occurrence: {
            source: context.id,
            role: config.role,
            document: ref,
            ...(config.environment ? { environment: config.environment } : {}),
          },
        })
      }
    } catch (error) {
      result.errors.push({
        source: context.id,
        document: where,
        message: `${config.extract.kind}: ${errorMessage(error)}`,
      })
    }
    return result
  },
} satisfies SourceProvider<DocumentSourceConfig>
