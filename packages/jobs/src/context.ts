import type { AnalyzerContext, AnyAnalyzer } from '@holtkeeper/analyzer'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import { type CommandRunner, localRunner } from '@holtkeeper/exec'
import type { ManagedRunner } from '@holtkeeper/exec-container'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import type { AnalysisStore, AuditRunStore, Job } from '@holtkeeper/store'
import type { Toolchain } from '@holtkeeper/toolchain'
import {
  type Checkout,
  type CheckoutOptions,
  type GitCredentials,
  checkout,
} from '@holtkeeper/workspace'

import {
  type CreateRunner,
  type ToolchainFor,
  runnerFactory,
  startOnFirstRun,
} from './execution.ts'
import { type ResolveRepos, groupRepositories } from './repos.ts'

/** The LLM agent type analyzers receive. */
export type JobAgent = NonNullable<AnalyzerContext<unknown>['agent']>

/** Picks the agent for a repository; `undefined` when none is configured for it. */
/** What the agent factory learns about the job, for usage records and the agent's command runner. */
interface AgentJobInfo {
  jobId: string
  analyzer: string
  actor?: string
  /** Runs commands the way the job does (host, mise or container). */
  runner: CommandRunner
}

export type AgentFor = (
  repo: RepoRef,
  job?: AgentJobInfo,
) => JobAgent | undefined | Promise<JobAgent | undefined>

/** An analyzer context without options, plus whatever must be released after the run. */
export interface PreparedContext {
  context: Omit<AnalyzerContext<unknown>, 'options' | 'signal' | 'log'>
  cleanup(): Promise<void>
}

/**
 * Builds exactly what an analyzer's `needs` ask for, for one job, plus the extra checkouts its
 * `requiredCheckouts` names for the validated `options`.
 */
export type ContextFor = (
  job: Job,
  analyzer: AnyAnalyzer,
  io: { signal: AbortSignal; log: (line: string) => void; options: unknown },
) => Promise<PreparedContext>

export interface ContextFactoryOptions {
  config: HoltkeeperConfig
  store: { analyses: AnalysisStore; auditRuns: AuditRunStore }
  /** Mirror cache for checkouts. */
  cacheDir: string
  /** Default: `localRunner`. */
  runner?: CommandRunner
  agentFor?: AgentFor
  /** Repositories of a group, for group analyzers. Default: `groupRepositories(config)`. */
  resolveRepos?: ResolveRepos
  /** Default: `checkout` from `@holtkeeper/workspace`. */
  checkout?: (options: CheckoutOptions) => Promise<Checkout>
  /** Parent directory of checkouts. Default: the OS temp directory. */
  workDir?: string
  /** The scoped `toolchain` setting per repository, applied over the detected toolchain. */
  toolchainFor?: ToolchainFor
  /** Builds the `mise` / `container` runner of a checkout. Default: `createRunner`. */
  createRunner?: CreateRunner
  /** Default: `detectToolchain` from `@holtkeeper/toolchain`. */
  detectToolchain?: (dir: string) => Promise<Toolchain>
}

/** `ForgeDefinition.gitCredentials?()`, read structurally so older forge definitions still work. */
function gitCredentialsOf(definition: object): GitCredentials | undefined {
  const read: unknown = Reflect.get(definition, 'gitCredentials')
  if (typeof read !== 'function') return undefined
  const value: unknown = read.call(definition)
  if (typeof value !== 'object' || value === null) return undefined
  const username: unknown = Reflect.get(value, 'username')
  const password: unknown = Reflect.get(value, 'password')
  return typeof username === 'string' && typeof password === 'string'
    ? { username, password }
    : undefined
}

/** Parses `forge:path`; a `RepoRef` is returned as is. */
export function toRepoRef(repo: RepoRef | string): RepoRef {
  if (typeof repo !== 'string') return repo
  const separator = repo.indexOf(':')
  if (separator < 1 || separator === repo.length - 1)
    throw new Error(`expected forge:path, got "${repo}"`)
  return { forge: repo.slice(0, separator), path: repo.slice(separator + 1) }
}

/**
 * The default `ContextFor`: a checkout of the job's ref (the default branch when it has none) for
 * analyzers that need one, `context.checkout` for checking out other repositories on demand (every
 * checkout is a private worktree, so read-only and writable ones are made the same way), the
 * repository's forge client, the agent from `agentFor`, the store as history, and for group
 * analyzers the group's repositories.
 *
 * With `config.jobs.execution.mode` `mise` or `container`, `context.runner` runs commands with the
 * checkout's detected toolchain (and, for `container`, in a sandbox started before the analyzer
 * and stopped in `cleanup`); every on-demand checkout gets its own such `runner`, started on its
 * first command. Git itself always runs on the host runner. In `host` mode (the default) every
 * runner is the host runner.
 */
