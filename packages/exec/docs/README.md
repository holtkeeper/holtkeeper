# @holtkeeper/exec

The contract for running external commands. Every module that shells out — scanners, fixers, later the workspace and Renovate integration — takes a `CommandRunner` instead of spawning processes itself. That keeps them testable and lets execution move into a container or a CI job without changing callers.

## CommandRunner

```ts
interface CommandRunner {
  run(command: readonly string[], options: RunOptions): Promise<CommandResult>
}

interface RunOptions {
  cwd: string
  env?: Record<string, string | undefined> // merged over the current environment
  signal?: AbortSignal
  timeoutMs?: number
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}
```

`run` resolves for every exit code and rejects only when the process cannot start. Commands are argument arrays, never shell strings.

## Helpers

| Export                                                    | Description                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `localRunner`                                             | Runs commands as local child processes with `Bun.spawn`. Rejects with `command not found` when the binary is not on `PATH`. See [Stopping commands](#stopping-commands). |
| `runChecked(runner, command, options, okExitCodes = [0])` | Runs and throws `CommandError` for any other exit code.                                                                                                                  |
| `CommandError`                                            | Carries `command` and `result`; the message includes the last 20 lines of output.                                                                                        |

## Stopping commands

`localRunner` starts every command in its own process group (`detached`, a new session), because a command is often more than one process: `git fetch` runs `git-remote-https` or `ssh`, which inherit its output pipes.

- `signal` or `timeoutMs` stops the whole group: SIGTERM, then SIGKILL 5 s later; once `run` settles, nothing of a stopped command is left, not even processes that ignored SIGTERM. The result carries the exit code of the killed command (`143`, `137`).
- When the command exits but processes it started still hold its stdout or stderr open, they get 5 s to finish, then the group is killed. Should something that left the group still hold a pipe a second later, `run` returns the output read so far.

So `run` always settles shortly after the command is gone or stopped. Without this, killing only the direct child let its helpers keep the pipes open and the call never settled.

## Testing

`@holtkeeper/exec/testing` exports `createFakeRunner(handler?)`. It records every call in `calls` and returns whatever the handler returns, defaulting to a successful empty run. Handlers may write files to simulate a tool:

```ts
const { runner, calls } = createFakeRunner(async (command, { cwd }) => {
  await Bun.write(join(cwd, 'package-lock.json'), '{}')
  return { stdout: '{"patches":[]}' }
})
```
