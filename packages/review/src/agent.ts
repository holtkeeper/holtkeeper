import type { Agent, AgentResult, AgentTask, Toolset } from '@holtkeeper/agent'
import { lockfileTools } from '@holtkeeper/agent-tools'
import { z } from 'zod'

import type { OpenThread } from './dedupe.ts'
import { changedLineCount, renderNumberedDiff } from './diff.ts'
import type { Guideline } from './guidelines.ts'
import { type AgentReview, type ReviewUsage, agentReviewSchema, categories } from './schema.ts'
import type { FileScope } from './scope.ts'
import type { Candidate } from './validate.ts'

/**
 * Runs a task and adds its turns, cost and token counts to `usage`; the first run that names its
 * model sets `usage.model`.
 */
export async function runTracked<Output>(
  agent: Agent,
  task: AgentTask<Output>,
  usage: ReviewUsage,
): Promise<AgentResult<Output>> {
  const result = await agent.run(task)
  usage.turns += result.turns
  if (result.model && !usage.model) usage.model = result.model
  if (result.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + result.costUsd
  if (result.usage) {
    usage.inputTokens = (usage.inputTokens ?? 0) + result.usage.inputTokens
    usage.outputTokens = (usage.outputTokens ?? 0) + result.usage.outputTokens
  }
  return result
}

export interface ReviewPromptInput {
  repo: string
  mergeRequest: { id: number; title: string; description: string }
  files: readonly FileScope[]
  mode: 'full' | 'incremental'
  previousHead?: string
  guidelines: readonly Guideline[]
  /**
   * The resolved Guide (repository rules files, team rules, policies, generated text, notes); it
   * replaces the plain `guidelines` block when given.
   */
  guide?: string
  instructions?: string
  /** REVIEW.md path rules that match files in scope, with those files. */
  pathInstructions?: readonly { glob: string; text: string; files: readonly string[] }[]
  /** Deterministic findings to turn into comments with suggestions, in the project's style. */
  requests?: readonly { path: string; line: number; text: string; category: string }[]
  threads: readonly OpenThread[]
  maxComments: number
  /**
   * Set when this pass reviews one part of a split diff: its 1-based `index`, the `count` of
   * parts, and every file in scope of the merge request.
   */
  part?: { index: number; count: number; files: readonly string[] }
  language?: string
  /**
   * `false` for a repository with no tests by design: the prompt does not ask about tests, and the
   * `tests` category stays only for `requests` of that category.
   */
  tests?: false
  /** The modern Go guidelines section (`goGuidelinesSection`), placed before the diff. */
  goGuidelines?: string
  /** The computed dependency section (`dependencySection`), placed before the diff. */
  dependencies?: string
}

const severityGuide = (tests: boolean) =>
  [
    '- critical: security holes, data loss, crashes in common paths.',
    '- major: wrong behavior, broken edge cases, race conditions, missing error handling that will bite.',
    `- minor: maintainability problems, ${tests ? 'missing tests for new logic, ' : ''}misleading names, small inefficiencies.`,
    '- info: optional remarks; use sparingly.',
  ].join('\n')

/** Prompt rule: whatever the prose language, code and technical terms stay in English. */
export const KEEP_ENGLISH =
  'Keep code, identifiers, file paths, suggestion replacements and code comments inside them, commit messages and established technical terms (API, hook, race condition, retry, ...) in English, whatever the prose language.'

const GO_FILE = /(^|\/)(go\.mod|go\.sum|go\.work)$|\.go$/
const NPM_FILE = /(^|\/)package\.json$|\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/

/** Where the agent reads dependency versions: npm manifests, Go module files, or both. */
function dependencySources(input: ReviewPromptInput): string {
  const paths = input.part?.files ?? input.files.map((file) => file.path)
  const npm = 'package.json, lockfiles.resolve'
  const goSources = 'the go.mod of the module owning the file (go.sum for the exact version)'
  if (!paths.some((path) => GO_FILE.test(path))) return npm
  return paths.some((path) => NPM_FILE.test(path)) ? `${npm} (Go code: ${goSources})` : goSources
}

/** The system prompt: role, rules for lines and suggestions, severities, language. */
export function reviewSystemPrompt(input: ReviewPromptInput): string {
  const language = `${
    input.language
      ? `Write titles, bodies, the summary and the walkthrough in ${input.language}.`
      : 'Write titles, bodies, the summary and the walkthrough in the language of the merge request description (English when it has none).'
  } ${KEEP_ENGLISH}`
  const tests = input.tests !== false
  const requestedTests = !tests && (input.requests ?? []).some((r) => r.category === 'tests')
  const listed =
    tests || requestedTests ? categories : categories.filter((name) => name !== 'tests')
  const parts = [
    `You review merge request !${input.mergeRequest.id} of ${input.repo}. The checkout is at the merge request head; use the read and search tools to look at surrounding code${tests ? ', callers and tests' : ' and callers'} instead of guessing.`,
    `Dependencies are usually not installed (node_modules or the module cache may be missing). Check how the change uses a dependency with the package tools you have before saying it cannot be checked: the organization’s own packages are in the API catalog (search_symbols by export name, then get_symbol or get_package_api, passing \`version\` = the version this repository depends on, from ${dependencySources(input)} or repo_packages), third-party libraries in the library tools. Packages defined in this checkout: read their source here; the catalog shows indexed versions, not this merge request.`,
    [
      'Rules:',
      '- Report only real problems the change introduces or exposes. No praise, no restating the diff, no nitpicks a formatter or linter would catch.',
      '- `line` (and `startLine` for a range) are new-side line numbers exactly as listed in the diff. Comment only on lines marked `+`; lines marked `~` were reviewed before.',
      '- A `suggestion.replacement` replaces exactly the full lines `startLine..line` (or just `line`): include their complete new text with indentation, and nothing from the lines around them. Suggest only when you are sure the replacement is correct.',
      `- At most ${input.maxComments} comments; when there are more, keep the most severe.`,
      `- Categories: ${listed.join(', ')}.${requestedTests ? ' Use `tests` only for the lines the checks flagged with it.' : ''}`,
      '- Do not repeat open threads listed in the prompt.',
      '- Lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, go.sum) are usually left out of the diff and too large for the search tools, so a search that finds nothing in them proves nothing. Never claim that a lockfile lacks a package, has a wrong entry or must be updated unless the computed dependency section or lockfiles.resolve says so; when the section says a lockfile is consistent, do not ask to update it.',
      '- verdict is `needs-changes` when any major or critical problem remains, `looks-good` otherwise.',
      '- `walkthrough`: the changes in scope grouped by logical change, most important first; each entry lists its files and says in one or two sentences what changed and why. Group related files instead of listing each one.',
      '- `effort`: how hard this change is for a human to review, 1 (trivial) to 5 (large or subtle, needs a careful look).',
      language,
    ].join('\n'),
    [
      'How to review:',
      `- Go through every changed file in the diff. Before judging a change, open the code around it, its callers and the code paths it touches with the tools; the larger the diff, the more you read.`,
      '- Check error paths, retries and idempotency, edge cases (empty, missing, boundary values), concurrency and ordering, and the contract with callers (types, return values, side effects).',
      '- Report every distinct problem you find, up to the comment limit; do not stop after the first one. A single comment on a large change is right only when the rest really is clean.',
    ].join('\n'),
    `Severity:\n${severityGuide(tests)}`,
  ]
  return parts.join('\n\n')
}

/**
 * The stable context block (the Guide, or the repository guidelines without one, then the run's
 * own instructions) passed as the task's `context`, so adapters can cache it across runs; empty
 * when there is nothing.
 */
export function reviewContext(input: ReviewPromptInput): string {
  const parts: string[] = []
  if (input.guide?.trim()) parts.push(input.guide.trim())
  else if (input.guidelines.length)
    parts.push(
      `Project guidelines from the repository:\n\n${input.guidelines.map((g) => `### ${g.file}\n\n${g.text}`).join('\n\n')}`,
    )
  if (input.instructions?.trim())
    parts.push(`Review instructions for this run:\n\n${input.instructions.trim()}`)
  return parts.join('\n\n')
}

/** The task prompt: the merge request, open threads and the numbered diff of the files in scope. */
export function reviewPrompt(input: ReviewPromptInput): string {
  const description = input.mergeRequest.description.trim().slice(0, 3000)
  const diff = input.files
    .map((file) => renderNumberedDiff(file.path, file.hunks, file.lines))
    .filter(Boolean)
    .join('\n\n')
  const pathRules = (input.pathInstructions ?? []).map((rule) => {
    const files = rule.files.slice(0, 5).join(', ') + (rule.files.length > 5 ? ', ...' : '')
    return `- \`${rule.glob}\` (${files}): ${rule.text}`
  })
  const requests = (input.requests ?? []).map(
    (r) => `- ${r.path}:${r.line} (${r.category}): ${r.text.replace(/\s+/g, ' ').slice(0, 400)}`,
  )
  const threads = input.threads.map(
    (t) => `- ${t.path}:${t.line} ${t.text.replace(/\s+/g, ' ').slice(0, 160)}`,
  )
  return [
    `# ${input.mergeRequest.title}`,
    description ? `Description:\n\n${description}` : 'The merge request has no description.',
    input.mode === 'incremental'
      ? `This is an incremental review: only lines added since ${input.previousHead?.slice(0, 12)} are marked \`+\`.`
      : '',
    pathRules.length
      ? `Rules for paths in this diff (from REVIEW.md), apply them to the matching files:\n${pathRules.join('\n')}`
      : '',
    requests.length
      ? `Checks flagged these lines. Comment on each one that is right, with that category, severity \`minor\` and a \`suggestion\` that fixes it in the style the note describes (for a missing test attribute: add the project's attribute with a short value unique within the component, named like the examples). Skip the ones that are wrong; they count toward the comment limit:\n${requests.join('\n')}`
      : '',
    input.part
      ? `The diff is split for review; this is part ${input.part.index} of ${input.part.count}. Comment only on lines of the diff below, and read the other files of the merge request when the change depends on them. Every file in scope:\n${input.part.files.map((path) => `- ${path}`).join('\n')}`
      : '',
    threads.length ? `Open threads (do not repeat them):\n${threads.join('\n')}` : '',
    input.dependencies?.trim() ?? '',
    input.goGuidelines?.trim() ?? '',
    `Diff:\n\n${diff}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface AgentReviewOptions {
  agent: Agent
  dir: string
  input: ReviewPromptInput
  usage: ReviewUsage
  /** Run on the `deep` model tier instead of `main`. */
  deep?: boolean
  toolsets?: readonly Toolset[]
  /** Turn limit of each agent pass. Default 40. */
  maxTurns?: number
  signal?: AbortSignal
}

/** Changed lines above which an answer given without reading any code is followed up once. */
export const INVESTIGATE_MIN_LINES = 80
/** Files above which an answer given without reading any code is followed up once. */
export const INVESTIGATE_MIN_FILES = 3
/** Changed lines above which the diff is split into parts reviewed by separate passes. */
export const SPLIT_MAX_LINES = 600
/** Files above which the diff is split into parts reviewed by separate passes. */
export const SPLIT_MAX_FILES = 12
/** Parts of a split diff reviewed at once. */
export const SPLIT_CONCURRENCY = 3

const INVESTIGATE_FOLLOW_UP =
  'You answered without opening any code, but this diff is too large to judge from the diff alone. Inspect the changed files, their callers and the code paths they touch with the tools, then answer again with the complete JSON: every problem you find, including those from your previous answer, not only new ones.'

/** Lines a file contributes to the size of a review: in-scope added lines when incremental. */
const weightOf = (file: FileScope, mode: ReviewPromptInput['mode']) =>
  mode === 'incremental' ? file.lines.size : changedLineCount(file.hunks)

const sizeOf = (files: readonly FileScope[], mode: ReviewPromptInput['mode']) =>
  files.reduce((sum, file) => sum + weightOf(file, mode), 0)

/**
 * Splits the files in scope into parts of at most `SPLIT_MAX_FILES` files that keep files of one
 * directory together and balance changed lines; one part when the diff is within
 * `SPLIT_MAX_LINES` and `SPLIT_MAX_FILES`. A directory that alone exceeds a limit is cut in path
 * order, and a single file larger than `SPLIT_MAX_LINES` forms its own part. Files keep their
 * diff order inside a part.
 */
export function splitReviewFiles(
  files: readonly FileScope[],
  mode: ReviewPromptInput['mode'],
): FileScope[][] {
  const total = sizeOf(files, mode)
  if (total <= SPLIT_MAX_LINES && files.length <= SPLIT_MAX_FILES) return [[...files]]
  const directories = new Map<string, FileScope[]>()
  for (const file of files) {
    const directory = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
    directories.set(directory, [...(directories.get(directory) ?? []), file])
  }
  const pieces: FileScope[][] = []
  for (const group of directories.values()) {
    let piece: FileScope[] = []
    for (const file of group.toSorted((a, b) => a.path.localeCompare(b.path))) {
      if (
        piece.length &&
        (piece.length >= SPLIT_MAX_FILES ||
          sizeOf(piece, mode) + weightOf(file, mode) > SPLIT_MAX_LINES)
      ) {
        pieces.push(piece)
        piece = []
      }
      piece.push(file)
    }
    if (piece.length) pieces.push(piece)
  }
  const count = Math.max(
    Math.ceil(total / SPLIT_MAX_LINES),
    Math.ceil(files.length / SPLIT_MAX_FILES),
  )
  const parts: FileScope[][] = Array.from({ length: count }, () => [])
  for (const piece of pieces.toSorted((a, b) => sizeOf(b, mode) - sizeOf(a, mode))) {
    const open = parts
      .filter((part) => part.length + piece.length <= SPLIT_MAX_FILES)
      .toSorted((a, b) => sizeOf(a, mode) - sizeOf(b, mode))[0]
    if (open) open.push(...piece)
    else parts.push([...piece])
  }
  const order = new Map(files.map((file, index) => [file.path, index]))
  return parts
    .filter((part) => part.length)
    .map((part) => part.toSorted((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)))
}

/** The prompt input of one part: its files, and the requests, threads and path rules on them. */
function partInput(
  input: ReviewPromptInput,
  files: readonly FileScope[],
  index: number,
  count: number,
): ReviewPromptInput {
  const paths = new Set(files.map((file) => file.path))
  const pathInstructions = (input.pathInstructions ?? []).flatMap((rule) => {
    const matching = rule.files.filter((path) => paths.has(path))
    return matching.length ? [{ ...rule, files: matching }] : []
  })
  const requests = (input.requests ?? []).filter((request) => paths.has(request.path))
  const { pathInstructions: _rules, requests: _requests, ...rest } = input
  return {
    ...rest,
    files,
    threads: input.threads.filter((thread) => paths.has(thread.path)),
    ...(pathInstructions.length ? { pathInstructions } : {}),
    ...(requests.length ? { requests } : {}),
    part: { index, count, files: input.files.map((file) => file.path) },
  }
}

type ReviewPass = Pick<AgentReview, 'summary' | 'verdict' | 'walkthrough' | 'effort'> & {
  candidates: Candidate[]
}

/** `toolsets` plus the `lockfiles` toolset, unless one of that name is already there. */
const withLockfileTools = (toolsets: readonly Toolset[] = []): Toolset[] =>
  toolsets.some((toolset) => toolset.name === 'lockfiles')
    ? [...toolsets]
    : [...toolsets, lockfileTools()]

async function reviewPass(options: AgentReviewOptions, input: ReviewPromptInput) {
  const context = reviewContext(input)
  const investigate =
    input.files.length > INVESTIGATE_MIN_FILES ||
    sizeOf(input.files, input.mode) > INVESTIGATE_MIN_LINES
  const result = await runTracked(
    options.agent,
    {
      dir: options.dir,
      system: reviewSystemPrompt(input),
      prompt: reviewPrompt(input),
      ...(context ? { context } : {}),
      capabilities: ['read', 'search'],
      output: agentReviewSchema,
      taskKind: 'review',
      tier: options.deep ? 'deep' : 'main',
      toolsets: withLockfileTools(options.toolsets),
      maxTurns: options.maxTurns ?? 40,
      ...(investigate ? { followUpWithoutTools: INVESTIGATE_FOLLOW_UP } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    options.usage,
  )
  const review = result.output ?? {
    comments: [],
    summary: result.text,
    verdict: 'looks-good' as const,
  }
  return {
    candidates: review.comments.map((comment) => ({ ...comment, source: 'agent' })),
    summary: review.summary,
    verdict: review.verdict,
    ...(review.walkthrough?.length ? { walkthrough: review.walkthrough } : {}),
    ...(review.effort ? { effort: review.effort } : {}),
  } satisfies ReviewPass
}

const isBudgetStop = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'BudgetExceededError' || isBudgetStop(error.cause))

async function settledInParallel<Item, Result>(
  items: readonly Item[],
  limit: number,
  signal: AbortSignal | undefined,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  const results: PromiseSettledResult<Result>[] = []
  const queue = [...items.entries()]
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      if (signal?.aborted) return
      const [index, item] = entry
      try {
        // oxlint-disable-next-line no-await-in-loop -- a worker takes one item at a time
        results[index] = { status: 'fulfilled', value: await work(item, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  signal?.throwIfAborted()
  return results
}

/**
 * Asks the agent for a structured review on the `main` tier (`deep` with `options.deep`); comments
 * come back as unvalidated candidates. A diff over `SPLIT_MAX_LINES` or `SPLIT_MAX_FILES` is
 * split with `splitReviewFiles` and each part reviewed by its own pass (`SPLIT_CONCURRENCY` at
 * once, each with `maxTurns`); their candidates are concatenated, summaries joined, walkthroughs
 * concatenated, `effort` is the highest and the verdict the worst. A failed part does not lose
 * the others: its files are listed as not reviewed in the summary and the verdict becomes
 * `needs-changes`. The review fails when every part fails, a spend limit stops a part, or the run
 * is aborted. A pass over more than `INVESTIGATE_MIN_FILES` files or `INVESTIGATE_MIN_LINES`
 * changed lines that answers without reading any code is followed up once
 * (`followUpWithoutTools`). Every pass adds to `usage`.
 */
export async function runAgentReview(options: AgentReviewOptions): Promise<ReviewPass> {
  const parts = splitReviewFiles(options.input.files, options.input.mode)
  if (parts.length <= 1) return reviewPass(options, options.input)
  const settled = await settledInParallel(
    parts,
    SPLIT_CONCURRENCY,
    options.signal,
    (files, index) => reviewPass(options, partInput(options.input, files, index + 1, parts.length)),
  )
  const errors = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  const passes = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const stop = errors.find(isBudgetStop)
  if (stop || !passes.length) throw stop ?? errors[0]
  const failed = parts.filter((_, index) => settled[index]?.status !== 'fulfilled')
  const walkthrough = passes.flatMap((pass) => pass.walkthrough ?? [])
  const effort = Math.max(0, ...passes.map((pass) => pass.effort ?? 0))
  const notReviewed = failed.flat().map((file) => `\`${file.path}\``)
  return {
    candidates: passes.flatMap((pass) => pass.candidates),
    summary: [
      ...passes.map((pass) => pass.summary.trim()),
      notReviewed.length
        ? `Not reviewed, a review pass failed on these files: ${notReviewed.join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    verdict:
      failed.length || passes.some((pass) => pass.verdict === 'needs-changes')
        ? 'needs-changes'
        : 'looks-good',
    ...(walkthrough.length ? { walkthrough } : {}),
    ...(effort ? { effort } : {}),
  }
}

const recheckSchema = z.object({
  threads: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['fixed', 'still-relevant', 'unclear']),
      note: z.string(),
    }),
  ),
})

export type RecheckVerdict = z.infer<typeof recheckSchema>['threads'][number]

/**
 * Asks the cheaper triage model whether each of our earlier comments still applies to the code at
 * the current head. Threads the answer leaves out count as `unclear`.
 */
export async function recheckThreads(options: {
  agent: Agent
  dir: string
  threads: readonly { thread: OpenThread; code: string }[]
  usage: ReviewUsage
  language?: string
  toolsets?: readonly Toolset[]
  signal?: AbortSignal
}): Promise<Map<string, RecheckVerdict>> {
  if (options.threads.length === 0) return new Map()
  const items = options.threads.map(
    ({ thread, code }) =>
      `## Thread ${thread.discussionId} at ${thread.path}:${thread.line}\n\nComment:\n${thread.text}\n\nCode now:\n\`\`\`\n${code}\n\`\`\``,
  )
  const result = await runTracked(
    options.agent,
    {
      dir: options.dir,
      system: [
        'You check whether earlier code review comments were addressed. For each thread answer `fixed` when the problem is gone from the current code, `still-relevant` when it remains, `unclear` when you cannot tell. Read the files when the excerpt is not enough.',
        'note: one short sentence for the author explaining your answer.',
        `${options.language ? `Write notes in ${options.language}.` : 'Write notes in the language of the comment.'} ${KEEP_ENGLISH}`,
      ].join('\n'),
      prompt: items.join('\n\n'),
      capabilities: ['read', 'search'],
      output: recheckSchema,
      taskKind: 'triage',
      tier: 'fast',
      ...(options.toolsets ? { toolsets: options.toolsets } : {}),
      maxTurns: 12,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    options.usage,
  )
  return new Map((result.output?.threads ?? []).map((verdict) => [verdict.id, verdict]))
}

const localizedSchema = z.object({
  items: z.array(z.object({ id: z.number().int(), title: z.string(), body: z.string() })),
})

/**
 * `candidates` with titles and bodies translated into `language` by one `fast` call without
 * tools; code, numbers and technical terms stay as they are. Returns the input unchanged for
 * English, for an empty list, and when the call fails or answers something unusable.
 */
export async function localizeFindings(options: {
  agent: Agent
  dir: string
  language: string
  candidates: readonly Candidate[]
  usage: ReviewUsage
  signal?: AbortSignal
}): Promise<Candidate[]> {
  const { candidates, language } = options
  if (candidates.length === 0 || /^en(glish)?\b/i.test(language.trim())) return [...candidates]
  try {
    const result = await runTracked(
      options.agent,
      {
        dir: options.dir,
        system: [
          `Translate code review findings into ${language}. Translate only the prose of each title and body; keep Markdown, code spans, file paths, numbers, units and arrows exactly as they are.`,
          KEEP_ENGLISH,
          'Answer with every item, keeping its id.',
        ].join('\n'),
        prompt: JSON.stringify({
          items: candidates.map((c, id) => ({ id, title: c.title, body: c.body })),
        }),
        capabilities: [],
        output: localizedSchema,
        taskKind: 'triage',
        tier: 'fast',
        maxTurns: 1,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.usage,
    )
    const byId = new Map((result.output?.items ?? []).map((item) => [item.id, item]))
    return candidates.map((candidate, id) => {
      const item = byId.get(id)
      return item?.title.trim() && item.body.trim()
        ? { ...candidate, title: item.title.trim(), body: item.body.trim() }
        : candidate
    })
  } catch {
    return [...candidates]
  }
}
