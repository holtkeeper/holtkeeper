import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import { z } from 'zod'

import type { ReleaseSettings } from './settings.ts'
import type { ReleaseEntry } from './types.ts'

const answerSchema = z.object({
  overview: z.string().describe('One or two sentences about what this release changes'),
  highlights: z.array(z.string()).describe('The most important changes, one sentence each'),
  check: z
    .array(z.string())
    .describe('What the audience should look at or test, one sentence each; may be empty'),
})

const audiences: Record<ReleaseSettings['summary']['audience'], string> = {
  qa: 'QA engineers who test the release: say what changed in behavior and what to test.',
  users: 'end users: describe visible changes in plain words, no internals.',
  developers: 'developers of dependent projects: mention APIs, breaking changes and migrations.',
  managers: 'managers: business-level impact in plain words, no internals.',
}

const bullets = (title: string, items: string[]) =>
  items.length ? `**${title}**\n\n${items.map((item) => `- ${item}`).join('\n')}` : ''

/** Task kind of release summaries, for model routing in `llm.models`. */
export const releaseSummaryTaskKind = 'release-notes'

/**
 * A short "what changed" for the included entries, written by the agent for the settings'
 * audience and language. The agent reads nothing but the entries (it runs in an empty temporary
 * directory). Rejects when the agent fails, so callers can fall back to the digest.
 */
export async function writeSummary(
  agent: Agent,
  entries: readonly ReleaseEntry[],
  settings: ReleaseSettings['summary'],
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
        `You write release summaries for ${audiences[settings.audience]}`,
        `Write in ${settings.language}. Keep every item to one sentence, no commit hashes.`,
        'Base everything on the changes given.',
        settings.instructions ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
      prompt: [
        `Summarize the release${options.version ? ` ${options.version}` : ''}${options.previous ? ` (previous: ${options.previous})` : ''}.`,
        'Changes as JSON:',
        JSON.stringify(included, null, 2),
      ].join('\n\n'),
      capabilities: [],
      output: answerSchema,
      maxTurns: 3,
      taskKind: releaseSummaryTaskKind,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const answer = result.output
    if (!answer) throw new Error('the agent returned no structured answer')
    return [
      answer.overview.trim(),
      bullets('Highlights', answer.highlights),
      bullets(settings.audience === 'qa' ? 'What to test' : 'Worth a look', answer.check),
    ]
      .filter(Boolean)
      .join('\n\n')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
