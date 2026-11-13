import { knowledgeKinds } from '@holtkeeper/knowledge'
import { z } from 'zod'

import type { BootstrapEvidence } from './evidence-code.ts'

/** Bumped whenever the prompt or the output handling changes; stored with every run. */
export const BOOTSTRAP_VERSION = 1

/** The system prompt of a starter knowledge run. */
export const BOOTSTRAP_SYSTEM = [
  'You write starter knowledge-base entries for one repository, the way an experienced teammate would after reading its code and its recent merge requests.',
  'A lesson is a concrete decision, convention, quirk or how-to that a coding agent or a new teammate would otherwise get wrong.',
  'Rules:',
  '- Every lesson follows from the evidence and cites at least one evidence id in `evidence`. Name paths, commands, packages and review feedback exactly as the evidence shows them.',
  '- Never write generic advice ("write tests", "keep functions small", "follow the style guide"), never restate the README, never invent files, commands or versions.',
  '- Prefer what reviewers enforce in merge request threads and decisions recorded in ADRs or docs over what any reader of the code would see.',
  '- Participants are named by role only (author, reviewer 1, ...); never guess or write names.',
  '- Phrase a lesson so it holds outside this repository when it can. Set `repoSpecific: true` when it only makes sense here (its own paths, commands or services).',
  '- When an existing entry says the same thing for another repository, put its id in `related` and give `general`: a title and body true for both repositories.',
  '- `level: "process"` marks team process (merge requests, reviews, releases, branches) rather than code; `level: "library"` with `library` set to one of the listed dependency subjects marks how to use that library.',
  '- `kind` is one of decision, convention, quirk, howto (migration only for a library upgrade, with `library` set).',
  '- Bodies are short Markdown: what to do, why, and where the evidence shows it. At most about 800 characters each.',
  'Answer with JSON only: {"lessons": [{"title", "body", "kind", "topics"?, "evidence": ["<id>"], "level"?, "library"?, "repoSpecific"?, "related"?, "general"?}]}.',
].join('\n')

/**
 * The task context of a starter knowledge run: it stands in for the Guide and the knowledge block,
 * so the model reads the existing entries only where the prompt lists them.
 */
export const BOOTSTRAP_CONTEXT =
  'Starter knowledge builder: the evidence and the existing entries follow in the prompt.'

/** The model's answer: lessons with evidence ids, placed later by `placeLessons`. */
export const bootstrapOutput = z.object({
  lessons: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        body: z.string().trim().min(1).max(1_500),
        kind: z.enum(knowledgeKinds),
        topics: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
        evidence: z.array(z.string()).min(1).max(6),
        level: z.enum(['repo', 'process', 'library']).default('repo'),
        library: z.string().trim().min(1).optional(),
        repoSpecific: z.boolean().default(false),
        related: z.array(z.string()).max(3).optional(),
        general: z
          .object({
            title: z.string().trim().min(1).max(160),
            body: z.string().trim().min(1).max(1_500),
          })
          .optional(),
      }),
    )
    .max(10),
})

export type BootstrapOutput = z.output<typeof bootstrapOutput>

/** An existing entry as the prompt lists it. */
export interface ExistingEntryLine {
  id: string
  scope: string
  title: string
  body: string
}

/** A fleet library the repository depends on, with the repository that owns it. */
export interface LibraryLine {
  subject: string
  home: string
}

/** Everything the user prompt of a run holds. */
export interface BootstrapPromptInput {
  /** `forge:path`. */
  repo: string
  groups: readonly string[]
  /** How far back merge requests were read. */
  since: string
  maxEntries: number
  evidence: readonly BootstrapEvidence[]
  existing: readonly ExistingEntryLine[]
  libraries: readonly LibraryLine[]
  /** Direct dependencies a `library` lesson may name. */
  dependencies: readonly string[]
  /** One-off extra request of the run. */
  extra?: string
}

/** Most characters of the existing entries block. */
export const EXISTING_CHARS = 9_000
/** Most dependency subjects listed. */
export const DEPENDENCIES = 60

/** The user prompt of a starter knowledge run. */
export function bootstrapPrompt(input: BootstrapPromptInput): string {
  let existingChars = 0
  const existing = input.existing.flatMap((entry) => {
    const line = `- kb:${entry.id} [${entry.scope}] ${entry.title} — ${entry.body.replaceAll(/\s+/g, ' ').slice(0, 200)}`
    if (existingChars + line.length > EXISTING_CHARS) return []
    existingChars += line.length
    return [line]
  })
  return [
    `Repository: ${input.repo}${input.groups.length ? ` (groups: ${input.groups.join(', ')})` : ''}`,
    `Write 3 to ${input.maxEntries} lessons; fewer when the evidence is thin, none when it shows nothing specific. Merge requests are those merged since ${input.since}.`,
    '# Evidence',
    ...input.evidence.map((item) => `## [${item.id}] ${item.label}\n${item.text}`),
    existing.length
      ? `# Existing entries of the team (ids for \`related\`; skip a lesson that an entry naming this repository already records)\n${existing.join('\n')}`
      : '# Existing entries\nNone yet.',
    input.libraries.length
      ? `# Libraries of the fleet this repository uses (subject → owning repository)\n${input.libraries.map((lib) => `- ${lib.subject} → ${lib.home}`).join('\n')}`
      : '',
    input.dependencies.length
      ? `# Direct dependencies (\`library\` must be one of these)\n${input.dependencies.slice(0, DEPENDENCIES).join(', ')}`
      : '',
    input.extra?.trim() ? `# Extra request for this run\n${input.extra.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
