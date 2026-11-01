import type {
  CommitRecord,
  ForgeRelease,
  GitForge,
  Job,
  MergeRequestRecord,
  Pipeline,
  PipelineStatus,
  TagRecord,
} from '@holtkeeper/forge'

const unsupported = () => {
  throw new Error('not supported by the fake forge')
}

interface FakeCommit {
  sha: string
  parents: string[]
  message: string
  date: string
}

/** A one-repository forge with a real commit graph, for release flow tests. */
export class FakeForge {
  readonly repo = 'g/app'
  readonly commits = new Map<string, FakeCommit>()
  readonly branches = new Map<string, string>()
  readonly tags: (TagRecord & { message?: string })[] = []
  readonly requests: MergeRequestRecord[] = []
  readonly pipelines: Pipeline[] = []
  readonly jobs = new Map<number, (Job & { retried?: boolean })[]>()
  readonly releases = new Map<string, ForgeRelease>()
  readonly files = new Map<string, string>()
  readonly calls: string[] = []
  private counter = 0
  private clock = Date.parse('2026-10-01T00:00:00Z')

  constructor() {
    const root = this.add([], 'chore: initial commit')
    this.branches.set('main', root)
  }

  private add(parents: string[], message: string): string {
    const sha = (++this.counter).toString(16).padStart(40, '0')
    this.clock += 60_000
    this.commits.set(sha, { sha, parents, message, date: new Date(this.clock).toISOString() })
    return sha
  }

  /** Commits on a branch, creating it from main when missing. */
  commitTo(branch: string, ...messages: string[]): string {
    let head = this.branches.get(branch) ?? this.branches.get('main')!
    for (const message of messages) head = this.add([head], message)
    this.branches.set(branch, head)
    return head
  }

  merge(from: string, into: string, message = `Merge branch '${from}' into '${into}'`): string {
    const sha = this.add([this.branches.get(into)!, this.branches.get(from)!], message)
    this.branches.set(into, sha)
    const open = this.requests.find(
      (mr) => mr.sourceBranch === from && mr.targetBranch === into && mr.state === 'open',
    )
    if (open) {
      open.state = 'merged'
      open.mergedAt = new Date(this.clock).toISOString()
    }
    return sha
  }

  tag(name: string, ref = 'main') {
    const sha = this.resolve(ref)!
    this.tags.unshift({
      name,
      sha,
      committedAt: this.commits.get(sha)!.date,
      createdAt: new Date(this.clock).toISOString(),
    })
  }

  addPipeline(
    ref: string,
    status: PipelineStatus,
    jobs: { name: string; status: PipelineStatus }[] = [],
  ) {
    const id = this.pipelines.length + 1
    this.pipelines.unshift({
      id,
      ref,
      sha: this.resolve(ref) ?? '',
      status,
      webUrl: `https://forge/p/${id}`,
    })
    this.jobs.set(
      id,
      jobs.map((job, index) => ({
        id: id * 100 + index,
        name: job.name,
        stage: 'deploy',
        status: job.status,
        webUrl: `https://forge/j/${id * 100 + index}`,
      })),
    )
    return id
  }

  private resolve(ref: string): string | undefined {
    return (
      this.branches.get(ref) ??
      this.tags.find((tag) => tag.name === ref)?.sha ??
      (this.commits.has(ref) ? ref : undefined)
    )
  }

  private reachable(sha: string): string[] {
    const seen = new Set<string>()
    const stack = [sha]
    while (stack.length) {
      const next = stack.pop()!
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(...(this.commits.get(next)?.parents ?? []))
    }
    return [...seen]
  }

