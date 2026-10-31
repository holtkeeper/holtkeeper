import { isAbsolute, join, normalize } from 'node:path'

import { defineAnalyzer } from '@holtkeeper/analyzer'
import { z } from 'zod'

import type { WarmupData } from './model.ts'
import { warmupAnalysis } from './report.ts'

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Options of the `warmup` analyzer. */
export const warmupOptionsSchema = z.object({
  /** Shell command run in the checkout with `sh -c`, e.g. `yarn install --immutable && yarn all`. */
  command: z.string().trim().min(1),
  /** Directory to run in, relative to the checkout root. */
  cwd: z
    .string()
    .default('.')
    .refine(
      (value) => !isAbsolute(value) && !normalize(value).startsWith('..'),
      'expected a path inside the checkout',
    ),
  /**
   * Extra environment of the command. Values are stored with the job and shown in the panel, so
   * put secrets in as egress secret placeholders, never as plain values.
   */
  env: z.record(z.string().regex(envName, 'expected a variable name'), z.string()).default({}),
  /** Stops the command after this long; the job's own timeout still applies. */
  timeoutMinutes: z.coerce.number().positive().optional(),
  /** Lines of output kept in the result. */
  outputLines: z.coerce.number().int().positive().max(2000).default(200),
  /** Branch whose push queued the run; set by push triggers. */
  branch: z.string().optional(),
})

export type WarmupOptions = z.output<typeof warmupOptionsSchema>

const lastLines = (text: string, count: number) => {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.slice(-count).join('\n')
}

/**
 * The `warmup` analyzer (scope `repo`, needs `checkout`): runs a command of the user's choosing in
 * a checkout of the job's ref, so build caches (Turborepo remote cache, Nx Cloud, ...) are filled
 * before people and CI ask for them. A failing command is a result, not a job failure: the record
 * keeps its exit code and the tail of its output. `now` exists for tests.
 */
export function createWarmupAnalyzer(settings: { now?: () => Date } = {}) {
  const now = settings.now ?? (() => new Date())
  return defineAnalyzer<WarmupData, WarmupOptions>({
    kind: 'warmup',
    analysis: warmupAnalysis,
    scope: 'repo',
    needs: { checkout: true },
    options: warmupOptionsSchema,
    flags: [
      { flag: 'command', option: 'command', description: 'shell command to run, e.g. "yarn all"' },
      { flag: 'cwd', option: 'cwd', description: 'directory inside the checkout (default .)' },
      {
        flag: 'timeout-minutes',
        option: 'timeoutMinutes',
        description: 'stop the command after this long',
      },
    ],
    async run({ dir, ref, runner, options, signal, log }) {
      if (!dir) throw new Error('the warmup analyzer needs a checkout')
      const startedAt = now()
      const timeoutMs = options.timeoutMinutes ? options.timeoutMinutes * 60_000 : undefined
      log?.(`warmup: ${options.command}`)
      const result = await runner.run(['sh', '-c', options.command], {
        cwd: join(dir, options.cwd),
        env: options.env,
        ...(signal && { signal }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      })
      const durationMs = now().getTime() - startedAt.getTime()
      const output = lastLines(
        [result.stdout, result.stderr].filter((part) => part.trim()).join('\n'),
        options.outputLines,
      )
      for (const line of lastLines(output, 40).split('\n')) log?.(line)
      log?.(`warmup: exit code ${result.exitCode} after ${Math.round(durationMs / 1000)} s`)
      const data: WarmupData = {
        command: options.command,
        cwd: options.cwd,
        ...(options.branch !== undefined && { branch: options.branch }),
        exitCode: result.exitCode,
        durationMs,
        timedOut: timeoutMs !== undefined && result.exitCode !== 0 && durationMs >= timeoutMs,
        output,
        startedAt: startedAt.toISOString(),
      }
      return { data, ...(ref ? { ref } : {}) }
    },
  })
}

/** The `warmup` analyzer with the real clock. */
export const warmupAnalyzer = createWarmupAnalyzer()
