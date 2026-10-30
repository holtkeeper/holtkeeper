import type { AgentReport, CheckResult } from '@holtkeeper/propagate'

/** What to port, as options give it: exactly one of `mergeRequest`, `commits` or `range`. */
export interface SourceSpec {
  /** `forge:path` of the source repository; a bare path means the group's forge. */
  repo: string
  mergeRequest?: number
  commits?: string[]
  range?: { from: string; to: string }
}

export type SourceKind = 'merge-request' | 'commits' | 'range'

/** One file of the source change. `diff` is the patch body after the `---`/`+++` header lines. */
export interface SourceFile {
  oldPath: string
  newPath: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  diff: string
  binary?: boolean
  /** Contents before the change, when known; lets `git apply --3way` merge in a sibling repository. */
  preimage?: string
}

/** The loaded source change; `files` may list a path more than once for several commits. */
export interface SourceChange {
  repo: string
  path: string
  kind: SourceKind
  mergeRequest?: number
  commits?: string[]
  range?: { from: string; to: string }
  title: string
  description: string
  webUrl?: string
  files: SourceFile[]
  /** Issue references found in the title and description: `#12`, `GTW-435`, issue URLs. */
  issues: string[]
}

/** Path rewrite used to apply the source patch to a repository with another layout. */
export interface PathMapping {
  from: string
  to: string
}

export type TriageVerdict = 'apply' | 'already-present' | 'not-applicable' | 'unclear'

/** Result of the cheap pre-check of one target. */
export interface TriageResult {
  verdict: TriageVerdict
  reason: string
  by: 'rules' | 'agent'
  /** Changed symbols found in the target. */
  symbols?: string[]
}

/** What the adapting agent must answer with. */
export interface AdaptReport {
  status: 'ported' | 'not-applicable' | 'already-present' | 'failed'
  summary: string
  changes: string[]
  deviations: string[]
}

export type PortMethod = 'clean' | 'remapped' | 'adapted'

export type PortOutcome =
  | 'ported-clean'
  | 'ported-remapped'
  | 'ported-adapted'
  | 'already-present'
  | 'not-applicable'
  | 'failed'
  | 'error'

/** Lines changed in a target, from `git diff --numstat`. */
export interface DiffStat {
  files: number
  additions: number
  deletions: number
}

/** Result of porting the change to one repository. */
export interface TargetOutcome {
  repo: string
  webUrl?: string
  outcome: PortOutcome
  /** How the change got in, also for `failed` targets whose checks fail after the port. */
  method?: PortMethod
  /** Why the target was skipped or failed. */
  reason?: string
  triage?: TriageResult
  remapped: PathMapping[]
  adapt?: AdaptReport
  checks: CheckResult[]
  fix?: { attempts: number; report?: AgentReport; files: string[] }
  changedFiles: string[]
  diffStat: DiffStat
  mergeRequest?: { id: number; url: string; draft: boolean }
  notes: string[]
  error?: string
}

/** A source file as stored: no pre-image, the diff trimmed. */
export interface StoredSourceFile {
  oldPath: string
  newPath: string
  status: SourceFile['status']
  binary?: boolean
  additions: number
  deletions: number
  diff: string
}

/** Everything the `port` analysis stores for one run. */
export interface PortData {
  group: string
  source: {
    repo: string
    kind: SourceKind
    mergeRequest?: number
    commits?: string[]
    range?: { from: string; to: string }
    title: string
    description: string
    webUrl?: string
    issues: string[]
    /** Deterministic summary given to agents and shown in reports. */
    intent: string
    files: StoredSourceFile[]
  }
  branch: string
  dryRun: boolean
  targets: TargetOutcome[]
  /** Whether the summary comment on the source merge request was posted. */
  sourceComment?: { posted: boolean; error?: string }
}
