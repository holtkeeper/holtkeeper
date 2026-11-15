import type { Agent } from '@holtkeeper/agent'
import { z } from 'zod'

import { KEEP_ENGLISH, runTracked } from './agent.ts'
import type { ReviewSizeAdvice, ReviewSizeLevel, ReviewUsage, ReviewWalkthrough } from './schema.ts'
import type { FileScope } from './scope.ts'

/** Minutes of estimated review time from which the summary advises splitting, per level. */
export interface SizeThresholds {
  /** From here the merge request is `large`: splitting is suggested where the changes allow it. */
  largeMinutes: number
  /** From here it is `too-large`: the note says a person cannot review it thoroughly. */
  tooLargeMinutes: number
}

/** Defaults of the `sizeAdvice` option. */
export const DEFAULT_SIZE_THRESHOLDS: SizeThresholds = { largeMinutes: 60, tooLargeMinutes: 120 }

/** Added and removed lines of one file the estimate counts. */
export interface SizedFile {
  path: string
  added: number
  removed: number
}

/** Added and removed lines of each file in a review scope (the whole merge request, not a part). */
export function sizedFiles(files: readonly FileScope[]): SizedFile[] {
  return files.map((file) => {
    let added = 0
    let removed = 0
    for (const hunk of file.hunks)
      for (const line of hunk.lines) {
        if (line.kind === 'add') added++
        else if (line.kind === 'remove') removed++
      }
    return { path: file.path, added, removed }
  })
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e|testdata)\/|\.(test|spec)\.[^/]+$|_test\.go$/
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$/i

// A careful reviewer reads about 500 lines of code an hour; past roughly an hour and 400 lines
// the share of defects they find drops sharply. Removed lines, tests and docs read faster.
const LINES_PER_HOUR = 500
const REMOVED_WEIGHT = 0.3
const TEST_WEIGHT = 0.5
const DOC_WEIGHT = 0.3
const START_MINUTES = 5
const MINUTES_PER_FILE = 1
const MINUTES_PER_EXTRA_GROUP = 3
const effortFactor: Record<number, number> = { 1: 0.5, 2: 0.75, 3: 1, 4: 1.3, 5: 1.6 }

const weightOf = (path: string) =>
  TEST_FILE.test(path) ? TEST_WEIGHT : DOC_FILE.test(path) ? DOC_WEIGHT : 1

/**
 * Estimated minutes a person needs to review the files carefully, rounded to 5 (at least 5):
 * time to get into the change, reading time per weighted line scaled by the agent's `effort`
 * (1–5; neutral when absent), a minute per file and a few per extra logical change (`groups`).
 * Deterministic: the same input gives the same estimate.
 */
export function estimateReviewMinutes(input: {
  files: readonly SizedFile[]
  effort?: number
  groups?: number
}): number {
  if (!input.files.length) return 0
  const lines = input.files.reduce(
    (sum, file) => sum + (file.added + file.removed * REMOVED_WEIGHT) * weightOf(file.path),
    0,
  )
  const factor = effortFactor[input.effort ?? 3] ?? 1
  const minutes =
    START_MINUTES +
    (lines / LINES_PER_HOUR) * 60 * factor +
    input.files.length * MINUTES_PER_FILE +
    Math.max(0, (input.groups ?? 1) - 1) * MINUTES_PER_EXTRA_GROUP
  return Math.max(5, Math.round(minutes / 5) * 5)
}

/** The level of an estimate under the thresholds. */
export function reviewSizeLevel(minutes: number, thresholds: SizeThresholds): ReviewSizeLevel {
  if (minutes >= thresholds.tooLargeMinutes) return 'too-large'
  if (minutes >= thresholds.largeMinutes) return 'large'
  return 'ok'
}

const levelRank: Record<ReviewSizeLevel, number> = { ok: 0, large: 1, 'too-large': 2 }

/** Whether `level` is more severe than `than` (anything is, compared with no level). */
export const sizeEscalated = (level: ReviewSizeLevel, than?: ReviewSizeLevel) =>
  levelRank[level] > (than ? levelRank[than] : -1)

/** `~25 min`, `~1 h`, `~2 h 10 min`. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `~${rest} min`
  return rest ? `~${hours} h ${rest} min` : `~${hours} h`
}

/** The English advice texts for a `large` or `too-large` estimate. */
export function adviceTexts(
  level: Exclude<ReviewSizeLevel, 'ok'>,
  minutes: number,
): ReviewSizeAdvice['texts'] {
  return {
    estimate: `A careful review of this merge request takes about ${formatDuration(minutes)}.`,
    ...(level === 'too-large'
      ? {
          limit:
            'That is more than a person can review thoroughly in one sitting: problems are likely to slip through.',
        }
      : {}),
    split:
      level === 'too-large'
        ? 'Split it into several merge requests by functionality.'
        : 'Consider splitting it into smaller merge requests by functionality, if the changes allow it.',
    parts: 'A possible split:',
    ai: 'If this code is written by an AI agent, ask it to split this merge request now and, from now on, to split large changes into several merge requests by functionality.',
  }
}

