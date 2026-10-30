import { scopeSchema } from '@holtkeeper/access'
import { z } from 'zod'

import { knowledgeKinds, knowledgeStatuses } from './model.ts'

const text = z.string().trim().min(1)

/** Validates a `KnowledgePackage`. */
export const knowledgePackageSchema = z.object({
  ecosystem: text,
  name: text,
  from: text.optional(),
  to: text.optional(),
})

/** Validates a `KnowledgeLink`. */
export const knowledgeLinkSchema = z.object({ label: text, url: z.url() })

const tags = z
  .array(text)
  .default([])
  .transform((values) => [...new Set(values.map((value) => value.toLowerCase()))])

/**
 * Validates the editable part of an entry and enforces the rules every stored entry obeys: the
 * scope covers something, `appliesTo` names at least one task kind (or `*`), and a `migration`
 * names the packages it is about. Topics come out lowercase and unique.
 */
export const knowledgeDraftSchema = z
  .object({
    title: text.max(200),
    body: text.max(20_000),
    kind: z.enum(knowledgeKinds),
    scope: scopeSchema,
    topics: tags,
    appliesTo: z.array(text).min(1, 'must name at least one task kind or *'),
    packages: z.array(knowledgePackageSchema).optional(),
    status: z.enum(knowledgeStatuses).optional(),
    evidence: z.array(knowledgeLinkSchema).default([]),
    supersedes: text.optional(),
  })
  .superRefine((draft, ctx) => {
    const { all, groups = [], repos = [] } = draft.scope
    if (!all && !groups.length && !repos.length)
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'scope must not be empty' })
    if (draft.kind === 'migration' && !draft.packages?.length)
      ctx.addIssue({
        code: 'custom',
        path: ['packages'],
        message: 'a migration must name its packages',
      })
  })

/** A validated entry draft: what people and agents write, before the store adds ids and versions. */
export type KnowledgeDraft = z.output<typeof knowledgeDraftSchema>

/** Outcome of `validateEntry`; `issues` read like `packages: a migration must name its packages`. */
export type KnowledgeValidation =
  | { success: true; data: KnowledgeDraft }
  | { success: false; issues: string[] }

/** Checks a draft against `knowledgeDraftSchema` without throwing. */
export function validateEntry(value: unknown): KnowledgeValidation {
  const result = knowledgeDraftSchema.safeParse(value)
  if (result.success) return { success: true, data: result.data }
  return {
    success: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    }),
  }
}

/** Thrown when a proposal or edit breaks the entry rules. */
export class KnowledgeValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`invalid knowledge entry: ${issues.join('; ')}`)
    this.name = 'KnowledgeValidationError'
    this.issues = issues
  }
}
