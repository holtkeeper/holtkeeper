import { resolve } from 'node:path'

import { type Agent, createAgent } from '@holtkeeper/agent'
import { loadConfig } from '@holtkeeper/core'
import { localRunner } from '@holtkeeper/exec'
import {
  type CaseResult,
  type QualityGroup,
  type QualityRow,
  formatEval,
  formatQuality,
  goldenCases,
  qualityGroups,
  qualityRows,
  runEval,
  summarize,
} from '@holtkeeper/review'
import type { Store } from '@holtkeeper/store'

import { UsageError } from './serve.ts'

/** Raw `review-eval` flags as `parseArgs` returns them. */
export interface ReviewEvalFlags {
  case?: string[] | undefined
  repeat?: string | undefined
  concurrency?: string | undefined
  by?: string | undefined
  days?: string | undefined
  'no-golden'?: boolean | undefined
  'no-acceptance'?: boolean | undefined
  json?: boolean | undefined
}

/** What `reviewEvalCommand` takes from outside, replaceable in tests. */
export interface ReviewEvalServices {
  /** Reviews the golden set; default the Anthropic API with `ANTHROPIC_API_KEY`. */
  agent?: Agent
  /** Replaces the store the config names, for the acceptance half. */
  store?: Pick<Store, 'learnings' | 'close'>
  env?: Record<string, string | undefined>
  now?: () => Date
}

const DAY = 86_400_000

const positiveInt = (flag: string, value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new UsageError(`--${flag} expects a positive integer, got "${value}"`)
  return parsed
}

function agentFromEnv(env: Record<string, string | undefined>): Agent {
  const secret = env['ANTHROPIC_API_KEY']
  if (!secret)
    throw new UsageError(
      'the golden set needs a model: set ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL for a compatible endpoint), or pass --no-golden',
    )
  const url = env['ANTHROPIC_BASE_URL']
  return createAgent(
    {
      kind: url ? 'anthropic-compatible' : 'anthropic',
      url: url ?? 'https://api.anthropic.com',
      secret,
    },
    { runner: localRunner },
  )
}

/**
 * `holtkeeper review-eval`: reviews the golden set with a real model and prints precision and
 * recall, then prints the acceptance of the review comments on real merge requests from the
 * config's store, by category (`--by` for another grouping). `--case <id>` limits the set,
 * `--repeat <n>` reviews each case n times, `--no-golden` and `--no-acceptance` skip a half.
 * The acceptance half is skipped with a note when the config file does not exist.
 */
export async function reviewEvalCommand(
  configFile: string,
  flags: ReviewEvalFlags,
  out: (line: string) => void,
  services: ReviewEvalServices = {},
): Promise<number> {
  const env = services.env ?? process.env
  const by = qualityGroups.find((group) => group === (flags.by ?? 'category'))
  if (!by) throw new UsageError(`--by expects ${qualityGroups.join(', ')}, got "${flags.by}"`)
  const days = positiveInt('days', flags.days, 90)
  const repeat = positiveInt('repeat', flags.repeat, 1)
  const concurrency = positiveInt('concurrency', flags.concurrency, 3)
  const json: Record<string, unknown> = {}
  let failed = false

  if (!flags['no-golden']) {
    const wanted = flags.case ?? []
    const unknown = wanted.filter((id) => !goldenCases.some((testCase) => testCase.id === id))
    if (unknown.length)
      throw new UsageError(
        `unknown case ${unknown.join(', ')}; known: ${goldenCases.map((testCase) => testCase.id).join(', ')}`,
      )
    const cases = wanted.length
      ? goldenCases.filter((testCase) => wanted.includes(testCase.id))
      : goldenCases
    const agent = services.agent ?? agentFromEnv(env)
    if (!flags.json) out(`Golden set: ${cases.length} cases x ${repeat}`)
    const results: CaseResult[] = await runEval({
      cases,
      repeat,
      concurrency,
      agent,
      runner: localRunner,
      onResult: (result) => {
        if (!flags.json)
          out(
            `  ${result.caseId}#${result.run}: found ${result.score.found.length}/${result.expected}, ${result.score.falsePositives} false positives${result.error ? `, FAILED: ${result.error}` : ''}`,
          )
      },
    })
    failed = results.some((result) => result.error)
    if (flags.json) json['golden'] = { summary: summarize(results), results }
    else out(`\n${formatEval(results)}`)
  }

  if (!flags['no-acceptance']) {
    const store = services.store ?? (await storeOf(configFile, flags, out))
    if (store) {
      try {
        const since = new Date(
          (services.now?.() ?? new Date()).getTime() - days * DAY,
        ).toISOString()
        const signals = (await store.learnings.reactions()).filter(
          (signal) => signal.updatedAt >= since,
        )
        const { rows, total } = qualityRows(signals, by)
        if (flags.json) json['acceptance'] = { by, days, rows, total }
        else
          out(
            `\nAcceptance of review comments on merged merge requests, last ${days} days:\n${formatAcceptance(by, rows, total)}`,
          )
      } finally {
        await store.close()
      }
    }
  }

  if (flags.json) out(JSON.stringify(json, null, 2))
  return failed ? 1 : 0
}

function formatAcceptance(by: QualityGroup, rows: QualityRow[], total: QualityRow): string {
  return total.comments === 0
    ? 'no judged comments yet: outcomes are stored when a merge request is merged'
    : formatQuality(by, rows, total)
}

/** The config's store, or `undefined` with a note when there is no config file to read it from. */
async function storeOf(configFile: string, flags: ReviewEvalFlags, out: (line: string) => void) {
  if (!(await Bun.file(resolve(configFile)).exists())) {
    if (flags['no-golden']) throw new UsageError(`config not found: ${resolve(configFile)}`)
    if (!flags.json) out(`\nAcceptance: skipped, no config file at ${resolve(configFile)}`)
    return undefined
  }
  const server = (await loadConfig(configFile)).server
  if (!server) throw new UsageError('review-eval needs a config with a server section')
  return server.store
}