  readonly forge: GitForge = {
    kind: 'fake',
    listRepositories: unsupported,
    getRepository: async (path) => ({
      path,
      name: 'app',
      defaultBranch: 'main',
      webUrl: `https://forge/${path}`,
      cloneUrl: '',
      archived: false,
    }),
    readFile: async (_repo, file) => this.files.get(file),
    createBranch: unsupported,
    deleteBranch: unsupported,
    commit: async (_repo, input) => {
      this.calls.push(`commit ${input.branch}`)
      for (const change of input.changes)
        if (change.action !== 'delete') this.files.set(change.path, change.content)
      const sha = this.commitTo(input.branch, input.message)
      return { sha, webUrl: `https://forge/c/${sha}` }
    },
    findMergeRequest: async (_repo, query) =>
      this.requests.find(
        (mr) =>
          mr.sourceBranch === query.sourceBranch &&
          (!query.targetBranch || mr.targetBranch === query.targetBranch) &&
          (!query.state || mr.state === query.state),
      ),
    createMergeRequest: async (_repo, input) => {
      this.calls.push(`create mr ${input.title}`)
      const mr: MergeRequestRecord = {
        id: this.requests.length + 1,
        title: input.title,
        description: input.description ?? '',
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        state: 'open',
        draft: input.draft ?? false,
        labels: input.labels ?? [],
        author: 'bot',
        webUrl: `https://forge/mr/${this.requests.length + 1}`,
        createdAt: new Date(this.clock).toISOString(),
        updatedAt: new Date(this.clock).toISOString(),
      }
      this.requests.push(mr)
      return mr
    },
    updateMergeRequest: async (_repo, id, input) => {
      this.calls.push(`update mr ${id}`)
      const mr = this.requests.find((candidate) => candidate.id === id)!
      if (input.title !== undefined) mr.title = input.title
      if (input.description !== undefined) mr.description = input.description
      if (input.labels !== undefined) mr.labels = input.labels
      return mr
    },
    mergeMergeRequest: unsupported,
    commentOnMergeRequest: unsupported,
    listPipelines: async (_repo, query) =>
      this.pipelines.filter((pipeline) => !query.ref || pipeline.ref === query.ref),
    listJobs: async (_repo, id) => this.jobs.get(id) ?? [],
    playJob: async (_repo, id) => {
      this.calls.push(`play ${id}`)
      const job = [...this.jobs.values()].flat().find((candidate) => candidate.id === id)!
      job.status = 'pending'
      return job
    },
    retryJob: async (_repo, id) => {
      this.calls.push(`retry ${id}`)
      for (const [pipeline, jobs] of this.jobs) {
        const job = jobs.find((candidate) => candidate.id === id)
        if (!job) continue
        job.retried = true
        const retry = { ...job, id: id + 1000, status: 'pending' as const, retried: false }
        jobs.push(retry)
        this.jobs.set(pipeline, jobs)
        return retry
      }
      throw new Error('no job')
    },
    createTag: async (_repo, input) => {
      this.calls.push(`tag ${input.name} ${input.message ?? ''}`)
      if (this.tags.some((tag) => tag.name === input.name)) throw new Error('tag exists')
      this.tag(input.name, input.ref)
      return { name: input.name, sha: this.resolve(input.name)! }
    },
    listMergeRequests: async (_repo, query = {}) =>
      this.requests.filter(
        (mr) =>
          (!query.state || query.state === 'all' || mr.state === query.state) &&
          (!query.targetBranch || mr.targetBranch === query.targetBranch),
      ),
    listTags: async () => this.tags,
    listCommits: async (_repo, query) => {
      const head = this.resolve(query.ref)
      if (!head) throw new Error(`unknown ref ${query.ref}`)
      const excluded = new Set(query.since ? this.reachable(this.resolve(query.since)!) : [])
      const list: CommitRecord[] = this.reachable(head)
        .filter((sha) => !excluded.has(sha))
        .map((sha) => this.commits.get(sha)!)
        .toSorted((a, b) => b.date.localeCompare(a.date))
        .map((commit) => ({
          sha: commit.sha,
          parents: commit.parents,
          authorName: 'Dev',
          authorEmail: 'dev@example.com',
          authoredAt: commit.date,
          title: commit.message.split('\n')[0]!,
          message: commit.message,
        }))
      return query.limit === undefined ? list : list.slice(0, query.limit)
    },
    createRelease: async (_repo, input) => {
      this.calls.push(`release ${input.tag}`)
      const release = { ...input, webUrl: `https://forge/releases/${input.tag}` }
      this.releases.set(input.tag, release)
      return release
    },
  }
}
