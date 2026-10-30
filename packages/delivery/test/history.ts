import type {
  Deployment,
  JobRun,
  MergeRequestRecord,
  PipelineRun,
  TagRecord,
} from '@holtkeeper/forge'

import type { DeliveryInput, DeliveryOptions } from '../src/types.ts'

export const options: DeliveryOptions = {
  days: 28,
  productionEnvironment: 'production',
  failureWindowHours: 24,
  staleDays: 7,
}

/** `2026-03-02T00:00:00Z` (a Monday) plus `days` days and `hours` hours. */
export const at = (days: number, hours = 0) =>
  new Date(Date.UTC(2026, 2, 2) + (days * 24 + hours) * 3_600_000).toISOString()

let ids = 0

export function mr(
  overrides: Partial<MergeRequestRecord> & { createdAt: string },
): MergeRequestRecord {
  const id = overrides.id ?? ++ids
  return {
    id,
    title: `change ${id}`,
    description: '',
    sourceBranch: `feature-${id}`,
    targetBranch: 'main',
    state: 'merged',
    draft: false,
    labels: [],
    author: 'dev',
    webUrl: `https://g.example/g/a/-/merge_requests/${id}`,
    updatedAt: overrides.mergedAt ?? overrides.createdAt,
    ...overrides,
  }
}

export function deployment(
  status: Deployment['status'],
  when: string,
  overrides: Partial<Deployment> = {},
): Deployment {
  return {
    id: ++ids,
    environment: 'production',
    status,
    sha: `sha${ids}`.padEnd(40, '0'),
    ref: 'main',
    createdAt: when,
    finishedAt: when,
    ...overrides,
  }
}

export function tag(name: string, when: string): TagRecord {
  return { name, sha: `tag${name}`, committedAt: when }
}

export function pipeline(
  status: PipelineRun['status'],
  when: string,
  overrides: Partial<PipelineRun> = {},
): PipelineRun {
  const id = overrides.id ?? ++ids
  return {
    id,
    ref: 'main',
    sha: `p${id}`,
    status,
    webUrl: `https://g.example/g/a/-/pipelines/${id}`,
    createdAt: when,
    finishedAt: when,
    ...overrides,
  }
}

export function job(
  pipelineId: number,
  name: string,
  status: JobRun['status'],
  overrides: Partial<JobRun> = {},
): JobRun {
  const id = overrides.id ?? ++ids
  return {
    id,
    name,
    stage: 'test',
    status,
    webUrl: `https://g.example/g/a/-/jobs/${id}`,
    pipelineId,
    createdAt: at(0),
    retried: false,
    allowFailure: false,
    ...overrides,
  }
}

export function input(partial: Partial<DeliveryInput> = {}): DeliveryInput {
  return {
    from: at(0),
    to: at(28),
    defaultBranch: 'main',
    mergeRequests: [],
    deployments: [],
    tags: [],
    pipelines: [],
    jobs: [],
    jobPipelines: 0,
    notes: [],
    ...partial,
  }
}
