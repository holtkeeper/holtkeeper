import type {
  CommitInput,
  CreateMergeRequestInput,
  GitForge,
  ListFilesOptions,
  MergeRequest,
  TagRecord,
  UpdateMergeRequestInput,
} from '@holtkeeper/forge'

import type { Ecosystem, VersionRegistry } from '../src/types.ts'

const unsupported = () => Promise.reject(new Error('not used by propagate'))

/** In-memory forge: files by repository, then path; branches other than `main` start empty. */
export function fakeForge(
  files: Record<string, Record<string, string>>,
  options: {
    tags?: Record<string, TagRecord[]>
    /** Files on other refs: `repo` → `ref` → path → content. */
    refs?: Record<string, Record<string, Record<string, string>>>
    mergeRequests?: (MergeRequest & { repo: string })[]
    archived?: string[]
  } = {},
) {
  const commits: (CommitInput & { repo: string })[] = []
  const mergeRequests = [...(options.mergeRequests ?? [])]
  const updates: { repo: string; id: number; input: UpdateMergeRequestInput }[] = []
  const reads: string[] = []
  const contentAt = (repo: string, ref?: string) =>
    ref && ref !== 'main' ? (options.refs?.[repo]?.[ref] ?? {}) : (files[repo] ?? {})
  const forge: GitForge = {
    kind: 'fake',
    async *listRepositories() {},
    async getRepository(path) {
      if (!(path in files)) throw new Error(`404 ${path}`)
      return {
        path,
        name: path.split('/').at(-1) ?? path,
        defaultBranch: 'main',
        webUrl: `https://git.test/${path}`,
        cloneUrl: `https://git.test/${path}.git`,
        archived: options.archived?.includes(path) ?? false,
      }
    },
    async readFile(repo, file, ref) {
      reads.push(`${repo}:${file}${ref ? `@${ref}` : ''}`)
      return contentAt(repo, ref)[file]
    },
    async listFiles(repo, query: ListFilesOptions = {}) {
      const prefix = query.path ? `${query.path}/` : ''
      return Object.keys(contentAt(repo, query.ref))
        .filter((path) => path.startsWith(prefix))
        .map((path) => ({ path, type: 'file' as const }))
    },
    async listTags(repo) {
      return options.tags?.[repo] ?? []
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
      const mr = {
        repo,
        id: mergeRequests.length + 1,
        title: input.title,
        description: input.description ?? '',
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        state: 'open' as const,
        draft: input.draft ?? false,
        labels: input.labels ?? [],
        author: 'holtkeeper',
        webUrl: `https://git.test/${repo}/-/merge_requests/${mergeRequests.length + 1}`,
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
    commentOnMergeRequest: unsupported,
    listPipelines: unsupported,
    listJobs: unsupported,
    playJob: unsupported,
    retryJob: unsupported,
    createTag: unsupported,
  }
  return { forge, commits, mergeRequests, updates, reads }
}

/** Registry answering from a fixed table keyed `ecosystem:name`. */
export function fakeRegistry(latest: Record<string, string>): VersionRegistry {
  return { latest: async (ecosystem: Ecosystem, name: string) => latest[`${ecosystem}:${name}`] }
}
