import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Principal } from '@holtkeeper/access'
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
import { assetsPolicySetting } from '@holtkeeper/assets'
import { commitConventionsSetting } from '@holtkeeper/commit-conventions'
import type { HoltkeeperFileConfig } from '@holtkeeper/core'
import {
  type TokenRotator,
  createCredentialService,
  startRotationSchedule,
} from '@holtkeeper/credentials'
import { localRunner } from '@holtkeeper/exec'
import { egressEnvironment, miseCacheStorage } from '@holtkeeper/exec-container'
import { resolveSecret } from '@holtkeeper/forge'
import { gitlabTokenRotator } from '@holtkeeper/forge-gitlab'
import { createGuideResolver, testIdOverridesFor, testIdsSettingKey } from '@holtkeeper/guide'
import { createGuideAnalyzer } from '@holtkeeper/guide-generator'
import { validateJiraCredentialOptions } from '@holtkeeper/issues-jira'
import { knowledgeAccess } from '@holtkeeper/knowledge'
import { createLimiter, limitsCredentialsSetting } from '@holtkeeper/limits'
import {
  type DefaultTrigger,
  liveConfig,
  retireSeededSchedules,
  seedDefaults,
} from '@holtkeeper/managed-config'
import { mergeRequestPoliciesSetting } from '@holtkeeper/mr-policies'
import { createPropagateAnalyzer } from '@holtkeeper/propagate'
import { releaseNotifyDefinition, releaseSettingsDefinition } from '@holtkeeper/release'
import type { AnalysisKind } from '@holtkeeper/report'
import { createReviewAnalyzer } from '@holtkeeper/review'
import {
  type DefaultSetting,
  type SettingDefinition,
  builtinSettings,
  defaultSettings,
  seedDefaultSettings,
} from '@holtkeeper/settings'
import { validateSshCredentialOptions } from '@holtkeeper/ssh-keys'
import type { Job } from '@holtkeeper/store'
import { createTrackerAnalyzer, trackersSetting } from '@holtkeeper/tracker'
import { defaultPolling, pollingSetting } from '@holtkeeper/updates'
import { aesVault } from '@holtkeeper/vault'
import { mirrorStorage } from '@holtkeeper/workspace'
import { WRITE_POOL, createWriteTaskAnalyzer } from '@holtkeeper/write-task'

import { autoAcceptFrom, settingsAgentFor } from './agent.ts'
import { builtinAnalyses } from './analyses.ts'
import { createApp } from './app.ts'
import { assetsPolicyFor } from './assets.ts'
import { verifyAuditChainIfDue } from './audit-verify.ts'
import { startAuditRetention } from './audit.ts'
import { type ServerDeps, forgeFor, repoTarget } from './context.ts'
import { startDatabaseSnapshots } from './database.ts'
import { documentSinksFor, documentSourcesFor, trackerDefinitionsFor } from './documents.ts'
import { validateEgressSecretOptions } from './egress-secrets.ts'
import { createEventDispatcher } from './events.ts'
import { freshnessSetting, freshnessSweepSetting, startFreshness } from './freshness.ts'
import { retiredReadOnlyCheck } from './health.ts'
import {
  type AgentFor,
  type AnyAnalyzer,
  analyzerSettings,
  executionSettings,
  startJobs,
} from './jobs.ts'
import { periodicDuty } from './leader.ts'
import { librariesSetting, noteLibraryUses, startLibraryIndex } from './libraries.ts'
import { limiterOptionsFor } from './limiter-state.ts'
import { serverLimits } from './limits.ts'
import { startManagedConfig } from './managed.ts'
import type { MediaEngine } from './media/engine.ts'
import { createMediaReviewer } from './media/reviewer.ts'
import { startOperations } from './operations.ts'
import { agentOpsAccess } from './ops-tools.ts'
import { agentReleaseAccess } from './release-steps.ts'
import { releaseServiceFor } from './releases.ts'
import { repoTestsFor, testsExpectedFor } from './repo-tests.ts'
import { guideScopesOf } from './reviews.ts'
import { type Role, roleDuties } from './roles.ts'
import { forgeGitKeys } from './ssh-keys.ts'
import { startStorageReports } from './storage-reports.ts'
import { databaseStorage, recordStorageSnapshot, storageOverview } from './storage.ts'
import {
  proposePropagateFixes,
  relatedRepos,
  requestRepository,
  taskJobFinished,
  taskStarted,
} from './tasks.ts'
import { type SupplyToolsAccess, supplyToolsAccess } from './tools/repos.ts'
import { commitConventionsReader } from './tools/rules.ts'
import { serverPoller } from './updates.ts'
import { serveWeb } from './web.ts'
import { startWebhookSync } from './webhook-sync.ts'
import { writeTaskPolicy } from './write-tasks.ts'

