import { join } from 'node:path'

import {
  type AiCatalog,
  aiProviderOptionsValidatorFor,
  modelsDevCatalog,
  withPluginCatalogs,
} from '@holtkeeper/agent'
import { builtinAnalyzers, reviewChecks } from '@holtkeeper/analyzers'
import {
  type ArtifactStore,
  type StorageProvider,
  artifactCache,
  artifactStorage,
  fsArtifactStore,
  s3ArtifactStore,
} from '@holtkeeper/artifacts'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import {
  type TokenRotator,
  createCredentialService,
  startRotationSchedule,
} from '@holtkeeper/credentials'
import { localRunner } from '@holtkeeper/exec'
import { miseCacheStorage } from '@holtkeeper/exec-container'
import { resolveSecret } from '@holtkeeper/forge'
import { gitlabTokenRotator } from '@holtkeeper/forge-gitlab'
import { knowledgeAccess } from '@holtkeeper/knowledge'
import { createLimiter, limitsCredentialsSetting } from '@holtkeeper/limits'
import {
  type DefaultSchedule,
  type DefaultTrigger,
  liveConfig,
  seedDefaults,
} from '@holtkeeper/managed-config'
import { mergeRequestPoliciesSetting } from '@holtkeeper/mr-policies'
import type { AnalysisKind } from '@holtkeeper/report'
import { createReviewAnalyzer } from '@holtkeeper/review'
import {
  type DefaultSetting,
  type SettingDefinition,
  builtinSettings,
  defaultSettings,
  seedDefaultSettings,
} from '@holtkeeper/settings'
import { resolveSetting } from '@holtkeeper/settings'
import { validateSshCredentialOptions } from '@holtkeeper/ssh-keys'
import type { Job } from '@holtkeeper/store'
import { createTrackerAnalyzer, trackersSetting } from '@holtkeeper/tracker'
import { defaultPolling, pollingSetting } from '@holtkeeper/updates'
import { aesVault } from '@holtkeeper/vault'
import { mirrorStorage } from '@holtkeeper/workspace'

import { autoAcceptFrom, settingsAgentFor } from './agent.ts'
import { builtinAnalyses } from './analyses.ts'
import { createApp } from './app.ts'
import { startAuditRetention } from './audit.ts'
import { type ServerDeps, repoTarget } from './context.ts'
import { documentSinksFor, documentSourcesFor, trackerDefinitionsFor } from './documents.ts'
import { validateEgressSecretOptions } from './egress-secrets.ts'
import { createEventDispatcher } from './events.ts'
import {
  type AgentFor,
  type AnyAnalyzer,
  analyzerSettings,
  executionSettings,
  startJobs,
} from './jobs.ts'
import { limiterOptionsFor } from './limiter-state.ts'
import { serverLimits } from './limits.ts'
import { startManagedConfig } from './managed.ts'
import type { MediaEngine } from './media/engine.ts'
import { createMediaReviewer } from './media/reviewer.ts'
import { startOperations } from './operations.ts'
import { type Role, roleDuties } from './roles.ts'
import { forgeGitKeys } from './ssh-keys.ts'
import { databaseStorage } from './storage.ts'
import { serverPoller } from './updates.ts'
import { serveWeb } from './web.ts'
import { startWebhookSync } from './webhook-sync.ts'

