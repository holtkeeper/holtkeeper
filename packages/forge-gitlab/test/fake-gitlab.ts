import type { FetchLike } from '../src/http.ts'

interface Branch {
  sha: string
  files: Map<string, string | Uint8Array>
}

interface FakeMergeRequest {
  iid: number
  title: string
  description: string | null
  source_branch: string
  target_branch: string
  state: 'opened' | 'closed' | 'merged' | 'locked'
  labels: string[]
  reviewer_ids: number[]
  author: { username: string }
  notes: string[]
  merge: Record<string, unknown> | undefined
  versions: FakeVersion[]
  drafts: FakeDraft[]
  discussions: FakeDiscussion[]
  approvals: { sha: unknown }[]
  /** Answer for the next approve call instead of approving. */
  approveError?: { status: number; message: string }
  reviewerStates: unknown[]
  created_at: string
  updated_at: string
  merged_at: string | null
  closed_at: string | null
}

export interface FakeDiff {
  old_path: string
  new_path: string
  diff: string
  new_file?: boolean
  renamed_file?: boolean
  deleted_file?: boolean
  collapsed?: boolean
  too_large?: boolean
}

export interface FakeVersion {
  id: number
  base_commit_sha: string
  start_commit_sha: string
  head_commit_sha: string
  diffs: FakeDiff[]
}

export interface FakeDraft {
  id: number
  note: string
  position?: Record<string, unknown>
}

export interface FakeNote {
  id: number
  body: string
  author: { username: string }
  created_at: string
  system: boolean
  resolvable: boolean
  resolved: boolean
  position?: Record<string, unknown>
}

export interface FakeDiscussion {
  id: string
  notes: FakeNote[]
}

export interface FakePipelineTiming {
  created_at?: string
  updated_at?: string
  started_at?: string | null
  finished_at?: string | null
  duration?: number | null
  queued_duration?: number | null
  source?: string
}

export interface FakeJobTiming {
  created_at?: string
  started_at?: string | null
  finished_at?: string | null
  duration?: number | null
  queued_duration?: number | null
  allow_failure?: boolean
}

export interface FakeDeployment {
  id: number
  environment: string
  status: string
  ref: string
  sha: string
  created_at: string
  updated_at: string
  finished_at: string | null
}

interface FakePipeline extends FakePipelineTiming {
  id: number
  ref: string
  sha: string
  status: string
}

interface FakeJob extends FakeJobTiming {
  id: number
  pipelineId: number
  name: string
  stage: string
  status: string
}

interface FakeTag {
  sha: string
  message?: string
  committed_date: string
  created_at: string | null
}

interface FakeProject {
  id: number
  path: string
  name: string
  archived: boolean
  defaultBranch: string
  branches: Map<string, Branch>
  mergeRequests: FakeMergeRequest[]
  pipelines: FakePipeline[]
  jobs: FakeJob[]
  deployments: FakeDeployment[]
  tags: Map<string, FakeTag>
}

export interface RecordedCall {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
  redirect: RequestInit['redirect']
}

export interface FakeGitLabOptions {
  /** Base URL including any path prefix. */
  url?: string
  token?: string
  /** `link` sends `Link: rel="next"` headers, `header` only `X-Next-Page`. */
  pagination?: 'link' | 'header'
  /** When a draft whose line is not in the diff is rejected. Default `create`. */
  rejectInvalidDrafts?: 'create' | 'publish'
}

/** Whether a text position's line is part of the diff, by an independent hunk walk. */
function lineInDiff(diff: string, position: Record<string, unknown>): boolean {
  const newLine = typeof position['new_line'] === 'number' ? position['new_line'] : undefined
  const oldLine = typeof position['old_line'] === 'number' ? position['old_line'] : undefined
  let oldN = 0
  let newN = 0
  for (const text of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text)
    if (header) {
      oldN = Number(header[1])
      newN = Number(header[2])
      continue
    }
    const kind = text[0]
    if (kind === '+') {
      if (newLine === newN && oldLine === undefined) return true
      newN++
    } else if (kind === '-') {
      if (oldLine === oldN && newLine === undefined) return true
      oldN++
    } else if (kind === ' ') {
      if (newLine === newN && oldLine === oldN) return true
      oldN++
      newN++
    }
  }
  return false
}

