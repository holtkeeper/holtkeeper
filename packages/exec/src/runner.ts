/** Outcome of a finished process. */
export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Working directory of the process. */
  cwd: string
  /** Variables merged over the current environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  /** Kills the process after this many milliseconds. */
  timeoutMs?: number
}

/**
 * Runs external commands. Everything that shells out depends on this interface, so tests can
 * substitute a fake and production can move execution into a container without touching callers.
 */
export interface CommandRunner {
  /** Resolves with the result for any exit code; rejects only when the process cannot start. */
  run(command: readonly string[], options: RunOptions): Promise<CommandResult>
}

export class CommandError extends Error {
  override name = 'CommandError'
  readonly command: readonly string[]
  readonly result: CommandResult

  constructor(command: readonly string[], result: CommandResult) {
    const output = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n')
    super(`\`${command.join(' ')}\` exited with ${result.exitCode}${output ? `:\n${output}` : ''}`)
    this.command = command
    this.result = result
  }
}

/** Runs a command and throws `CommandError` unless its exit code is in `okExitCodes`. */
export async function runChecked(
  runner: CommandRunner,
  command: readonly string[],
  options: RunOptions,
  okExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  const result = await runner.run(command, options)
  if (!okExitCodes.includes(result.exitCode)) throw new CommandError(command, result)
  return result
}

/** Runs commands as local child processes. */
export const localRunner: CommandRunner = {
  async run(command, { cwd, env, signal, timeoutMs }) {
    const [binary] = command
    if (!binary || !Bun.which(binary, { cwd })) throw new Error(`command not found: ${binary}`)

    const process = Bun.spawn([...command], {
      cwd,
      env: { ...Bun.env, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
      timeout: timeoutMs,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    return { exitCode, stdout, stderr }
  },
}
