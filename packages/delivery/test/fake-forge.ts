import type {
  Deployment,
  GitForge,
  JobRun,
  MergeRequestRecord,
  PipelineRun,
  TagRecord,
} from '@holtkeeper/forge'

export interface FakeHistory {
  mergeRequests?: MergeRequestRecord[]
  deployments?: Deployment[]
  tags?: TagRecord[]
  pipelines?: PipelineRun[]
  jobs?: JobRun[]
}

const unsupported = () => {
  throw new Error('not supported by the fake forge')
}

const newest = <T>(items: T[], time: (item: T) => string, limit?: number) =>
  items.toSorted((a, b) => time(b).localeCompare(time(a))).slice(0, limit)

/** A `GitForge` serving fixed history through the insight reads; `without` drops some of them. */
export function fakeForge(
  history: FakeHistory,
  without: (
    | 'listMergeRequests'
    | 'listDeployments'
    | 'listTags'
    | 'listPipelineRuns'
    | 'listJobRuns'
  )[] = [],
): GitForge & { calls: string[] } {
  const calls: string[] = []
  const forge: GitForge & { calls: string[] } = {
    kind: 'fake',
    calls,
    listRepositories: unsupported,
    getRepository: async (repo) => ({
      path: repo,
      name: repo,
      defaultBranch: 'main',
      webUrl: `https://g.example/${repo}`,
      cloneUrl: `https://g.example/${repo}.git`,
      archived: false,
    }),
    readFile: unsupported,
    createBranch: unsupported,
    deleteBranch: unsupported,
    commit: unsupported,
    findMergeRequest: unsupported,
    createMergeRequest: unsupported,
    updateMergeRequest: unsupported,
    mergeMergeRequest: unsupported,
    commentOnMergeRequest: unsupported,
    listPipelines: unsupported,
    listJobs: unsupported,
    playJob: unsupported,
    retryJob: unsupported,
    createTag: unsupported,
    async listMergeRequests(_repo, query = {}) {
      calls.push(`mergeRequests ${query.state ?? 'all'}`)
      const list = (history.mergeRequests ?? []).filter(
        (mr) =>
          (!query.state || query.state === 'all' || mr.state === query.state) &&
          (!query.updatedAfter || mr.updatedAt >= query.updatedAfter),
      )
      return newest(list, (mr) => mr.updatedAt, query.limit)
    },
    async listDeployments(_repo, query = {}) {
      calls.push(`deployments ${query.environment ?? ''}`)
      const list = (history.deployments ?? []).filter(
        (d) => !query.environment || d.environment === query.environment,
      )
      return newest(list, (d) => d.createdAt, query.limit)
    },
    async listTags(_repo, query = {}) {
      calls.push('tags')
      return newest(history.tags ?? [], (t) => t.committedAt, query.limit)
    },
    async listPipelineRuns(_repo, query = {}) {
      calls.push('pipelines')
      const list = (history.pipelines ?? []).filter(
        (p) => !query.after || p.createdAt >= query.after,
      )
      return newest(list, (p) => p.createdAt, query.limit)
    },
    async listJobRuns(_repo, pipelineId) {
      calls.push(`jobs ${pipelineId}`)
      return (history.jobs ?? []).filter((j) => j.pipelineId === pipelineId)
    },
  }
  for (const method of without) delete forge[method]
  return forge
}
