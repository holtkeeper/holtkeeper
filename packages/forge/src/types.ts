/** Identifies a repository: the config's forge id plus the repository's full path. */
export interface RepoRef {
  forge: string
  path: string
}

/** Repository metadata as the forge reports it. */
export interface Repository {
  path: string
  name: string
  defaultBranch: string
  webUrl: string
  cloneUrl: string
  archived: boolean
}

/** One file operation inside an API commit. */
export type FileChange =
  | {
      action: 'create' | 'update'
      path: string
      content: string
      /** `base64` for binary files such as images; default `text`. */
      encoding?: 'text' | 'base64'
    }
  | { action: 'delete'; path: string }

/** A commit made through the forge API, without a local clone. */
export interface CommitInput {
  branch: string
  startBranch?: string
  message: string
  changes: FileChange[]
}

export interface Commit {
  sha: string
  webUrl: string
}

export type MergeRequestState = 'open' | 'merged' | 'closed'

/** A merge request (GitLab) or pull request (GitHub); `id` is the per-repository number. */
export interface MergeRequest {
  id: number
  title: string
  description: string
  sourceBranch: string
  targetBranch: string
  state: MergeRequestState
  draft: boolean
  labels: string[]
  author: string
  webUrl: string
}

export interface CreateMergeRequestInput {
  sourceBranch: string
  targetBranch: string
  title: string
  description?: string
  labels?: string[]
  reviewers?: string[]
  draft?: boolean
}

export type UpdateMergeRequestInput = Partial<
  Pick<CreateMergeRequestInput, 'title' | 'description' | 'labels' | 'targetBranch' | 'draft'>
> & { state?: 'open' | 'closed' }

export interface MergeOptions {
  squash?: boolean
  removeSourceBranch?: boolean
  whenPipelineSucceeds?: boolean
}

/** Provider statuses normalized to one set. */
export type PipelineStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'manual'

export interface Pipeline {
  id: number
  ref: string
  sha: string
  status: PipelineStatus
  webUrl: string
}

export interface Job {
  id: number
  name: string
  stage: string
  status: PipelineStatus
  webUrl: string
}

export interface Tag {
  name: string
  sha: string
}

/** A merge request with its timestamps, for delivery insights. Times are ISO 8601. */
export interface MergeRequestRecord extends MergeRequest {
  createdAt: string
  updatedAt: string
  /** Set once merged. */
  mergedAt?: string
  /** Set once closed without merging. */
  closedAt?: string
  /** Author date of the oldest commit, when the provider returns it without extra requests. */
  firstCommitAt?: string
  /** Number of changed files, when the provider returns it without extra requests. */
  changesCount?: number
  /** The commit the merge request currently points at, when the list carries it. */
  headSha?: string
}

/** Filters for `listMergeRequests`; omitted fields do not filter. */
export interface MergeRequestQuery {
  /** Default `all`. */
  state?: MergeRequestState | 'all'
  /** Only merge requests updated at or after this ISO 8601 time. */
  updatedAfter?: string
  targetBranch?: string
  /** At most this many, newest update first; all matching when omitted. */
  limit?: number
}

/** A pipeline with timing, for CI health. Durations are seconds, absent while unknown. */
export interface PipelineRun extends Pipeline {
  createdAt: string
  updatedAt?: string
  startedAt?: string
  finishedAt?: string
  /** Time spent running, excluding queueing. */
  durationSeconds?: number
  /** Time spent waiting for runners. */
  queuedSeconds?: number
  /** What triggered the pipeline as the provider names it, e.g. `push`, `merge_request_event`, `schedule`. */
  source?: string
}

/** Filters for `listPipelineRuns`; omitted fields do not filter. */
export interface PipelineRunQuery {
  ref?: string
  /** Only pipelines created at or after this ISO 8601 time. */
  after?: string
  /** At most this many, newest first; all matching when omitted. */
  limit?: number
}

