import { type RepoTarget, type Scope, scopeCoversRepo, scopeSpecificity } from '@holtkeeper/access'
import { z } from 'zod'

import { builtinActions } from './actions/index.ts'
import type { ActionRegistry } from './actions/provider.ts'
import type { Policy } from './model.ts'
import { conditionSchema, createPoliciesSchema, policiesSchema } from './schema.ts'

/** Settings key under which policies are stored per scope. */
export const policiesSettingKey = 'mergeRequests.policies'

const actionForms = builtinActions.map((action) => action.schema)

/**
 * Policies as editors see them: the built-in actions as variants keyed by `type`, so a form can
 * offer each action's options. Marked `x-editor: merge-request-policies` for a dedicated editor.
 */
const policiesForm = z
  .array(
    z.object({
      id: z.string().regex(/^[\w.-]+$/),
      name: z.string().min(1),
      enabled: z.boolean().default(true),
      when: conditionSchema.default({}),
      actions: z.array(z.union(actionForms)).default([]),
      stop: z.boolean().optional(),
      skipAnalyzers: z.union([z.literal('*'), z.array(z.string().min(1))]).optional(),
    }),
  )
  .meta({ 'x-editor': 'merge-request-policies' })

/**
 * The scoped setting that holds policies, structurally a `SettingDefinition` of
 * `@holtkeeper/settings`, so the server can register it and the panel can edit it per scope.
 */
export const mergeRequestPoliciesSetting = {
  key: policiesSettingKey,
  label: 'Merge request policies',
  description:
    'Rules that run on merge request events before analysis: approve, merge, label, comment or skip analyzers when conditions hold. Policies from every scope covering a repository apply, most specific first.',
  section: 'Merge requests',
  help: `Each policy reads as **if** its conditions hold, **then** run its actions.

- Conditions inside one block must all hold. Use an **Any of** group for alternatives and **Not** to exclude cases, e.g. *target branch is \`main\` and author is a bot but not a draft*.
- Policies run top to bottom; turn on **Stop** to skip later policies once this one matched.
- **Skip analyzers** keeps noisy analyzers off merge requests the policy handles, e.g. dependency bumps.
- Put shared policies on a group and override one in a repository by reusing its **id**; the most specific scope wins.
- Try new policies on a single repository first: every decision shows up in Activity.`,
  schema: policiesSchema,
  form: policiesForm,
}

/** A stored setting value, structurally a `SettingEntry` of `@holtkeeper/store`. */
export interface PolicyEntry {
  key?: string
  scope: Scope
  value: unknown
  updatedAt?: string
}

/** Policies for one repository, and entries that failed validation. */
export interface CombinedPolicies {
  policies: Policy[]
  invalid: { scope: Scope; error: string }[]
}

/**
 * Combines policies from every entry whose scope covers `repo`: most specific scope first, then the
 * most recently updated. A policy without its own scope takes the entry's; one with its own scope
 * still applies only inside the entry's (`within`). A policy id seen in a more specific entry
 * overrides the same id from less specific ones, so a repository can disable or replace a group
 * policy. Entries with another `key` are ignored.
 */
export function combinePolicies(
  entries: readonly PolicyEntry[],
  repo: RepoTarget,
  registry?: ActionRegistry,
): CombinedPolicies {
  const schema = registry ? createPoliciesSchema(registry) : policiesSchema
  const result: CombinedPolicies = { policies: [], invalid: [] }
  const ids = new Set<string>()
  const ordered = entries
    .filter((entry) => (entry.key ?? policiesSettingKey) === policiesSettingKey)
    .filter((entry) => scopeCoversRepo(entry.scope, repo))
    .toSorted(
      (a, b) =>
        scopeSpecificity(b.scope) - scopeSpecificity(a.scope) ||
        (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    )
  for (const entry of ordered) {
    const parsed = schema.safeParse(entry.value)
    if (!parsed.success) {
      result.invalid.push({ scope: entry.scope, error: z.prettifyError(parsed.error) })
      continue
    }
    for (const policy of parsed.data) {
      if (ids.has(policy.id)) continue
      ids.add(policy.id)
      result.policies.push(
        policy.scope
          ? { ...policy, scope: policy.scope, within: entry.scope }
          : { ...policy, scope: entry.scope },
      )
    }
  }
  return result
}
