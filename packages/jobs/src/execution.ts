import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { CommandRunner } from '@holtkeeper/exec'
import {
  type ManagedRunner,
  type Mount,
  containerRunner,
  egressEnvironment,
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
  /** From `RunnerFactoryOptions.egressEnv`; applied only with `execution.egress`. */
  egressEnv?: Record<string, string>
  /** From `RunnerFactoryOptions.jobEnv`; applied with or without `execution.egress`. */
  jobEnv?: Record<string, string>
}

/** Builds a runner for a checkout; replaceable in tests. */
export type CreateRunner = (spec: RunnerSpec) => ManagedRunner

/** Image used in `container` mode when neither config nor setting names one. */
export const defaultWorkerImage = 'holtkeeper-worker:latest'

const egressDir = '/etc/holtkeeper/egress'

/**
 * Go variables every job command gets behind an egress proxy: no toolchain download. `GOFLAGS`
 * stays unset because Go refuses `-mod=mod` in `go.work` checkouts; callers that run per module
 * set it themselves.
 */
const egressGoEnv: Readonly<Record<string, string>> = {
  GOTOOLCHAIN: 'local',
}

/**
 * The default `CreateRunner`: `localMiseRunner` for `mise`, `containerRunner` for `container`.
 * With `execution.egress`, commands get the proxy variables, `egressGoEnv` and `spec.egressEnv`;
 * `spec.jobEnv` comes on top in every mode, and the toolchain setting's `env` above all.
 */
export const createRunner: CreateRunner = (spec) => {
  const { execution, toolchain, hostRunner, log } = spec
  const egress = execution.egress
    ? egressEnvironment(
        execution.egress,
        spec.mode === 'container' ? { containerDir: egressDir } : {},
      )
    : undefined
  if (execution.egress) log(`egress proxy: ${new URL(execution.egress.url).host}`)
  const env = {
    ...egress?.env,
    ...(egress && { ...egressGoEnv, ...spec.egressEnv }),
    ...spec.jobEnv,
    ...toolchain.env,
  }
  if (env.GOPRIVATE && (egress || spec.jobEnv?.GOPRIVATE))
    log(`${egress ? 'egress: ' : ''}GOPRIVATE=${env.GOPRIVATE}`)
  if (spec.mode === 'mise')
    return localMiseRunner({
      toolchain,
      hostRunner,
      env,
      ...(execution.envAllowlist && { envAllowlist: execution.envAllowlist }),
      ignoreConfigIn: [spec.dir, ...spec.extraMounts.map((mount) => mount.hostDir)],
    })
  return containerRunner({
    ...(execution.engine && { engine: execution.engine }),
    image: toolchain.image ?? execution.image ?? defaultWorkerImage,
    workspace: { hostDir: spec.dir },
    extraMounts: [...spec.extraMounts, ...(egress?.mounts ?? [])],
    toolchain,
    ...(execution.limits && { limits: execution.limits }),
    ...networksFor(toolchain.network ?? execution.network ?? 'install'),
    ...(execution.user && { user: execution.user }),
    env,
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
  /**
   * More variables for job commands behind `execution.egress`, read for every runner, e.g.
   * `GOPRIVATE` for the forges the proxy adds credentials for. Never pass secrets: commands and
   * their logs see these. Not called without an egress proxy; a failure is logged and skipped.
   */
  egressEnv?: () => Record<string, string> | Promise<Record<string, string>>
  /**
   * More variables for every job command in `mise` and `container` mode, with or without an
   * egress proxy, read for every runner, e.g. `GOPRIVATE` for the private Go modules. They win over
   * `egressEnv`. Never pass secrets: commands and their logs see these. A failure is logged and
   * skipped.
   */
  jobEnv?: () => Record<string, string> | Promise<Record<string, string>>
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
    const egressEnv = execution.egress && (await readEnv(options.egressEnv, log, 'egress'))
    const jobEnv = await readEnv(options.jobEnv, log, 'job')
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
      ...(egressEnv && { egressEnv }),
      ...(jobEnv && { jobEnv }),
    })
  }
}

async function readEnv(
  read: RunnerFactoryOptions['egressEnv'],
  log: (line: string) => void,
  what: 'egress' | 'job',
): Promise<Record<string, string> | undefined> {
  if (!read) return undefined
  try {
    return await read()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(what === 'egress' ? `egress: job environment: ${message}` : `job environment: ${message}`)
    return undefined
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
