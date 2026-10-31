import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CommandRunner } from '@holtkeeper/exec'

import { analyzeBundle } from './analyze.ts'
import { buildProject } from './build.ts'
import type { ExplicitEntry } from './resolvers.ts'
import type { BundleTarget } from './targets.ts'

export interface BuildTargetOptions {
  /** Target name, e.g. `app` or `storefront`. */
  name: string
  /** Project directory the build runs in. */
  dir: string
  /**
   * Build output relative to `dir`; with several candidates the first that exists after the
   * build is measured.
   */
  dist: string | string[]
  /** Root module paths are reported relative to. Default `dir`. */
  root?: string
  /** Build command; without it the output must already be there. */
  command?: string[]
  runner?: CommandRunner
  env?: Record<string, string | undefined>
  entries?: ExplicitEntry[]
  ignore?: string[]
  signal?: AbortSignal
  timeoutMs?: number
}

const MAX_ERROR = 4000

/**
 * Builds (optionally) and measures one target. Never throws for a failed build or a missing
 * output: the target comes back `failed` with the error, so history keeps the gap. An abort still
 * rejects.
 */
export async function analyzeBuildTarget(options: BuildTargetOptions): Promise<BundleTarget> {
  const base = { name: options.name, source: 'build' as const }
  try {
    const build = options.command
      ? await buildProject({
          dir: options.dir,
          command: options.command,
          ...(options.runner ? { runner: options.runner } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
      : undefined
    const candidates = [options.dist].flat().map((dist) => resolve(options.dir, dist))
    const dist = candidates.find((path) => existsSync(path))
    if (!dist)
      throw new Error(`no build output at ${[options.dist].flat().join(', ')} in ${options.dir}`)
    const data = await analyzeBundle({
      dist,
      root: options.root ?? options.dir,
      ...(options.entries ? { entries: options.entries } : {}),
      ...(options.ignore ? { ignore: options.ignore } : {}),
    })
    return {
      ...base,
      status: 'ok',
      data: build
        ? { ...data, build: { command: build.command, durationMs: build.durationMs } }
        : data,
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, status: 'failed', error: message.slice(-MAX_ERROR) }
  }
}
