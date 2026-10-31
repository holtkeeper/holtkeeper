import {
  imageType,
  resolveSecret,
  type Commit,
  type Deployment,
  type DeploymentStatus,
  type DiffFile,
  type DiffRefs,
  type Discussion,
  type ForgeDefinition,
  type GitForge,
  type Job,
  type JobRun,
  type MergeRequest,
  type MergeRequestRecord,
  type MergeRequestState,
  type Pipeline,
  type PipelineRun,
  type PipelineStatus,
  type Repository,
  type ReviewComment,
  type ReviewOutcome,
  type Secret,
  type TreeEntry,
} from '@holtkeeper/forge'
import { z } from 'zod'

import { gitlabHooks } from './hooks.ts'
import { createGitLabClient, encode, GitLabApiError, type FetchLike } from './http.ts'
import { invalidReason, parseHunks, renderBody, textPosition, type PositionFile } from './review.ts'
import { gitlabSshKeyMethods } from './ssh-keys.ts'

export interface GitLabForgeOptions {
  /** GitLab base URL, with or without a trailing slash, including the path prefix of a self-managed instance. */
  url: string
  /** Personal, project or group access token with the `api` scope (`read_api` for read-only use). */
  token: Secret
  fetch?: FetchLike
  /** Page size for paginated lists (GitLab allows 1 to 100). Default 100. */
  perPage?: number
  /** How many times a 429 answer is retried after waiting for `Retry-After` (capped at 60 s). Default 1. */
  retries?: number
}

const projectSchema = z.object({
  path_with_namespace: z.string(),
  name: z.string(),
  default_branch: z.string().nullable().optional(),
  web_url: z.string(),
  http_url_to_repo: z.string(),
  archived: z.boolean().optional(),
})

const mergeRequestSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable().optional(),
  source_branch: z.string(),
  target_branch: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
  web_url: z.string(),
})

const pipelineSchema = z.object({
  id: z.number(),
  ref: z.string(),
  sha: z.string(),
  status: z.string(),
  web_url: z.string(),
})

const jobSchema = z.object({
  id: z.number(),
  name: z.string(),
  stage: z.string(),
  status: z.string(),
  web_url: z.string(),
})

const time = z.string().nullable().optional()
const seconds = z.number().nullable().optional()

const mergeRequestRecordSchema = mergeRequestSchema.extend({
  created_at: z.string(),
  updated_at: z.string(),
  merged_at: time,
  closed_at: time,
  sha: z.string().nullable().optional(),
})

const pipelineRunSchema = pipelineSchema.extend({
  created_at: z.string(),
  updated_at: time,
  started_at: time,
  finished_at: time,
  duration: seconds,
  queued_duration: seconds,
  source: z.string().nullable().optional(),
})

const jobRunSchema = jobSchema.extend({
  created_at: z.string(),
  started_at: time,
  finished_at: time,
  duration: seconds,
  queued_duration: seconds,
  allow_failure: z.boolean().optional(),
  retried: z.boolean().optional(),
})

const projectJobRunSchema = jobRunSchema.extend({
  ref: z.string().nullable().optional(),
  tag: z.boolean().nullable().optional(),
  commit: z.object({ id: z.string() }).nullable().optional(),
  pipeline: z.object({
    id: z.number(),
    ref: z.string().nullable().optional(),
    sha: z.string().nullable().optional(),
  }),
})

const deploymentSchema = z.object({
  id: z.number(),
  ref: z.string(),
  sha: z.string(),
  status: z.string(),
  created_at: z.string(),
  environment: z.object({ name: z.string() }).nullable().optional(),
  deployable: z.object({ finished_at: time }).nullable().optional(),
})

const tagRecordSchema = z.object({
  name: z.string(),
  commit: z.object({ id: z.string(), committed_date: time, created_at: time }),
  created_at: time,
})

const ciVariableSchema = z.object({
  key: z.string(),
  value: z.string().nullable().optional(),
  variable_type: z.string().optional(),
  masked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  environment_scope: z.string().optional(),
})

const registryRepositorySchema = z.object({
  location: z.string(),
  tags: z
    .array(z.object({ name: z.string() }))
    .nullable()
    .optional(),
})

const branchRecordSchema = z.object({
  name: z.string(),
  merged: z.boolean().nullable().optional(),
  protected: z.boolean().nullable().optional(),
  default: z.boolean().nullable().optional(),
  web_url: z.string().nullable().optional(),
  commit: z.object({
    id: z.string(),
    committed_date: time,
    created_at: time,
    author_name: z.string().nullable().optional(),
    author_email: z.string().nullable().optional(),
  }),
})

const treeEntrySchema = z.object({ path: z.string(), type: z.string() })

