// oxlint-disable no-await-in-loop -- fix attempts build on each other in the same checkout
import type { Agent } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import { z } from 'zod'

import { trimText } from './notes.ts'
import { snapshot, touchedBetween } from './publish.ts'
import type {
  AgentReport,
  CheckResult,
  CheckSpec,
  FixContext,
  Fixer,
  FixInput,
  Verifier,
} from './types.ts'

/** What the agent must answer with after each attempt. */
export const agentReportSchema = z.object({
  summary: z.string(),
  changes: z.array(z.string()),
  remainingProblems: z.array(z.string()),
})

/** Rules every agent-backed fix attempt gets as its system prompt, unless replaced. */
export const defaultFixSystem = [
  'You change code in a repository checkout so that its checks pass.',
  'Work only inside the current directory and do not access the network except through the',
  "repository's own check commands.",
  'Make minimal, idiomatic changes that follow the conventions already used in the repository.',
  'Never disable, skip or delete checks or tests to make them pass, and never add type-assertion',
  'or lint-suppression escapes unless the code base already does so for the same case.',
].join(' ')

/** The user prompt of one fix attempt. */
export function fixPrompt(input: FixInput): string {
  const failing = input.failing.map(
    (check) =>
      `### ${check.name} (\`${check.command}\`, exit ${check.exitCode})\n\n\`\`\`\n${trimText(check.output, 6000)}\n\`\`\``,
  )
  const context = input.context.map((item) => `### ${item.title}\n\n${trimText(item.text, 8000)}`)
  return [
    ...(input.instructions ? [input.instructions] : []),
    `These checks fail (attempt ${input.attempt}):`,
    failing.join('\n\n'),
    ...(context.length ? ['Context:', context.join('\n\n')] : []),
    'Change the code so that every check passes. You may run the check commands above to',
    'confirm. When done, answer with `summary` (one paragraph), `changes` (one entry per file or',
    'logical change) and `remainingProblems` (empty when you believe all checks pass).',
  ].join('\n\n')
}

/** Options of the agent-backed fixer. */
export interface AgentFixerOptions {
  /** Default 40. */
  maxTurns?: number
  /** Per attempt; default 20. */
  timeoutMinutes?: number
  /** Replaces `defaultFixSystem`. */
  system?: string
}

/**
 * Asks `agent` (read, search, edit, run; confined to the checkout) to make the failing checks
 * pass and answer with an `AgentReport`. An agent failure or timeout is reported as an attempt
 * with a remaining problem, never as a rejection.
 */
export function createAgentFixer(agent: Agent, options: AgentFixerOptions = {}): Fixer {
  return {
    async fix(input) {
      const timeout = AbortSignal.timeout((options.timeoutMinutes ?? 20) * 60_000)
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
      try {
        const result = await agent.run<AgentReport>({
          dir: input.dir,
          system: options.system ?? defaultFixSystem,
          prompt: fixPrompt(input),
          capabilities: ['read', 'search', 'edit', 'run'],
          output: agentReportSchema,
          maxTurns: options.maxTurns ?? 40,
          signal,
        })
        return (
          result.output ?? {
            summary: result.text.trim().slice(0, 2000),
            changes: [],
            remainingProblems: ['the agent did not return a structured report'],
          }
        )
      } catch (error) {
        return {
          summary: `${agent.name} failed`,
          changes: [],
          remainingProblems: [error instanceof Error ? error.message : String(error)],
        }
      }
    },
  }
}

/** A fixer that never attempts anything. */
export const noopFixer: Fixer = { fix: async () => undefined }

/** Latest result per check name, in first-seen order. */
export function mergeChecks(previous: CheckResult[], next: CheckResult[]): CheckResult[] {
  const byName = new Map(previous.map((check) => [check.name, check]))
  for (const check of next) byName.set(check.name, check)
  return [...byName.values()]
}

/** Input of `fixUntilPassing`. */
export interface FixLoopInput {
  dir: string
  runner: CommandRunner
  verifier: Verifier
  fixer: Fixer
  /** Checks to re-run after each attempt; `install` is not re-run. */
  specs: CheckSpec[]
  /** Results of the run before any attempt. */
  checks: CheckResult[]
  /** Default 3. */
  maxAttempts?: number
  context?: FixContext[]
  instructions?: string
  /** Runs after each attempt, before the checks; e.g. restores files the fixer must not change. */
  afterAttempt?(attempt: number): Promise<void>
  signal?: AbortSignal
  log?: (line: string) => void
}

/** Outcome of `fixUntilPassing`. */
export interface FixLoopOutcome {
  /** Latest result per check. */
  checks: CheckResult[]
  attempts: number
  /** Report of the last attempt. */
  report?: AgentReport
  /** Files the fixer touched (git checkouts only), sorted. */
  touched: string[]
}

async function trySnapshot(dir: string, runner: CommandRunner) {
  try {
    return await snapshot(dir, runner)
  } catch {
    return undefined
  }
}

/**
 * Calls `fixer` and re-runs the checks until they all pass, the fixer gives up or `maxAttempts`
 * is reached. Does nothing while a failing `install` check is among the results.
 */
export async function fixUntilPassing(input: FixLoopInput): Promise<FixLoopOutcome> {
  const { dir, runner, signal } = input
  let checks = input.checks
  let attempts = 0
  let report: AgentReport | undefined
  const touched = new Set<string>()
  const installed = !checks.some((check) => check.name === 'install' && !check.ok)
  const limit = installed ? (input.maxAttempts ?? 3) : 0
  const rerun = input.specs.filter((spec) => spec.name !== 'install')
  while (attempts < limit && checks.some((check) => !check.ok)) {
    const before = await trySnapshot(dir, runner)
    const next = await input.fixer.fix({
      dir,
      attempt: attempts + 1,
      failing: checks.filter((check) => !check.ok),
      context: input.context ?? [],
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(signal ? { signal } : {}),
    })
    if (!next) break
    attempts++
    report = next
    const after = await trySnapshot(dir, runner)
    if (before && after) for (const path of touchedBetween(before, after)) touched.add(path)
    await input.afterAttempt?.(attempts)
    checks = mergeChecks(
      checks,
      await input.verifier.verify({
        dir,
        checks: rerun,
        runner,
        attempt: attempts,
        ...(signal ? { signal } : {}),
      }),
    )
    input.log?.(
      `fix attempt ${attempts}: ${checks.every((check) => check.ok) ? 'checks pass' : 'checks still fail'}`,
    )
  }
  return { checks, attempts, ...(report ? { report } : {}), touched: [...touched].toSorted() }
}
