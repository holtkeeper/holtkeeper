import type { GitForge, JobRun, MergeRequestRecord } from '@holtkeeper/forge'

import type { DeliveryInput, DeliveryOptions } from './types.ts'

/** Caps on how much history is fetched; each pipeline and each job list costs a request. */
export interface CollectLimits {
  mergeRequests: number
  deployments: number
  tags: number
  pipelines: number
  /** Newest finished pipelines whose jobs are loaded. */
  jobPipelines: number
}

export const defaultLimits: CollectLimits = {
  mergeRequests: 1000,
  deployments: 1000,
  tags: 200,
  pipelines: 300,
  jobPipelines: 100,
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, map: (item: T) => Promise<R>) {
  const result: R[] = []
  for (let i = 0; i < items.length; i += concurrency)
    result.push(...(await Promise.all(items.slice(i, i + concurrency).map(map))))
  return result
}

/**
 * Fetches what `analyzeDelivery` needs for the window of `options.days` ending at `now`. Insight
 * reads the forge does not implement yield empty lists and a note instead of failing.
 */
export async function collectDelivery(options: {
  forge: GitForge
  repo: string
  settings: DeliveryOptions
  now: Date
  limits?: Partial<CollectLimits>
  log?: (line: string) => void
}): Promise<DeliveryInput> {
  const { forge, repo, settings } = options
  const limits = { ...defaultLimits, ...options.limits }
  const to = options.now.toISOString()
  const from = new Date(options.now.getTime() - settings.days * 86_400_000).toISOString()
  const notes: string[] = []
  const missing = (method: string) => {
    notes.push(
      `The ${forge.kind} forge does not provide ${method}; that part of the report is empty.`,
    )
    return []
  }

  const repository = await forge.getRepository(repo)

  const mergeRequests = async (): Promise<MergeRequestRecord[]> => {
    if (!forge.listMergeRequests) return missing('listMergeRequests')
    const [recent, open] = await Promise.all([
      forge.listMergeRequests(repo, {
        state: 'all',
        updatedAfter: from,
        limit: limits.mergeRequests,
      }),
      forge.listMergeRequests(repo, { state: 'open', limit: limits.mergeRequests }),
    ])
    const byId = new Map(recent.map((mr) => [mr.id, mr]))
    for (const mr of open) byId.set(mr.id, mr)
    return [...byId.values()]
  }

  const [mrs, deployments, tags, pipelines] = await Promise.all([
    mergeRequests(),
    forge.listDeployments
      ? forge.listDeployments(repo, {
          environment: settings.productionEnvironment,
          after: from,
          limit: limits.deployments,
        })
      : missing('listDeployments'),
    forge.listTags ? forge.listTags(repo, { limit: limits.tags }) : missing('listTags'),
    forge.listPipelineRuns
      ? forge.listPipelineRuns(repo, { after: from, limit: limits.pipelines })
      : missing('listPipelineRuns'),
  ])
  if (pipelines.length >= limits.pipelines)
    notes.push(`Only the newest ${limits.pipelines} pipelines of the window were analyzed.`)

  const withJobs = pipelines
    .filter((p) => p.status === 'success' || p.status === 'failed' || p.status === 'canceled')
    .slice(0, limits.jobPipelines)
  let jobs: JobRun[] = []
  if (forge.listJobRuns) {
    const listJobRuns = forge.listJobRuns.bind(forge)
    jobs = (await mapConcurrent(withJobs, 4, (p) => listJobRuns(repo, p.id))).flat()
  } else if (withJobs.length > 0) missing('listJobRuns')
  options.log?.(
    `delivery: ${mrs.length} merge requests, ${deployments.length} deployments, ${tags.length} tags, ${pipelines.length} pipelines, ${jobs.length} jobs`,
  )

  return {
    from,
    to,
    defaultBranch: repository.defaultBranch,
    mergeRequests: mrs,
    deployments,
    tags,
    pipelines,
    jobs,
    jobPipelines: forge.listJobRuns ? withJobs.length : 0,
    notes,
  }
}