export interface ServerOptions {
  /** Extra token rotators besides GitLab's. */
  rotators?: TokenRotator[]
  /** Analysis kinds besides the built-in changelog, bundle and dependency analyses. */
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  analyses?: AnalysisKind<any>[]
  /** Extra settings, e.g. from plugins. */
  settings?: SettingDefinition[]
  /**
   * Values a fresh install starts with (no settings in the store yet), written once per store.
   * Default `defaultSettings` from `@holtkeeper/settings` plus `defaultPolling` from
   * `@holtkeeper/updates`; `false` seeds nothing.
   */
  defaultSettings?: readonly DefaultSetting[] | false
  /**
   * Schedules and triggers an install starts with, each written once per store as a panel
   * document (see `seedDefaults`). Default `defaultSchedules` and `defaultTriggers` from
   * `@holtkeeper/managed-config`; `false` seeds nothing.
   */
  defaultConfig?:
    | { schedules?: readonly DefaultSchedule[]; triggers?: readonly DefaultTrigger[] }
    | false
  /** Analyzers background jobs may run. Default: the registry from `@holtkeeper/analyzers`. */
  analyzers?: AnyAnalyzer[]
  /** The LLM agent for a repository. Default: the AI provider credential named by `llm.provider`. */
  agentFor?: AgentFor
  /** Artifact store instead of the one `server.artifacts` / `server.artifactsDir` describes. */
  artifacts?: ArtifactStore
  /** Image engine of the media routes. Default `@holtkeeper/media`. */
  media?: MediaEngine
  /**
   * Provider and model catalog of `ai-sdk` credentials. Default `modelsDevCatalog()`; the config's
   * `ai.providers` catalogs are added to it either way.
   */
  aiCatalog?: AiCatalog
  /**
   * More areas for the storage overview, e.g. `mirrorStorage(jobs.cacheDir)` from
   * `@holtkeeper/workspace` or `miseCacheStorage(...)` from `@holtkeeper/exec-container`.
   */
  storage?: StorageProvider[]
  /** Audit events older than this many days are removed daily. Default 365; `0` keeps them forever. */
  auditRetentionDays?: number
  /** What this process runs, see `Role`. Default `['all']`. */
  roles?: Role[]
  /** Worker overrides for this process: `concurrency`, `maxJobs` (exit after that many jobs). */
  worker?: { concurrency?: number; maxJobs?: number }
  /** On `stop`, running jobs get this long to finish before they are requeued. Default 30 s. */
  drainTimeoutMs?: number
  log?: (line: string) => void
}

export interface RunningServer {
  url: string
  /** Resolves once the worker ran `worker.maxJobs` jobs; pending otherwise. */
  exhausted: Promise<void>
  /** Drains (readiness fails, running jobs finish or are requeued), then closes everything. */
  stop(): Promise<void>
}

const defaultWebRoot = join(import.meta.dir, '../../web/dist')

type ServerConfig = NonNullable<HoltkeeperConfig['server']>

/** The artifact store a server config describes: `artifacts`, else `artifactsDir`, else `.holtkeeper/artifacts`. */
function artifactStoreFor(server: ServerConfig): ArtifactStore {
  const artifacts = server.artifacts
  if (artifacts?.kind === 's3') {
    return s3ArtifactStore({
      bucket: artifacts.bucket,
      accessKeyId: resolveSecret(artifacts.accessKeyId),
      secretAccessKey: resolveSecret(artifacts.secretAccessKey),
      ...(artifacts.sessionToken ? { sessionToken: resolveSecret(artifacts.sessionToken) } : {}),
      ...(artifacts.endpoint ? { endpoint: artifacts.endpoint } : {}),
      ...(artifacts.region ? { region: artifacts.region } : {}),
      ...(artifacts.prefix ? { prefix: artifacts.prefix } : {}),
      ...(artifacts.virtualHostedStyle ? { virtualHostedStyle: true } : {}),
    })
  }
  return fsArtifactStore({ dir: artifacts?.dir ?? server.artifactsDir ?? '.holtkeeper/artifacts' })
}