const BOT = 'holtkeeper-bot'

const DRAFT = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-)/i

const EPOCH = '2026-01-01T00:00:00.000Z'

/** An in-memory GitLab REST v4 that implements the endpoints the adapter calls. */
export class FakeGitLab {
  readonly base: string
  readonly token: string
  readonly calls: RecordedCall[] = []
  readonly projects = new Map<string, FakeProject>()
  readonly users: { id: number; username: string }[] = []
  /** Answers the next N requests with 429. */
  rateLimit = 0
  retryAfter = '0'
  readonly compares = new Map<string, FakeDiff[]>()
  private readonly pagination: 'link' | 'header'
  private readonly rejectInvalidDrafts: 'create' | 'publish'
  private readonly groups = new Set<string>()
  private nextId = 1
  private shaCounter = 0

  constructor(options: FakeGitLabOptions = {}) {
    this.base = (options.url ?? 'https://gitlab.example.com').replace(/\/+$/, '')
    this.token = options.token ?? 'glpat-test-token'
    this.pagination = options.pagination ?? 'link'
    this.rejectInvalidDrafts = options.rejectInvalidDrafts ?? 'create'
  }

  readonly fetch: FetchLike = async (input, init) => this.handle(input, init)

  addUser(username: string): number {
    const id = this.nextId++
    this.users.push({ id, username })
    return id
  }

