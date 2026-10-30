import { scopeSchema } from '@holtkeeper/access'
import { z } from 'zod'

import { builtinActions } from './actions/index.ts'
import { type ActionRegistry, createRegistry } from './actions/provider.ts'
import { compileRegex } from './conditions.ts'
import {
  type Condition,
  type Policy,
  type PolicyAction,
  mergeRequestEventActions,
  pipelineStates,
} from './model.ts'

const oneOrMany = <T extends z.ZodType>(item: T) =>
  z
    .union([item, z.array(item).min(1)])
    .transform((value) => (Array.isArray(value) ? value : [value]))

const name = z.string().min(1)
const names = z.array(name).min(1)

const globSetsSchema = z.object({
  all: names.optional(),
  any: names.optional(),
  none: names.optional(),
})

const regexSchema = z.string().refine(
  (source) => {
    try {
      compileRegex(source)
      return true
    } catch {
      return false
    }
  },
  { message: 'invalid regular expression' },
)

const authorSchema = z.union([
  oneOrMany(name).transform((users) => ({ users })),
  z.object({ users: oneOrMany(name).optional(), bot: z.boolean().optional() }),
])

/**
 * Validates a `Condition`. Single values are accepted where lists are (`event: open`,
 * `targetBranch: main`, `author: renovate-bot`) and normalized to lists.
 */
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.strictObject({
    event: oneOrMany(z.enum(mergeRequestEventActions)).optional(),
    sourceBranch: oneOrMany(name).optional(),
    targetBranch: oneOrMany(name).optional(),
    author: authorSchema.optional(),
    labels: globSetsSchema.optional(),
    labelAdded: oneOrMany(name).optional(),
    title: regexSchema.optional(),
    draft: z.boolean().optional(),
    command: oneOrMany(name).optional(),
    changedPaths: globSetsSchema.optional(),
    size: z
      .object({
        maxLines: z.int().min(0).optional(),
        maxFiles: z.int().min(0).optional(),
        minLines: z.int().min(0).optional(),
        minFiles: z.int().min(0).optional(),
      })
      .optional(),
    pipeline: oneOrMany(z.enum(pipelineStates)).optional(),
    all: z.array(conditionSchema).min(1).optional(),
    any: z.array(conditionSchema).min(1).optional(),
    not: conditionSchema.optional(),
  }),
)

/** Validates one action against the registry: its `type` must be known and its options valid. */
export function actionSchema(registry: ActionRegistry): z.ZodType<PolicyAction> {
  return z.looseObject({ type: z.string().min(1) }).transform((action, context) => {
    const provider = registry.get(action.type)
    if (!provider) {
      context.addIssue({
        code: 'custom',
        message: `unknown action ${action.type}; known: ${[...registry.keys()].join(', ')}`,
        path: ['type'],
      })
      return z.NEVER
    }
    const parsed = provider.schema.safeParse(action)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', message: issue.message, path: issue.path })
      }
      return z.NEVER
    }
    return action
  })
}

/** Validates a policy; actions are checked against `registry`. `scope` may be left out in settings. */
export function policySchema(registry: ActionRegistry = createRegistry(builtinActions)) {
  return z.object({
    id: z.string().regex(/^[\w.-]+$/, 'letters, digits, dots, dashes and underscores'),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    scope: scopeSchema.optional(),
    when: conditionSchema.default({}),
    actions: z.array(actionSchema(registry)).default([]),
    stop: z.boolean().optional(),
    skipAnalyzers: z.union([z.literal('*'), z.array(name)]).optional(),
  })
}

/** A policy as configured: like `Policy`, but `scope` may come from the settings entry instead. */
export type PolicyInput = Omit<Policy, 'scope' | 'within'> & { scope?: Policy['scope'] }

/** Validates a list of policies with unique ids, actions checked against `registry`. */
export function createPoliciesSchema(
  registry: ActionRegistry = createRegistry(builtinActions),
): z.ZodType<PolicyInput[]> {
  return z.array(policySchema(registry)).superRefine((policies, context) => {
    const seen = new Set<string>()
    policies.forEach((policy, index) => {
      if (seen.has(policy.id)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate id ${policy.id}`,
          path: [index, 'id'],
        })
      }
      seen.add(policy.id)
    })
  })
}

/** Validates policies that use the built-in actions. */
export const policiesSchema = createPoliciesSchema()
