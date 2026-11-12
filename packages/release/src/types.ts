import type { MergeRequest, PipelineStatus, RepoRef } from '@holtkeeper/forge'

import type { SectionId } from './sections.ts'
import type { Bump, ReleaseEventKind } from './settings.ts'
import type { VersionTag } from './version.ts'

/**
 * Where a repository is in its release flow, the most advanced pending step first:
 * `awaiting-version` (the target branch has changes no version holds yet), `proposed` (a release
 * candidate merge request is open), `candidate` (the source branch is ahead of the target),
 * `released` (the newest version holds everything), `idle` (nothing to release), `external`
 * (another tool releases it).
 */
export type ReleaseStage =
  | 'awaiting-version'
  | 'proposed'
  | 'candidate'
  | 'released'
  | 'idle'
  | 'external'

/** A commit as the release assistant reads it. */
export interface ReleaseCommit {
  sha: string
  parents: string[]
  author: { name: string; email: string }
  /** ISO 8601. */
  date: string
  subject: string
  body: string
}

/** A branch head. */
export interface BranchHead {
  name: string
  sha: string
  /** ISO 8601 commit date, when known. */
  date?: string
}

/** The latest pipeline of a branch or tag. */
export interface PipelineState {
  id: number
  status: PipelineStatus
  sha: string
  webUrl: string
}

/**
 * Where a person ran a release step: `ui` (the panel), `api`, `cli`, `forge` (a merge or a label)
 * or the id of the chat surface (`web` for the panel's chat).
 */
export type ReleaseChannel = string

/** Who runs a release step: a principal or forge user id, its display name and where they were. */
export interface ReleaseActor {
  id: string
  name?: string
  channel?: ReleaseChannel
}

/** Someone or something said the changes on the target branch may become a version. */
export interface Acceptance {
  /** Head of the target branch that was accepted. */
  sha: string
  /** Principal id of the person, or the forge username for merges and labels. */
  by: string
  /** Display name of `by` when it was accepted. */
  name?: string
  at: string
  via: 'manual' | 'label' | 'merge'
  channel?: ReleaseChannel
  note?: string
}

/** Everything the board and the plans need, read from the forge in one pass. */
export interface ReleaseFacts {
  repo: RepoRef
  webUrl: string
  defaultBranch: string
  target: BranchHead
  /** Absent in trunk mode or when the branch does not exist. */
  source?: BranchHead
  /** Version tags, newest version first. */
  versions: VersionTag[]
  latest?: VersionTag
  /** Commits on the source branch not on the target; capped, see `aheadCapped`. */
  ahead: ReleaseCommit[]
  aheadCapped: boolean
  /** Commits on the target branch since the latest version; capped like `ahead`. */
  unreleased: ReleaseCommit[]
  unreleasedCapped: boolean
  /** Open release candidate merge request. */
  request?: MergeRequest
  /** Newest merged merge request from source to target, when one was merged after the latest version. */
  merged?: MergeRequest & { mergedAt?: string }
  pipelines: { source?: PipelineState; target?: PipelineState }
  acceptance?: Acceptance
  /** Open merge requests carrying a blocking label. */
  blockers: { id: number; title: string; webUrl: string; labels: string[] }[]
}

/** Why the next version is what it is. */
export interface BumpReason {
  bump: Bump
  because: string
  /** Entry ids behind the reason. */
  entries: string[]
}

/** One line of the changelog: a commit or several with the same message. */
export interface ReleaseEntry {
  /** Stable across plans while the message stays the same. */
  id: string
  section: SectionId
  type?: string
  scope?: string
  breaking: boolean
  /** What the entry's commits call for, by the commit conventions' `bumpFor`. */
  bump: Bump
  /** Text as written in the commits. */
  title: string
  /** Text shown: `title` or what a person changed it to. */
  text: string
  tickets: string[]
  mergeRequests: number[]
  commits: { sha: string; subject: string; author: string; date: string }[]
  authors: string[]
  included: boolean
  /** Why an entry is left out. */
  excludedBy?: 'rule' | 'person' | 'revert'
}

/** What a person changed in a plan; kept until the step it is for runs. */
export interface ReleaseEdits {
  /** Version chosen instead of the suggestion. */
  version?: string
  /** Entries left out, by id. */
  excluded?: string[]
  /** Entries put back although a rule left them out, by id. */
  included?: string[]
  /** New text per entry id. */
  texts?: Record<string, string>
  summary?: { markdown: string; source: 'agent' | 'changelog' | 'person'; at: string }
  /** Merge request title instead of the default. */
  title?: string
  updatedAt?: string
  updatedBy?: string
}

/**
 * What a failing gate means: `block` refuses the step unless a person overrides it (hard gates
 * never), `warn` is shown but never refuses, `info` only states a fact.
 */
export type GateSeverity = 'block' | 'warn' | 'info'

/** A check a step must pass; failing `block` checks need an explicit override. */
export interface GateResult {
  id: 'pipeline' | 'blockers' | 'acceptance' | 'empty' | 'tag-exists' | 'order' | 'changelog'
  ok: boolean
  severity: GateSeverity
  message: string
}