  addProject(
    path: string,
    options: { archived?: boolean; files?: Record<string, string> } = {},
  ): FakeProject {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) this.groups.add(parts.slice(0, i).join('/'))
    const project: FakeProject = {
      id: this.nextId++,
      path,
      name: parts.at(-1) ?? path,
      archived: options.archived ?? false,
      defaultBranch: 'main',
      branches: new Map([
        ['main', { sha: this.sha(), files: new Map(Object.entries(options.files ?? {})) }],
      ]),
      mergeRequests: [],
      pipelines: [],
      jobs: [],
      deployments: [],
      tags: new Map(),
    }
    this.projects.set(path, project)
    return project
  }

  addPipeline(
    project: FakeProject,
    ref: string,
    status: string,
    jobs: [string, string, string, FakeJobTiming?][],
    timing: FakePipelineTiming & { sha?: string } = {},
  ) {
    const pipeline: FakePipeline = {
      ...timing,
      id: this.nextId++,
      ref,
      sha: timing.sha ?? project.branches.get(ref)?.sha ?? '',
      status,
    }
    project.pipelines.unshift(pipeline)
    for (const [name, stage, jobStatus, jobTiming] of jobs)
      project.jobs.push({
        ...jobTiming,
        id: this.nextId++,
        pipelineId: pipeline.id,
        name,
        stage,
        status: jobStatus,
      })
    return pipeline
  }

  addMergeRequest(
    project: FakeProject,
    input: Partial<
      Pick<
        FakeMergeRequest,
        | 'title'
        | 'description'
        | 'source_branch'
        | 'target_branch'
        | 'state'
        | 'labels'
        | 'author'
        | 'created_at'
        | 'updated_at'
        | 'merged_at'
        | 'closed_at'
      >
    > & { title: string },
  ): FakeMergeRequest {
    const mr: FakeMergeRequest = {
      description: null,
      source_branch: `feature-${project.mergeRequests.length + 1}`,
      target_branch: project.defaultBranch,
      state: 'opened',
      labels: [],
      author: { username: 'dev' },
      created_at: EPOCH,
      updated_at: EPOCH,
      merged_at: null,
      closed_at: null,
      ...input,
      iid: project.mergeRequests.length + 1,
      reviewer_ids: [],
      notes: [],
      merge: undefined,
      ...this.reviewState(),
    }
    project.mergeRequests.push(mr)
    return mr
  }

  addVersion(
    mr: FakeMergeRequest,
    diffs: FakeDiff[],
    refs: Partial<FakeVersion> = {},
  ): FakeVersion {
    const base = refs.base_commit_sha ?? this.sha()
    const version: FakeVersion = {
      base_commit_sha: base,
      start_commit_sha: base,
      head_commit_sha: this.sha(),
      ...refs,
      id: this.nextId++,
      diffs,
    }
    mr.versions.push(version)
    return version
  }

  addDiscussion(mr: FakeMergeRequest, notes: Partial<FakeNote>[]): FakeDiscussion {
    const discussion: FakeDiscussion = {
      id: (this.nextId++).toString(16).padStart(40, 'd'),
      notes: notes.map((note) => this.note(note)),
    }
    mr.discussions.push(discussion)
    return discussion
  }

  private reviewState() {
    return { versions: [], drafts: [], discussions: [], approvals: [], reviewerStates: [] }
  }

  private note(input: Partial<FakeNote>): FakeNote {
    return {
      body: '',
      author: { username: BOT },
      created_at: EPOCH,
      system: false,
      resolvable: false,
      resolved: false,
      ...input,
      id: this.nextId++,
    }
  }

  addDeployment(
    project: FakeProject,
    input: Partial<Omit<FakeDeployment, 'id'>> & { status: string },
  ): FakeDeployment {
    const deployment: FakeDeployment = {
      environment: 'production',
      ref: project.defaultBranch,
      sha: project.branches.get(project.defaultBranch)?.sha ?? '',
      created_at: EPOCH,
      updated_at: input.created_at ?? EPOCH,
      finished_at: null,
      ...input,
      id: this.nextId++,
    }
    project.deployments.push(deployment)
    return deployment
  }

  addTag(
    project: FakeProject,
    name: string,
    input: { committed_date: string; created_at?: string | null; sha?: string },
  ) {
    project.tags.set(name, {
      sha: input.sha ?? project.branches.get(project.defaultBranch)?.sha ?? '',
      committed_date: input.committed_date,
      created_at: input.created_at ?? null,
    })
  }

  private sha(): string {
    return (++this.shaCounter).toString(16).padStart(40, '0')
  }

  private webUrl(path: string) {
    return `${this.base}/${path}`
  }

  private async handle(input: string, init: RequestInit): Promise<Response> {
    const headers = (init.headers ?? {}) as Record<string, string>
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const method = init.method ?? 'GET'
    this.calls.push({ method, url: input, headers, body, redirect: init.redirect })
    if (this.rateLimit > 0) {
      this.rateLimit--
      return json(429, { message: '429 Too Many Requests' }, { 'Retry-After': this.retryAfter })
    }
    if (headers['PRIVATE-TOKEN'] !== this.token) return json(401, { message: '401 Unauthorized' })
    const url = new URL(input)
    const prefix = `${new URL(this.base).pathname.replace(/\/+$/, '')}/api/v4/`
    if (url.origin !== new URL(this.base).origin || !url.pathname.startsWith(prefix))
      return json(404, { error: '404 Not Found' })
    const segments = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent)
    return this.route(method, segments, url, body ?? {})
  }

  private route(method: string, s: string[], url: URL, body: Record<string, unknown>): Response {
    const q = url.searchParams

    if (method === 'GET' && s[0] === 'users' && s.length === 1)
      return json(
        200,
        this.users.filter((u) => u.username === q.get('username')),
      )
    if (method === 'GET' && s[0] === 'groups' && s[2] === 'projects' && s.length === 3) {
      const group = s[1] ?? ''
      if (!this.groups.has(group) || this.users.some((u) => u.username === group))
        return json(404, { message: '404 Group Not Found' })
      return this.page(
        url,
        this.projectsUnder(group).map((p) => this.projectJson(p)),
      )
    }
    if (method === 'GET' && s[0] === 'users' && s[2] === 'projects' && s.length === 3) {
      if (!this.users.some((u) => u.username === s[1]))
        return json(404, { message: '404 User Not Found' })
      return this.page(
        url,
        this.projectsUnder(s[1] ?? '').map((p) => this.projectJson(p)),
      )
    }
    if (s[0] !== 'projects') return json(404, { error: '404 Not Found' })
    const project = this.projects.get(s[1] ?? '')
    if (!project) return json(404, { message: '404 Project Not Found' })
    const rest = s.slice(2)
    if (method === 'GET' && rest.length === 0) return json(200, this.projectJson(project))
    if (rest[0] === 'repository' && rest[1] === 'files' && rest[3] === 'raw' && method === 'GET') {
      const branch = project.branches.get(q.get('ref') ?? project.defaultBranch)
      const content = branch?.files.get(rest[2] ?? '')
      if (content === undefined) return json(404, { message: '404 File Not Found' })
      const type = typeof content === 'string' ? 'text/plain' : 'application/octet-stream'
      return new Response(content, { status: 200, headers: { 'Content-Type': type } })
    }
    if (rest[0] === 'repository' && rest[1] === 'branches') {
      if (method === 'POST' && rest.length === 2) {
        const name = String(body['branch'])
        const from = project.branches.get(String(body['ref']))
        if (!from) return json(400, { message: 'Invalid reference name' })
        if (project.branches.has(name)) return json(400, { message: 'Branch already exists' })
        project.branches.set(name, { sha: from.sha, files: new Map(from.files) })
        return json(201, { name, commit: { id: from.sha } })
      }
      const branch = project.branches.get(rest[2] ?? '')
      if (!branch) return json(404, { message: '404 Branch Not Found' })
      if (method === 'GET') return json(200, { name: rest[2], commit: { id: branch.sha } })
      if (method === 'DELETE') {
        project.branches.delete(rest[2] ?? '')
        return new Response(null, { status: 204 })
      }
    }
    if (method === 'POST' && rest.join('/') === 'repository/commits')
      return this.commit(project, body)
    if (method === 'POST' && rest.join('/') === 'repository/tags') {
      const branch = project.branches.get(String(body['ref']))
      if (!branch) return json(400, { message: 'Target ref is invalid' })
      const name = String(body['tag_name'])
      project.tags.set(name, {
        sha: branch.sha,
        message: body['message'] as string | undefined,
        committed_date: EPOCH,
        created_at: body['message'] ? EPOCH : null,
      })
      return json(201, { name, commit: { id: branch.sha } })
    }
    if (rest[0] === 'merge_requests') return this.mergeRequests(project, method, rest, url, body)
    if (method === 'GET' && rest.join('/') === 'repository/tree') return this.tree(project, url)
    if (method === 'GET' && rest.join('/') === 'repository/compare') {
      const diffs = this.compares.get(`${q.get('from')}..${q.get('to')}`)
      if (!diffs) return json(404, { message: '404 Ref Not Found' })
      return json(200, { commit: null, commits: [], diffs, compare_timeout: false })
    }
    if (method === 'GET' && rest.join('/') === 'repository/tags') {
      const tags = [...project.tags.entries()].toReversed().map(([name, tag]) => ({
        name,
        message: tag.message ?? '',
        commit: { id: tag.sha, committed_date: tag.committed_date, created_at: tag.committed_date },
        created_at: tag.created_at,
      }))
      return this.page(url, tags)
    }
    if (method === 'GET' && rest[0] === 'deployments' && rest.length === 1)
      return this.deployments(project, url)
    if (method === 'GET' && rest[0] === 'pipelines' && rest.length === 1) {
      const after = q.get('created_after')
      const list = project.pipelines.filter(
        (p) =>
          (!q.has('ref') || p.ref === q.get('ref')) &&
          (!q.has('sha') || p.sha === q.get('sha')) &&
          (!after || (p.created_at ?? EPOCH) >= after),
      )
      return this.page(
        url,
        list.map((p) => ({
          id: p.id,
          ref: p.ref,
          sha: p.sha,
          status: p.status,
          source: p.source ?? 'push',
          created_at: p.created_at ?? EPOCH,
          updated_at: p.updated_at ?? p.created_at ?? EPOCH,
          web_url: this.webUrl(`${project.path}/-/pipelines/${p.id}`),
        })),
      )
    }
    if (method === 'GET' && rest[0] === 'pipelines' && rest.length === 2) {
      const p = project.pipelines.find((pipeline) => pipeline.id === Number(rest[1]))
      if (!p) return json(404, { message: '404 Not found' })
      return json(200, {
        id: p.id,
        ref: p.ref,
        sha: p.sha,
        status: p.status,
        source: p.source ?? 'push',
        created_at: p.created_at ?? EPOCH,
        updated_at: p.updated_at ?? p.created_at ?? EPOCH,
        started_at: p.started_at ?? null,
        finished_at: p.finished_at ?? null,
        duration: p.duration ?? null,
        queued_duration: p.queued_duration ?? null,
        web_url: this.webUrl(`${project.path}/-/pipelines/${p.id}`),
      })
    }
    if (method === 'GET' && rest[0] === 'jobs' && rest.length === 1) {
      const jobs = project.jobs.toSorted((a, b) => b.id - a.id)
      return this.page(
        url,
        jobs.map((j) => {
          const pipeline = project.pipelines.find((p) => p.id === j.pipelineId)
          return {
            ...this.jobJson(project, j),
            ref: pipeline?.ref ?? null,
            commit: pipeline ? { id: pipeline.sha } : null,
            pipeline: { id: j.pipelineId, ref: pipeline?.ref, sha: pipeline?.sha },
          }
        }),
      )
    }
    if (method === 'GET' && rest[0] === 'pipelines' && rest[2] === 'jobs') {
      const all = project.jobs.filter((j) => j.pipelineId === Number(rest[1]))
      const jobs =
        q.get('include_retried') === 'true'
          ? all
          : all.filter((j) => !all.some((other) => other.name === j.name && other.id > j.id))
      return this.page(
        url,
        jobs.map((j) => this.jobJson(project, j)),
      )
    }
    if (method === 'POST' && rest[0] === 'jobs' && (rest[2] === 'play' || rest[2] === 'retry')) {
      const job = project.jobs.find((j) => j.id === Number(rest[1]))
      if (!job) return json(404, { message: '404 Job Not Found' })
      if (rest[2] === 'play') {
        if (job.status !== 'manual') return json(400, { message: 'Unplayable Job' })
        job.status = 'pending'
        return json(200, this.jobJson(project, job))
      }
      const retried = { ...job, id: this.nextId++, status: 'pending' }
      project.jobs.push(retried)
      return json(201, this.jobJson(project, retried))
    }
    return json(404, { error: `404 Not Found (${method} ${rest.join('/')})` })
  }

  private commit(project: FakeProject, body: Record<string, unknown>): Response {
    const name = String(body['branch'])
    let branch = project.branches.get(name)
    if (!branch) {
      const start = project.branches.get(String(body['start_branch']))
      if (!start)
        return json(400, { message: 'You can only create or edit files when you are on a branch' })
      branch = { sha: start.sha, files: new Map(start.files) }
    }
    const files = new Map(branch.files)
    for (const action of body['actions'] as {
      action: string
      file_path: string
      content?: string
      encoding?: string
    }[]) {
      const exists = files.has(action.file_path)
      if (action.action === 'create' && exists)
        return json(400, { message: 'A file with this name already exists' })
      if (action.action !== 'create' && !exists)
        return json(400, { message: "A file with this name doesn't exist" })
      if (action.action === 'delete') files.delete(action.file_path)
      else if (action.encoding === 'base64')
        files.set(action.file_path, new Uint8Array(Buffer.from(action.content ?? '', 'base64')))
      else if (action.encoding !== undefined && action.encoding !== 'text')
        return json(400, { message: 'encoding does not have a valid value' })
      else files.set(action.file_path, action.content ?? '')
    }
    const sha = this.sha()
    project.branches.set(name, { sha, files })
    return json(201, { id: sha, web_url: this.webUrl(`${project.path}/-/commit/${sha}`) })
  }

  private mergeRequests(
    project: FakeProject,
    method: string,
    rest: string[],
    url: URL,
    body: Record<string, unknown>,
  ): Response {
    const q = url.searchParams
    if (rest.length === 1 && method === 'GET') {
      const state = q.get('state')
      const updatedAfter = q.get('updated_after')
      const byUpdate = q.get('order_by') === 'updated_at'
      const list = project.mergeRequests
        .filter(
          (mr) =>
            (!q.has('source_branch') || mr.source_branch === q.get('source_branch')) &&
            (!q.has('target_branch') || mr.target_branch === q.get('target_branch')) &&
            (!state || state === 'all' || mr.state === state) &&
            (!updatedAfter || mr.updated_at >= updatedAfter),
        )
        .toSorted((a, b) =>
          byUpdate ? b.updated_at.localeCompare(a.updated_at) || b.iid - a.iid : b.iid - a.iid,
        )
      return this.page(
        url,
        list.map((mr) => this.mrJson(project, mr)),
      )
    }
    if (rest.length === 1 && method === 'POST') {
      if (!project.branches.has(String(body['source_branch'])))
        return json(400, { message: ['Source branch does not exist'] })
      const mr: FakeMergeRequest = {
        iid: project.mergeRequests.length + 1,
        title: String(body['title']),
        description: (body['description'] as string | undefined) ?? null,
        source_branch: String(body['source_branch']),
        target_branch: String(body['target_branch']),
        state: 'opened',
        labels:
          typeof body['labels'] === 'string' && body['labels'] ? body['labels'].split(',') : [],
        reviewer_ids: (body['reviewer_ids'] as number[] | undefined) ?? [],
        author: { username: BOT },
        notes: [],
        merge: undefined,
        ...this.reviewState(),
        created_at: EPOCH,
        updated_at: EPOCH,
        merged_at: null,
        closed_at: null,
      }
      project.mergeRequests.push(mr)
      return json(201, this.mrJson(project, mr))
    }
    const mr = project.mergeRequests.find((m) => m.iid === Number(rest[1]))
    if (!mr) return json(404, { message: '404 Not found' })
    if (rest.length === 2 && method === 'GET') return json(200, this.mrJson(project, mr))
    if (rest.length === 2 && method === 'PUT') {
      if (typeof body['title'] === 'string') mr.title = body['title']
      if (typeof body['description'] === 'string') mr.description = body['description']
      if (typeof body['target_branch'] === 'string') mr.target_branch = body['target_branch']
      if (typeof body['labels'] === 'string')
        mr.labels = body['labels'] ? body['labels'].split(',') : []
      if (body['state_event'] === 'close') mr.state = 'closed'
      if (body['state_event'] === 'reopen') mr.state = 'opened'
      return json(200, this.mrJson(project, mr))
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (mr.state !== 'opened') return json(405, { message: '405 Method Not Allowed' })
      mr.merge = body
      if (!body['auto_merge']) mr.state = 'merged'
      return json(200, this.mrJson(project, mr))
    }
    if (rest[2] === 'notes' && method === 'POST') {
      mr.notes.push(String(body['body']))
      return json(201, { id: this.nextId++, body: body['body'] })
    }
    return this.review(project, mr, method, rest.slice(2), url, body)
  }

  private latestVersion(mr: FakeMergeRequest) {
    return mr.versions.toSorted((a, b) => b.id - a.id)[0]
  }

  private draftValid(mr: FakeMergeRequest, draft: FakeDraft): boolean {
    const position = draft.position
    if (!position) return true
    const version = mr.versions.find((v) => v.head_commit_sha === position['head_sha'])
    const file = version?.diffs.find((d) => d.new_path === position['new_path'])
    return file !== undefined && lineInDiff(file.diff, position)
  }

  private publishDraft(mr: FakeMergeRequest, draft: FakeDraft) {
    mr.drafts = mr.drafts.filter((d) => d !== draft)
    this.addDiscussion(mr, [
      { body: draft.note, position: draft.position, resolvable: draft.position !== undefined },
    ])
  }

  private review(
    project: FakeProject,
    mr: FakeMergeRequest,
    method: string,
    rest: string[],
    url: URL,
    body: Record<string, unknown>,
  ): Response {
    const path = rest.join('/')
    const invalidDraft = {
      message:
        '400 Bad request - Note {:line_code=>["can\'t be blank", "must be a valid line code"]}',
    }
    if (method === 'GET' && path === 'versions')
      return this.page(
        url,
        mr.versions
          .toSorted((a, b) => b.id - a.id)
          .map((v) => ({
            id: v.id,
            base_commit_sha: v.base_commit_sha,
            start_commit_sha: v.start_commit_sha,
            head_commit_sha: v.head_commit_sha,
            state: 'collected',
          })),
      )
    if (method === 'GET' && rest[0] === 'versions' && rest.length === 2) {
      const version = mr.versions.find((v) => v.id === Number(rest[1]))
      if (!version) return json(404, { message: '404 Not found' })
      return json(200, { ...version, state: 'collected', commits: [] })
    }
    if (method === 'GET' && path === 'diffs')
      return this.page(url, this.latestVersion(mr)?.diffs ?? [])
    if (method === 'POST' && path === 'approve') {
      if (mr.approveError) {
        const { status, message } = mr.approveError
        mr.approveError = undefined
        return json(status, { message })
      }
      if (body['sha'] !== undefined && body['sha'] !== this.latestVersion(mr)?.head_commit_sha)
        return json(409, { message: 'SHA does not match HEAD of source branch' })
      mr.approvals.push({ sha: body['sha'] })
      return json(201, { approved: true })
    }
    if (rest[0] === 'draft_notes') {
      if (method === 'POST' && rest.length === 1) {
        const draft: FakeDraft = {
          id: this.nextId++,
          note: String(body['note']),
          position: body['position'] as Record<string, unknown> | undefined,
        }
        if (this.rejectInvalidDrafts === 'create' && !this.draftValid(mr, draft))
          return json(400, invalidDraft)
        mr.drafts.push(draft)
        return json(201, { id: draft.id, note: draft.note, position: draft.position ?? null })
      }
      if (method === 'POST' && rest[1] === 'bulk_publish') {
        if (mr.drafts.some((d) => !this.draftValid(mr, d))) return json(400, invalidDraft)
        if (mr.drafts.length === 0) return json(400, { message: 'No draft notes found' })
        for (const draft of mr.drafts.slice()) this.publishDraft(mr, draft)
        mr.reviewerStates.push(body['reviewer_state'])
        return new Response(null, { status: 204 })
      }
      const draft = mr.drafts.find((d) => d.id === Number(rest[1]))
      if (!draft) return json(404, { message: '404 Not found' })
      if (method === 'PUT' && rest[2] === 'publish') {
        if (!this.draftValid(mr, draft)) return json(400, invalidDraft)
        this.publishDraft(mr, draft)
        return new Response(null, { status: 204 })
      }
      if (method === 'DELETE' && rest.length === 2) {
        mr.drafts = mr.drafts.filter((d) => d !== draft)
        return new Response(null, { status: 204 })
      }
    }
    if (rest[0] === 'discussions') {
      if (method === 'GET' && rest.length === 1)
        return this.page(
          url,
          mr.discussions.map((d) => ({
            id: d.id,
            individual_note: d.notes.length === 1 && !d.notes[0]?.position,
            notes: d.notes.map((n) => ({
              ...n,
              type: n.position ? 'DiffNote' : null,
              position: n.position ?? null,
            })),
          })),
        )
      const discussion = mr.discussions.find((d) => d.id === rest[1])
      if (!discussion) return json(404, { message: '404 Not found' })
      if (method === 'POST' && rest[2] === 'notes' && rest.length === 3) {
        const note = this.note({ body: String(body['body']) })
        discussion.notes.push(note)
        return json(201, note)
      }
      if (method === 'PUT' && rest.length === 2) {
        const resolved = url.searchParams.get('resolved')
        if (resolved !== 'true' && resolved !== 'false')
          return json(400, { message: 'resolved is missing' })
        if (!discussion.notes.some((n) => n.resolvable))
          return json(400, { message: 'Discussion is not resolvable' })
        for (const note of discussion.notes)
          if (note.resolvable) note.resolved = resolved === 'true'
        return json(200, { id: discussion.id, notes: discussion.notes })
      }
    }
    return json(404, { error: `404 Not Found (${method} ${project.path} ${path})` })
  }

  private projectsUnder(namespace: string) {
    return [...this.projects.values()]
      .filter((p) => p.path.startsWith(`${namespace}/`))
      .toSorted((a, b) => a.id - b.id)
  }

  private projectJson(project: FakeProject) {
    return {
      id: project.id,
      name: project.name,
      path_with_namespace: project.path,
      default_branch: project.defaultBranch,
      web_url: this.webUrl(project.path),
      http_url_to_repo: `${this.webUrl(project.path)}.git`,
      archived: project.archived,
    }
  }

  private mrJson(project: FakeProject, mr: FakeMergeRequest) {
    const latest = this.latestVersion(mr)
    return {
      sha: latest?.head_commit_sha ?? null,
      diff_refs: latest
        ? {
            base_sha: latest.base_commit_sha,
            start_sha: latest.start_commit_sha,
            head_sha: latest.head_commit_sha,
          }
        : null,
      id: 1000 + mr.iid,
      iid: mr.iid,
      title: mr.title,
      description: mr.description,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      state: mr.state,
      draft: DRAFT.test(mr.title),
      labels: mr.labels,
      author: mr.author,
      created_at: mr.created_at,
      updated_at: mr.updated_at,
      merged_at: mr.merged_at,
      closed_at: mr.closed_at,
      web_url: this.webUrl(`${project.path}/-/merge_requests/${mr.iid}`),
    }
  }

  private tree(project: FakeProject, url: URL): Response {
    const q = url.searchParams
    const branch = project.branches.get(q.get('ref') ?? project.defaultBranch)
    if (!branch) return json(404, { message: '404 Tree Not Found' })
    const base = (q.get('path') ?? '').replace(/^\/+|\/+$/g, '')
    const recursive = q.get('recursive') === 'true'
    const entries = new Map<string, 'tree' | 'blob'>()
    for (const file of branch.files.keys()) {
      const parts = file.split('/')
      for (let i = 1; i <= parts.length; i++)
        entries.set(parts.slice(0, i).join('/'), i === parts.length ? 'blob' : 'tree')
    }
    if (base && entries.get(base) !== 'tree') return json(404, { message: '404 Tree Not Found' })
    const prefix = base ? `${base}/` : ''
    const list = [...entries]
      .filter(
        ([path]) =>
          path.startsWith(prefix) && (recursive || !path.slice(prefix.length).includes('/')),
      )
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([path, type]) => ({
        id: path,
        name: path.split('/').at(-1),
        type,
        path,
        mode: type === 'tree' ? '040000' : '100644',
      }))
    return this.page(url, list)
  }

  private deployments(project: FakeProject, url: URL): Response {
    const q = url.searchParams
    const updatedAfter = q.get('updated_after')
    if (updatedAfter && q.get('order_by') !== 'updated_at')
      return json(400, { message: 'updated_after requires order_by=updated_at' })
    const key = q.get('order_by') === 'updated_at' ? 'updated_at' : 'id'
    const desc = q.get('sort') === 'desc'
    const list = project.deployments
      .filter(
        (d) =>
          (!q.has('environment') || d.environment === q.get('environment')) &&
          (!updatedAfter || d.updated_at >= updatedAfter),
      )
      .toSorted((a, b) => {
        const order = key === 'id' ? a.id - b.id : a.updated_at.localeCompare(b.updated_at)
        return desc ? -order : order
      })
    return this.page(
      url,
      list.map((d) => ({
        id: d.id,
        iid: d.id,
        ref: d.ref,
        sha: d.sha,
        status: d.status,
        created_at: d.created_at,
        updated_at: d.updated_at,
        environment: { id: 1, name: d.environment },
        deployable: { id: d.id, status: d.status, finished_at: d.finished_at },
      })),
    )
  }

  private jobJson(project: FakeProject, job: FakeJob) {
    return {
      id: job.id,
      name: job.name,
      stage: job.stage,
      status: job.status,
      created_at: job.created_at ?? EPOCH,
      started_at: job.started_at ?? null,
      finished_at: job.finished_at ?? null,
      duration: job.duration ?? null,
      queued_duration: job.queued_duration ?? null,
      allow_failure: job.allow_failure ?? false,
      web_url: this.webUrl(`${project.path}/-/jobs/${job.id}`),
    }
  }

  private page(url: URL, items: unknown[]): Response {
    const perPage = Number(url.searchParams.get('per_page') ?? 20)
    const page = Number(url.searchParams.get('page') ?? 1)
    const slice = items.slice((page - 1) * perPage, page * perPage)
    const headers: Record<string, string> = {}
    if (page * perPage < items.length) {
      headers['X-Next-Page'] = String(page + 1)
      if (this.pagination === 'link') {
        const next = new URL(url)
        next.searchParams.set('page', String(page + 1))
        headers['Link'] = `<${next.toString()}>; rel="next"`
      }
    }
    return json(200, slice, headers)
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}
