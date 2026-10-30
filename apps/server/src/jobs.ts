import type { ArtifactStore } from '@holtkeeper/artifacts'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type AgentFor,
  type AnyAnalyzer,
  type JobEngine,
  type JobEngineOptions,
  type PersistArtifacts,
  type ToolchainOverride,
  createJobEngine,
  toolchainOverrideSchema,
  toolchainSetting,
} from '@holtkeeper/jobs'
import { type SettingDefinition, resolveSetting } from '@holtkeeper/settings'
import type { AnalysisRecord, Job, Store } from '@holtkeeper/store'
import { z } from 'zod'

import { jobTarget } from './routes/jobs.ts'

export type { AgentFor, AnyAnalyzer } from '@holtkeeper/jobs'

export interface JobsOptions {
  config: HoltkeeperConfig
  store: Store
  analyzers: AnyAnalyzer[]
  agentFor?: AgentFor
  now: () => Date
  /** Where artifacts returned by analyzer runs are stored; without it they are dropped. */
  artifacts?: ArtifactStore
  /** Whether a claimed job may start now, e.g. `limitJobs` from `@holtkeeper/limits`. */
  admission?: (job: Job) => boolean | Promise<boolean>
  /** Called after the activity entry is written, e.g. for notifications. */
  onFinished?: (job: Job, record?: AnalysisRecord) => void | Promise<void>
  /** What to start: the worker and/or the scheduler. Default both. */
  run?: { worker: boolean; scheduler: boolean }
  /** Worker overrides for this process (concurrency, max jobs). */
  worker?: JobEngineOptions['worker']
  log: (line: string) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validates a partial options object field by field against an analyzer's options schema and keeps
 * it as given, so defaults are not stored and cannot override schedule options when merged.
 */
function partialOptions(options: z.ZodType) {
  const shape = options instanceof z.ZodObject ? options.shape : undefined
  return z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
    if (!shape) return
    for (const [key, field] of Object.entries(value)) {
      const schema = shape[key]
      if (!schema) {
        ctx.addIssue({ code: 'custom', path: [key], message: `unknown option ${key}` })
        continue
      }
      for (const issue of schema.safeParse(field).error?.issues ?? []) {
        ctx.addIssue({ code: 'custom', path: [key, ...issue.path], message: issue.message })
      }
    }
  })
}

/**
 * Setting definitions `analyzers.<kind>` (section `Analyzers`): per-scope partial options for each
 * analyzer, merged over schedule options when a job runs.
 */
export function analyzerSettings(analyzers: AnyAnalyzer[]): SettingDefinition[] {
  return analyzers.map((analyzer) => ({
    key: `analyzers.${analyzer.kind}`,
    label: analyzer.analysis.label,
    description: `Options for the ${analyzer.kind} analyzer in this scope; unset options keep their defaults.`,
    section: 'Analyzers',
    schema: partialOptions(analyzer.options),
    ...(analyzer.options instanceof z.ZodObject
      ? {
          form: z.object(
            Object.fromEntries(
              Object.entries(analyzer.options.shape).map(([key, field]) => [key, field.optional()]),
            ),
          ),
        }
      : {}),
  }))
}

/**
 * Setting definitions for job execution: `toolchain` (section `Runtime`), the per-scope override of
 * detected tool versions, container image, network and environment. Register next to
 * `analyzerSettings`.
 */
export function executionSettings(): SettingDefinition[] {
  return [toolchainSetting]
}

/** The `toolchain` setting that applies to a repository; `undefined` when unset or invalid. */
async function scopedToolchain(
  config: HoltkeeperConfig,
  store: Store,
  repo: RepoRef,
): Promise<ToolchainOverride | undefined> {
  const key = toolchainSetting.key
  const entry = resolveSetting(await store.settings.list(key), key, jobTarget(config, { repo }))
  if (!entry || entry.secret) return undefined
  const parsed = toolchainOverrideSchema.safeParse(entry.value)
  return parsed.success ? parsed.data : undefined
}

/** The `analyzers.<kind>` setting that applies to a job's repository or group. */
export async function scopedAnalyzerOptions(
  config: HoltkeeperConfig,
  store: Store,
  job: Job,
): Promise<Record<string, unknown> | undefined> {
  const key = `analyzers.${job.analyzer}`
  const entry = resolveSetting(await store.settings.list(key), key, jobTarget(config, job))
  return entry && !entry.secret && isRecord(entry.value) ? entry.value : undefined
}

/**
 * A `persistArtifacts` hook storing run artifacts in `store`, tagged `{ repo, kind, analysis }`.
 * Ids are checked against the content hash the store computes.
 */
export function persistArtifactsTo(store: ArtifactStore): PersistArtifacts {
  return async (artifacts, { repo, kind, analysisId }) => {
    for (const artifact of artifacts) {
      const stored = await store.put(artifact.data, {
        ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
        ...(artifact.name ? { name: artifact.name } : {}),
        tags: { repo: `${repo.forge}:${repo.path}`, kind, analysis: analysisId },
      })
      if (stored.id !== artifact.id)
        throw new Error(`artifact ${artifact.id} does not match its content (${stored.id})`)
    }
  }
}

/**
 * Starts the scheduler and worker when the config has a `jobs` section; `undefined` otherwise.
 * Finished jobs are written to the activity log.
 */
export async function startJobs(options: JobsOptions): Promise<JobEngine | undefined> {
  const { config, store, now, log } = options
  if (!config.jobs) return undefined
  const engine = createJobEngine({
    config,
    store,
    analyzers: options.analyzers,
    ...(options.agentFor && { agentFor: options.agentFor }),
    now,
    log,
    settingOptions: (job) => scopedAnalyzerOptions(config, store, job),
    toolchainFor: (repo) => scopedToolchain(config, store, repo),
    ...(options.artifacts && { persistArtifacts: persistArtifactsTo(options.artifacts) }),
    ...(options.admission && { admission: options.admission }),
    ...(options.worker && { worker: options.worker }),
    async onFinished(job, record) {
      await store.activity.append({
        at: now().toISOString(),
        actor: job.actor ?? 'system',
        action: record ? 'job.succeeded' : 'job.failed',
        subject: `${job.repo.forge}:${job.repo.path}`,
        details: {
          id: job.id,
          analyzer: job.analyzer,
          ...(job.ref ? { ref: job.ref } : {}),
          ...(record ? { analysis: record.id } : { error: job.error }),
        },
      })
      await options.onFinished?.(job, record)
    },
  })
  const run = options.run ?? { worker: true, scheduler: true }
  if (run.worker) await engine.worker.start()
  if (run.scheduler) engine.scheduler.start()
  log(
    `jobs: ${config.jobs.schedules.length} schedule(s)${run.scheduler ? '' : ' (scheduler started separately)'}, ` +
      (run.worker
        ? `worker concurrency ${options.worker?.concurrency ?? config.jobs.concurrency}`
        : 'no worker'),
  )
  return engine
}
