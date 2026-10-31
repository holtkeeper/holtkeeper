import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RunningServer, ServerOptions } from '@holtkeeper/server'

import { UsageError } from './audit.ts'

/** `startServer` from `@holtkeeper/server`, injectable for tests. */
export type StartServer = (
  config: HoltkeeperConfig,
  options: ServerOptions,
) => Promise<RunningServer>

/** Raw `serve` flags as `parseArgs` returns them. */
export interface ServeFlags {
  role?: string | undefined
  concurrency?: string | undefined
  'max-jobs'?: string | undefined
  'drain-timeout'?: string | undefined
}

const positiveInt = (flag: string, value: string | undefined) => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new UsageError(`--${flag} expects a positive integer, got "${value}"`)
  return parsed
}

const durationUnits: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** Parses `30`, `30s`, `2m`, `1h` or `500ms` into milliseconds (bare numbers are seconds). */
export function parseDuration(flag: string, value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim())
  if (!match) throw new UsageError(`--${flag} expects a duration like 30s or 2m, got "${value}"`)
  return Number(match[1]) * (durationUnits[match[2] ?? 's'] ?? 1000)
}

/**
 * Server options from `serve` flags and the environment: `--role` (else `HOLTKEEPER_ROLE`, else
 * `all`), `--concurrency`, `--max-jobs`, `--drain-timeout` (else `HOLTKEEPER_DRAIN_TIMEOUT`).
 */
export async function serveOptions(
  flags: ServeFlags,
  env: Record<string, string | undefined> = process.env,
): Promise<Pick<ServerOptions, 'roles' | 'worker' | 'drainTimeoutMs'>> {
  const { parseRoles } = await import('@holtkeeper/server')
  let roles
  try {
    roles = parseRoles(flags.role ?? env.HOLTKEEPER_ROLE)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const concurrency = positiveInt('concurrency', flags.concurrency ?? env.HOLTKEEPER_CONCURRENCY)
  const maxJobs = positiveInt('max-jobs', flags['max-jobs'] ?? env.HOLTKEEPER_MAX_JOBS)
  const drain = flags['drain-timeout'] ?? env.HOLTKEEPER_DRAIN_TIMEOUT
  return {
    roles,
    ...((concurrency !== undefined || maxJobs !== undefined) && {
      worker: {
        ...(concurrency !== undefined && { concurrency }),
        ...(maxJobs !== undefined && { maxJobs }),
      },
    }),
    ...(drain !== undefined && { drainTimeoutMs: parseDuration('drain-timeout', drain) }),
  }
}

/**
 * Runs the server until `untilStopped` resolves (a signal) or, with `--max-jobs`, until the worker
 * ran that many jobs; then drains and stops it. Resolves with exit code 0.
 */
export async function serve(
  config: HoltkeeperConfig,
  options: ServerOptions,
  start: StartServer,
  untilStopped: () => Promise<void>,
  log: (line: string) => void,
): Promise<number> {
  const server = await start(config, options)
  const reason = await Promise.race([
    untilStopped().then(() => 'signal' as const),
    server.exhausted.then(() => 'max-jobs' as const),
  ])
  log(reason === 'max-jobs' ? 'max jobs reached; shutting down' : 'shutting down')
  await server.stop()
  return 0
}
