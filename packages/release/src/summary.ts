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

const announcementSchema = z.object({
  packages: z
    .array(
      z.object({
        name: z.string().describe('Package or repository name exactly as given'),
        overview: z.string().describe('One or two sentences about what this version changes'),
        highlights: z.array(z.string()).describe('The most important changes, one sentence each'),
        breaking: z
          .array(
            z.object({
              change: z.string().describe('What breaks, one sentence'),
              migration: z.string().optional().describe('How to migrate, one or two sentences'),
            }),
          )
          .describe('Breaking changes with migration hints; empty when nothing breaks'),
      }),
    )
    .describe('One item per package, in the order given'),
})

/** What `writeAnnouncementNotes` writes for each package of a release announcement. */
export type AnnouncementNotes = z.infer<typeof announcementSchema>['packages']

/** One package (or repository) version of an announcement, as `writeAnnouncementNotes` reads it. */
export interface AnnouncementNotesPackage {
  name: string
  version: string
  previous?: string
  entries: readonly ReleaseEntry[]
  /** Breaking changes of the public API between `previous` and `version`. */
  apiBreaking?: readonly { name: string; change: string; before?: string; after?: string }[]
}

/**
 * Notes for a release announcement covering one or more package versions, in one cheap call (task
 * kind `release-notes`, tier `fast`): per package an overview, highlights and the breaking
 * changes with migration hints, taken from breaking commits and the public API diff. Prose is in
 * `language` (English by default), code and technical terms stay English; the Guide's `releases`
 * section reaches the agent as for `writeSummary`. Rejects when the agent fails or a budget
 * refuses the call, so callers announce without notes.
 */
export async function writeAnnouncementNotes(
  agent: Agent,
  input: {
    packages: readonly AnnouncementNotesPackage[]
    language?: string
    signal?: AbortSignal
  },
): Promise<AnnouncementNotes> {
  const packages = input.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    ...(pkg.previous ? { previous: pkg.previous } : {}),
    changes: pkg.entries
      .filter((entry) => entry.included)
      .slice(0, 80)
      .map((entry) => ({
        type: entry.type ?? 'other',
        ...(entry.scope ? { scope: entry.scope } : {}),
        ...(entry.breaking ? { breaking: true } : {}),
        text: entry.text,
        commits: entry.commits.slice(0, 2).map((commit) => commit.subject),
      })),
    ...(pkg.apiBreaking?.length
      ? {
          apiBreaking: pkg.apiBreaking.slice(0, 30).map((change) => ({
            ...change,
            ...(change.before ? { before: change.before.slice(0, 600) } : {}),
            ...(change.after ? { after: change.after.slice(0, 600) } : {}),
          })),
        }
      : {}),
  }))
  const language = input.language ?? 'English'
  const scratch = await mkdtemp(join(tmpdir(), 'holtkeeper-release-'))
  try {
    const result = await agent.run({
      dir: scratch,
      system: [
        'You announce new versions to the developers who depend on them: what changed, what breaks and how to migrate.',
        'Follow the team rules in the context for audience and style; they win over these defaults.',
        `Write the prose in ${language}. Keep code, identifiers, package names, file paths and established technical terms in English.`,
        'Keep every item to one sentence, no commit hashes. Base everything on the changes given: a breaking change comes from a breaking commit or an apiBreaking entry (removed exports, members removed from a declaration).',
      ].join('\n'),
      prompt: [
        'Write the announcement notes of these package versions.',
        'Packages as JSON:',
        JSON.stringify(packages, null, 2),
      ].join('\n\n'),
      capabilities: [],
      output: announcementSchema,
      maxTurns: 3,
      taskKind: releaseSummaryTaskKind,
      tier: 'fast',
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const answer = result.output
    if (!answer) throw new Error('the agent returned no structured answer')
    return answer.packages
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
