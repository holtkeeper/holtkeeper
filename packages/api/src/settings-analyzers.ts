import type { Scope } from '@holtkeeper/access'
import type { Timestamp } from '@holtkeeper/store'

import type { SettingView } from './types.ts'

/** One analyzer's jobs over the health window. */
export interface AnalyzerHealthView {
  analyzer: string
  runs: number
  failed: number
  /** Refused or stopped by the AI budget. */
  blocked: number
  /** Repositories (or groups) it ran on. */
  targets: number
  lastRunAt?: Timestamp
  lastFailureAt?: Timestamp
  medianDurationMs?: number
}

/** `GET /api/jobs/analyzers/health` — jobs of the last `days` days per analyzer. */
export interface AnalyzerHealthList {
  days: number
  analyzers: AnalyzerHealthView[]
}

/** One change of a policy draft: put an entry (replace it with `id`) or remove one. */
export type PolicyDraftChange =
  | { op: 'put'; id?: string; key: string; scope: Scope; value: unknown }
  | { op: 'remove'; id: string }

/** `POST /api/settings/draft` — saves several setting changes at once; all or nothing. */
export interface PolicyDraftInput {
  changes: PolicyDraftChange[]
}

/** Result of `POST /api/settings/draft`. */
export interface PolicyDraftResult {
  saved: SettingView[]
  removed: string[]
}

/** `POST /api/commit-conventions/check` — checks a message, a branch name or both. */
export interface CommitConventionsCheckInput {
  /** `forge:path` */
  repo: string
  message?: string
  branch?: string
}

/** One rule a checked message or branch breaks. */
export interface CommitConventionsProblem {
  target: 'message' | 'branch'
  /** The convention field it breaks (`types`, `ticket`, `maxLength`, ...) or `pattern`. */
  rule: string
  message: string
  /** `error` breaks a configured or enforced rule; `warning` only differs from recent history. */
  severity: 'error' | 'warning'
  /** Where the rule comes from: `setting`, `push-rule`, `commitlint` or `history`. */
  source: string
}

/** Result of `POST /api/commit-conventions/check`; `ok` when no problem is an `error`. */
export interface CommitConventionsCheckResult {
  ok: boolean
  problems: CommitConventionsProblem[]
}