const textsSchema = z.object({
  estimate: z.string(),
  limit: z.string().optional(),
  split: z.string(),
  parts: z.string(),
  ai: z.string(),
})

const splitSchema = z.object({
  splittable: z.boolean(),
  reason: z.string(),
  parts: z.array(z.object({ title: z.string(), files: z.array(z.string()) })),
  texts: textsSchema,
})

const MAX_LISTED_FILES = 300
const MAX_DESCRIPTION = 3000

/**
 * Asks the `fast` model tier, without tools, how a large merge request could be split by
 * functionality, and to put the advice texts into the review language (`language`, else the
 * merge request description's). Parts keep only listed paths, each path in one part; fewer than
 * two parts means not splittable. Texts the answer leaves empty stay as given. Never throws
 * unless `signal` is aborted: a failed call or unusable answer gives the English texts without
 * a plan.
 */
export async function planSplit(options: {
  agent: Agent
  dir: string
  usage: ReviewUsage
  mergeRequest: { title: string; description: string }
  files: readonly SizedFile[]
  walkthrough?: ReviewWalkthrough
  texts: ReviewSizeAdvice['texts']
  language?: string
  signal?: AbortSignal
}): Promise<ReviewSizeAdvice> {
  const fallback: ReviewSizeAdvice = { texts: options.texts, splittable: true }
  const language = options.language
    ? `in ${options.language}`
    : 'in the language of the merge request description (English when it has none)'
  const listed = options.files.slice(0, MAX_LISTED_FILES)
  try {
    const result = await runTracked(
      options.agent,
      {
        dir: options.dir,
        system: [
          'You plan how to split a merge request that is too large to review in one sitting into smaller merge requests, each reviewable on its own.',
          '- Group files by functionality, not by directory or file type: each part is one coherent change that makes sense and builds on its own. Order parts so that each builds only on earlier ones. Tests go with the code they test.',
          '- Aim for 2 to 6 parts. Use only paths from the list; put each path in at most one part.',
          '- Set `splittable` to false when splitting would not make the review easier: a mechanical change (a rename, formatting, generated code, a dependency bump touching many files) or one atomic change whose pieces cannot work alone. `reason` says in one or two sentences why the split helps, or why it would not; leave `parts` empty then.',
          `- \`texts\`: rewrite every given text ${language}, keeping its meaning, Markdown and numbers; return a text unchanged when it is already in that language. Write \`reason\` and part titles ${language} as well.`,
          KEEP_ENGLISH,
        ].join('\n'),
        prompt: [
          `Merge request: ${options.mergeRequest.title}`,
          options.mergeRequest.description.trim()
            ? `Description:\n${options.mergeRequest.description.trim().slice(0, MAX_DESCRIPTION)}`
            : '',
          `Files (added/removed lines):\n${listed.map((file) => `- ${file.path} (+${file.added} -${file.removed})`).join('\n')}${options.files.length > listed.length ? `\n… ${options.files.length - listed.length} more` : ''}`,
          options.walkthrough?.length
            ? `Logical changes found by the review:\n${options.walkthrough.map((step) => `- ${step.change} (${step.files.join(', ')})`).join('\n')}`
            : '',
          `Texts:\n${JSON.stringify(options.texts)}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        capabilities: [],
        output: splitSchema,
        taskKind: 'review-split',
        tier: 'fast',
        maxTurns: 1,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.usage,
    )
    const answer = result.output
    if (!answer) return fallback
    return {
      texts: mergeTexts(options.texts, answer.texts),
      ...splitParts(answer, new Set(options.files.map((file) => file.path))),
    }
  } catch {
    options.signal?.throwIfAborted()
    return fallback
  }
}

function mergeTexts(
  given: ReviewSizeAdvice['texts'],
  answer: Partial<ReviewSizeAdvice['texts']>,
): ReviewSizeAdvice['texts'] {
  const pick = (key: keyof ReviewSizeAdvice['texts']) => answer[key]?.trim() || given[key]
  return {
    estimate: pick('estimate') ?? given.estimate,
    ...(given.limit ? { limit: pick('limit') ?? given.limit } : {}),
    split: pick('split') ?? given.split,
    parts: pick('parts') ?? given.parts,
    ai: pick('ai') ?? given.ai,
  }
}

function splitParts(
  answer: z.infer<typeof splitSchema>,
  known: ReadonlySet<string>,
): Omit<ReviewSizeAdvice, 'texts'> {
  const reason = answer.reason.trim()
  const withReason = reason ? { reason } : {}
  if (!answer.splittable) return { splittable: false, ...withReason }
  const taken = new Set<string>()
  const parts = answer.parts.flatMap((part) => {
    const files = part.files.filter((path) => known.has(path) && !taken.has(path))
    for (const path of files) taken.add(path)
    const title = part.title.trim()
    return files.length && title ? [{ title, files }] : []
  })
  // A one-part "split" is no plan; keep the advice but propose nothing.
  return parts.length >= 2 ? { splittable: true, ...withReason, parts } : { splittable: true }
}
