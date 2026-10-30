import type { CommandResult, CommandRunner, RunOptions } from './runner.ts'

export interface RecordedCommand {
  command: string[]
  options: RunOptions
}

type Handler = (
  command: string[],
  options: RunOptions,
) => Partial<CommandResult> | undefined | Promise<Partial<CommandResult> | undefined>

/**
 * A `CommandRunner` for tests. Every call is recorded in `calls`; `handler` decides the result and
 * may have side effects such as writing files. Missing fields default to a successful empty run.
 */
export function createFakeRunner(handler: Handler = () => undefined) {
  const calls: RecordedCommand[] = []
  const runner: CommandRunner = {
    async run(command, options) {
      calls.push({ command: [...command], options })
      const result = await handler([...command], options)
      return { exitCode: 0, stdout: '', stderr: '', ...result }
    },
  }
  return { runner, calls }
}
