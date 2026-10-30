import { tmpdir } from 'node:os'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'
import { type Toolchain, miseExecArgs, miseToolSpecs } from '@holtkeeper/toolchain'

import type { ManagedRunner } from './types.ts'

export interface LocalMiseRunnerOptions {
  toolchain: Pick<Toolchain, 'tools'>
  /** Runs `mise` on the host. */
  hostRunner: CommandRunner
  /** Variables for every command, below each run's own `env`. */
  env?: Record<string, string>
  /**
   * Directories whose mise config files are ignored (`MISE_IGNORED_CONFIG_PATHS`), e.g. the
   * checkout, so a repository's own mise config cannot run code; its versions come from `toolchain`.
   */
  ignoreConfigIn?: readonly string[]
}

/**
 * Runs commands on the host through `mise exec <tools> --`, for development without containers.
 * `start` installs the tools once; there is no isolation beyond picking tool versions.
 */
export function localMiseRunner(options: LocalMiseRunnerOptions): ManagedRunner {
  const { toolchain, hostRunner } = options
  const ignored = options.ignoreConfigIn?.length
    ? { MISE_IGNORED_CONFIG_PATHS: options.ignoreConfigIn.join(':') }
    : {}
  return {
    async start() {
      const specs = miseToolSpecs(toolchain)
      if (specs.length)
        await runChecked(hostRunner, ['mise', 'install', ...specs], { cwd: tmpdir() })
    },
    run(command, runOptions) {
      const prefix = toolchain.tools.length ? miseExecArgs(toolchain) : []
      return hostRunner.run([...prefix, ...command], {
        ...runOptions,
        env: { ...ignored, ...options.env, ...runOptions.env },
      })
    },
    async stop() {},
  }
}
