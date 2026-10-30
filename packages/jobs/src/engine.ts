import { resolve } from 'node:path'

import type { AnyAnalyzer } from '@holtkeeper/analyzer'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { CommandRunner } from '@holtkeeper/exec'
import type { AnalysisRecord, Job, Store } from '@holtkeeper/store'

import { type AgentFor, type ContextFor, type GitKeyFor, createContextFactory } from './context.ts'
import type { ToolchainFor } from './execution.ts'
import { type ResolveRepos, groupRepositories } from './repos.ts'
import { type Scheduler, createScheduler } from './scheduler.ts'
import { type Worker, type WorkerOptions, createWorker } from './worker.ts'

export interface JobEngineOptions {
  /** Must have a `jobs` section. */
  config: HoltkeeperConfig
  store: Store
  analyzers: AnyAnalyzer[]
  agentFor?: AgentFor
  runner?: CommandRunner
  resolveRepos?: ResolveRepos
  /** Replaces the default checkout-forge-agent-history context. */
  contextFor?: ContextFor
  /** The SSH key of each forge, for checkouts; see `ContextFactoryOptions.gitKeyFor`. */
  gitKeyFor?: GitKeyFor
  /** Scoped `toolchain` setting per repository, for `jobs.execution` modes `mise` and `container`. */
  toolchainFor?: ToolchainFor
  /** Scoped `analyzers.<kind>` setting for a job; see `WorkerOptions.settingOptions`. */
  settingOptions?: WorkerOptions['settingOptions']
  /** Whether a claimed job may start now; see `WorkerOptions.admission`. */
  admission?: WorkerOptions['admission']
  /** Stores the artifacts of runs; see `WorkerOptions.persistArtifacts`. */
  persistArtifacts?: WorkerOptions['persistArtifacts']
  /** Overrides for this process's worker, e.g. from `serve --concurrency` / `--max-jobs`. */
  worker?: Pick<WorkerOptions, 'concurrency' | 'maxJobs' | 'workerId'>
  now?: () => Date
  onFinished?: (job: Job, record?: AnalysisRecord) => void | Promise<void>
  log?: (line: string) => void
}

/** Scheduler and worker built from `config.jobs`, started and stopped together. */
export interface JobEngine {
  scheduler: Scheduler
  worker: Worker
  start(): Promise<void>
  stop(): Promise<void>
}

/** Wires a scheduler and a worker from `config.jobs`; throws when the section is missing or invalid. */
export function createJobEngine(options: JobEngineOptions): JobEngine {
  const { config, store, analyzers } = options
  const jobs = config.jobs
  if (!jobs) throw new Error('the config has no `jobs` section')
  const resolveRepos = options.resolveRepos ?? groupRepositories(config)
  const shared = {
    ...(options.now && { now: options.now }),
    ...(options.log && { log: options.log }),
  }

  const scheduler = createScheduler({ config, store, analyzers, resolveRepos, ...shared })
  const worker = createWorker({
    store,
    analyzers,
    contextFor:
      options.contextFor ??
      createContextFactory({
        config,
        store,
        cacheDir: resolve(jobs.cacheDir),
        resolveRepos,
        ...(options.runner && { runner: options.runner }),
        ...(options.agentFor && { agentFor: options.agentFor }),
        ...(options.toolchainFor && { toolchainFor: options.toolchainFor }),
        ...(options.gitKeyFor && { gitKeyFor: options.gitKeyFor }),
      }),
    concurrency: jobs.concurrency,
    timeoutMs: jobs.timeoutMinutes * 60_000,
    ...(options.onFinished && { onFinished: options.onFinished }),
    ...(options.settingOptions && { settingOptions: options.settingOptions }),
    ...(options.admission && { admission: options.admission }),
    ...(options.persistArtifacts && { persistArtifacts: options.persistArtifacts }),
    ...options.worker,
    ...shared,
  })

  return {
    scheduler,
    worker,
    async start() {
      scheduler.start()
      await worker.start()
    },
    async stop() {
      scheduler.stop()
      await worker.stop()
    },
  }
}