/** One job attempt of a pipeline, including attempts that were retried. */
export interface JobRun extends Job {
  pipelineId: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  durationSeconds?: number
  queuedSeconds?: number
  /** True when a later attempt of the same job in the same pipeline replaced this one. */
  retried: boolean
  /** True when the job may fail without failing the pipeline. */
  allowFailure: boolean
  /** Branch or tag of the job's pipeline, when the read reports it. */
  ref?: string
  /** Commit of the job's pipeline, when the read reports it. */
  sha?: string
  /** True when the pipeline ran for a tag rather than a branch, when the read reports it. */
  tag?: boolean
}

/** An image read from a forge, e.g. an avatar. */
export interface ForgeImage {
  data: Uint8Array
  contentType: string
}

/** Filters for `listProjectJobRuns`; omitted fields do not filter. */
export interface JobRunQuery {
  /** Only jobs created at or after this ISO 8601 time. */
  after?: string
  /** At most this many, newest first; all matching when omitted. */
  limit?: number
}

/** Deployment statuses normalized to one set. */
export type DeploymentStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'skipped'
  | 'blocked'

/** A deployment to an environment. */
export interface Deployment {
  id: number
  environment: string
  status: DeploymentStatus
  sha: string
  ref: string
  createdAt: string
  /** When the deployment job finished, if it did. */
  finishedAt?: string
}

/** Filters for `listDeployments`; omitted fields do not filter. */
export interface DeploymentQuery {
  environment?: string
  /** Only deployments updated at or after this ISO 8601 time. */
  after?: string
  /** At most this many, newest first; all matching when omitted. */
  limit?: number
}

/** A tag with the date of the commit it points to. */
export interface TagRecord extends Tag {
  /** Commit date of the tagged commit. */
  committedAt: string
  /** When an annotated tag was created; absent for lightweight tags. */
  createdAt?: string
}

/** A branch with its head commit, for branch hygiene. Times are ISO 8601. */
export interface BranchRecord {
  name: string
  sha: string
  /** Commit date of the head commit. */
  committedAt: string
  /** Author of the head commit, when the forge reports it. */
  authorName?: string
  authorEmail?: string
  /** The head commit is reachable from the default branch (squash merges do not count). */
  merged: boolean
  protected: boolean
  default: boolean
  webUrl?: string
}

/** An entry of a repository tree, with its path from the repository root. */
export interface TreeEntry {
  path: string
  type: 'file' | 'dir'
}

/** Filters for `listFiles`; omitted fields use the defaults stated there. */
export interface ListFilesOptions {
  /** Directory to list, relative to the root; the root when omitted. */
  path?: string
  /** Branch, tag or commit; the default branch when omitted. */
  ref?: string
  /** Lists the whole subtree instead of direct children. Default `false`. */
  recursive?: boolean
  /** At most this many entries. Default 10 000. */
  limit?: number
}

/**
 * Provider-neutral access to a Git hosting service. Repositories are addressed by full path.
 * Methods reject on transport or permission errors; lookups that may miss return `undefined`.
 */
/** The three commits a merge request diff is computed from; positions of review comments need them. */
export interface DiffRefs {
  baseSha: string
  startSha: string
  headSha: string
}

/** One changed file of a merge request. `diff` is the unified diff body (`@@` hunks). */
export interface DiffFile {
  oldPath: string
  newPath: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  diff: string
  binary?: boolean
  /** The forge left the diff out because it is too large. */
  collapsed?: boolean
}

export interface MergeRequestDiff {
  refs: DiffRefs
  files: DiffFile[]
}

/**
 * A review comment on a line (or a range ending at `line`) of the merge request diff. Lines refer
 * to the new version unless `side` is `old`. A `suggestion` replaces lines `startLine..line` (or just
 * `line`) of the new version; forges render it as a change the author can apply with one click.
 */
export interface ReviewComment {
  path: string
  line: number
  startLine?: number
  side?: 'new' | 'old'
  body: string
  suggestion?: { replacement: string }
}

export interface DiscussionNote {
  id: number | string
  author: string
  body: string
  createdAt: string
  system: boolean
}

/** A comment thread on a merge request, on a diff line or general. */
export interface Discussion {
  id: string
  resolvable: boolean
  resolved: boolean
  notes: DiscussionNote[]
  position?: { path: string; line: number; side: 'new' | 'old'; headSha: string }
}

