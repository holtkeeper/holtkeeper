import { posix } from 'node:path'

import type { Agent, AgentCapability, Toolset } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import { trimText } from '@holtkeeper/propagate'
import { z } from 'zod'

import { remapPaths, reverseApplies } from './apply.ts'
import { gitIn, grepPresent, trackedFiles } from './git.ts'
import {
  changedSymbols,
  distinctiveAdditions,
  distinctiveRemovals,
  formatPatch,
  remapFiles,
} from './patch.ts'
import type { SourceFile, TriageResult } from './types.ts'

/** Input of a triage step. */
export interface TriageInput {
  dir: string
  runner: CommandRunner
  files: SourceFile[]
  intent: string
  signal?: AbortSignal
}

/** Decides cheaply whether a target needs the change; replaceable. */
export interface Triage {
  triage(input: TriageInput): Promise<TriageResult>
}

/**
 * Deterministic triage in the target checkout:
 * - `already-present` when the patch (or its remapped form) reverses cleanly, or when every
 *   distinctive added line is found and no distinctive removed line remains;
 * - `not-applicable` when no touched file exists (by path or name) and no changed symbol occurs;
 * - `unclear` when the evidence is mixed (some added lines present, or files missing but symbols
 *   found); `apply` otherwise.
 */
export const ruleTriage: Triage = {
  async triage({ dir, runner, files, signal }) {
    const git = gitIn(dir, runner, signal)
    const tracked = await trackedFiles(git)
    const mapped = remapFiles(files, remapPaths(files, tracked))
    if ((await reverseApplies(git, files)) || (await reverseApplies(git, mapped)))
      return {
        verdict: 'already-present',
        reason: 'the source patch reverses cleanly',
        by: 'rules',
      }

    const additions = distinctiveAdditions(files)
    const removals = distinctiveRemovals(files)
    const added = await grepPresent(git, additions)
    const remaining = await grepPresent(git, removals)
    if (additions.length > 0 && added.size === additions.length && remaining.size === 0)
      return {
        verdict: 'already-present',
        reason: `all ${additions.length} added lines already exist and none of the removed lines remain`,
        by: 'rules',
      }

    const existing = files.filter((file) => file.status !== 'added')
    const names = new Set(tracked.map((path) => posix.basename(path)))
    const present = new Set(tracked)
    const touched = existing.filter(
      (file) => present.has(file.oldPath) || names.has(posix.basename(file.oldPath)),
    )
    const symbols = [...(await grepPresent(git, changedSymbols(files), { words: true }))]
    if (existing.length > 0 && touched.length === 0 && symbols.length === 0)
      return {
        verdict: 'not-applicable',
        reason: `none of the ${existing.length} touched files and none of the changed symbols exist`,
        by: 'rules',
      }
    if (added.size > 0 && added.size < additions.length)
      return {
        verdict: 'unclear',
        reason: `${added.size} of ${additions.length} added lines already exist`,
        by: 'rules',
        symbols,
      }
    if (existing.length > 0 && touched.length === 0)
      return {
        verdict: 'unclear',
        reason: `no touched file exists, but ${symbols.length} changed symbols do`,
        by: 'rules',
        symbols,
      }
    return {
      verdict: 'apply',
      reason: `${touched.length} of ${existing.length} touched files exist`,
      by: 'rules',
      symbols,
    }
  },
}

/** What the triage agent answers. */
export const triageAnswerSchema = z.object({
  verdict: z.enum(['apply', 'already-present', 'not-applicable']),
  reason: z.string(),
})

/** System prompt of the triage agent. */
export const triageSystem = [
  'You decide whether a code change made in another repository is needed in this repository.',
  'Do not change any file. Answer `already-present` when this repository already has the same',
  'change (possibly written differently), `not-applicable` when the code it changes does not',
  'exist here or works differently so the change has no meaning, and `apply` otherwise.',
].join(' ')

/** Options of `agentTriage`. */
export interface AgentTriageOptions {
  /** Default 12. */
  maxTurns?: number
  toolsets?: Toolset[]
}

/**
 * Runs `rules` first and asks `agent` (`taskKind: 'triage'`, read and search only) when the rules
 * are unsure. An agent failure keeps the rules' `unclear` verdict.
 */
export function agentTriage(
  agent: Agent,
  rules: Triage = ruleTriage,
  options: AgentTriageOptions = {},
): Triage {
  return {
    async triage(input) {
      const result = await rules.triage(input)
      if (result.verdict !== 'unclear') return result
      try {
        const capabilities: AgentCapability[] = ['read', 'search']
        const answer = await agent.run({
          dir: input.dir,
          system: triageSystem,
          taskKind: 'triage',
          capabilities,
          ...(options.toolsets?.length ? { toolsets: options.toolsets } : {}),
          output: triageAnswerSchema,
          maxTurns: options.maxTurns ?? 12,
          prompt: [
            'The change to judge:',
            input.intent,
            `Pre-check: ${result.reason}.`,
            ...(result.symbols?.length
              ? [`Changed symbols found here: ${result.symbols.join(', ')}`]
              : []),
            'Source diff:',
            `\`\`\`diff\n${trimText(formatPatch(input.files), 12_000)}\n\`\`\``,
            'Answer with `verdict` and a one-sentence `reason`.',
          ].join('\n\n'),
          ...(input.signal ? { signal: input.signal } : {}),
        })
        if (!answer.output) return result
        return {
          verdict: answer.output.verdict,
          reason: answer.output.reason,
          by: 'agent',
          ...(result.symbols ? { symbols: result.symbols } : {}),
        }
      } catch {
        return result
      }
    },
  }
}