export function createContextFactory(factory: ContextFactoryOptions): ContextFor {
  const { config, store, cacheDir } = factory
  const runner = factory.runner ?? localRunner
  const resolveRepos = factory.resolveRepos ?? groupRepositories(config)
  const checkoutRepo = factory.checkout ?? checkout
  const sandboxFor = runnerFactory({
    execution: config.jobs?.execution,
    hostRunner: runner,
    ...(factory.toolchainFor && { toolchainFor: factory.toolchainFor }),
    ...(factory.createRunner && { createRunner: factory.createRunner }),
    ...(factory.detectToolchain && { detect: factory.detectToolchain }),
  })

  const forges = new Map<string, GitForge>()
  const definitionOf = (forgeId: string) => {
    const definition = config.forges[forgeId]
    if (!definition) throw new Error(`forge ${forgeId} is not configured`)
    return definition
  }
  const clientOf = (forgeId: string) => {
    let client = forges.get(forgeId)
    if (!client) {
      client = definitionOf(forgeId).create()
      forges.set(forgeId, client)
    }
    return client
  }

  return async (job, analyzer, { signal, log, options }) => {
    definitionOf(job.repo.forge)
    const forgeClient = () => clientOf(job.repo.forge)
    const checkouts = new Set<Checkout>()
    const runners = new Set<ManagedRunner>()
    const checkoutOf = async (repo: RepoRef, ref: string | undefined) => {
      const repository = await clientOf(repo.forge).getRepository(repo.path)
      const credentials = gitCredentialsOf(definitionOf(repo.forge))
      const result = await checkoutRepo({
        cloneUrl: repository.cloneUrl,
        ref: ref ?? repository.defaultBranch,
        ...(credentials && { credentials }),
        cacheDir,
        runner,
        signal,
        log,
        ...(factory.workDir !== undefined && { workDir: factory.workDir }),
      })
      const tracked: Checkout = {
        ...result,
        async cleanup() {
          checkouts.delete(tracked)
          await result.cleanup()
        },
      }
      checkouts.add(tracked)
      return tracked
    }

    const onDemand = async (repo: RepoRef, ref: string | undefined) => {
      const result = await checkoutOf(repo, ref)
      if (!sandboxFor) return { ...result, runner }
      let sandbox: ManagedRunner
      try {
        sandbox = startOnFirstRun(await sandboxFor({ repo, dir: result.dir, log }))
      } catch (error) {
        await result.cleanup()
        throw error
      }
      runners.add(sandbox)
      return {
        ...result,
        runner: sandbox,
        async cleanup() {
          runners.delete(sandbox)
          await sandbox.stop().catch(() => {})
          await result.cleanup()
        },
      }
    }

    const context: PreparedContext['context'] = {
      repo: job.repo,
      runner,
      checkout: (repo, { ref } = {}) => onDemand(repo, ref),
      ...(job.ref !== undefined && { ref: job.ref }),
    }
    const cleanup = async () => {
      await Promise.allSettled([...runners].map((r) => r.stop()))
      runners.clear()
      await Promise.allSettled([...checkouts].map((c) => c.cleanup()))
    }

    try {
      if (analyzer.needs.forge) context.forge = forgeClient()
      if (analyzer.needs.history)
        context.history = { analyses: store.analyses, auditRuns: store.auditRuns }
      if (analyzer.needs.agent) {
        const agent = await factory.agentFor?.(job.repo, {
          jobId: job.id,
          analyzer: job.analyzer,
          ...(job.actor ? { actor: job.actor } : {}),
          // The job's runner is prepared with the checkout below; resolve it when the agent runs a command.
          runner: { run: (command, runOptions) => context.runner.run(command, runOptions) },
        })
        if (agent) context.agent = agent
        else if (analyzer.needs.agent === 'required')
          throw new Error(`analyzer ${analyzer.kind} needs an agent, but none is configured`)
      }

      if (analyzer.scope === 'group') {
        context.repos = await resolveRepos(job.group ?? job.repo.path)
        log(`group ${job.group ?? job.repo.path}: ${context.repos.length} repositories`)
      } else if (analyzer.needs.checkout) {
        context.dir = (await checkoutOf(job.repo, job.ref)).dir
      }

      const extra = analyzer.requiredCheckouts?.(options, job.repo) ?? []
      if (extra.length) {
        context.checkouts = {}
        for (const { repo, ref } of extra) {
          const target = toRepoRef(repo)
          const key = `${target.forge}:${target.path}`
          if (key in context.checkouts) continue
          context.checkouts[key] = (await checkoutOf(target, ref)).dir
        }
      }

      if (sandboxFor && context.dir !== undefined) {
        const sandbox = await sandboxFor({
          repo: job.repo,
          dir: context.dir,
          extraDirs: Object.values(context.checkouts ?? {}),
          log,
        })
        runners.add(sandbox)
        await sandbox.start()
        context.runner = sandbox
      }
      if (signal.aborted) throw signal.reason
    } catch (error) {
      await cleanup()
      throw error
    }
    return { context, cleanup }
  }
}
