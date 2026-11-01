import type { Deployment, GitForge, Job, JobRun, RepoRef } from '@holtkeeper/forge'

import type { ReleaseEnvironment, ReleaseSettings } from './settings.ts'
import type {
  DeployAttempt,
  DeployState,
  DeployStatus,
  EnvironmentState,
  PipelineState,
} from './types.ts'

type JobLike = Job &
  Partial<Pick<JobRun, 'retried' | 'startedAt' | 'finishedAt' | 'durationSeconds'>>

/** Whether a job deploys `environment`: its `job` glob, else its name. */
export const deploysTo = (environment: ReleaseEnvironment, job: Pick<Job, 'name'>) => {
  const pattern = environment.job ?? environment.name
  return job.name === pattern || new Bun.Glob(pattern).match(job.name)
}

const statusOf = (job: JobLike): DeployStatus => {
  switch (job.status) {
    case 'manual':
      return 'ready'
    case 'pending':
      return 'pending'
    case 'running':
      return 'running'
    case 'success':
      return 'success'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'canceled'
    case 'skipped':
      return 'skipped'
    default:
      return 'pending'
  }
}

const attemptOf = (job: JobLike): DeployAttempt => ({
  jobId: job.id,
  status: job.status,
  webUrl: job.webUrl,
  ...(job.startedAt ? { startedAt: job.startedAt } : {}),
  ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
  ...(job.durationSeconds !== undefined ? { durationSeconds: job.durationSeconds } : {}),
})

/**
 * Where each configured environment stands for a version: from the jobs of the tag pipeline
 * (retried attempts included when the forge lists them) and, when given, what the forge reports
 * deployed there. A manual job whose `after` environment has not succeeded is `waiting`.
 */
export function deployState(
  settings: ReleaseSettings,
  tag: string,
  pipeline: PipelineState | undefined,
  jobs: readonly JobLike[],
  current: ReadonlyMap<string, Deployment> = new Map(),
): DeployState {
  const environments: EnvironmentState[] = settings.deploy.environments.map((environment) => {
    const attempts = jobs
      .filter((job) => deploysTo(environment, job))
      .toSorted((a, b) => b.id - a.id)
    const latest = attempts.find((job) => !job.retried) ?? attempts[0]
    const deployed = current.get(environment.name)
    return {
      name: environment.name,
      ...(environment.job ? { job: environment.job } : {}),
      status: !pipeline ? 'no-pipeline' : latest ? statusOf(latest) : 'missing',
      attempts: attempts.map(attemptOf),
      ...(environment.after ? { after: environment.after } : {}),
      confirm: environment.confirm,
      auto: environment.auto,
      ...(deployed
        ? {
            current: {
              ref: deployed.ref,
              sha: deployed.sha,
              status: deployed.status,
              ...((deployed.finishedAt ?? deployed.createdAt)
                ? { at: deployed.finishedAt ?? deployed.createdAt }
                : {}),
            },
          }
        : {}),
    }
  })
  for (const environment of environments) {
    if (environment.status !== 'ready' || !environment.after) continue
    const before = environments.find((other) => other.name === environment.after)
    if (before && before.status !== 'success') environment.status = 'waiting'
  }
  return { tag, ...(pipeline ? { pipeline } : {}), environments }
}

/** Reads the deploy state of `tag` from its newest pipeline. */
export async function readDeployState(
  forge: GitForge,
  repo: RepoRef,
  settings: ReleaseSettings,
  tag: string,
): Promise<DeployState> {
  const pipeline = (await forge.listPipelines(repo.path, { ref: tag }))[0]
  const state = pipeline
    ? { id: pipeline.id, status: pipeline.status, sha: pipeline.sha, webUrl: pipeline.webUrl }
    : undefined
  const jobs: JobLike[] = !pipeline
    ? []
    : forge.listJobRuns
      ? await forge.listJobRuns(repo.path, pipeline.id)
      : await forge.listJobs(repo.path, pipeline.id)
  const current = new Map<string, Deployment>()
  if (forge.listDeployments)
    await Promise.all(
      settings.deploy.environments.map(async (environment) => {
        const [latest] = await forge.listDeployments!(repo.path, {
          environment: environment.name,
          limit: 1,
        }).catch(() => [])
        if (latest) current.set(environment.name, latest)
      }),
    )
  return deployState(settings, tag, state, jobs, current)
}

/** Why a deploy cannot start. */
export class DeployError extends Error {
  readonly code: 'unknown-environment' | 'no-pipeline' | 'missing' | 'order' | 'busy' | 'done'

  constructor(code: DeployError['code'], message: string) {
    super(message)
    this.name = 'DeployError'
    this.code = code
  }
}

export interface StartDeployOptions {
  forge: GitForge
  repo: RepoRef
  settings: ReleaseSettings
  tag: string
  environment: string
  /** Run again although the environment already succeeded. */
  redeploy?: boolean
  /** Start although the `after` environment has not succeeded. */
  force?: boolean
}

/**
 * Starts the deploy job of one environment for a version: plays a manual job, retries a failed or
 * canceled one, and with `redeploy` reruns a successful one. Refuses jobs that are already
 * pending or running, and environments whose `after` environment has not succeeded unless
 * `force`. Resolves with the started job.
 */
export async function startDeploy(
  options: StartDeployOptions,
): Promise<{ job: Job; state: EnvironmentState }> {
  const { forge, repo, settings, tag, environment: name } = options
  if (!settings.deploy.environments.some((environment) => environment.name === name))
    throw new DeployError('unknown-environment', `environment ${name} is not configured`)
  const state = await readDeployState(forge, repo, settings, tag)
  const environment = state.environments.find((env) => env.name === name)!
  if (!state.pipeline) throw new DeployError('no-pipeline', `${tag} has no pipeline yet`)
  const latest = environment.attempts[0]
  if (!latest) throw new DeployError('missing', `the ${tag} pipeline has no job for ${name}`)
  if (environment.status === 'waiting' && !options.force)
    throw new DeployError('order', `${environment.after} must be deployed first`)
  if (environment.status === 'pending' || environment.status === 'running')
    throw new DeployError('busy', `${name} is already ${environment.status}`)
  if (environment.status === 'success' && !options.redeploy)
    throw new DeployError('done', `${tag} is already deployed to ${name}`)
  const job =
    latest.status === 'manual'
      ? await forge.playJob(repo.path, latest.jobId)
      : await forge.retryJob(repo.path, latest.jobId)
  return { job, state: environment }
}

/** Environments to start on their own once `finished` succeeded (or right after versioning when absent). */
export function autoEnvironments(
  settings: ReleaseSettings,
  finished?: string,
): ReleaseEnvironment[] {
  return settings.deploy.environments.filter(
    (environment) => environment.auto && environment.after === finished,
  )
}

/** Whether a deploy status is final. */
export const deployFinished = (status: DeployStatus) =>
  status === 'success' || status === 'failed' || status === 'canceled' || status === 'skipped'
