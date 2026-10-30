import type { CommandRunner } from '@holtkeeper/exec'

/** A `CommandRunner` with a lifetime: `start` before the first `run`, `stop` when done. */
export interface ManagedRunner extends CommandRunner {
  /** Prepares the environment (installs tools, starts the sandbox). Throws when that fails. */
  start(): Promise<void>
  /** Releases everything `start` created; safe to call more than once and without `start`. */
  stop(): Promise<void>
}

/** A host directory visible inside the container. */
export interface Mount {
  hostDir: string
  containerDir: string
  readOnly?: boolean
}

/** Resource limits of the job container. */
export interface ContainerLimits {
  /** CPUs, fractions allowed. Default 2. */
  cpus?: number
  /** Memory in docker syntax, e.g. `4g`. Default `4g`. */
  memory?: string
  /** Maximum number of processes. Default 1024. */
  pids?: number
  /** Size of the `/tmp` tmpfs (also `HOME`). Default `2g`. */
  tmp?: string
}