export interface ServerOptions {
  /** Extra token rotators besides GitLab's. */
  rotators?: TokenRotator[]
  /** Analysis kinds besides those of the built-in analyzers. */
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
   * Triggers an install starts with, each written once per store as a panel document (see
   * `seedDefaults`). Default `defaultTriggers` from `@holtkeeper/managed-config`; `false` seeds
   * nothing.
   */
  defaultConfig?: { triggers?: readonly DefaultTrigger[] } | false
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
  /**
   * Worker overrides for this process: `concurrency`, `claimDelayMs` (take only jobs queued that
   * long), `maxJobs` (exit after that many jobs), `pools` (the worker pools it serves, default
   * `['default']`).
   */
  worker?: { concurrency?: number; claimDelayMs?: number; maxJobs?: number; pools?: string[] }
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

type ServerConfig = NonNullable<HoltkeeperFileConfig['server']>

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

/**
 * Builds the dependencies from a config file and the panel documents in its store, and starts
 * listening.
 */
export async function startServer(
  fileConfig: HoltkeeperFileConfig,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const server = fileConfig.server
  if (!server) throw new Error('the config has no `server` section')
  const log = options.log ?? ((line: string) => console.log(line))
  const aiProviders = fileConfig.ai?.providers ?? []

  const vault = aesVault(server.vaultKey)
  const credentials = createCredentialService({
    credentials: server.store.credentials,
    audit: server.store.audit,
    vault,
    rotators: [gitlabTokenRotator(), ...(options.rotators ?? [])],
    validateOptions: (kind, values) =>
      validateSshCredentialOptions(kind, values) ??
      validateEgressSecretOptions(kind, values) ??
      validateJiraCredentialOptions(kind, values) ??
      aiProviderOptionsValidatorFor(aiProviders)(kind, values),
  })
  const duties = roleDuties(options.roles ?? ['all'])
  const limiterOptions = limiterOptionsFor(fileConfig, server.store)
  const limiter = createLimiter(limiterOptions)
  const retired = await retireSeededSchedules({ store: server.store })
  if (retired.length > 0) log(`config: removed seeded schedules ${retired.join(', ')}`)
  if (options.defaultConfig !== false) {
    const seeded = await seedDefaults({
      store: server.store,
      analyzers: (options.analyzers ?? builtinAnalyzers).map((analyzer) => analyzer.kind),
      ...options.defaultConfig,
    })
    if (seeded.length > 0) log(`config: seeded defaults ${seeded.join(', ')}`)
  }
  const leftoverReadOnly = await retiredReadOnlyCheck(server.store).catch(() => undefined)
  if (leftoverReadOnly) log(`warning: ${leftoverReadOnly.detail}`)
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
  const executionMode = config.jobs.execution?.mode ?? 'host'
  if (duties.worker && options.worker?.pools?.includes(WRITE_POOL) && executionMode === 'host') {
    managed.stop()
    throw new Error(
      'the write pool runs repository scripts: set jobs.execution.mode to mise or container',
    )
  }
  const artifacts = options.artifacts ?? artifactStoreFor(server)
  const mediaCache = artifactCache(artifacts, {
    onError: (error) => log(`cache: ${error instanceof Error ? error.message : String(error)}`),
  })
  // The review analyzer needs server state: the Guide and the knowledge base.
  const resolveGuide = createGuideResolver({ store: server.store })
  const testsOf = repoTestsFor(server.store, () => config)
  const testsExpected = testsExpectedFor(server.store, () => config)
  const review = createReviewAnalyzer({
    checks: reviewChecks(),
    checksFor: async (repo) =>
      reviewChecks({
        testids: testIdOverridesFor(
          await server.store.settings.list(testIdsSettingKey),
          repoTarget(config, repo),
        ),
      }),
    testsExpected,
    botUsername: (repo) => config.jobs.botUsernames?.[repo.forge],
    mediaReviewer: createMediaReviewer({
      cache: mediaCache,
      policyFor: async (repo) =>
        (await assetsPolicyFor(server.store, repoTarget(config, repo))).policy,
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
    async guideFor(repo, { docs, query }) {
      const resolved = await resolveGuide({
        repo: repoTarget(config, repo),
        task: 'review',
        repoDocs: docs,
        ...(query && { query }),
      })
      return resolved.text ? { text: resolved.text, scopes: guideScopesOf(resolved) } : undefined
    },
  })
  const documentDeps = { config, store: server.store, credentials }
  const documentSinks = documentSinksFor(documentDeps)
  const tracker = createTrackerAnalyzer({
    documentsFor: documentSourcesFor(documentDeps),
    sinksFor: documentSinks,
    definitionsFor: trackerDefinitionsFor(documentDeps),
    groupRepos: () => undefined,
  })
  const guide = createGuideAnalyzer({
    store: server.store,
    groupsOf: (repo) => repoTarget(config, repo).groups,
    testsExpected,
  })
  const conventionsOf = commitConventionsReader({
    forgeOf: (forge) => forgeFor(config, forge),
    settings: server.store.settings,
    now: () => new Date(),
  })
  const taskDeps = { store: server.store, config, now: () => new Date() }
  const writeTask = createWriteTaskAnalyzer({
    policy: writeTaskPolicy({
      store: server.store,
      readOnly: managed.readOnly,
      tests: testsOf,
      dryRun: () => config.dryRun,
      executionMode: () => config.jobs.execution?.mode,
      now: () => new Date(),
    }),
    conventions: (repo) => conventionsOf(repoTarget(config, repo)),
    env: () => {
      const egress = config.jobs.execution?.egress
      return egress ? egressEnvironment(egress).env : undefined
    },
    onStart: (repo, task, jobId) => taskStarted(taskDeps, repo, task, jobId),
    links: {
      related: (repo, task) => relatedRepos(taskDeps, repo, task),
      requestRepository: (request) => requestRepository(taskDeps, request),
    },
  })
  const propagate = createPropagateAnalyzer({
    fixes: { propose: (input) => proposePropagateFixes(taskDeps, input) },
    testsExpected,
  })
  const replacements: Record<string, AnyAnalyzer> = {
    review,
    propagate,
    tracker,
    guide,
    'write-task': writeTask,
  }
  const analyzers =
    options.analyzers ?? builtinAnalyzers.map((analyzer) => replacements[analyzer.kind] ?? analyzer)
  const aiCatalog = withPluginCatalogs(options.aiCatalog ?? modelsDevCatalog(), aiProviders, {
    onError: (error) =>
      log(`ai catalog: ${error instanceof Error ? error.message : String(error)}`),
  })
  let supplyFor: ((principal: Principal) => SupplyToolsAccess) | undefined
  const settingsAgent = options.agentFor
    ? undefined
    : settingsAgentFor({
        config,
        store: server.store,
        vault,
        credentials,
        rateLimiter: limiter,
        aiCatalog,
        aiProviders,
        artifacts,
        releases: (target, requester) => agentReleaseAccess(deps, target, requester),
        ops: (target, requester) =>
          agentOpsAccess(deps, target, requester, () =>
            releaseServiceFor(deps).snapshot(requester),
          ),
        supply: (requester) => (supplyFor ??= supplyToolsAccess(deps))(requester),
      })
  const agentFor: AgentFor = options.agentFor ?? settingsAgent ?? (() => undefined)
  // Areas on the disks of the process that runs jobs; web processes see them through reports.
  const workerStorage = duties.worker
    ? [
        mirrorStorage(config.jobs.cacheDir),
        miseCacheStorage(
          config.jobs.execution?.mode === 'container'
            ? {
                mode: 'container',
                ...(config.jobs.execution.engine ? { engine: config.jobs.execution.engine } : {}),
                hostRunner: localRunner,
              }
            : { mode: 'host' },
        ),
      ]
    : []
  const deps: ServerDeps = {
    supply: (principal) => (supplyFor ??= supplyToolsAccess(deps))(principal),
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
      releaseSettingsDefinition,
      releaseNotifyDefinition,
      commitConventionsSetting,
      assetsPolicySetting,
      librariesSetting,
      freshnessSetting,
      freshnessSweepSetting,
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
    agentFor: async (repo) =>
      settingsAgent ? settingsAgent(repo, { interactive: true }) : agentFor(repo),
    chatAgentFor: async (target, run) =>
      settingsAgent ? settingsAgent(target, run) : agentFor(target),
    automaticAgentFor: async (repo) =>
      settingsAgent
        ? settingsAgent(repo, { interactive: false, actor: 'agent:learning' })
        : agentFor(repo),
    ...(options.media ? { media: options.media } : {}),
    storage: [
      artifactStorage(artifacts),
      databaseStorage(server.databasePath, server.store.database),
      ...workerStorage,
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
    onFinished: async (job, record) => {
      metrics?.observeJob(job)
      if (record) await noteLibraryUses(server.store.kv, record.kind, deps.now())
      await taskJobFinished(taskDeps, job, record)
    },
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
        jobs.scheduler.start()
        return () => jobs.scheduler.stop()
      },
      () => serverPoller(deps, createEventDispatcher(deps), log)?.start() ?? (() => {}),
      () => startFreshness(deps, log) ?? (() => {}),
      () => startWebhookSync(deps, log),
      () => startLibraryIndex(deps, log),
      () => startDatabaseSnapshots(server.store, { log }),
      periodicDuty(
        'storage snapshot',
        async () => {
          const { kv } = server.store
          if (!kv) return
          const overview = await storageOverview({
            providers: deps.storage ?? [],
            kv,
            now: deps.now(),
          })
          await recordStorageSnapshot(kv, overview, deps.now())
        },
        { intervalMs: 6 * 3_600_000, log },
      ),
      periodicDuty('audit chain check', () => verifyAuditChainIfDue(server.store, deps.now()), {
        intervalMs: 3_600_000,
        log,
      }),
      () => releaseServiceFor(deps).startBoardRefresh(),
    ],
  })
  metrics = ops.metrics
  const stopStorageReports =
    workerStorage.length && server.store.kv
      ? startStorageReports({
          kv: server.store.kv,
          providers: workerStorage,
          directories: {
            'git-mirrors': config.jobs.cacheDir,
            ...(config.jobs.execution?.mode !== 'container'
              ? { 'mise-cache': Bun.env.MISE_DATA_DIR ?? join(homedir(), '.local/share/mise') }
              : {}),
          },
          log,
        })
      : undefined

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
    exhausted: duties.worker ? jobs.worker.exhausted : new Promise<void>(() => {}),
    async stop() {
      ops.startDraining()
      if (duties.worker) {
        const drained = await jobs.worker.drain(options.drainTimeoutMs ?? 30_000)
        log(`drained: ${drained.finished} job(s) finished, ${drained.requeued} requeued`)
      }
      await ops.stop()
      await stopStorageReports?.()
      managed.stop()
      await listener.stop()
      await jobs.stop()
      limiterOptions.state?.close()
      await server.store.close()
    },
  }
}
