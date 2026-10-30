import { tmpdir } from 'node:os'

import { type CommandRunner, type RunOptions, runChecked } from '@holtkeeper/exec'
import { type Toolchain, miseExecArgs, miseToolSpecs } from '@holtkeeper/toolchain'

import type { ManagedRunner } from './types.ts'

export interface LocalMiseRunnerOptions {
  toolchain: Pick<Toolchain, 'tools'>
  /** Runs `mise` on the host. */
  hostRunner: CommandRunner
  /** Variables for every command, below each run's own `env`. */
  env?: Record<string, string>
  /**
   * Host variables copied into every command on top of `defaultLocalEnvAllowlist`; a trailing `*`
   * matches a prefix. `HOLTKEEPER_*` never passes, even when listed.
   */
  envAllowlist?: readonly string[]
  /** The environment `hostRunner` starts processes with. Default `Bun.env`. */
  hostEnv?: Record<string, string | undefined>
  /**
   * Directories whose mise config files are ignored (`MISE_IGNORED_CONFIG_PATHS`), e.g. the
   * checkout, so a repository's own mise config cannot run code; its versions come from `toolchain`.
   */
  ignoreConfigIn?: readonly string[]
}

/**
 * Host variables every command of a `localMiseRunner` keeps: paths, user, locale, terminal, mise's
 * own settings, proxies and trust stores. A trailing `*` matches a prefix.
 */
export const defaultLocalEnvAllowlist: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_*',
  'TZ',
  'TERM',
  'XDG_*',
  'MISE_*',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]

const secretLike = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|^KEY$/i

const allows = (pattern: string, name: string) =>
  pattern.endsWith('*')
    ? name.startsWith(pattern.slice(0, -1)) && !secretLike.test(name)
    : name === pattern

// Masking with `undefined` instead of a "do not inherit" run option keeps every existing
// `CommandRunner` correct: a runner that ignored such an option would leak the whole environment.
function filterHostEnv(
  hostEnv: Record<string, string | undefined>,
  allowlist: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.keys(hostEnv).map((name) => [
      name,
      !name.startsWith('HOLTKEEPER_') && allowlist.some((pattern) => allows(pattern, name))
        ? hostEnv[name]
        : undefined,
    ]),
  )
}

/**
 * Runs commands on the host through `mise exec <tools> --`, e.g. inside a worker pod. `start`
 * installs the tools once. Commands (including `mise install`) start from the allowlisted host
 * variables only, so they never see `HOLTKEEPER_*` secrets or other variables of the server
 * process; there is no isolation beyond that and the tool versions.
 */
export function localMiseRunner(options: LocalMiseRunnerOptions): ManagedRunner {
  const { toolchain, hostRunner } = options
  const hostEnv = options.hostEnv ?? Bun.env
  const allowlist = [...defaultLocalEnvAllowlist, ...(options.envAllowlist ?? [])]
  const ignored = options.ignoreConfigIn?.length
    ? { MISE_IGNORED_CONFIG_PATHS: options.ignoreConfigIn.join(':') }
    : {}
  const environment = (env: RunOptions['env']) => ({
    ...filterHostEnv(hostEnv, allowlist),
    ...ignored,
    ...options.env,
    ...env,
  })
  return {
    async start() {
      const specs = miseToolSpecs(toolchain)
      if (specs.length)
        await runChecked(hostRunner, ['mise', 'install', ...specs], {
          cwd: tmpdir(),
          env: environment(undefined),
        })
    },
    run(command, runOptions) {
      const env = environment(runOptions.env)
      if (!toolchain.tools.length) return hostRunner.run(command, { ...runOptions, env })
      return hostRunner.run([...miseExecArgs(toolchain), ...command], { ...runOptions, env })
    },
    async stop() {},
  }
}