export interface ReviewSubmission {
  refs: DiffRefs
  comments: ReviewComment[]
  /** Overall review text, posted as one general comment. */
  summary?: string
  /** `approve` also approves where the forge supports it. */
  event?: 'comment' | 'approve' | 'request_changes'
}

export interface ReviewOutcome {
  posted: number
  /** Comments the forge rejected, e.g. a line outside the diff. */
  failed: { comment: ReviewComment; error: string }[]
}

/** A CI/CD variable pipelines of a repository receive, as the forge stores it. */
export interface CiVariable {
  key: string
  value: string
  /** Environments it applies to; `*` for all. */
  environmentScope: string
}

/** Whose CI/CD variables to read: one repository's own, or one group's (not its parents'). */
export interface CiVariableScope {
  kind: 'repo' | 'group'
  path: string
}

export interface GitForge {
  readonly kind: string

  listRepositories(namespace: string): AsyncIterable<Repository>
  getRepository(repo: string): Promise<Repository>
  /** File contents at `ref` (default branch when omitted), or `undefined` if it does not exist. */
  readFile(repo: string, file: string, ref?: string): Promise<string | undefined>
  /** Raw bytes of a file, for binary content such as images; `undefined` if it does not exist. */
  readFileBytes?(repo: string, file: string, ref?: string): Promise<Uint8Array | undefined>
  /**
   * Files and directories under `options.path` without a clone; empty when the path or ref does
   * not exist. Submodules are left out. Optional so adapters can add it later.
   */
  listFiles?(repo: string, options?: ListFilesOptions): Promise<TreeEntry[]>

  createBranch(repo: string, branch: string, ref: string): Promise<void>
  deleteBranch(repo: string, branch: string): Promise<void>
  /** Commits all changes atomically; creates `branch` from `startBranch` when it does not exist. */
  commit(repo: string, input: CommitInput): Promise<Commit>

  findMergeRequest(
    repo: string,
    query: { sourceBranch: string; targetBranch?: string; state?: MergeRequestState },
  ): Promise<MergeRequest | undefined>
  createMergeRequest(repo: string, input: CreateMergeRequestInput): Promise<MergeRequest>
  updateMergeRequest(
    repo: string,
    id: number,
    input: UpdateMergeRequestInput,
  ): Promise<MergeRequest>
  mergeMergeRequest(repo: string, id: number, options?: MergeOptions): Promise<void>
  commentOnMergeRequest(repo: string, id: number, body: string): Promise<void>

  /** Newest first, one page; `updatedAfter` (ISO 8601) keeps pipelines changed since then. */
  listPipelines(
    repo: string,
    query: { ref?: string; sha?: string; updatedAfter?: string },
  ): Promise<Pipeline[]>
  listJobs(repo: string, pipelineId: number): Promise<Job[]>
  /** Starts a manual job. */
  playJob(repo: string, jobId: number): Promise<Job>
  retryJob(repo: string, jobId: number): Promise<Job>

  createTag(repo: string, input: { name: string; ref: string; message?: string }): Promise<Tag>

  /**
   * Read-only history for delivery insights. Optional so adapters can add them later; callers
   * check for presence. Lists are newest first and return at most `limit` items.
   */
  listMergeRequests?(repo: string, query?: MergeRequestQuery): Promise<MergeRequestRecord[]>
  /** Pipelines with timing details. */
  listPipelineRuns?(repo: string, query?: PipelineRunQuery): Promise<PipelineRun[]>
  /** Every job attempt of a pipeline, retried attempts included. */
  listJobRuns?(repo: string, pipelineId: number): Promise<JobRun[]>
  /**
   * Job attempts of every pipeline of the repository, retried attempts included, with `ref` and
   * `sha` set. Cheaper than `listJobRuns` per pipeline when reading long histories.
   */
  listProjectJobRuns?(repo: string, query?: JobRunQuery): Promise<JobRun[]>
  listDeployments?(repo: string, query?: DeploymentQuery): Promise<Deployment[]>
  /** Tags, most recently updated first. */
  listTags?(repo: string, query?: { limit?: number }): Promise<TagRecord[]>
  /** Every branch of the repository, the default branch included, in no particular order. */
  listBranches?(repo: string): Promise<BranchRecord[]>

