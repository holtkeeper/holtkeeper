import { join } from 'node:path'

import { type Agent, BudgetExceededError } from '@holtkeeper/agent'
import {
  DIGEST_MIN_CHARS,
  DIGEST_VERSION,
  type DigestGroup,
  type DigestItem,
  type RepoDigest,
  blobSha,
  digestGroups,
  digestKey,
  readRepoDigests,
} from '@holtkeeper/guide'
import type { KvStore } from '@holtkeeper/store'
import { z } from 'zod'

/** Rules files of a repository's root that get digested, the ones agents read as rules. */
export const DIGEST_FILES = ['REVIEW.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'] as const

/** Spend cap of one file's digest call, in USD (tier `fast`). */
export const DIGEST_CALL_CAP_USD = 0.03

/** Most of a file the model reads; the rest is cut, the digest says nothing about it. */
export const DIGEST_INPUT_CHARS = 40_000

/** Most digest lines kept per group. */
export const DIGEST_GROUP_LINES = 12

const MAX_LINE = 240

/** The system prompt of a digest call. */
export const DIGEST_SYSTEM = `You condense one contributor document of a repository for AI agents that work on it.
Sort every rule the document actually states into three groups:
- general: facts and rules any work needs (project layout, how to build, run and test, hard prohibitions);
- review: what a code reviewer should check or must not flag (review criteria, merge requirements, quality bars);
- code: how to write code here (style, naming, patterns, commit and branch conventions, tooling).
Rules:
- State only what the document says. No generic advice, no inventions, nothing from your own knowledge.
- One short imperative sentence per line, at most ${MAX_LINE} characters, at most ${DIGEST_GROUP_LINES} lines per group; keep concrete names, commands and paths.
- Drop onboarding prose, history, contact details, badges and anything that does not change how work is done.
- For each line give "source": the exact heading of the section it comes from, or leave it out when there is none.
- A group may be empty. Write the lines in English; keep names, commands, paths and quoted terms exactly as the document has them.`

/** Own context, so the server adds neither the Guide nor knowledge to a digest call. */
export const DIGEST_CONTEXT = 'Rules file digest: the document follows in the prompt.'

/** The text the model gets for `file`. */
export const digestPrompt = (file: string, text: string): string =>
  `Document: ${file}\n\n${text.slice(0, DIGEST_INPUT_CHARS)}`

const lines = z.array(z.object({ text: z.string(), source: z.string().optional() }))

/** The shape the model answers in. */
export const digestOutput = z.object({ general: lines, review: lines, code: lines })

/** The markdown headings of `text`, lowercased and without `#`s. */
export const headingsOf = (text: string): Set<string> =>
  new Set(
    text
      .split('\n')
      .map((line) => /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1]?.trim().toLowerCase())
      .filter((heading): heading is string => !!heading),
  )

/**
 * Cleans a model answer deterministically: lines are trimmed, cut at `MAX_LINE`, deduplicated and
 * limited per group; a `source` that is not a heading of the document is removed (the line stays,
 * without a pointer it cannot back up).
 */
export function acceptDigest(
  output: z.output<typeof digestOutput>,
  document: string,
): Record<DigestGroup, DigestItem[]> {
  const headings = headingsOf(document)
  const seen = new Set<string>()
  const clean = (group: DigestGroup): DigestItem[] => {
    const kept: DigestItem[] = []
    for (const raw of output[group]) {
      const text = raw.text
        .replace(/^[-*•\d.)\s]+/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_LINE)
      const key = text.toLowerCase()
      if (!text || seen.has(key)) continue
      seen.add(key)
      const source = raw.source?.replace(/^#+\s*/, '').trim()
      kept.push({
        text,
        ...(source && headings.has(source.toLowerCase()) && { source }),
      })
      if (kept.length >= DIGEST_GROUP_LINES) break
    }
    return kept
  }
  return { general: clean('general'), review: clean('review'), code: clean('code') }
}

/** What one file's turn did. */
export type DigestOutcome = 'digested' | 'unchanged' | 'short' | 'missing' | 'failed'

/** The result for one file of `digestRepoFiles`. */
export interface DigestResult {
  file: string
  outcome: DigestOutcome
  costUsd: number
  reason?: string
}

/**
 * Digests the long rules files of the checkout `dir` and stores each under `digestKey`. A file is
 * only sent to the model when its blob sha differs from the stored digest's (or the stored one is
 * of an older `DIGEST_VERSION`), so a run on an unchanged repository costs nothing. Files under
 * `DIGEST_MIN_CHARS` need no digest and a stored digest of a file that became short is left
 * alone (the resolver ignores it). A file whose call fails is reported as `failed` and the others
 * go on; a budget refusal is not caught, it ends the run like every agent call.
 */
export async function digestRepoFiles(input: {
  agent: Agent
  kv: Pick<KvStore, 'get' | 'set'>
  forgeId: string
  repo: string
  dir: string
  files?: readonly string[]
  force?: boolean
  now?: () => Date
  signal?: AbortSignal
  log?: (line: string) => void
}): Promise<DigestResult[]> {
  const results: DigestResult[] = []
  for (const file of input.files ?? DIGEST_FILES) {
    const handle = Bun.file(join(input.dir, file))
    // Files go one after another: each call is metered against the weekly budget.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await handle.exists())) {
      results.push({ file, outcome: 'missing', costUsd: 0 })
      continue
    }
    // oxlint-disable-next-line no-await-in-loop
    const text = await handle.text()
    if (text.trim().length < DIGEST_MIN_CHARS) {
      results.push({ file, outcome: 'short', costUsd: 0 })
      continue
    }
    const sha = blobSha(text)
    // oxlint-disable-next-line no-await-in-loop
    const stored = await readRepoDigests({
      kv: input.kv,
      forgeId: input.forgeId,
      repo: input.repo,
      files: [file],
      shas: new Map([[file, sha]]),
    })
    if (stored.has(file) && !input.force) {
      results.push({ file, outcome: 'unchanged', costUsd: 0 })
      continue
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await input.agent.run({
        dir: input.dir,
        system: DIGEST_SYSTEM,
        context: DIGEST_CONTEXT,
        prompt: digestPrompt(file, text),
        capabilities: [],
        output: digestOutput,
        maxTurns: 2,
        maxCostUsd: DIGEST_CALL_CAP_USD,
        tier: 'fast',
        taskKind: 'guide',
        ...(input.signal && { signal: input.signal }),
      })
      if (!answer.output) {
        results.push({ file, outcome: 'failed', costUsd: answer.costUsd ?? 0, reason: 'no answer' })
        continue
      }
      const digest: RepoDigest = {
        version: DIGEST_VERSION,
        sha,
        groups: acceptDigest(answer.output, text),
        model: answer.model ?? 'tier:fast',
        costUsd: answer.costUsd ?? 0,
        at: (input.now?.() ?? new Date()).toISOString(),
      }
      // oxlint-disable-next-line no-await-in-loop
      await input.kv.set(digestKey(input.forgeId, input.repo, file), digest)
      input.log?.(
        `digested ${file}: ${digestGroups.map((group) => `${group} ${digest.groups[group].length}`).join(', ')}`,
      )
      results.push({ file, outcome: 'digested', costUsd: digest.costUsd })
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error
      results.push({
        file,
        outcome: 'failed',
        costUsd: 0,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}