const mergeRequestDetailSchema = mergeRequestSchema.extend({
  sha: z.string().nullable().optional(),
  diff_refs: z
    .object({ base_sha: z.string(), start_sha: z.string(), head_sha: z.string() })
    .nullable()
    .optional(),
})

const diffSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  diff: z.string().nullable().optional(),
  new_file: z.boolean().optional(),
  renamed_file: z.boolean().optional(),
  deleted_file: z.boolean().optional(),
  collapsed: z.boolean().optional(),
  too_large: z.boolean().optional(),
})

const versionSchema = z.object({
  id: z.number(),
  base_commit_sha: z.string(),
  start_commit_sha: z.string(),
  head_commit_sha: z.string(),
})

const versionDetailSchema = versionSchema.extend({ diffs: z.array(diffSchema) })

const compareSchema = z.object({ diffs: z.array(diffSchema) })

const nullableNumber = z.number().nullable().optional()

const noteSchema = z.object({
  id: z.union([z.number(), z.string()]),
  body: z.string(),
  author: z.object({ username: z.string() }).nullable().optional(),
  created_at: z.string(),
  system: z.boolean().optional(),
  resolvable: z.boolean().optional(),
  resolved: z.boolean().nullable().optional(),
  position: z
    .object({
      position_type: z.string().optional(),
      head_sha: z.string(),
      old_path: z.string().nullable().optional(),
      new_path: z.string().nullable().optional(),
      old_line: nullableNumber,
      new_line: nullableNumber,
    })
    .nullable()
    .optional(),
})

const discussionSchema = z.object({ id: z.string(), notes: z.array(noteSchema) })

const draftSchema = z.object({ id: z.number() })
const draftResponseSchema = z.union([draftSchema, z.array(draftSchema).length(1)])

const commitSchema = z.object({ id: z.string(), web_url: z.string() })
const tagSchema = z.object({ name: z.string(), commit: z.object({ id: z.string() }) })
const userSchema = z.object({ id: z.number(), username: z.string() })
const currentUserSchema = z.object({
  username: z.string(),
  name: z.string(),
  commit_email: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
})
const anySchema = z.unknown()

const toRepository = (project: z.infer<typeof projectSchema>): Repository => ({
  path: project.path_with_namespace,
  name: project.name,
  defaultBranch: project.default_branch ?? '',
  webUrl: project.web_url,
  cloneUrl: project.http_url_to_repo,
  archived: project.archived ?? false,
})

const MR_STATES: Record<string, MergeRequestState> = {
  opened: 'open',
  locked: 'open',
  merged: 'merged',
  closed: 'closed',
}

const MR_QUERY_STATES: Record<MergeRequestState, string> = {
  open: 'opened',
  merged: 'merged',
  closed: 'closed',
}

const toMergeRequest = (mr: z.infer<typeof mergeRequestSchema>): MergeRequest => ({
  id: mr.iid,
  title: mr.title,
  description: mr.description ?? '',
  sourceBranch: mr.source_branch,
  targetBranch: mr.target_branch,
  state: MR_STATES[mr.state] ?? 'closed',
  draft: mr.draft ?? mr.work_in_progress ?? false,
  labels: mr.labels ?? [],
  author: mr.author?.username ?? '',
  webUrl: mr.web_url,
})

const BINARY = /^(?:Binary files .* differ|GIT binary patch)$/m

const toDiffFile = (diff: z.infer<typeof diffSchema>): DiffFile => {
  const text = diff.diff ?? ''
  const file: DiffFile = {
    oldPath: diff.old_path,
    newPath: diff.new_path,
    status: diff.new_file
      ? 'added'
      : diff.deleted_file
        ? 'deleted'
        : diff.renamed_file
          ? 'renamed'
          : 'modified',
    diff: text,
  }
  if (BINARY.test(text)) file.binary = true
  if (diff.collapsed || diff.too_large) file.collapsed = true
  return file
}

const toRefs = (version: z.infer<typeof versionSchema>): DiffRefs => ({
  baseSha: version.base_commit_sha,
  startSha: version.start_commit_sha,
  headSha: version.head_commit_sha,
})

const toDiscussion = (discussion: z.infer<typeof discussionSchema>): Discussion => {
  const resolvable = discussion.notes.filter((note) => note.resolvable)
  const result: Discussion = {
    id: discussion.id,
    resolvable: resolvable.length > 0,
    resolved: resolvable.length > 0 && resolvable.every((note) => note.resolved === true),
    notes: discussion.notes.map((note) => ({
      id: note.id,
      author: note.author?.username ?? '',
      body: note.body,
      createdAt: note.created_at,
      system: note.system ?? false,
    })),
  }
  const position = discussion.notes.find((note) => note.position)?.position
  const onNew = typeof position?.new_line === 'number'
  const line = onNew ? position?.new_line : position?.old_line
  const path = onNew ? position?.new_path : (position?.old_path ?? position?.new_path)
  if (position && typeof line === 'number' && path)
    result.position = { path, line, side: onNew ? 'new' : 'old', headSha: position.head_sha }
  return result
}

