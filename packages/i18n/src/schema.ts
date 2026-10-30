import type { CodeChange } from '@holtkeeper/changes'
import { z } from 'zod'

import type { I18nData } from './types.ts'

const position = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
})
const target = z.object({ forge: z.string().min(1), path: z.string().min(1) })

const edit = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    file: z.string().min(1),
    range: z.object({ start: position, end: position }),
    oldText: z.string(),
    newText: z.string(),
  }),
  z.object({ kind: z.literal('create'), file: z.string().min(1), newText: z.string() }),
  z.object({ kind: z.literal('delete'), file: z.string().min(1), oldText: z.string() }),
])

const change: z.ZodType<CodeChange> = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  confidence: z.enum(['safe', 'review']),
  source: z.string(),
  target: target.optional(),
  edits: z.array(edit).min(1),
})

const located = { bundle: z.string(), key: z.string(), locale: z.string() }
const where = {
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
}

/** Validates `I18nData` received from analyzers, e.g. uploads from CI. */
export const i18nDataSchema: z.ZodType<I18nData> = z.object({
  baseLocale: z.string().min(1),
  mode: z.enum(['report', 'suggest']),
  layers: z.array(
    z.object({
      id: z.string().min(1),
      repo: target.optional(),
      ref: z.string().optional(),
      files: z.string().optional(),
      shared: z.boolean(),
      catalogs: z.number().int().nonnegative(),
    }),
  ),
  provenance: z.array(
    z.object({
      bundle: z.string(),
      key: z.string(),
      layer: z.string(),
      layers: z.array(z.string()),
    }),
  ),
  overrides: z.array(z.object({ ...located, layer: z.string(), overrides: z.array(z.string()) })),
  formats: z.array(z.string()),
  bundles: z.array(
    z.object({
      id: z.string(),
      namespace: z.string().optional(),
      formats: z.array(z.string()),
      files: z.array(z.object({ locale: z.string(), layer: z.string(), file: z.string() })),
    }),
  ),
  locales: z.array(
    z.object({
      locale: z.string(),
      base: z.boolean(),
      optional: z.boolean().optional(),
      translated: z.number().int().nonnegative(),
      missing: z.number().int().nonnegative(),
      extra: z.number().int().nonnegative(),
      untranslated: z.number().int().nonnegative(),
      completeness: z.number().min(0).max(100),
    }),
  ),
  keys: z.number().int().nonnegative(),
  missing: z.array(
    z.object({ ...located, file: z.string().optional(), layer: z.string().optional() }),
  ),
  extra: z.array(z.object({ ...located, file: z.string() })),
  untranslated: z.array(
    z.object({ ...located, file: z.string(), reason: z.enum(['empty', 'identical', 'fuzzy']) }),
  ),
  placeholders: z.array(
    z.object({
      ...located,
      file: z.string(),
      missing: z.array(z.string()),
      unexpected: z.array(z.string()),
    }),
  ),
  plurals: z.array(z.object({ ...located, file: z.string(), missing: z.array(z.string()) })),
  usage: z.object({
    files: z.number().int().nonnegative(),
    references: z.number().int().nonnegative(),
    missingInBase: z.array(
      z.object({ key: z.string(), namespace: z.string().optional(), ...where }),
    ),
    unused: z.array(
      z.object({ bundle: z.string(), key: z.string(), layer: z.string(), shared: z.boolean() }),
    ),
    dynamic: z.array(z.object({ text: z.string(), prefix: z.string().optional(), ...where })),
  }),
  changes: z.array(change),
})
