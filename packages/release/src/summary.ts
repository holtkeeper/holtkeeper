import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import { z } from 'zod'

import type { ReleaseEntry } from './types.ts'

const answerSchema = z.object({
  overview: z.string().describe('One or two sentences about what this release changes'),
  highlights: z.array(z.string()).describe('The most important changes, one sentence each'),
  check: z
    .array(z.string())
    .describe('What the audience should look at or test, one sentence each; may be empty'),
})

const bullets = (title: string, items: string[]) =>
  items.length ? `**${title}**\n\n${items.map((item) => `- ${item}`).join('\n')}` : ''

/** Task kind of release summaries, for model routing in `llm.models`. */
export const releaseSummaryTaskKind = 'release-notes'

/**
 * A short "what changed" for the included entries, written by the agent in one cheap call (task
 * kind `release-notes`, tier `fast`). Audience, language and style come from the team's rules:
 * the server's agent adds the repository's Guide (sections `releases` and `commits`) as context
 * to tasks of this kind. The agent reads nothing but the entries (it runs in an empty temporary
 * directory). Rejects when the agent fails, so callers can fall back to the digest.
 */
export async function writeSummary(
  agent: Agent,
  entries: readonly ReleaseEntry[],
  options: { previous?: string; version?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const included = entries
    .filter((entry) => entry.included)
    .slice(0, 150)
    .map((entry) => ({
      type: entry.type ?? 'other',
      ...(entry.scope ? { scope: entry.scope } : {}),
      ...(entry.breaking ? { breaking: true } : {}),
      text: entry.text,
      ...(entry.tickets.length ? { tickets: entry.tickets } : {}),
      commits: entry.commits.slice(0, 3).map((commit) => commit.subject),
    }))
  const scratch = await mkdtemp(join(tmpdir(), 'holtkeeper-release-'))
  try {
    const result = await agent.run({
      dir: scratch,
      system: [
        'You write release notes for the people who test and ship the release: what changed in behavior and what to check.',
        'Follow the team rules in the context for audience, language and style; they win over these defaults.',
        'Keep every item to one sentence, no commit hashes. Base everything on the changes given.',
      ].join('\n'),
      prompt: [
        `Summarize the release${options.version ? ` ${options.version}` : ''}${options.previous ? ` (previous: ${options.previous})` : ''}.`,
        'Changes as JSON:',
        JSON.stringify(included, null, 2),
      ].join('\n\n'),
      capabilities: [],
      output: answerSchema,
      maxTurns: 3,
      taskKind: releaseSummaryTaskKind,
      tier: 'fast',
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const answer = result.output
    if (!answer) throw new Error('the agent returned no structured answer')
    return [
      answer.overview.trim(),
      bullets('Highlights', answer.highlights),
      bullets('What to check', answer.check),
    ]
      .filter(Boolean)
      .join('\n\n')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