const findFile = (files: DiffFile[], comment: ReviewComment): DiffFile | undefined =>
  comment.side === 'old'
    ? (files.find((f) => f.oldPath === comment.path) ??
      files.find((f) => f.newPath === comment.path))
    : (files.find((f) => f.newPath === comment.path) ??
      files.find((f) => f.oldPath === comment.path))

const toPositionFile = (file: DiffFile): PositionFile => ({
  oldPath: file.oldPath,
  newPath: file.newPath,
  hunks: file.collapsed || file.binary || !file.diff ? undefined : parseHunks(file.diff),
})

const sameRefs = (a: DiffRefs, b: DiffRefs) =>
  a.baseSha === b.baseSha && a.startSha === b.startSha && a.headSha === b.headSha

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const STATUSES: Record<string, PipelineStatus> = {
  created: 'pending',
  waiting_for_resource: 'pending',
  preparing: 'pending',
  pending: 'pending',
  scheduled: 'pending',
  running: 'running',
  success: 'success',
  failed: 'failed',
  canceling: 'canceled',
  canceled: 'canceled',
  skipped: 'skipped',
  manual: 'manual',
}

// Unknown future statuses are treated as not finished rather than failing the whole call.
const toStatus = (status: string): PipelineStatus => STATUSES[status] ?? 'pending'

const toPipeline = (pipeline: z.infer<typeof pipelineSchema>): Pipeline => ({
  id: pipeline.id,
  ref: pipeline.ref,
  sha: pipeline.sha,
  status: toStatus(pipeline.status),
  webUrl: pipeline.web_url,
})

const toJob = (job: z.infer<typeof jobSchema>): Job => ({
  id: job.id,
  name: job.name,
  stage: job.stage,
  status: toStatus(job.status),
  webUrl: job.web_url,
})

const toMergeRequestRecord = (
  mr: z.infer<typeof mergeRequestRecordSchema>,
): MergeRequestRecord => ({
  ...toMergeRequest(mr),
  createdAt: mr.created_at,
  updatedAt: mr.updated_at,
  mergedAt: mr.merged_at ?? undefined,
  closedAt: mr.state === 'closed' ? (mr.closed_at ?? undefined) : undefined,
  ...(mr.sha && { headSha: mr.sha }),
})

const toPipelineRun = (pipeline: z.infer<typeof pipelineRunSchema>): PipelineRun => ({
  ...toPipeline(pipeline),
  createdAt: pipeline.created_at,
  updatedAt: pipeline.updated_at ?? undefined,
  startedAt: pipeline.started_at ?? undefined,
  finishedAt: pipeline.finished_at ?? undefined,
  durationSeconds: pipeline.duration ?? undefined,
  queuedSeconds: pipeline.queued_duration ?? undefined,
  source: pipeline.source ?? undefined,
})

const DEPLOYMENT_STATUSES: Record<string, DeploymentStatus> = {
  created: 'pending',
  running: 'running',
  success: 'success',
  failed: 'failed',
  canceled: 'canceled',
  skipped: 'skipped',
  blocked: 'blocked',
}

const toDeployment = (deployment: z.infer<typeof deploymentSchema>): Deployment => ({
  id: deployment.id,
  environment: deployment.environment?.name ?? '',
  status: DEPLOYMENT_STATUSES[deployment.status] ?? 'pending',
  sha: deployment.sha,
  ref: deployment.ref,
  createdAt: deployment.created_at,
  finishedAt: deployment.deployable?.finished_at ?? undefined,
})

/** Attempts replaced by a later attempt of the same job; GitLab's `retried` flag wins when sent. */
function toJobRuns<J extends z.infer<typeof jobRunSchema>>(
  jobs: J[],
  pipelineOf: (job: J) => number,
): JobRun[] {
  const attempt = (job: J) => `${pipelineOf(job)}\u0000${job.name}`
  const latest = new Map<string, number>()
  for (const job of jobs) latest.set(attempt(job), Math.max(latest.get(attempt(job)) ?? 0, job.id))
  return jobs.map((job) => ({
    ...toJob(job),
    pipelineId: pipelineOf(job),
    createdAt: job.created_at,
    startedAt: job.started_at ?? undefined,
    finishedAt: job.finished_at ?? undefined,
    durationSeconds: job.duration ?? undefined,
    queuedSeconds: job.queued_duration ?? undefined,
    retried: job.retried ?? latest.get(attempt(job)) !== job.id,
    allowFailure: job.allow_failure ?? false,
  }))
}

