import type { RepoTarget, Scope } from '@holtkeeper/access'
import type { MergeRequest, RepoRef } from '@holtkeeper/forge'

/** What happened to a merge request, normalized across forges. */
export type MergeRequestEventAction =
  | 'open'
  | 'update'
  | 'reopen'
  | 'label'
  | 'merge'
  | 'approve'
  | 'command'

export const mergeRequestEventActions = [
  'open',
  'update',
  'reopen',
  'label',
  'merge',
  'approve',
  'command',
] as const satisfies readonly MergeRequestEventAction[]

/**
 * A merge request event as the server normalizes it from a forge webhook. `mr.headSha` is optional:
 * when absent the engine asks the forge for it, and only when a condition or action needs it.
 */
export interface MergeRequestEvent {
  repo: RepoRef
  /** Groups the config puts the repository in; scopes match against them. */
  groups: string[]
  mr: MergeRequest & { headSha?: string }
  action: MergeRequestEventAction
  /** Labels added by this event (for `label` events). */
  labelsAdded?: string[]
  /** Who triggered the event. */
  actor: string
  /** Whether `actor` is a bot user. */
  isBot: boolean
  /** Whether the merge request author is a bot user; the engine's `bots` list is used when unset. */
  authorIsBot?: boolean
  /** For `command` events: the command name without the leading slash, e.g. `approve`. */
  command?: string
}

/** Pipeline state of the merge request head, reduced to what policies can decide on. */
export type PipelineState = 'success' | 'failed' | 'running' | 'none'

export const pipelineStates = [
  'success',
  'failed',
  'running',
  'none',
] as const satisfies readonly PipelineState[]

/** Glob lists that a set of values must satisfy; every given list must hold. */
export interface GlobSets {
  /** Every value matches one of these (and there is at least one value). */
  all?: string[]
  /** At least one value matches one of these. */
  any?: string[]
  /** No value matches any of these. */
  none?: string[]
}

/**
 * When a policy applies. Every field is optional and all given fields must hold (AND). `any`, `all`
 * and `not` combine nested conditions. An empty condition always holds.
 */
export interface Condition {
  /** One of these event actions. */
  event?: MergeRequestEventAction[]
  /** Source branch matches one of these globs. */
  sourceBranch?: string[]
  /** Target branch matches one of these globs. */
  targetBranch?: string[]
  /** Author matches one of `users` (names or globs) and, when `bot` is set, is or is not a bot. */
  author?: { users?: string[]; bot?: boolean }
  /** Label lists of the merge request: has all, has any, has none. Exact names. */
  labels?: { all?: string[]; any?: string[]; none?: string[] }
  /** One of these labels was added by this event. */
  labelAdded?: string[]
  /** Title matches this regular expression: `pattern` or `/pattern/flags`. */
  title?: string
  draft?: boolean
  /** For `command` events: the command is one of these. */
  command?: string[]
  /** Changed file paths (new path, old path for deletions) against globs. Loads the diff. */
  changedPaths?: GlobSets
  /**
   * Size of the diff: added plus removed lines and changed files. Loads the diff. Files the forge
   * collapsed as too large count as exceeding any line limit.
   */
  size?: { maxLines?: number; maxFiles?: number; minLines?: number; minFiles?: number }
  /** Latest pipeline for the head commit is in one of these states. */
  pipeline?: PipelineState[]
  all?: Condition[]
  any?: Condition[]
  not?: Condition
}

/** One action of a policy. `type` names a registered `ActionProvider`; the rest is its options. */
export interface PolicyAction {
  type: string
  [option: string]: unknown
}

/** A merge request policy as configured. */
export interface Policy {
  id: string
  name: string
  enabled: boolean
  /** Repositories the policy applies to. */
  scope: Scope
  /**
   * Scope of the settings entry the policy came from; the policy applies only where both scopes
   * cover the repository. Set by `combinePolicies`.
   */
  within?: Scope
  when: Condition
  actions: PolicyAction[]
  /** When the policy matched, later policies are not evaluated. */
  stop?: boolean
  /** Analyzers the caller should not enqueue for this event; `*` for all. */
  skipAnalyzers?: '*' | string[]
}

/** How an action ended. `intent` means the caller is asked to act (e.g. enqueue an analyzer). */
export type ActionStatus =
  | 'done'
  | 'dry-run'
  | 'skipped'
  | 'deferred'
  | 'unsupported'
  | 'failed'
  | 'intent'

/** The result of one action, ready for the activity log: what was done or why not. */
export interface ActionOutcome {
  policyId: string
  action: string
  status: ActionStatus
  detail: string
  data?: Record<string, unknown>
}

/** An analyzer the caller should enqueue for the merge request. */
export interface EnqueueIntent {
  analyzer: string
  options?: Record<string, unknown>
}

/**
 * Remembers actions that already happened, so they are not repeated for the same head commit.
 * The server backs it with the store; `createMemory` keeps it in memory.
 */
export interface PolicyMemory {
  seen(key: string): Promise<boolean> | boolean
  remember(key: string): Promise<void> | void
}

/** The repository of an event as scopes see it. */
export const eventRepo = (event: MergeRequestEvent): RepoTarget => ({
  ...event.repo,
  groups: event.groups,
})