  // Code review. Optional so forges can add them one by one.

  /** One merge request by its number, with the commit it currently points at. */
  getMergeRequest?(repo: string, id: number): Promise<MergeRequest & { headSha: string }>
  /** The merge request's latest diff, with the refs review comments must be positioned against. */
  getMergeRequestDiff?(repo: string, id: number): Promise<MergeRequestDiff>
  /** Diff between two commits of the repository, e.g. what changed since the last review. */
  compareCommits?(repo: string, from: string, to: string): Promise<DiffFile[]>
  listDiscussions?(repo: string, id: number): Promise<Discussion[]>
  /** Posts all comments as one review where the forge supports batching (GitLab draft notes). */
  submitReview?(repo: string, id: number, review: ReviewSubmission): Promise<ReviewOutcome>
  replyToDiscussion?(repo: string, id: number, discussionId: string, body: string): Promise<void>
  resolveDiscussion?(
    repo: string,
    id: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<void>

  /** The account behind the token, e.g. the identity for commits signed with its SSH key. */
  getCurrentUser?(): Promise<ForgeUser>
  /**
   * The repository's avatar image, else the nearest parent group's; `undefined` when none of them
   * has one. `contentType` is a raster or SVG image type.
   */
  getRepositoryAvatar?(repo: string): Promise<ForgeImage | undefined>

  // CI/CD settings. Optional so forges can add them one by one.

  /**
   * CI/CD variables defined directly on a repository or group, without inherited ones. Masked,
   * hidden and file variables are left out, so values are never secrets the forge protects.
   * `undefined` when the token may not read them (they usually need maintainer access) or the
   * scope does not exist.
   */
  listCiVariables?(scope: CiVariableScope): Promise<CiVariable[] | undefined>
  /**
   * Tags of a container image in this forge's own registry, e.g.
   * `registry.example.com/group/project/image` (no tag); `undefined` when this forge does not
   * serve the image or the token may not read it.
   */
  listImageTags?(image: string): Promise<string[] | undefined>

  // SSH keys. Optional so forges can add them one by one.

  /** Registers a public key for the token's own user or as a deploy key of one repository. */
  registerSshKey?(key: SshKeyRegistration): Promise<{ id: string }>
  /** Keys registered in `scope`; for `deploy`, the keys enabled on that repository. */
  listSshKeys?(scope: SshKeyListScope): Promise<SshKeyRecord[]>
  /** Removes a key from `scope`; a deploy key stays on the other repositories it is enabled on. */
  removeSshKey?(id: string, scope: SshKeyListScope): Promise<void>
  /** Enables an already registered deploy key on one more repository. */
  enableDeployKey?(id: string, scope: Extract<SshKeyScope, { kind: 'deploy' }>): Promise<void>

  // Webhooks. Optional so forges can add them one by one.

  /**
   * Makes sure a hook with `hook.url` exists on the group or project and has this secret and these
   * events; an existing hook with the same URL is updated instead of duplicated.
   */
  ensureWebhook?(target: WebhookTarget, hook: WebhookSpec): Promise<WebhookRegistration>
  /** Removes the hooks `ensureWebhook` reported; hooks that are already gone are ignored. */
  removeWebhook?(hooks: RegisteredHook[]): Promise<void>
}

/**
 * Something that happened on a forge, from a webhook delivery or found by polling. Holtkeeper
 * reacts to it the same way whatever its source.
 */
export type ForgeEvent =
  | TagPushedEvent
  | BranchPushedEvent
  | MergeRequestChangedEvent
  | NoteAddedEvent
  | PipelineDoneEvent

/** A tag was created or moved. */
export interface TagPushedEvent {
  kind: 'tag'
  repo: RepoRef
  tag: string
  sha: string
}

/** Commits were pushed to a branch, or a branch was created. Deleted branches are not reported. */
export interface BranchPushedEvent {
  kind: 'push'
  repo: RepoRef
  branch: string
  /** The branch head after the push. */
  sha: string
  /** Username of whoever pushed; empty when unknown (polling). */
  actor: string
}

/**
 * A merge request changed. `action` follows GitLab: `open`, `reopen`, `update`, `merge`, `close`,
 * `approved`; `update` covers new commits, label changes, leaving draft and edits.
 */
export interface MergeRequestChangedEvent {
  kind: 'mergeRequest'
  repo: RepoRef
  action: string
  /** Username of whoever caused it; empty when unknown. */
  actor: string
  /** Commits were pushed since the previous state. */
  newCommits: boolean
  /** The merge request just left draft. */
  leftDraft: boolean
  labelsAdded: string[]
  /** The merge request after the change, as far as the source knows it. */
  mr: MergeRequest & { headSha?: string }
}

/** A comment on a merge request. */
export interface NoteAddedEvent {
  kind: 'note'
  repo: RepoRef
  mergeRequest: number
  mergeRequestState: MergeRequestState
  headSha?: string
  author: string
  body: string
  discussionId?: string
  /** The note is part of a thread (a diff or discussion note), not a standalone comment. */
  inThread: boolean
}

/** A merge request pipeline finished. */
export interface PipelineDoneEvent {
  kind: 'pipeline'
  repo: RepoRef
  mergeRequest: number
  pipelineId: number
  status: PipelineStatus
  sha: string
  actor: string
}

/** Events a forge webhook can deliver. */
export type WebhookEvent = 'push' | 'tag_push' | 'merge_request' | 'note' | 'pipeline'

/** Where a webhook goes: a group (all its projects) or one project, by full path. */
export interface WebhookTarget {
  group?: string
  project?: string
}

export interface WebhookSpec {
  url: string
  secret: string
  events: WebhookEvent[]
}

/** One hook on the forge. */
export interface RegisteredHook {
  id: string
  scope: 'group' | 'project'
  /** Group or project path. */
  target: string
}

/**
 * What `ensureWebhook` set up. `id` is the first hook's id. When a group hook is not available
 * (e.g. GitLab Free), the forge may fall back to one hook per project and says so in `fallback`.
 */
export interface WebhookRegistration {
  id: string
  hooks: RegisteredHook[]
  fallback?: string
}

/** What a config holds under `forges`; `create` is called lazily, when a task needs the forge. */
export interface ForgeDefinition {
  kind: string
  url: string
  create(): GitForge
  /**
   * HTTPS basic-auth credentials that let `git clone` and `git fetch` reach this forge's
   * repositories. Resolves secrets when called; absent when the forge cannot provide them.
   */
  gitCredentials?(): { username: string; password: string }
  /**
   * The same forge with its HTTP `fetch` replaced by `wrap(current fetch)`, e.g. to apply shared
   * rate limits. Absent when the adapter does not use `fetch`.
   */
  withFetch?(wrap: (fetch: ForgeFetch) => ForgeFetch): ForgeDefinition
}

/** The `fetch` shape forge adapters call; the global `fetch` satisfies it. */
export type ForgeFetch = (input: string, init: RequestInit) => Promise<Response>

/** The forge account behind a token. `email` is the one commits should use to show as verified. */
export interface ForgeUser {
  username: string
  name: string
  email?: string
}

/** What an SSH key may be used for: git over SSH, commit signing, or both. */
export type SshKeyUsage = 'auth' | 'signing' | 'auth_and_signing'

/**
 * Where a key is registered: on the account behind the forge token (`user`) or as a deploy key of
 * one repository, which can only authenticate git transport.
 */
export type SshKeyScope = { kind: 'user' } | { kind: 'deploy'; repo: string; canPush: boolean }

/** A scope to list or remove keys in; deploy keys are addressed by repository alone. */
export type SshKeyListScope = { kind: 'user' } | { kind: 'deploy'; repo: string }

/** A public key to register. `publicKey` is one OpenSSH line (`ssh-ed25519 AAAA… comment`). */
export interface SshKeyRegistration {
  title: string
  publicKey: string
  usage: SshKeyUsage
  /** ISO 8601; the forge stops accepting the key afterwards. */
  expiresAt?: string
  scope: SshKeyScope
}

/** A registered key as the forge reports it. */
export interface SshKeyRecord {
  id: string
  title: string
  publicKey: string
  usage: SshKeyUsage
  expiresAt?: string
  createdAt?: string
  /** Deploy keys only. */
  canPush?: boolean
}
