import { isAbsolute, posix, relative, resolve, sep } from 'node:path'

import {
  type CommandResult,
  type CommandRunner,
  CommandError,
  type RunOptions,
} from '@holtkeeper/exec'
import {
  type NetworkPolicy,
  type Toolchain,
  miseExecArgs,
  miseToolSpecs,
} from '@holtkeeper/toolchain'

import type { ContainerLimits, ManagedRunner, Mount } from './types.ts'

/** Container engines with a docker-compatible CLI. */
export type ContainerEngine = 'docker' | 'podman'

export interface ContainerRunnerOptions {
  /** Default: `docker` when it is on the PATH, else `podman`. */
  engine?: ContainerEngine
  image: string
  /** The checkout; commands may only run in directories under a mount. */
  workspace: { hostDir: string; containerDir?: string }
  /** More checkouts, e.g. read-only extra repositories. */
  extraMounts?: Mount[]
  /** Named volume holding mise's installed tools, shared between jobs. Default `holtkeeper-mise-cache`. */
  cacheVolume?: string
  /** Tools installed at `start` and put on the PATH of every command. */
  toolchain: Pick<Toolchain, 'tools'>
  limits?: ContainerLimits
  /** Network of the job container. Default `none`. */
  network?: 'none' | 'bridge'
  /** Network of the short-lived container that runs `mise install`. Default `bridge`. */
  installNetwork?: 'none' | 'bridge'
  /** `uid:gid` commands run as. Default `10001:10001`, the image's `holtkeeper` user. */
  user?: string
  /** Variables for every command, below each run's own `env`. */
  env?: Record<string, string>
  /** Host variables copied into every command (proxies, `CI`, ...); nothing else is inherited. */
  envAllowlist?: readonly string[]
  /** Where allowlisted variables are read from. Default `Bun.env`. */
  hostEnv?: Record<string, string | undefined>
  /** Runs the engine's CLI. */
  hostRunner: CommandRunner
  /** Container name. Default: `holtkeeper-job-<random>`. */
  name?: string
  /** Default 15 minutes. */
  installTimeoutMs?: number
  log?: (line: string) => void
}

/** A `ManagedRunner` backed by one long-lived container; `containerId` is set while it runs. */
export interface ContainerRunner extends ManagedRunner {
  readonly containerId: string | undefined
}

const defaultUser = '10001:10001'
const defaultCacheVolume = 'holtkeeper-mise-cache'
const cacheMount = '/mise'
const killGraceMs = 10_000
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/
const engineFailure =
  /Error response from daemon|OCI runtime exec failed|No such container|is not running|Cannot connect to the (Docker|Podman)/i

/** The network of the job and of the install step for a toolchain's network policy. */
export function networksFor(policy: NetworkPolicy): {
  network: 'none' | 'bridge'
  installNetwork: 'none' | 'bridge'
} {
  if (policy === 'none') return { network: 'none', installNetwork: 'none' }
  if (policy === 'full') return { network: 'bridge', installNetwork: 'bridge' }
  return { network: 'none', installNetwork: 'bridge' }
}

/** `docker` when it is installed, else `podman`, else `docker` (so the error names it). */
export function detectEngine(
  which: (binary: string) => string | null = (binary) => Bun.which(binary),
): ContainerEngine {
  if (which('docker')) return 'docker'
  if (which('podman')) return 'podman'
  return 'docker'
}

/**
 * The container path of a host directory under one of `mounts` (the most specific wins); throws for
 * directories outside every mount, so nothing runs where the container cannot see.
 */
export function containerPath(hostPath: string, mounts: readonly Mount[]): string {
  const absolute = resolve(hostPath)
  const candidates = mounts.toSorted((a, b) => b.hostDir.length - a.hostDir.length)
  for (const mount of candidates) {
    const rest = relative(resolve(mount.hostDir), absolute)
    if (rest === '') return mount.containerDir
    if (!rest.startsWith('..') && !isAbsolute(rest))
      return posix.join(mount.containerDir, ...rest.split(sep))
  }
  throw new Error(`${hostPath} is not inside a directory mounted into the container`)
}

const bindMount = ({ hostDir, containerDir, readOnly }: Mount) => {
  const source = resolve(hostDir)
  if (source.includes(',') || containerDir.includes(','))
    throw new Error(`cannot mount a path containing a comma: ${source}`)
  return [
    '--mount',
    `type=bind,source=${source},target=${containerDir}${readOnly ? ',readonly' : ''}`,
  ]
}

/** `-e NAME` flags plus the environment that gives them values, so values never appear in argv. */
function envFlags(variables: Record<string, string | undefined>) {
  const flags: string[] = []
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined || !variableName.test(name)) continue
    flags.push('-e', name)
    env[name] = value
  }
  return { flags, env }
}

/**
 * Runs commands inside one container per job. `start` installs the toolchain with mise in a
 * short-lived container (network `installNetwork`, no checkout mounted) and then starts the job
 * container: read-only root, tmpfs `/tmp`, no capabilities, no privilege escalation, a non-root
 * user, resource limits, network `network`, the checkout and the mise cache volume mounted. Each
 * `run` is a `docker exec` with the host `cwd` mapped into the container, the environment passed
 * for that command only, and the command prefixed with `mise exec <tools> --`. Timeouts and aborts
 * kill the command's process group (falling back to killing the container). `stop` removes it.
 */
