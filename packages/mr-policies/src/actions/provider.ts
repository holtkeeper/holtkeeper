import type { GitForge } from '@holtkeeper/forge'
import { z } from 'zod'

import type { MergeRequestFacts } from '../facts.ts'
import type {
  ActionStatus,
  EnqueueIntent,
  MergeRequestEvent,
  Policy,
  PolicyAction,
} from '../model.ts'

/** What an action provider returns; the engine adds the policy id and action type. */
export interface ActionResult {
  status: ActionStatus
  detail: string
  data?: Record<string, unknown>
  /** Analyzers the caller should enqueue. */
  enqueue?: EnqueueIntent[]
}

/** Everything an action may use. Providers must not change anything when `dryRun` is set. */
export interface ActionContext {
  event: MergeRequestEvent
  policy: Policy
  forge: GitForge
  facts: MergeRequestFacts
  now: Date
  dryRun: boolean
  /** The username Holtkeeper acts as on the forge, for self-approval checks. */
  botUser?: string
  /** Whether the policy's scope covers the event's repository. */
  scopeCovers: boolean
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  /**
   * Runs `effect` unless this is a dry run. Returns `done` with `detail`, `dry-run` with
   * `would <detail>`, or `failed` with the error message.
   */
  perform(
    detail: string,
    effect: () => Promise<unknown>,
    data?: Record<string, unknown>,
  ): Promise<ActionResult>
}

/**
 * One kind of policy action as the engine sees it. `schema` validates the action as configured
 * (including its literal `type`); `run` does the work, or explains why it did not.
 */
export interface ActionProvider {
  readonly type: string
  readonly schema: z.ZodType<PolicyAction>
  run(action: PolicyAction, context: ActionContext): Promise<ActionResult>
  /**
   * Key under which a successful run is remembered; a later run with the same key is skipped and
   * reported as such. Absent or `undefined` means the action may repeat.
   */
  onceKey?(action: PolicyAction, context: ActionContext): Promise<string | undefined>
}

/** A provider written against its own parsed options; `defineAction` turns it into an `ActionProvider`. */
export interface TypedActionProvider<Schema extends z.ZodType<PolicyAction>> {
  type: string
  schema: Schema
  run: (action: z.output<Schema>, context: ActionContext) => Promise<ActionResult>
  onceKey?: (action: z.output<Schema>, context: ActionContext) => Promise<string | undefined>
}

/** Wraps a typed provider: options are parsed with its schema first, invalid ones fail the action. */
export function defineAction<Schema extends z.ZodType<PolicyAction>>(
  provider: TypedActionProvider<Schema>,
): ActionProvider {
  const { type, schema, run, onceKey } = provider
  return {
    type,
    schema,
    async run(action, context) {
      const parsed = schema.safeParse(action)
      if (!parsed.success) {
        return { status: 'failed', detail: `invalid options: ${z.prettifyError(parsed.error)}` }
      }
      return run(parsed.data, context)
    },
    onceKey: onceKey
      ? async (action, context) => {
          const parsed = schema.safeParse(action)
          return parsed.success ? onceKey(parsed.data, context) : undefined
        }
      : undefined,
  }
}

/** Providers by action type. */
export type ActionRegistry = ReadonlyMap<string, ActionProvider>

/** Builds a registry; a later provider with the same type replaces an earlier one. */
export const createRegistry = (providers: readonly ActionProvider[]): ActionRegistry =>
  new Map(providers.map((provider) => [provider.type, provider]))

/** A memory key unique to the merge request head, policy and action options. */
export async function headShaKey(
  action: PolicyAction,
  context: ActionContext,
): Promise<string | undefined> {
  const sha = await context.facts.headSha()
  if (!sha) return undefined
  return mergeRequestKey(action, context, sha)
}

/** A memory key unique to the merge request, policy and action options, whatever the head is. */
export function mergeRequestKey(action: PolicyAction, context: ActionContext, sha = '*'): string {
  const { repo, mr } = context.event
  return `mr-policy:${repo.forge}:${repo.path}!${mr.id}@${sha}:${context.policy.id}:${JSON.stringify(action)}`
}
