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

/** How long a stopped command's process group gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000
/** How long output pipes may stay open after the command exited before its leftovers are killed. */
const PIPE_GRACE_MS = 5000
/** How long to wait for pipes after SIGKILL; only processes that left the group can hold them. */
const PIPE_GIVE_UP_MS = 1000

interface Collected {
  done: Promise<void>
  text(): string
  cancel(): void
}

function collect(stream: ReadableStream<Uint8Array>): Collected {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  const done = (async () => {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- chunks arrive one after another
      const { done: ended, value } = await reader.read()
      if (ended) return
      chunks.push(value)
    }
  })().catch(() => {})
  return {
    done,
    text: () => Buffer.concat(chunks).toString('utf8'),
    cancel: () => void reader.cancel().catch(() => {}),
  }
}

const settlesWithin = (promise: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Runs commands as local child processes. Each command gets its own process group, and stopping
 * it (`signal`, `timeoutMs`) stops the whole group: SIGTERM, then SIGKILL after a grace period.
 * Processes the command leaves behind holding its output open are killed shortly after it exits,
 * so `run` always settles once the command is gone.
 */
export const localRunner: CommandRunner = {
  async run(command, { cwd, env, signal, timeoutMs }) {
    const [binary] = command
    if (!binary || !Bun.which(binary, { cwd })) throw new Error(`command not found: ${binary}`)

    // A new session makes the child a group leader, so `kill(-pid)` reaches every process it
    // starts. Killing only the child is not enough: git's remote helpers outlive it, keep the
    // pipes open and the run would never settle.
    const child = Bun.spawn([...command], {
      cwd,
      env: { ...Bun.env, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
    const signalGroup = (name: 'SIGTERM' | 'SIGKILL') => {
      try {
        process.kill(-child.pid, name)
      } catch {
        // The group is already gone.
      }
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      if (killTimer) return
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
    }
    const timer = timeoutMs === undefined ? undefined : setTimeout(stop, timeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()

    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    try {
      const exitCode = await child.exited
      const drained = Promise.all([stdout.done, stderr.done])
      if (!(await settlesWithin(drained, PIPE_GRACE_MS))) {
        signalGroup('SIGKILL')
        if (!(await settlesWithin(drained, PIPE_GIVE_UP_MS))) {
          stdout.cancel()
          stderr.cancel()
        }
      }
      return { exitCode, stdout: stdout.text(), stderr: stderr.text() }
    } finally {
      clearTimeout(timer)
      clearTimeout(killTimer)
      // A stopped command leaves nothing behind, not even processes that ignored SIGTERM.
      if (killTimer) signalGroup('SIGKILL')
      signal?.removeEventListener('abort', stop)
    }
  },
}
