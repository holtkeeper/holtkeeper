import type { Agent } from '@holtkeeper/agent'
import { z } from 'zod'

import { KEEP_ENGLISH, runTracked } from './agent.ts'
import { type ReviewMessages, englishReviewMessages } from './messages.ts'
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

/** Ids of the review time models `sizeAdvice.model` picks from. */
export const reviewTimeModels = ['agent', 'combined', 'smartbear', 'psp', 'effort-tiers'] as const

/** A review time model: how `estimateReviewMinutes` turns a change into minutes. */
export type ReviewTimeModel = (typeof reviewTimeModels)[number]

/** The model used when `sizeAdvice.model` is not set. */
export const DEFAULT_REVIEW_TIME_MODEL: ReviewTimeModel = 'agent'

/** What each model is based on and how it estimates, for editors choosing one. */
export const reviewTimeModelInfo: Record<
  ReviewTimeModel,
  { label: string; source: string; summary: string }
> = {
  agent: {
    label: 'Agent, bounded (default)',
    source: 'CodeRabbit-style estimate by the reviewing model, bounded by the Combined model',
    summary:
      'The reviewing agent, having read the code, estimates the minutes itself (styles, config and repeated code count little, new logic counts a lot); the result is kept between a third and twice the Combined estimate, and is the Combined estimate when the agent gives none. Incremental runs keep the estimate of the last full review.',
  },
  combined: {
    label: 'Combined',
    source: 'Bacchelli & Bird, ICSE 2013; CodeRabbit effort tiers; SmartBear/Cisco reading rates',
    summary:
      'Time to understand the change by review effort (2, 5, 10, 20 or 30 min for effort 1–5), plus reading at 400 weighted lines an hour scaled by effort (×0.3 to ×1.6), plus half a minute per file (at most 30 files). Styles, config and data files count 0.3.',
  },
  smartbear: {
    label: 'SmartBear / Cisco',
    source: 'SmartBear, "Best Kept Secrets of Peer Code Review" (Cisco study, 2006)',
    summary:
      'Reading at 500 weighted lines an hour, the fastest rate that still finds most defects, plus 5 minutes to start and a minute per file. Ignores effort.',
  },
  psp: {
    label: 'PSP inspection',
    source: 'Kemerer & Paulk, IEEE TSE 2009 (PSP data)',
    summary:
      'Reading at 200 weighted lines an hour, the rate recommended for thorough inspections, plus 5 minutes to start and a minute per file. Ignores effort; the strictest model.',
  },
  'effort-tiers': {
    label: 'Effort tiers',
    source: 'CodeRabbit "Estimated code review effort" (tiers 1–3 observed; 4–5 extrapolated)',
    summary:
      'Fixed minutes per review effort: 5, 10, 25, 50 or 90 for effort 1–5. Ignores the size of the change.',
  },
}

/** Added and removed lines of one file the estimate counts. */
export interface SizedFile {
  path: string
  added: number
  removed: number
  /**
   * How many of `added` and `removed` repeat a changed line seen earlier in the merge request
   * (mirrored code, one edit applied to many files); absent means none.
   */
  repeatedAdded?: number
  repeatedRemoved?: number
}

// Shorter lines (`}`, `);`, `</Box>`) repeat in any change and are read as structure anyway.
const MIN_REPEATED_LENGTH = 8

/**
 * Added and removed lines of each file in a review scope (the whole merge request, not a part),
 * in diff order. A changed line counts as repeated when the same line (whitespace ignored, at
 * least 8 characters) was already added or removed earlier in the scope.
 */
export function sizedFiles(files: readonly FileScope[]): SizedFile[] {
  const seen = new Set<string>()
  return files.map((file) => {
    let added = 0
    let removed = 0
    let repeatedAdded = 0
    let repeatedRemoved = 0
    for (const hunk of file.hunks)
      for (const line of hunk.lines) {
        if (line.kind === 'context') continue
        const text = line.text.trim().replace(/\s+/g, ' ')
        const key = `${line.kind}:${text}`
        const repeated = text.length >= MIN_REPEATED_LENGTH && seen.has(key)
        if (text.length >= MIN_REPEATED_LENGTH) seen.add(key)
        if (line.kind === 'add') {
          added++
          if (repeated) repeatedAdded++
        } else {
          removed++
          if (repeated) repeatedRemoved++
        }
      }
    return {
      path: file.path,
      added,
      removed,
      ...(repeatedAdded ? { repeatedAdded } : {}),
      ...(repeatedRemoved ? { repeatedRemoved } : {}),
    }
  })
}

/**
 * The number of distinct logical changes in a walkthrough: entries that share a file are one
 * change. A review split into parts writes a walkthrough per part, so the same change can be
 * listed several times.
 */
export function logicalChanges(walkthrough: readonly { files: readonly string[] }[]): number {
  const parent = walkthrough.map((_, index) => index)
  const root = (index: number): number => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]!]!
    return index
  }
  const owner = new Map<string, number>()
  walkthrough.forEach((entry, index) => {
    for (const path of entry.files) {
      const other = owner.get(path)
      if (other === undefined) owner.set(path, index)
      else parent[root(index)] = root(other)
    }
  })
  return new Set(walkthrough.map((_, index) => root(index))).size
}

const TEST_FILE =
  /(^|\/)(__tests__|tests?|spec|e2e|testdata)\/|\.(test|spec|stories)\.[^/]+$|_test\.go$/
const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$/i
// Declarative files a reviewer skims: styles (CSS and CSS-in-JS modules), config and data.
const LIGHT_FILE =
  /\.(css|scss|sass|less|styl|json|ya?ml|toml|ini|properties)$|(^|\/)(styled|styles?)\.[jt]sx?$|\.(styled|styles?|css)\.[jt]sx?$|(^|\/)(locales?|i18n|translations)\//i

