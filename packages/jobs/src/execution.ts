import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { CommandRunner } from '@holtkeeper/exec'
import {
  type ManagedRunner,
  type Mount,
  containerRunner,
  localMiseRunner,
  networksFor,
} from '@holtkeeper/exec-container'
import type { RepoRef } from '@holtkeeper/forge'
import {
  type EffectiveToolchain,
  type Toolchain,
  type ToolchainOverride,
  detectToolchain,
  mergeToolchain,
  miseToolSpecs,
} from '@holtkeeper/toolchain'

/** `config.jobs.execution`. */
export type ExecutionConfig = NonNullable<NonNullable<HoltkeeperConfig['jobs']>['execution']>

/** The scoped `toolchain` setting for a repository; `undefined` when none applies. */
export type ToolchainFor = (
  repo: RepoRef,
) => ToolchainOverride | undefined | Promise<ToolchainOverride | undefined>

/** Everything needed to build the runner of one checkout. */
export interface RunnerSpec {
  mode: 'mise' | 'container'
  execution: ExecutionConfig
  /** Detected on the checkout, with the scoped override applied. */
  toolchain: EffectiveToolchain
  /** The checkout commands run in. */
  dir: string
  /** Other checkouts the commands may read, mounted read-only. */
  extraMounts: Mount[]
  /** Runs `mise` or the container engine on the host. */
  hostRunner: CommandRunner
  log: (line: string) => void
}

/** Builds a runner for a checkout; replaceable in tests. */
export type CreateRunner = (spec: RunnerSpec) => ManagedRunner

/** Image used in `container` mode when neither config nor setting names one. */
export const defaultWorkerImage = 'holtkeeper-worker:latest'

/** The default `CreateRunner`: `localMiseRunner` for `mise`, `containerRunner` for `container`. */
export const createRunner: CreateRunner = (spec) => {
  const { execution, toolchain, hostRunner, log } = spec
  if (spec.mode === 'mise')
    return localMiseRunner({
      toolchain,
      hostRunner,
      env: toolchain.env,
      ...(execution.envAllowlist && { envAllowlist: execution.envAllowlist }),
      ignoreConfigIn: [spec.dir, ...spec.extraMounts.map((mount) => mount.hostDir)],
    })
  return containerRunner({
    ...(execution.engine && { engine: execution.engine }),
    image: toolchain.image ?? execution.image ?? defaultWorkerImage,
    workspace: { hostDir: spec.dir },
    extraMounts: spec.extraMounts,
    toolchain,
    ...(execution.limits && { limits: execution.limits }),
    ...networksFor(toolchain.network ?? execution.network ?? 'install'),
    ...(execution.user && { user: execution.user }),
    env: toolchain.env,
    ...(execution.envAllowlist && { envAllowlist: execution.envAllowlist }),
    hostRunner,
    log,
  })
}

/** One checkout to build a runner for. */
export interface RunnerRequest {
  repo: RepoRef
  dir: string
  /** Read-only extra checkouts, mounted at `/checkouts/<n>`. */
  extraDirs?: readonly string[]
  log: (line: string) => void
}

export interface RunnerFactoryOptions {
  execution: ExecutionConfig | undefined
  hostRunner: CommandRunner
  toolchainFor?: ToolchainFor
  createRunner?: CreateRunner
  /** Default: `detectToolchain` from `@holtkeeper/toolchain`. */
  detect?: (dir: string) => Promise<Toolchain>
}

/**
 * Builds a not yet started runner per checkout: detects its toolchain, applies the repository's
 * `toolchain` setting and logs the result. `undefined` in `host` mode (the default), where callers
 * keep using the host runner exactly as before.
 */
export function runnerFactory(
  options: RunnerFactoryOptions,
): ((request: RunnerRequest) => Promise<ManagedRunner>) | undefined {
  const { execution, hostRunner } = options
  if (!execution || execution.mode === 'host') return undefined
  const mode = execution.mode
  const create = options.createRunner ?? createRunner
  const detect = options.detect ?? ((dir: string) => detectToolchain(dir))
  return async ({ repo, dir, extraDirs = [], log }) => {
    const override = await options.toolchainFor?.(repo)
    const toolchain = mergeToolchain(await detect(dir), override)
    const tools = miseToolSpecs(toolchain)
    log(`toolchain (${mode}): ${tools.length ? tools.join(' ') : 'no tools'}`)
    for (const note of toolchain.notes) log(`toolchain: ${note}`)
    return create({
      mode,
      execution,
      toolchain,
      dir,
      extraMounts: extraDirs.map((hostDir, index) => ({
        hostDir,
        containerDir: `/checkouts/${index}`,
        readOnly: true,
      })),
      hostRunner,
      log,
    })
  }
}

/** Starts `runner` on its first `run`; `stop` does nothing when it never started. */
export function startOnFirstRun(runner: ManagedRunner): ManagedRunner {
  let starting: Promise<void> | undefined
  return {
    start() {
      starting ??= runner.start()
      return starting
    },
    async run(command, options) {
      starting ??= runner.start()
      await starting
      return runner.run(command, options)
    },
    async stop() {
      if (!starting) return
      await starting.catch(() => {})
      await runner.stop()
    },
  }
}