async function take<T>(items: AsyncIterable<T>, limit: number | undefined): Promise<T[]> {
  const result: T[] = []
  if (limit !== undefined && limit <= 0) return result
  for await (const item of items) {
    result.push(item)
    if (limit !== undefined && result.length >= limit) break
  }
  return result
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = []
  const queue = items.entries()
  const worker = async () => {
    for (const [index, item] of queue) result[index] = await map(item)
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return result
}

// GitLab treats these title prefixes as draft markers.
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-)\s*/i

const draftTitle = (title: string, draft: boolean) => {
  const plain = title.replace(DRAFT_PREFIX, '')
  return draft ? `Draft: ${plain}` : plain
}

const isNotFound = (error: unknown): error is GitLabApiError =>
  error instanceof GitLabApiError && error.status === 404

const isDenied = (error: unknown): error is GitLabApiError =>
  error instanceof GitLabApiError && [401, 403, 404].includes(error.status)

const project = (repo: string) => `projects/${encode(repo)}`

const mrPath = (repo: string, id: number) => `${project(repo)}/merge_requests/${id}`

const withoutUndefined = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))

function createGitLabForge(options: GitLabForgeOptions): GitForge {
  const perPage = options.perPage ?? 100
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100)
    throw new Error('perPage must be an integer from 1 to 100')
  const client = createGitLabClient({
    url: options.url,
    token: resolveSecret(options.token),
    fetch: options.fetch ?? fetch,
    retries: options.retries ?? 1,
    perPage,
  })

  const pageSize = (limit: number | undefined) =>
    limit === undefined ? perPage : Math.max(1, Math.min(perPage, limit))

  const fetchMergeRequest = async (repo: string, id: number) =>
    client.json('GET', `${project(repo)}/merge_requests/${id}`, mergeRequestDetailSchema)

  const listVersions = async (repo: string, id: number) =>
    (
      await take(client.paginate(`${mrPath(repo, id)}/versions`, versionSchema), undefined)
    ).toSorted((a, b) => b.id - a.id)

  const versionDiff = async (repo: string, id: number, versionId: number) => {
    const version = await client.json(
      'GET',
      `${mrPath(repo, id)}/versions/${versionId}`,
      versionDetailSchema,
    )
    return { refs: toRefs(version), files: version.diffs.map(toDiffFile) }
  }

  const latestDiff = async (repo: string, id: number) => {
    const latest = (await listVersions(repo, id))[0]
    if (latest) return versionDiff(repo, id, latest.id)
    // A merge request gets its first version asynchronously; until then use diff_refs and /diffs.
    const mr = await fetchMergeRequest(repo, id)
    if (!mr.diff_refs) throw new Error(`GitLab merge request ${id} has no diff yet`)
    const files = await take(client.paginate(`${mrPath(repo, id)}/diffs`, diffSchema), undefined)
    return {
      refs: {
        baseSha: mr.diff_refs.base_sha,
        startSha: mr.diff_refs.start_sha,
        headSha: mr.diff_refs.head_sha,
      },
      files: files.map(toDiffFile),
    }
  }

  const diffFor = async (repo: string, id: number, refs: DiffRefs) => {
    const versions = await listVersions(repo, id)
    const match = versions.find((version) => sameRefs(toRefs(version), refs)) ?? versions[0]
    if (match) return (await versionDiff(repo, id, match.id)).files
    return (await latestDiff(repo, id)).files
  }

  const createDraft = async (repo: string, id: number, body: Record<string, unknown>) => {
    const draft = await client.json(
      'POST',
      `${mrPath(repo, id)}/draft_notes`,
      draftResponseSchema,
      { body },
    )
    return Array.isArray(draft) ? (draft[0]?.id ?? 0) : draft.id
  }

  const userIds = async (usernames: string[]) =>
    Promise.all(
      usernames.map(async (username) => {
        const users = await client.json('GET', 'users', z.array(userSchema), {
          query: { username },
        })
        const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase())
        if (!user) throw new Error(`GitLab user ${username} not found`)
        return user.id
      }),
    )

  async function rawFile(
    repo: string,
    file: string,
    ref: string | undefined,
    as: 'text',
  ): Promise<string | undefined>
  async function rawFile(
    repo: string,
    file: string,
    ref: string | undefined,
    as: 'bytes',
  ): Promise<Uint8Array | undefined>
  async function rawFile(
    repo: string,
    file: string,
    ref: string | undefined,
    as: 'text' | 'bytes',
  ) {
    const path = `${project(repo)}/repository/files/${encode(file)}/raw`
    try {
      return as === 'text'
        ? await client.text('GET', path, { query: { ref } })
        : await client.bytes('GET', path, { query: { ref } })
    } catch (error) {
      if (isNotFound(error) && !/project not found/i.test(error.message)) return undefined
      throw error
    }
  }

  const branchExists = async (repo: string, branch: string) => {
    try {
      await client.json('GET', `${project(repo)}/repository/branches/${encode(branch)}`, anySchema)
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  return {
    ...gitlabSshKeyMethods(client),
    ...gitlabHooks(client),
    kind: 'gitlab',

    async *listRepositories(namespace) {
      const query = { include_subgroups: true, with_shared: false, order_by: 'id', sort: 'asc' }
      const groupProjects = client.paginate(
        `groups/${encode(namespace)}/projects`,
        projectSchema,
        query,
      )
      const iterator = groupProjects[Symbol.asyncIterator]()
      let first: IteratorResult<z.infer<typeof projectSchema>>
      try {
        first = await iterator.next()
      } catch (error) {
        if (!isNotFound(error)) throw error
        // Not a group: fall back to a user namespace.
        const userQuery = { order_by: 'id', sort: 'asc' }
        const userProjects = `users/${encode(namespace)}/projects`
        for await (const p of client.paginate(userProjects, projectSchema, userQuery))
          yield toRepository(p)
        return
      }
      for (let item = first; !item.done; item = await iterator.next())
        yield toRepository(item.value)
    },

    async getCurrentUser() {
      const user = await client.json('GET', 'user', currentUserSchema)
      const email = user.commit_email || user.email
      return { username: user.username, name: user.name, ...(email ? { email } : {}) }
    },

    async getRepository(repo) {
      return toRepository(await client.json('GET', project(repo), projectSchema))
    },

    async getRepositoryAvatar(repo) {
      const segments = repo.split('/')
      const candidates = [
        project(repo),
        ...segments
          .slice(0, -1)
          .map(
            (_, index) =>
              `groups/${encode(segments.slice(0, segments.length - 1 - index).join('/'))}`,
          ),
      ]
      for (const path of candidates) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- the nearest avatar wins, so one after another
          const data = await client.bytes('GET', `${path}/avatar`)
          const contentType = imageType(data)
          if (contentType) return { data, contentType }
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
      }
      return undefined
    },

    async readFile(repo, file, ref) {
      return rawFile(repo, file, ref, 'text')
    },

    async readFileBytes(repo, file, ref) {
      return rawFile(repo, file, ref, 'bytes')
    },

    async listFiles(repo, listOptions = {}) {
      const limit = listOptions.limit ?? 10_000
      const entries = client.paginate(`${project(repo)}/repository/tree`, treeEntrySchema, {
        path: listOptions.path,
        ref: listOptions.ref,
        recursive: listOptions.recursive ?? false,
        pagination: 'keyset',
        per_page: pageSize(limit),
      })
      const result: TreeEntry[] = []
      if (limit <= 0) return result
      try {
        for await (const entry of entries) {
          if (entry.type !== 'tree' && entry.type !== 'blob') continue
          result.push({ path: entry.path, type: entry.type === 'tree' ? 'dir' : 'file' })
          if (result.length >= limit) break
        }
      } catch (error) {
        if (isNotFound(error) && !/project not found/i.test(error.message)) return []
        throw error
      }
      return result
    },

    async createBranch(repo, branch, ref) {
      await client.json('POST', `${project(repo)}/repository/branches`, anySchema, {
        body: { branch, ref },
      })
    },

    async deleteBranch(repo, branch) {
      await client.text('DELETE', `${project(repo)}/repository/branches/${encode(branch)}`)
    },

    async commit(repo, input): Promise<Commit> {
      const startBranch =
        input.startBranch && input.startBranch !== input.branch
          ? (await branchExists(repo, input.branch))
            ? undefined
            : input.startBranch
          : undefined
      const actions = input.changes.map((change) =>
        change.action === 'delete'
          ? { action: 'delete', file_path: change.path }
          : withoutUndefined({
              action: change.action,
              file_path: change.path,
              content: change.content,
              encoding: change.encoding === 'base64' ? 'base64' : undefined,
            }),
      )
      const commit = await client.json(
        'POST',
        `${project(repo)}/repository/commits`,
        commitSchema,
        {
          body: withoutUndefined({
            branch: input.branch,
            start_branch: startBranch,
            commit_message: input.message,
            actions,
          }),
        },
      )
      return { sha: commit.id, webUrl: commit.web_url }
    },

    async findMergeRequest(repo, query) {
      const list = await client.json(
        'GET',
        `${project(repo)}/merge_requests`,
        z.array(mergeRequestSchema),
        {
          query: {
            source_branch: query.sourceBranch,
            target_branch: query.targetBranch,
            state: query.state ? MR_QUERY_STATES[query.state] : undefined,
            order_by: 'created_at',
            sort: 'desc',
            per_page: 1,
          },
        },
      )
      const mr = list[0]
      return mr ? toMergeRequest(mr) : undefined
    },

    async createMergeRequest(repo, input) {
      const reviewerIds = input.reviewers?.length ? await userIds(input.reviewers) : undefined
      const mr = await client.json('POST', `${project(repo)}/merge_requests`, mergeRequestSchema, {
        body: withoutUndefined({
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          title: input.draft === undefined ? input.title : draftTitle(input.title, input.draft),
          description: input.description,
          labels: input.labels?.join(','),
          reviewer_ids: reviewerIds,
        }),
      })
      return toMergeRequest(mr)
    },

    async updateMergeRequest(repo, id, input) {
      let title = input.title
      if (input.draft !== undefined || title !== undefined) {
        const current =
          title === undefined || input.draft === undefined
            ? toMergeRequest(await fetchMergeRequest(repo, id))
            : undefined
        title = draftTitle(title ?? current?.title ?? '', input.draft ?? current?.draft ?? false)
      }
      const body = withoutUndefined({
        title,
        description: input.description,
        labels: input.labels?.join(','),
        target_branch: input.targetBranch,
        state_event:
          input.state === undefined ? undefined : input.state === 'closed' ? 'close' : 'reopen',
      })
      if (Object.keys(body).length === 0) return toMergeRequest(await fetchMergeRequest(repo, id))
      const mr = await client.json(
        'PUT',
        `${project(repo)}/merge_requests/${id}`,
        mergeRequestSchema,
        { body },
      )
      return toMergeRequest(mr)
    },

    async mergeMergeRequest(repo, id, mergeOptions = {}) {
      await client.json('PUT', `${project(repo)}/merge_requests/${id}/merge`, anySchema, {
        // auto_merge replaces merge_when_pipeline_succeeds since GitLab 17.11; older versions ignore it.
        body: withoutUndefined({
          squash: mergeOptions.squash,
          should_remove_source_branch: mergeOptions.removeSourceBranch,
          merge_when_pipeline_succeeds: mergeOptions.whenPipelineSucceeds,
          auto_merge: mergeOptions.whenPipelineSucceeds,
        }),
      })
    },

    async commentOnMergeRequest(repo, id, body) {
      await client.json('POST', `${project(repo)}/merge_requests/${id}/notes`, anySchema, {
        body: { body },
      })
    },

    async listPipelines(repo, query) {
      const pipelines = await client.json(
        'GET',
        `${project(repo)}/pipelines`,
        z.array(pipelineSchema),
        {
          query: {
            ref: query.ref,
            sha: query.sha,
            updated_after: query.updatedAfter,
            per_page: perPage,
          },
        },
      )
      return pipelines.map(toPipeline)
    },

    async listJobs(repo, pipelineId) {
      const jobs: Job[] = []
      for await (const job of client.paginate(
        `${project(repo)}/pipelines/${pipelineId}/jobs`,
        jobSchema,
      ))
        jobs.push(toJob(job))
      return jobs
    },

    async playJob(repo, jobId) {
      return toJob(await client.json('POST', `${project(repo)}/jobs/${jobId}/play`, jobSchema))
    },

    async retryJob(repo, jobId) {
      return toJob(await client.json('POST', `${project(repo)}/jobs/${jobId}/retry`, jobSchema))
    },

    async createTag(repo, input) {
      const tag = await client.json('POST', `${project(repo)}/repository/tags`, tagSchema, {
        body: withoutUndefined({ tag_name: input.name, ref: input.ref, message: input.message }),
      })
      return { name: tag.name, sha: tag.commit.id }
    },

    async listMergeRequests(repo, query = {}) {
      const state = query.state && query.state !== 'all' ? MR_QUERY_STATES[query.state] : 'all'
      const list = client.paginate(`${project(repo)}/merge_requests`, mergeRequestRecordSchema, {
        state,
        updated_after: query.updatedAfter,
        target_branch: query.targetBranch,
        order_by: 'updated_at',
        sort: 'desc',
        per_page: pageSize(query.limit),
      })
      return (await take(list, query.limit)).map(toMergeRequestRecord)
    },

    async listPipelineRuns(repo, query = {}) {
      const list = client.paginate(`${project(repo)}/pipelines`, pipelineSchema, {
        ref: query.ref,
        created_after: query.after,
        order_by: 'id',
        sort: 'desc',
        per_page: pageSize(query.limit),
      })
      const pipelines = await take(list, query.limit)
      // The list endpoint has no timing fields, so every pipeline is fetched on its own.
      return mapConcurrent(pipelines, 8, async (pipeline) =>
        toPipelineRun(
          await client.json('GET', `${project(repo)}/pipelines/${pipeline.id}`, pipelineRunSchema),
        ),
      )
    },

    async listJobRuns(repo, pipelineId) {
      const list = client.paginate(`${project(repo)}/pipelines/${pipelineId}/jobs`, jobRunSchema, {
        include_retried: true,
      })
      return toJobRuns(await take(list, undefined), () => pipelineId)
    },

    async listProjectJobRuns(repo, query = {}) {
      const after = query.after === undefined ? undefined : Date.parse(query.after)
      const jobs: z.infer<typeof projectJobRunSchema>[] = []
      const list = client.paginate(`${project(repo)}/jobs`, projectJobRunSchema, {
        per_page: pageSize(query.limit),
      })
      // The endpoint has no time filter but lists newest first, so the first older job ends the read.
      for await (const job of list) {
        if (after !== undefined && Date.parse(job.created_at) < after) break
        jobs.push(job)
        if (query.limit !== undefined && jobs.length >= query.limit) break
      }
      const runs = toJobRuns(jobs, (job) => job.pipeline.id)
      return runs.map((run, index) => {
        const job = jobs[index]
        const ref = job?.pipeline.ref ?? job?.ref
        const sha = job?.pipeline.sha ?? job?.commit?.id
        return {
          ...run,
          ...(ref ? { ref } : {}),
          ...(sha ? { sha } : {}),
          ...(job?.tag ? { tag: true } : {}),
        }
      })
    },

    async listDeployments(repo, query = {}) {
      const list = client.paginate(`${project(repo)}/deployments`, deploymentSchema, {
        environment: query.environment,
        // GitLab answers 400 when updated_after comes without order_by=updated_at.
        updated_after: query.after,
        order_by: query.after ? 'updated_at' : 'id',
        sort: 'desc',
        per_page: pageSize(query.limit),
      })
      return (await take(list, query.limit)).map(toDeployment)
    },

    async listTags(repo, query = {}) {
      const list = client.paginate(`${project(repo)}/repository/tags`, tagRecordSchema, {
        order_by: 'updated',
        sort: 'desc',
        per_page: pageSize(query.limit),
      })
      return (await take(list, query.limit)).map((tag) => ({
        name: tag.name,
        sha: tag.commit.id,
        committedAt: tag.commit.committed_date ?? tag.commit.created_at ?? tag.created_at ?? '',
        createdAt: tag.created_at ?? undefined,
      }))
    },

    async listBranches(repo) {
      const list = client.paginate(`${project(repo)}/repository/branches`, branchRecordSchema, {
        per_page: pageSize(undefined),
      })
      return (await take(list, undefined)).map((branch) => ({
        name: branch.name,
        sha: branch.commit.id,
        committedAt: branch.commit.committed_date ?? branch.commit.created_at ?? '',
        ...(branch.commit.author_name ? { authorName: branch.commit.author_name } : {}),
        ...(branch.commit.author_email ? { authorEmail: branch.commit.author_email } : {}),
        merged: branch.merged ?? false,
        protected: branch.protected ?? false,
        default: branch.default ?? false,
        ...(branch.web_url ? { webUrl: branch.web_url } : {}),
      }))
    },

    async listCiVariables(scope) {
      const base = scope.kind === 'repo' ? project(scope.path) : `groups/${encode(scope.path)}`
      try {
        const list = await take(client.paginate(`${base}/variables`, ciVariableSchema), undefined)
        return list.flatMap((variable) =>
          variable.masked ||
          variable.hidden ||
          variable.variable_type === 'file' ||
          typeof variable.value !== 'string'
            ? []
            : [
                {
                  key: variable.key,
                  value: variable.value,
                  environmentScope: variable.environment_scope ?? '*',
                },
              ],
        )
      } catch (error) {
        if (isDenied(error)) return undefined
        throw error
      }
    },

    npmRegistry: (repo) =>
      `${options.url.replace(/\/+$/, '')}/api/v4/${project(repo)}/packages/npm/`,

    async listImageTags(image) {
      const segments = image.split('/').slice(1)
      // The project is some prefix of the image path; the longest one that has the image wins.
      for (let length = segments.length; length >= 2; length--) {
        const path = segments.slice(0, length).join('/')
        try {
          // oxlint-disable-next-line no-await-in-loop -- the longest matching project wins
          const repositories = await take(
            client.paginate(`${project(path)}/registry/repositories`, registryRepositorySchema, {
              tags: true,
            }),
            undefined,
          )
          const found = repositories.find((repository) => repository.location === image)
          if (found) return (found.tags ?? []).map((tag) => tag.name)
        } catch (error) {
          if (!isDenied(error)) throw error
        }
      }
      return undefined
    },

    async getMergeRequest(repo, id) {
      const mr = await fetchMergeRequest(repo, id)
      return { ...toMergeRequest(mr), headSha: mr.sha ?? mr.diff_refs?.head_sha ?? '' }
    },

    async getMergeRequestDiff(repo, id) {
      return latestDiff(repo, id)
    },

    async compareCommits(repo, from, to) {
      const compare = await client.json(
        'GET',
        `${project(repo)}/repository/compare`,
        compareSchema,
        {
          query: { from, to, straight: true },
        },
      )
      return compare.diffs.map(toDiffFile)
    },

    async listDiscussions(repo, id) {
      const list = client.paginate(`${mrPath(repo, id)}/discussions`, discussionSchema)
      return (await take(list, undefined)).map(toDiscussion)
    },

    async submitReview(repo, id, review): Promise<ReviewOutcome> {
      if (review.event === 'approve')
        await client.json('POST', `${mrPath(repo, id)}/approve`, anySchema, {
          body: { sha: review.refs.headSha },
        })

      const failed: ReviewOutcome['failed'] = []
      const valid = review.comments.filter((comment) => {
        const reason = invalidReason(comment)
        if (reason) failed.push({ comment, error: reason })
        return !reason
      })
      const files = valid.length > 0 ? await diffFor(repo, id, review.refs) : []

      const summary = review.summary
        ? await createDraft(repo, id, { note: review.summary })
        : undefined
      const drafts: { id: number; comment: ReviewComment }[] = []
      for (const comment of valid) {
        const file = findFile(files, comment)
        if (!file) {
          failed.push({ comment, error: `${comment.path} is not part of the merge request diff` })
          continue
        }
        try {
          const position = textPosition(review.refs, toPositionFile(file), comment)
          drafts.push({
            // oxlint-disable-next-line no-await-in-loop
            id: await createDraft(repo, id, { note: renderBody(comment), position }),
            comment,
          })
        } catch (error) {
          if (!(error instanceof GitLabApiError)) throw error
          failed.push({ comment, error: error.message })
        }
      }

      const reviewerState = review.event === 'request_changes' ? 'requested_changes' : undefined
      const publishAll = () =>
        client.json('POST', `${mrPath(repo, id)}/draft_notes/bulk_publish`, anySchema, {
          body: withoutUndefined({ reviewer_state: reviewerState }),
        })
      if (summary === undefined && drafts.length === 0) {
        if (reviewerState) await publishAll()
        return { posted: 0, failed }
      }
      try {
        await publishAll()
        return { posted: drafts.length, failed }
      } catch (error) {
        if (!(error instanceof GitLabApiError)) throw error
      }

      const publish = (draftId: number) =>
        client.text('PUT', `${mrPath(repo, id)}/draft_notes/${draftId}/publish`)
      let posted = 0
      for (const draft of drafts) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await publish(draft.id)
          posted++
        } catch (error) {
          if (!(error instanceof GitLabApiError)) throw error
          if (error.status === 404) {
            posted++
            continue
          }
          let message = error.message
          try {
            // oxlint-disable-next-line no-await-in-loop
            await client.text('DELETE', `${mrPath(repo, id)}/draft_notes/${draft.id}`)
          } catch (deleteError) {
            message += `; deleting the draft failed: ${errorMessage(deleteError)}`
          }
          failed.push({ comment: draft.comment, error: message })
        }
      }
      if (summary !== undefined) {
        try {
          await publish(summary)
        } catch (error) {
          if (!(error instanceof GitLabApiError && error.status === 404)) throw error
        }
      }
      if (reviewerState) {
        try {
          await publishAll()
        } catch {
          // Best effort: with nothing left to publish, older GitLab versions reject the call.
        }
      }
      return { posted, failed }
    },

    async replyToDiscussion(repo, id, discussionId, body) {
      await client.json(
        'POST',
        `${mrPath(repo, id)}/discussions/${encode(discussionId)}/notes`,
        anySchema,
        { body: { body } },
      )
    },

    async resolveDiscussion(repo, id, discussionId, resolved) {
      await client.json(
        'PUT',
        `${mrPath(repo, id)}/discussions/${encode(discussionId)}`,
        anySchema,
        {
          query: { resolved },
        },
      )
    },
  }
}

/**
 * A `ForgeDefinition` of kind `gitlab` for the config's `forges`; `create` returns a `GitForge` over
 * the GitLab REST API v4. Repositories are projects addressed by full path, merge request ids are
 * GitLab `iid`s. The token is resolved when `create` is called. HTTP failures reject with
 * `GitLabApiError` carrying GitLab's status and message, never the token. Redirects are refused,
 * and a 429 answer is retried after `Retry-After`. `gitCredentials` returns `oauth2` and the
 * token for HTTPS git access.
 */
export function gitlab(options: GitLabForgeOptions): ForgeDefinition {
  return {
    kind: 'gitlab',
    url: options.url,
    create: () => createGitLabForge(options),
    gitCredentials: () => ({ username: 'oauth2', password: resolveSecret(options.token) }),
    withFetch: (wrap) => gitlab({ ...options, fetch: wrap(options.fetch ?? fetch) }),
    fetch: options.fetch ?? fetch,
  }
}