// Removed lines, repeated lines, tests, stories, docs, styles and config read faster than new code.
const REMOVED_WEIGHT = 0.3
const REPEATED_WEIGHT = 0.3
const TEST_WEIGHT = 0.5
const DOC_WEIGHT = 0.3
const LIGHT_WEIGHT = 0.3
const effortFactor: Record<number, number> = { 1: 0.3, 2: 0.5, 3: 1, 4: 1.3, 5: 1.6 }
const understandMinutes: Record<number, number> = { 1: 2, 2: 5, 3: 10, 4: 20, 5: 30 }
const tierMinutes: Record<number, number> = { 1: 5, 2: 10, 3: 25, 4: 50, 5: 90 }
const MAX_COUNTED_FILES = 30

const weightOf = (path: string) =>
  TEST_FILE.test(path)
    ? TEST_WEIGHT
    : DOC_FILE.test(path)
      ? DOC_WEIGHT
      : LIGHT_FILE.test(path)
        ? LIGHT_WEIGHT
        : 1

const weightedLines = (file: SizedFile) => {
  const repeatedAdded = file.repeatedAdded ?? 0
  const repeatedRemoved = file.repeatedRemoved ?? 0
  const added = file.added - repeatedAdded + repeatedAdded * REPEATED_WEIGHT
  const removed = file.removed - repeatedRemoved + repeatedRemoved * REPEATED_WEIGHT
  return (added + removed * REMOVED_WEIGHT) * weightOf(file.path)
}

const readingRate = (lines: number, perHour: number) => (lines / perHour) * 60

/**
 * Estimated minutes a person needs to review the files carefully under `model` (default
 * `DEFAULT_REVIEW_TIME_MODEL`, see `reviewTimeModelInfo`), rounded to the minute and at least 1;
 * 0 without files. Line-based models weigh added lines 1, removed 0.3, lines repeated from
 * earlier files 0.3 of that, tests and stories 0.5, docs, styles, config and data 0.3. The `agent`
 * model takes `agentMinutes` kept between a third and twice the `combined` estimate. `effort` is the agent's 1–5 (3 when
 * absent). Deterministic: the same input gives the same estimate.
 */
export function estimateReviewMinutes(input: {
  files: readonly SizedFile[]
  effort?: number
  model?: ReviewTimeModel
  /** The agent's own estimate; only the `agent` model reads it. */
  agentMinutes?: number
}): number {
  if (!input.files.length) return 0
  const effort =
    input.effort && input.effort >= 1 && input.effort <= 5 ? Math.round(input.effort) : 3
  const lines = input.files.reduce((sum, file) => sum + weightedLines(file), 0)
  const files = input.files.length
  const model = input.model ?? DEFAULT_REVIEW_TIME_MODEL
  const combined =
    (understandMinutes[effort] ?? 10) +
    readingRate(lines, 400) * (effortFactor[effort] ?? 1) +
    Math.min(files, MAX_COUNTED_FILES) * 0.5
  const minutes =
    model === 'smartbear'
      ? 5 + readingRate(lines, 500) + files
      : model === 'psp'
        ? 5 + readingRate(lines, 200) + files
        : model === 'effort-tiers'
          ? (tierMinutes[effort] ?? 25)
          : model === 'agent' && input.agentMinutes && input.agentMinutes > 0
            ? Math.min(Math.max(input.agentMinutes, combined / 3), combined * 2)
            : combined
  return Math.max(1, Math.round(minutes))
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

/**
 * `~25 min`, `~1 h`, `~2 h 10 min`; in the language of `messages` when given (English by
 * default).
 */
export function formatDuration(minutes: number, messages?: ReviewMessages): string {
  const t = (messages ?? englishReviewMessages).t
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return t('duration.minutes', { minutes: rest })
  return rest
    ? t('duration.hoursMinutes', { hours, minutes: rest })
    : t('duration.hours', { hours })
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
    ai: 'If this code is written by an AI agent, ask it to split this merge request now and, from now on, to split large changes into several merge requests by functionality.',
  }
}

const textsSchema = z.object({
  estimate: z.string(),
  limit: z.string().optional(),
  split: z.string(),
  ai: z.string(),
})

const splitSchema = z.object({
  splittable: z.boolean(),
  reason: z.string(),
  direction: z.string(),
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
          'You advise how to split a merge request that is too large to review in one sitting into smaller merge requests, each reviewable on its own.',
          '- `direction`: one to three plain sentences on how to split it by functionality: which coherent pieces to cut out and in what order to merge them, each building only on earlier ones, tests going with the code they test. Name pieces by what they do, never by file paths; no lists, no Markdown headings.',
          '- Set `splittable` to false when splitting would not make the review easier: a mechanical change (a rename, formatting, generated code, a dependency bump touching many files) or one atomic change whose pieces cannot work alone. `reason` then says in one or two sentences why; leave `direction` empty. When splittable, leave `reason` empty.',
          `- \`texts\`: rewrite every given text ${language}, keeping its meaning, Markdown and numbers; return a text unchanged when it is already in that language. Write \`reason\` and \`direction\` ${language} as well.`,
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
    return { texts: mergeTexts(options.texts, answer.texts), ...splitAdvice(answer) }
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
    ai: pick('ai') ?? given.ai,
  }
}

function splitAdvice(answer: z.infer<typeof splitSchema>): Omit<ReviewSizeAdvice, 'texts'> {
  const reason = answer.reason.trim()
  if (!answer.splittable) return { splittable: false, ...(reason ? { reason } : {}) }
  const direction = answer.direction.trim()
  return { splittable: true, ...(direction ? { direction } : {}) }
}
