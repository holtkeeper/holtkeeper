import type { Agent, Toolset } from '@holtkeeper/agent'
import { trimText } from '@holtkeeper/propagate'
import { z } from 'zod'

import type { AdaptReport } from './types.ts'

/** What the adapting agent must answer with. */
export const adaptReportSchema = z.object({
  status: z.enum(['ported', 'not-applicable', 'already-present', 'failed']),
  summary: z.string(),
  changes: z.array(z.string()),
  deviations: z.array(z.string()),
})

/** Input of one adaptation: everything the agent needs to redo the change by hand. */
export interface AdaptInput {
  /** Clean writable checkout of the target. */
  dir: string
  intent: string
  /** The source patch as `git apply` saw it. */
  patch: string
  /** Why applying the patch failed (git output, conflicting files). */
  applyOutput: string
  /** `git grep -n` lines of the changed symbols in the target, and remapping candidates. */
  locations: string[]
  signal?: AbortSignal
}

/** Implements the change in a repository where the patch does not apply; replaceable. */
export interface Adapter {
  /** `undefined` when no adaptation can be attempted (no agent). */
  adapt(input: AdaptInput): Promise<AdaptReport | undefined>
}

/** System prompt of the adapting agent. */
export const adaptSystem = [
  'You port a change made in a sibling repository into this repository checkout.',
  'Implement the same behavior change here, following the conventions, names and structure this',
  'repository already uses; do not copy code that does not fit. Keep the change minimal: no',
  'unrelated refactoring, formatting or dependency changes. Work only inside the current directory.',
  'If the repository already has the change answer `already-present`; if the changed code does not',
  'exist here answer `not-applicable`; change nothing in both cases.',
].join(' ')

/** The user prompt of an adaptation. */
export function adaptPrompt(input: AdaptInput): string {
  return [
    'Port this change into the current repository.',
    input.intent,
    'Source diff (paths are from the source repository):',
    `\`\`\`diff\n${trimText(input.patch, 16_000)}\n\`\`\``,
    `\`git apply --3way\` did not apply it here:\n\n\`\`\`\n${trimText(input.applyOutput, 2000)}\n\`\`\``,
    ...(input.locations.length
      ? [`Where the changed symbols occur here:\n\n\`\`\`\n${input.locations.join('\n')}\n\`\`\``]
      : []),
    'When done, answer with `status`, `summary` (one paragraph), `changes` (one entry per file or',
    'logical change) and `deviations` (every way the port differs from the source change, and why).',
  ].join('\n\n')
}

/** Options of `createAgentAdapter`. */
export interface AgentAdapterOptions {
  /** Default 60. */
  maxTurns?: number
  /** Default 30. */
  timeoutMinutes?: number
  /** Code tools (e.g. from `@holtkeeper/agent-tools`) mounted besides read, search, edit and run. */
  toolsets?: Toolset[]
  system?: string
}

/**
 * Asks `agent` (read, search, edit, run; `taskKind: 'port'`) to implement the change. A failing
 * agent or a missing structured answer is reported as `failed`, never as a rejection.
 */
export function createAgentAdapter(agent: Agent, options: AgentAdapterOptions = {}): Adapter {
  return {
    async adapt(input) {
      const timeout = AbortSignal.timeout((options.timeoutMinutes ?? 30) * 60_000)
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
      try {
        const result = await agent.run<AdaptReport>({
          dir: input.dir,
          system: options.system ?? adaptSystem,
          prompt: adaptPrompt(input),
          capabilities: ['read', 'search', 'edit', 'run'],
          taskKind: 'port',
          ...(options.toolsets?.length ? { toolsets: options.toolsets } : {}),
          output: adaptReportSchema,
          maxTurns: options.maxTurns ?? 60,
          signal,
        })
        return (
          result.output ?? {
            status: 'failed',
            summary: result.text.trim().slice(0, 2000),
            changes: [],
            deviations: ['the agent did not return a structured report'],
          }
        )
      } catch (error) {
        return {
          status: 'failed',
          summary: `${agent.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          changes: [],
          deviations: [],
        }
      }
    },
  }
}

/** An adapter that never attempts anything. */
export const noopAdapter: Adapter = { adapt: async () => undefined }
