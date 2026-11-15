import { z } from 'zod'

/** Bumped when the verification prompt changes. */
export const VERIFY_VERSION = 1

/** Own context, so the server adds neither the Guide nor knowledge to the call. */
export const VERIFY_CONTEXT =
  'Knowledge verification: the entries, what changed and the code follow in the prompt.'

/** The system prompt of a verification call. */
export const VERIFY_SYSTEM = [
  'You check whether notes in a team knowledge base are still true for one repository.',
  'Each entry comes with the reasons it was flagged (a file it rests on changed or disappeared, a library it is about is no longer used, or it is old) and the relevant diff or file head.',
  'For every entry answer exactly one verdict:',
  '- "valid": the evidence shows the entry still holds, or the change is unrelated to what it says.',
  '- "update": the entry is partly outdated. Give "title" and "body" with the corrected text, keeping its form and every part that is still true.',
  '- "obsolete": the entry no longer holds at all.',
  'Judge only from the evidence shown. When it does not show enough to say the entry is wrong, answer "valid".',
  'Never invent facts for an update; use only what the entry and the evidence say. "reason" is one sentence naming the evidence.',
].join('\n')

/** The model's answer: one verdict per entry id. */
export const verifyOutput = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(['valid', 'update', 'obsolete']),
      reason: z.string().max(400),
      title: z.string().max(300).optional(),
      body: z.string().max(8_000).optional(),
    }),
  ),
})

export type VerifyOutput = z.output<typeof verifyOutput>

/** One entry as the prompt shows it. */
export interface VerifyItem {
  id: string
  title: string
  body: string
  signals: string[]
  /** Diff of the changed files or the head of the files the entry rests on, already cut. */
  evidence: string
}

/** Most characters of evidence per entry. */
export const VERIFY_EVIDENCE_CHARS = 2_500

/** The user prompt: the repository and the entries to check. */
export function verifyPrompt(repo: string, items: readonly VerifyItem[]): string {
  const blocks = items.map(
    (item) =>
      `### ${item.id}\nTitle: ${item.title}\n\n${item.body.trim()}\n\nFlagged because:\n${item.signals.map((signal) => `- ${signal}`).join('\n')}\n\nEvidence:\n${item.evidence.trim() || '(none)'}`,
  )
  return `Repository: ${repo}\n\nEntries to check (${items.length}):\n\n${blocks.join('\n\n')}`
}
