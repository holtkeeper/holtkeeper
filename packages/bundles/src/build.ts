import { type CommandRunner, localRunner, runChecked } from '@holtkeeper/exec'

export interface BuildProjectOptions {
  /** Project directory the command runs in. */
  dir: string
  /** Build command chosen by the caller, e.g. `['bun', 'run', 'build']`. */
  command: string[]
  /** Defaults to running local processes. */
  runner?: CommandRunner
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface BuildResult {
  command: string[]
  durationMs: number
  stdout: string
  stderr: string
}

/** Runs the project's build. Throws `CommandError` from `@holtkeeper/exec` when it fails. */
export async function buildProject(options: BuildProjectOptions): Promise<BuildResult> {
  const { dir, command, runner = localRunner, env, signal, timeoutMs } = options
  const started = performance.now()
  const result = await runChecked(runner, command, {
    cwd: dir,
    ...(env ? { env } : {}),
    ...(signal ? { signal } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  return {
    command: [...command],
    durationMs: Math.round(performance.now() - started),
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