export function containerRunner(options: ContainerRunnerOptions): ContainerRunner {
  const engine = options.engine ?? detectEngine()
  const { hostRunner, image, toolchain } = options
  const workspace: Mount = {
    hostDir: options.workspace.hostDir,
    containerDir: options.workspace.containerDir ?? '/workspace',
  }
  const mounts = [workspace, ...(options.extraMounts ?? [])]
  const cacheVolume = options.cacheVolume ?? defaultCacheVolume
  const user = options.user ?? defaultUser
  const limits = options.limits ?? {}
  const hostEnv = options.hostEnv ?? Bun.env
  const name = options.name ?? `holtkeeper-job-${crypto.randomUUID().slice(0, 12)}`
  const log = options.log ?? (() => {})
  const host = { cwd: resolve(workspace.hostDir) }
  let containerId: string | undefined
  let starting: Promise<void> | undefined

  const inherited = () =>
    Object.fromEntries((options.envAllowlist ?? []).map((key) => [key, hostEnv[key]]))

  const sandbox = (network: 'none' | 'bridge') => [
    '--init',
    '--read-only',
    '--tmpfs',
    `/tmp:rw,exec,nosuid,nodev,size=${limits.tmp ?? '2g'}`,
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--user',
    user,
    '--network',
    network,
    '--cpus',
    String(limits.cpus ?? 2),
    '--memory',
    limits.memory ?? '4g',
    '--pids-limit',
    String(limits.pids ?? 1024),
    '--mount',
    `type=volume,source=${cacheVolume},target=${cacheMount}`,
  ]

  const engineRun = async (
    args: string[],
    env: Record<string, string> = {},
    timeoutMs?: number,
  ) => {
    const command = [engine, ...args]
    const result = await hostRunner.run(command, {
      ...host,
      env,
      ...(timeoutMs !== undefined && { timeoutMs }),
    })
    if (result.exitCode !== 0) throw new CommandError(command, result)
    return result
  }

  async function install() {
    const specs = miseToolSpecs(toolchain)
    if (!specs.length) return
    log(`installing ${specs.join(' ')} (network ${options.installNetwork ?? 'bridge'})`)
    const { flags, env } = envFlags(inherited())
    await engineRun(
      [
        'run',
        '--rm',
        ...sandbox(options.installNetwork ?? 'bridge'),
        '--workdir',
        '/tmp',
        '--label',
        'holtkeeper.role=install',
        ...flags,
        image,
        'mise',
        'install',
        ...specs,
      ],
      env,
      options.installTimeoutMs ?? 15 * 60_000,
    )
  }

  async function launch() {
    await install()
    const result = await engineRun([
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      ...sandbox(options.network ?? 'none'),
      ...mounts.flatMap(bindMount),
      '--workdir',
      workspace.containerDir,
      '--label',
      'holtkeeper.role=job',
      image,
      'sleep',
      'infinity',
    ])
    containerId = result.stdout.trim().split('\n').at(-1) || name
    log(`container ${containerId.slice(0, 12)} started from ${image}`)
  }

  async function kill(id: string, pidFile: string) {
    const groupKill = 'kill -KILL -- -"$(cat "$0")" 2>/dev/null || kill -KILL "$(cat "$0")"'
    try {
      const result = await hostRunner.run([engine, 'exec', id, 'sh', '-c', groupKill, pidFile], {
        ...host,
        timeoutMs: killGraceMs,
      })
      if (result.exitCode === 0) return
    } catch {}
    log(`could not kill the command in ${id.slice(0, 12)}; killing the container`)
    await hostRunner.run([engine, 'kill', id], { ...host, timeoutMs: killGraceMs }).catch(() => {})
    containerId = undefined
  }

  async function run(command: readonly string[], runOptions: RunOptions): Promise<CommandResult> {
    const id = containerId
    if (!id) throw new Error('the container is not running; call start() first')
    const { signal, timeoutMs } = runOptions
    if (signal?.aborted) throw new Error(`aborted before \`${command.join(' ')}\` started`)
    const workdir = containerPath(runOptions.cwd, mounts)
    const ignoredConfigs = mounts.map((mount) => mount.containerDir).join(':')
    const { flags, env } = envFlags({
      ...inherited(),
      MISE_IGNORED_CONFIG_PATHS: ignoredConfigs,
      ...options.env,
      ...runOptions.env,
    })
    const pidFile = `/tmp/.holtkeeper-exec-${crypto.randomUUID().slice(0, 12)}.pid`
    const inner = toolchain.tools.length ? [...miseExecArgs(toolchain), ...command] : [...command]
    const args = [
      engine,
      'exec',
      '--workdir',
      workdir,
      ...flags,
      id,
      'setsid',
      '-w',
      'sh',
      '-c',
      'echo $$ > "$0"; exec "$@"',
      pidFile,
      ...inner,
    ]

    let killing: Promise<void> | undefined
    const stopCommand = () => {
      killing ??= kill(id, pidFile)
    }
    const timer = timeoutMs !== undefined ? setTimeout(stopCommand, timeoutMs) : undefined
    signal?.addEventListener('abort', stopCommand, { once: true })
    try {
      const result = await hostRunner.run(args, {
        ...host,
        env,
        ...(timeoutMs !== undefined && { timeoutMs: timeoutMs + killGraceMs }),
      })
      await killing
      if ([125, 126, 127].includes(result.exitCode) && engineFailure.test(result.stderr))
        throw new Error(`${engine} exec failed: ${result.stderr.trim().split('\n').at(-1)}`)
      return result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stopCommand)
    }
  }

  return {
    get containerId() {
      return containerId
    },
    start() {
      starting ??= launch().catch((error: unknown) => {
        starting = undefined
        throw error
      })
      return starting
    },
    run,
    async stop() {
      await starting?.catch(() => {})
      starting = undefined
      const id = containerId
      containerId = undefined
      if (!id) return
      await hostRunner.run([engine, 'rm', '--force', id], host).catch(() => {})
      log(`container ${id.slice(0, 12)} removed`)
    },
  }
}
