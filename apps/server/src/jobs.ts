import { type ArtifactStore, artifactCache } from '@holtkeeper/artifacts'
import { assetsPolicyKey } from '@holtkeeper/assets'
import { type HoltkeeperConfig, resolveRepo } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type AgentFor,
  type AnyAnalyzer,
  type GitKeyFor,
  type JobEngine,
  type JobEngineOptions,
  type PersistArtifacts,
  type ToolchainOverride,
  createJobEngine,
  toolchainOverrideSchema,
  toolchainSetting,
} from '@holtkeeper/jobs'
import { type SettingDefinition, resolveSetting } from '@holtkeeper/settings'
import type { AnalysisRecord, AuditTrigger, Job, Store } from '@holtkeeper/store'
import { auditReportSchema } from '@holtkeeper/vuln'
import { z } from 'zod'

import { assetsPolicyFor } from './assets.ts'
import type { ReadOnlyRepos } from './read-only.ts'
import { RUN_ONLY_ANALYZERS, jobTarget } from './routes/jobs.ts'

export type { AgentFor, AnyAnalyzer } from '@holtkeeper/jobs'

export interface JobsOptions {
  config: HoltkeeperConfig
  store: Store
  analyzers: AnyAnalyzer[]
  agentFor?: AgentFor
  /** The SSH key of each forge, for job checkouts. */
  gitKeyFor?: GitKeyFor
  /** Repositories nothing may be pushed to over git (the `repo.readOnly` setting). */
  readOnly?: ReadOnlyRepos
  now: () => Date
  /**
   * Where artifacts returned by analyzer runs are stored; without it they are dropped. Also backs
   * `context.cache`, so expensive results (encoded image variants) survive between runs, and holds
   * each attempt's log, which `GET /api/jobs/:id/log` reads.
   */
  artifacts?: ArtifactStore
  /** Whether a claimed job may start now, e.g. `limitJobs` from `@holtkeeper/limits`. */
  admission?: (job: Job) => boolean | Promise<boolean>
  /** Called once a job finished, e.g. for notifications. */
  onFinished?: (job: Job, record?: AnalysisRecord) => void | Promise<void>
  /** What to start: the worker and/or the scheduler. Default both. */
  run?: { worker: boolean; scheduler: boolean }
  /** Worker overrides for this process (concurrency, max jobs). */
  worker?: JobEngineOptions['worker']
  log: (line: string) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Options filled from their own setting, never from `analyzers.<kind>`, by analyzer kind. */
const SETTING_OPTIONS: Record<string, Record<string, string>> = {
  assets: { policy: assetsPolicyKey },
}

const withoutSettingOptions = (kind: string, schema: z.ZodType): z.ZodType => {
  const owned = Object.keys(SETTING_OPTIONS[kind] ?? {})
  if (!owned.length || !(schema instanceof z.ZodObject)) return schema
  return z.object(
    Object.fromEntries(Object.entries(schema.shape).filter(([key]) => !owned.includes(key))),
  )
}

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
 * analyzer but those in `RUN_ONLY_ANALYZERS`, merged over schedule options when a job runs.
 */
export function analyzerSettings(analyzers: AnyAnalyzer[]): SettingDefinition[] {
  return analyzers
    .filter((analyzer) => !RUN_ONLY_ANALYZERS.has(analyzer.kind))
    .map((analyzer) => {
      const shape = withoutSettingOptions(analyzer.kind, analyzer.options)
      return {
        key: `analyzers.${analyzer.kind}`,
        label: analyzer.analysis.label,
        description: `Options for the ${analyzer.kind} analyzer in this scope; unset options keep their defaults.`,
        section: 'Analyzers',
        help: `Options for the ${analyzer.kind} analyzer in repositories this entry covers. Set only what differs from the defaults: unset options keep them. The most specific entry covering a repository wins as a whole, so repeat shared options in narrower entries.`,
        schema: partialOptions(shape),
        ...(analyzer.presets?.length
          ? {
              presets: analyzer.presets.map(({ options, ...preset }) => ({
                ...preset,
                value: options,
              })),
            }
          : {}),
        ...(shape instanceof z.ZodObject
          ? {
              form: z
                .object(
                  Object.fromEntries(
                    Object.entries(shape.shape).map(([key, field]) => [key, field.optional()]),
                  ),
                )
                .meta(analyzer.editor ? { 'x-editor': analyzer.editor } : {}),
            }
          : {}),
      }
    })
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
  job: Pick<Job, 'analyzer' | 'repo' | 'group'>,
): Promise<Record<string, unknown> | undefined> {
  if (RUN_ONLY_ANALYZERS.has(job.analyzer)) return undefined
  const key = `analyzers.${job.analyzer}`
  const target = jobTarget(config, job)
  const entry = resolveSetting(await store.settings.list(key), key, target)
  const scoped = entry && !entry.secret && isRecord(entry.value) ? entry.value : undefined
  if (job.analyzer === 'assets' && job.group === undefined) {
    const { policy } = await assetsPolicyFor(store, target)
    return { ...scoped, policy }
  }
  if (job.analyzer !== 'audit' || job.group !== undefined) return scoped

  const valueOf = async (settingKey: string) => {
    const found = resolveSetting(await store.settings.list(settingKey), settingKey, target)
    return found && !found.secret ? found.value : undefined
  }
  const [fix, allowlist] = await Promise.all([valueOf('audit.fix'), valueOf('audit.allowlist')])
  return {
    ...(typeof fix === 'boolean' && { fix }),
    ...(Array.isArray(allowlist) && { allowlist }),
    traits: resolveRepo(config, job.repo).traits,
    ...scoped,
  }
}

/**
 * Whether an automatically queued job would get valid options: its own merged with the
 * `analyzers.<kind>` setting that applies to it, as the worker merges them for non-manual jobs.
 * False when an analyzer with required options is not set up for
 * the repository, so triggers can leave it out instead of queuing a job bound to fail.
 */
export async function automaticJobReady(
  config: HoltkeeperConfig,
  store: Store,
  analyzer: { options: z.ZodType },
  request: Pick<Job, 'analyzer' | 'repo'> & { group?: string; options?: Record<string, unknown> },
): Promise<boolean> {
  const scoped = (await scopedAnalyzerOptions(config, store, request)) ?? {}
  return analyzer.options.safeParse({ ...request.options, ...scoped }).success
}

const auditTriggers: Partial<Record<Job['trigger'], AuditTrigger>> = {
  manual: 'manual',
  schedule: 'schedule',
  freshness: 'freshness',
}

/** Stores a finished `audit` job's report as an audit run, so it shows up next to CLI uploads. */
async function recordAuditRun(store: Store, job: Job, record: AnalysisRecord) {
  if (job.analyzer !== 'audit' || record.kind !== 'audit') return
  const parsed = auditReportSchema.safeParse(record.data)
  if (!parsed.success) return
  await store.auditRuns.add({
    repo: job.repo,
    trigger: auditTriggers[job.trigger] ?? 'webhook',
    ...(job.actor !== undefined && { actor: job.actor }),
    startedAt: job.startedAt ?? job.createdAt,
    finishedAt: job.finishedAt ?? record.createdAt,
    report: parsed.data,
  })
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
 * Starts the scheduler and worker (`run` picks which). Job outcomes stay on the job records; they
 * are not audited.
 */
export async function startJobs(options: JobsOptions): Promise<JobEngine> {
  const { config, store, now, log } = options
  const engine = createJobEngine({
    config,
    store,
    analyzers: options.analyzers,
    ...(options.agentFor && { agentFor: options.agentFor }),
    ...(options.gitKeyFor && { gitKeyFor: options.gitKeyFor }),
    ...(options.readOnly && { readOnly: options.readOnly }),
    now,
    log,
    settingOptions: (job) => scopedAnalyzerOptions(config, store, job),
    toolchainFor: (repo) => scopedToolchain(config, store, repo),
    ...(options.artifacts && {
      logs: options.artifacts,
      persistArtifacts: persistArtifactsTo(options.artifacts),
      cache: artifactCache(options.artifacts, {
        onError: (error) => log(`cache: ${error instanceof Error ? error.message : String(error)}`),
      }),
    }),
    ...(options.admission && { admission: options.admission }),
    ...(options.worker && { worker: options.worker }),
    async onFinished(job, record) {
      if (record) await recordAuditRun(store, job, record)
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
