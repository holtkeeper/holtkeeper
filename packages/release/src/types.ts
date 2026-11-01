import type { SectionId } from '@holtkeeper/changelog'
import type { MergeRequest, PipelineStatus, RepoRef } from '@holtkeeper/forge'

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

/** Someone or something said the changes on the target branch may become a version. */
export interface Acceptance {
  /** Head of the target branch that was accepted. */
  sha: string
  by: string
  at: string
  via: 'manual' | 'label' | 'merge'
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
  /** Merge request title instead of the template's. */
  title?: string
  updatedAt?: string
  updatedBy?: string
}

/** A check a step must pass; failing checks need an explicit override. */
export interface GateResult {
  id: 'pipeline' | 'freeze' | 'blockers' | 'acceptance' | 'empty' | 'tag-exists' | 'order'
  ok: boolean
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
  /** Title and description of the merge request (`propose`) or notes of the release (`version`). */
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
}

export interface EnvironmentState {
  name: string
  job?: string
  status: DeployStatus
  /** Newest first, retried runs included. */
  attempts: DeployAttempt[]
  after?: string
  confirm: boolean
  auto: boolean
  /** What the forge reports as deployed there now, when it tracks environments. */
  current?: { ref: string; sha: string; status: string; at?: string }
}

/** Deploy state of one version. */
export interface DeployState {
  tag: string
  pipeline?: PipelineState
  environments: EnvironmentState[]
}

/** A suggested flow for a repository without its own settings. */
export interface FlowDetection {
  preset: string
  settings: Record<string, unknown>
  reasons: string[]
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
  deploy?: DeployState
  error?: string
}

/** A recorded release event for history and notifications. */
export interface ReleaseEvent {
  kind: ReleaseEventKind
  repo: RepoRef
  at: string
  actor: string
  version?: string
  tag?: string
  environment?: string
  url?: string
  detail?: string
}