/** Applies `server.retention` every `intervalMs`; returns a stop function. */
export function startArtifactRetention(
  store: ArtifactStore,
  retention: ServerConfig['retention'],
  options: { intervalMs?: number; now?: () => Date; log?: (line: string) => void } = {},
): () => void {
  if (!retention?.days && !retention?.maxBytes) return () => {}
  const now = options.now ?? (() => new Date())
  const sweep = async () => {
    try {
      const result = await store.sweep({
        ...(retention.days
          ? { olderThan: new Date(now().getTime() - retention.days * 86_400_000) }
          : {}),
        ...(retention.maxBytes ? { maxBytes: retention.maxBytes } : {}),
      })
      if (result.removed)
        options.log?.(`artifacts: removed ${result.removed} (${result.bytes} bytes)`)
    } catch (error) {
      options.log?.(
        `artifacts: sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  void sweep()
  const timer = setInterval(() => void sweep(), options.intervalMs ?? 3_600_000)
  return () => clearInterval(timer)
}

/** Builds the dependencies from a config and starts listening. */
export async function startServer(
  fileConfig: HoltkeeperConfig,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const server = fileConfig.server
  if (!server) throw new Error('the config has no `server` section')
  const log = options.log ?? ((line: string) => console.log(line))
  const aiProviders = fileConfig.ai?.providers ?? []

  const vault = aesVault(server.vaultKey)
  const credentials = createCredentialService({
    credentials: server.store.credentials,
    activity: server.store.activity,
    vault,
    rotators: [gitlabTokenRotator(), ...(options.rotators ?? [])],
    validateOptions: (kind, values) =>
      validateSshCredentialOptions(kind, values) ??
      validateEgressSecretOptions(kind, values) ??
      aiProviderOptionsValidatorFor(aiProviders)(kind, values),
  })
  const duties = roleDuties(options.roles ?? ['all'])
  const limiterOptions = limiterOptionsFor(fileConfig, server.store)
  const limiter = createLimiter(limiterOptions)
  if (options.defaultConfig !== false) {
    const seeded = await seedDefaults({
      store: server.store,
      file: fileConfig,
      analyzers: (options.analyzers ?? builtinAnalyzers).map((analyzer) => analyzer.kind),
      ...options.defaultConfig,
    })
    if (seeded.length > 0) log(`config: seeded defaults ${seeded.join(', ')}`)
  }
  const managed = await startManagedConfig({
    file: fileConfig,
    store: server.store,
    vault,
    credentials,
    limiter,
    log,
  })
  // Everything below reads the effective config through this live view.
  const config = liveConfig(managed.source)
  const artifacts = options.artifacts ?? artifactStoreFor(server)
  const mediaCache = artifactCache(artifacts, {
    onError: (error) => log(`cache: ${error instanceof Error ? error.message : String(error)}`),
  })
  // The review analyzer needs server state: scoped review instructions and the knowledge base.
  const review = createReviewAnalyzer({
    checks: reviewChecks(),
    ...(config.jobs?.botUsername ? { botUsername: config.jobs.botUsername } : {}),
    mediaReviewer: createMediaReviewer({
      cache: mediaCache,
      ...(server.publicUrl ? { publicUrl: server.publicUrl } : {}),
    }),
    knowledge: {
      access: knowledgeAccess({
        store: server.store,
        now: () => new Date(),
        autoAccept: async (repo) => autoAcceptFrom(await server.store.settings.list(), repo),
      }),
      groupsOf: (repo) => repoTarget(config, repo).groups,
    },
    async instructionsFor(repo) {
      const entry = resolveSetting(
        await server.store.settings.list(),
        'review.instructions',
        repoTarget(config, repo),
      )
      return typeof entry?.value === 'string' ? entry.value : undefined
    },
  })
  const documentDeps = { config, store: server.store, vault }
  const documentSinks = documentSinksFor(documentDeps)
  const tracker = createTrackerAnalyzer({
    documentsFor: documentSourcesFor(documentDeps),
    sinksFor: documentSinks,
    definitionsFor: trackerDefinitionsFor(documentDeps),
    groupRepos: () => undefined,
  })
  const replacements: Record<string, AnyAnalyzer> = { review, tracker }
  const analyzers =
    options.analyzers ?? builtinAnalyzers.map((analyzer) => replacements[analyzer.kind] ?? analyzer)
  const aiCatalog = withPluginCatalogs(options.aiCatalog ?? modelsDevCatalog(), aiProviders, {
    onError: (error) =>
      log(`ai catalog: ${error instanceof Error ? error.message : String(error)}`),
  })
  const agentFor =
    options.agentFor ??
    settingsAgentFor({
      config,
      store: server.store,
      vault,
      rateLimiter: limiter,
      aiCatalog,
      aiProviders,
    })
  const deps: ServerDeps = {
    config,
    auth: server.auth,
    store: server.store,
    vault,
    configSource: managed.source,
    readOnly: managed.readOnly,
    limiter,
    credentials,
    settings: [
      ...builtinSettings,
      mergeRequestPoliciesSetting,
      limitsCredentialsSetting,
      pollingSetting,
      trackersSetting,
      ...analyzerSettings(analyzers),
      ...executionSettings(),
      ...(options.settings ?? []),
    ],
    analyses: [...builtinAnalyses, ...(options.analyses ?? [])],
    analyzers,
    documentSinks,
    artifacts,
    aiCatalog,
    aiProviders,
    ...(options.media ? { media: options.media } : {}),
    storage: [
      artifactStorage(artifacts),
      databaseStorage(server.databasePath),
      ...(config.jobs
        ? [
            mirrorStorage(config.jobs.cacheDir),
            miseCacheStorage(
              config.jobs.execution?.mode === 'container'
                ? {
                    mode: 'container',
                    ...(config.jobs.execution.engine
                      ? { engine: config.jobs.execution.engine }
                      : {}),
                    hostRunner: localRunner,
                  }
                : { mode: 'host' },
            ),
          ]
        : []),
      ...(options.storage ?? []),
    ],
    now: () => new Date(),
  }

  if (options.defaultSettings !== false) {
    const seeded = await seedDefaultSettings({
      store: server.store,
      definitions: deps.settings,
      defaults: options.defaultSettings ?? [...defaultSettings, defaultPolling],
      now: deps.now,
    })
    if (seeded.length > 0) log(`settings: seeded defaults for ${seeded.join(', ')}`)
  }

  const app = createApp(deps)
  if (duties.http === 'api') {
    const webRoot = server.webRoot ?? defaultWebRoot
    if (!(await serveWeb(app, webRoot))) log(`web UI not built (${webRoot}); serving the API only`)
    for (const line of (await server.auth.start?.()) ?? []) log(line)
  }
  const { admission } = serverLimits({
    limiter,
    config,
    store: server.store,
    forgeCredential: (forgeId) => managed.source.effective().forges[forgeId]?.credentialId,
    needsAgent: (kind) =>
      analyzers.find((analyzer) => analyzer.kind === kind)?.needs.agent !== undefined,
  })
  let metrics: { observeJob(job: Job): void } | undefined
  const jobs = await startJobs({
    config,
    store: server.store,
    analyzers,
    agentFor,
    gitKeyFor: forgeGitKeys({ store: server.store, credentials }),
    readOnly: managed.readOnly,
    admission,
    artifacts,
    now: deps.now,
    run: { worker: duties.worker, scheduler: false },
    ...(options.worker && { worker: options.worker }),
    onFinished: (job) => metrics?.observeJob(job),
    log,
  })

  const ops = startOperations({
    duties,
    store: server.store,
    artifacts,
    limiter,
    log,
    leaderDuties: [
      () =>
        server.rotationIntervalMinutes > 0
          ? startRotationSchedule(deps.credentials, {
              intervalMs: server.rotationIntervalMinutes * 60_000,
            })
          : () => {},
      () => startArtifactRetention(artifacts, server.retention, { log }),
      () =>
        startAuditRetention(server.store, {
          retentionDays: options.auditRetentionDays ?? 365,
          log,
        }),
      () => {
        jobs?.scheduler.start()
        return () => jobs?.scheduler.stop()
      },
      () => serverPoller(deps, createEventDispatcher(deps), log)?.start() ?? (() => {}),
      () => startWebhookSync(deps, log),
    ],
  })
  metrics = ops.metrics

  const listener = Bun.serve({
    hostname: server.hostname,
    port: server.port,
    fetch: ops.fetch(duties.http === 'api' ? app.fetch : undefined),
  })
  const url = `http://${listener.hostname}:${listener.port}`
  const roles = (options.roles ?? ['all']).join(',')
  log(`holtkeeper ${roles} listening on ${url} (auth: ${server.auth.name})`)

  return {
    url,
    exhausted: duties.worker && jobs ? jobs.worker.exhausted : new Promise<void>(() => {}),
    async stop() {
      ops.startDraining()
      if (duties.worker && jobs) {
        const drained = await jobs.worker.drain(options.drainTimeoutMs ?? 30_000)
        log(`drained: ${drained.finished} job(s) finished, ${drained.requeued} requeued`)
      }
      await ops.stop()
      managed.stop()
      await listener.stop()
      await jobs?.stop()
      limiterOptions.state?.close()
      await server.store.close()
    },
  }
}
