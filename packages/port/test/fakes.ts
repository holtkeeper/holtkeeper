import type {
  CommitInput,
  CreateMergeRequestInput,
  DiffFile,
  GitForge,
  MergeRequest,
  UpdateMergeRequestInput,
} from '@holtkeeper/forge'

const unsupported = () => Promise.reject(new Error('not used by port'))

/** A merge request the fake forge serves with its diff and the files at its base commit. */
export interface FakeSourceMergeRequest {
  repo: string
  id: number
  title: string
  description: string
  baseSha: string
  files: DiffFile[]
  /** Files at `baseSha`. */
  base: Record<string, string>
}

/** In-memory forge for the port pipeline: repositories, one source merge request, recorded writes. */
export function fakeForge(options: {
  repos: string[]
  source?: FakeSourceMergeRequest
  namespaces?: Record<string, string[]>
  failComment?: boolean
}) {
  const commits: (CommitInput & { repo: string })[] = []
  const mergeRequests: (MergeRequest & { repo: string })[] = []
  const updates: { repo: string; id: number; input: UpdateMergeRequestInput }[] = []
  const comments: { repo: string; id: number; body: string }[] = []
  const { source } = options
  const forge: GitForge = {
    kind: 'fake',
    async *listRepositories(namespace) {
      for (const path of options.namespaces?.[namespace] ?? [])
        yield {
          path,
          name: path.split('/').at(-1) ?? path,
          defaultBranch: 'main',
          webUrl: `https://git.test/${path}`,
          cloneUrl: `https://git.test/${path}.git`,
          archived: false,
        }
    },
    async getRepository(path) {
      if (!options.repos.includes(path)) throw new Error(`404 ${path}`)
      return {
        path,
        name: path.split('/').at(-1) ?? path,
        defaultBranch: 'main',
        webUrl: `https://git.test/${path}`,
        cloneUrl: `https://git.test/${path}.git`,
        archived: false,
      }
    },
    async readFile(repo, file, ref) {
      if (source && repo === source.repo && ref === source.baseSha) return source.base[file]
      return undefined
    },
    createBranch: unsupported,
    deleteBranch: unsupported,
    async commit(repo, input) {
      commits.push({ repo, ...input })
      return {
        sha: `sha${commits.length}`,
        webUrl: `https://git.test/${repo}/-/commit/${commits.length}`,
      }
    },
    async findMergeRequest(repo, query) {
      return mergeRequests.find(
        (mr) =>
          mr.repo === repo &&
          mr.sourceBranch === query.sourceBranch &&
          (!query.state || mr.state === query.state),
      )
    },
    async createMergeRequest(repo, input: CreateMergeRequestInput) {
      const id = mergeRequests.filter((mr) => mr.repo === repo).length + 1
      const mr = {
        repo,
        id,
        title: input.title,
        description: input.description ?? '',
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        state: 'open' as const,
        draft: input.draft ?? false,
        labels: input.labels ?? [],
        author: 'holtkeeper',
        webUrl: `https://git.test/${repo}/-/merge_requests/${id}`,
      }
      mergeRequests.push(mr)
      return mr
    },
    async updateMergeRequest(repo, id, input) {
      updates.push({ repo, id, input })
      const mr = mergeRequests.find((candidate) => candidate.repo === repo && candidate.id === id)
      if (!mr) throw new Error('no such merge request')
      Object.assign(mr, input)
      return mr
    },
    mergeMergeRequest: unsupported,
    async commentOnMergeRequest(repo, id, body) {
      if (options.failComment) throw new Error('403 forbidden')
      comments.push({ repo, id, body })
    },
    listPipelines: unsupported,
    listJobs: unsupported,
    playJob: unsupported,
    retryJob: unsupported,
    createTag: unsupported,
    async getMergeRequest(repo, id) {
      if (!source || repo !== source.repo || id !== source.id) throw new Error('404 merge request')
      return {
        id,
        title: source.title,
        description: source.description,
        sourceBranch: 'feature',
        targetBranch: 'main',
        state: 'open',
        draft: false,
        labels: [],
        author: 'dev',
        webUrl: `https://git.test/${repo}/-/merge_requests/${id}`,
        headSha: 'head',
      }
    },
    async getMergeRequestDiff(repo, id) {
      if (!source || repo !== source.repo || id !== source.id) throw new Error('404 merge request')
      return {
        refs: { baseSha: source.baseSha, startSha: source.baseSha, headSha: 'head' },
        files: source.files,
      }
    },
  }
  return { forge, commits, mergeRequests, updates, comments }
}