/** What one step is going to do, before anyone confirms it. */
export interface ReleasePlan {
  step: 'propose' | 'version'
  /** Range of the changes: `from` (exclusive, absent for the first release) to `to`. */
  range: { from?: string; to: string; fromLabel?: string; toLabel: string }
  compareUrl?: string
  entries: ReleaseEntry[]
  /** Commits in the range before deduplication. */
  commitCount: number
  capped: boolean
  current?: VersionTag
  suggested: { bump: Bump; version?: string; reasons: BumpReason[] }
  /** The version the step uses: the edit or the suggestion. */
  version?: string
  tag?: string
  summary: { markdown: string; source: 'agent' | 'changelog' | 'person' | 'none' }
  /** Changelog markdown of the included entries. */
  changelog: string
  /** Title and description of the merge request (`propose`) or name and notes of the release (`version`). */
  title: string
  body: string
  gates: GateResult[]
  edits: ReleaseEdits
}

/** Where one environment stands for a version. */
export type DeployStatus =
  | 'no-pipeline'
  | 'missing'
  | 'waiting'
  | 'ready'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'

/** One run of a deploy job. */
export interface DeployAttempt {
  jobId: number
  status: PipelineStatus | 'created'
  webUrl: string
  startedAt?: string
  finishedAt?: string
  durationSeconds?: number
  /** Who started this run through Holtkeeper: a principal id or forge username. */
  actor?: string
  /** Display name of `actor` when it differs from the id. */
  actorName?: string
  /** Why it was started when it was not a plain first deploy: a redeploy or an overridden order. */
  reason?: string
}

export interface EnvironmentState {
  name: string
  job?: string
  status: DeployStatus
  /** Newest first, retried runs included. */
  attempts: DeployAttempt[]
  after?: string
  confirm: boolean
  /** What the forge reports as deployed there now, when it tracks environments. */
  current?: { ref: string; sha: string; status: string; at?: string }
}

/** Deploy state of one version. */
export interface DeployState {
  tag: string
  pipeline?: PipelineState
  environments: EnvironmentState[]
}

/**
 * What runs on one environment now: `tag` and `version` it runs (what the forge reports deployed
 * there, else the latest version once its deploy job succeeded), the `status` of the latest
 * version's deploy job there and when that last changed.
 */
export interface EnvironmentSummary {
  name: string
  tag?: string
  version?: string
  status: DeployStatus
  at?: string
}

/** One row of the release board. */
export interface ReleaseBoardRow {
  repo: RepoRef
  stage: ReleaseStage
  mode: 'merge-request' | 'trunk' | 'external'
  webUrl?: string
  source?: string
  target?: string
  latest?: VersionTag
  /** Suggested next version for what is waiting, if anything. */
  next?: string
  bump?: Bump
  ahead: number
  aheadCapped: boolean
  unreleased: number
  unreleasedCapped: boolean
  tickets: string[]
  request?: Pick<MergeRequest, 'id' | 'title' | 'webUrl' | 'draft'>
  pipelines: { source?: PipelineState; target?: PipelineState }
  acceptance?: Acceptance
  /** Since when the target branch waits for a version (oldest unreleased commit, else the merge). */
  waitingSince?: string
  /**
   * Failing `block` gates of the pending step (the version while the target branch has unreleased
   * changes, else the release candidate), as plain sentences. Acceptance is not among them: see
   * `acceptanceRequired` and `acceptance`.
   */
  blockers: string[]
  /** The flow needs an acceptance before a version is created (`acceptance` is not `none`). */
  acceptanceRequired: boolean
  /** Why the next version is what it is, from the pending step's plan. */
  reasons: string[]
  /** Changes of the pending step's plan left out of the changelog. */
  leftOut: number
  /** Tracker tasks among the pending step's included changes (the length of `tickets`). */
  tasks: number
  /** One entry per configured environment, in the configured order. */
  environments: EnvironmentSummary[]
  deploy?: DeployState
  error?: string
}

/** The notes a version was created with: their source, whether a person edited the plan, the Markdown. */
export interface VersionNotes {
  source: ReleasePlan['summary']['source']
  edited: boolean
  /** The written notes above the changelog; absent when there were none. */
  markdown?: string
}

/** A recorded release event for history and notifications. */
export interface ReleaseEvent {
  kind: ReleaseEventKind
  repo: RepoRef
  at: string
  actor: string
  /** Display name of `actor` when it differs from the id. */
  actorName?: string
  channel?: ReleaseChannel
  version?: string
  tag?: string
  environment?: string
  url?: string
  detail?: string
  /** `accepted`: the target head accepted; `versioned`: the target head the version was cut from. */
  sha?: string
  /** `accepted`: how it was accepted. */
  via?: Acceptance['via']
  /** `accepted`: the note the person left. */
  note?: string
  /** `versioned`: failing gates were overridden. */
  force?: boolean
  /** `versioned`: where the notes came from, whether a person changed the plan and the written notes. */
  notes?: VersionNotes
  /** `versioned`: the commit that prepended the notes to `CHANGELOG.md`. */
  changelogSha?: string
  /** `deploy-started`: the job that was started. */
  jobId?: number
  /** `deploy-started`: why, when it was not a plain first deploy. */
  reason?: string
}

/** Who did what to cut one version, from the recorded release events. */
export interface ReleaseProvenance {
  /** The acceptance the version was created on, when one was recorded. */
  accepted?: {
    actor: string
    actorName?: string
    channel?: ReleaseChannel
    at: string
    via?: Acceptance['via']
    note?: string
    sha?: string
  }
  /** The step that created the version, when Holtkeeper created it. */
  versioned?: {
    actor: string
    actorName?: string
    channel?: ReleaseChannel
    at: string
    force: boolean
    notes?: VersionNotes
    changelogSha?: string
    url?: string
  }
}
