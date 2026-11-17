import type { Agent, AgentResult, AgentTask, Toolset } from '@holtkeeper/agent'
import { lockfileTools } from '@holtkeeper/agent-tools'
import { z } from 'zod'

import { type OpenThread, severityRank } from './dedupe.ts'
import { changedLineCount, renderNumberedDiff } from './diff.ts'
import type { Guideline } from './guidelines.ts'
import { type AgentReview, type ReviewUsage, agentReviewSchema, categories } from './schema.ts'
import type { FileScope } from './scope.ts'
import type { Candidate } from './validate.ts'

/**
 * Runs a task and adds its turns, cost and token counts to `usage`; the first run that names its
 * model sets `usage.model`. With `report`, logs one line on what the run cost under its label,
 * including the size of its first request (`startTokens`), so a growing fixed context shows.
 */
export async function runTracked<Output>(
  agent: Agent,
  task: AgentTask<Output>,
  usage: ReviewUsage,
  report?: { label: string; log?: ((line: string) => void) | undefined },
): Promise<AgentResult<Output>> {
  const result = await agent.run(task)
  usage.turns += result.turns
  if (result.model && !usage.model) usage.model = result.model
  if (result.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + result.costUsd
  if (result.usage) {
    usage.inputTokens = (usage.inputTokens ?? 0) + result.usage.inputTokens
    usage.outputTokens = (usage.outputTokens ?? 0) + result.usage.outputTokens
  }
  if (report?.log) report.log(`${report.label}: ${runSummary(result)}`)
  return result
}

const thousands = (tokens: number) => `${Math.round(tokens / 1000)}k`

/** One run's turns, prompt tokens, first request size and cost, for a log line. */
export function runSummary(result: AgentResult): string {
  const { usage } = result
  const prompt = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0
  return [
    `${result.turns} turns`,
    ...(usage ? [`${thousands(prompt)} prompt tokens`] : []),
    ...(result.startTokens === undefined ? [] : [`${thousands(result.startTokens)} at the start`]),
    ...(result.costUsd === undefined ? [] : [`$${result.costUsd.toFixed(2)}`]),
  ].join(', ')
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
  /**
   * Set for the cross-part pass after a split review: what the parts already reported (`path`,
   * `line`, `title`) and their walkthrough, so this pass looks only for problems that span parts.
   */
  crossPart?: {
    parts: number
    /** The parts' findings; `id` is the number the pass names in `duplicates`. */
    findings: readonly {
      id?: number
      path: string
      line: number
      title: string
      severity?: Candidate['severity']
    }[]
    walkthrough: readonly string[]
    /** The parts' summaries, which the pass's summary replaces. */
    summaries?: readonly string[]
  }
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
  /**
   * The computed public API changes between the merge request's base and head (packages other
   * code imports), placed before the diff.
   */
  apiChanges?: string
  /**
   * The computed impact of the changed declarations of this pass (callers, readers and writers,
   * tests), placed before the diff.
   */
  impact?: string
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
      '- Ground every finding in code you read. A claim about code outside the diff (a caller, a guard that does or does not exist, another method relying on a value, a test that is missing) must come from reading that code with the tools: list what you read in `evidence` (path, line, what it shows). If you could not check a premise, check it now or leave the finding out; never post a finding that says you did not check something.',
      '- Before calling a flag, field or return value wrong, find every place that reads and writes it (code.references) and make sure your fix would not break one of them.',
      '- Lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, go.sum) are usually left out of the diff and too large for the search tools, so a search that finds nothing in them proves nothing. Never claim that a lockfile lacks a package, has a wrong entry or must be updated unless the computed dependency section or lockfiles.resolve says so; when the section says a lockfile is consistent, do not ask to update it.',
      '- verdict is `needs-changes` when any major or critical problem remains, `looks-good` otherwise.',
      '- `walkthrough`: the changes in scope grouped by logical change, most important first; each entry lists its files and says in one or two sentences what changed and why. Group related files instead of listing each one.',
      '- `effort`: how hard this change is for a human to review, 1 (trivial) to 5 (large or subtle, needs a careful look).',
      '- `reviewMinutes`: how many minutes an experienced developer of this team needs to review the diff in this prompt carefully (read it, check the logic, leave comments), not counting waiting or fixing. Judge by what the code is: declarative styles, constants, config, generated or repeated code are skimmed in minutes; new logic, state, concurrency and contracts take the time. For orientation: a trivial change takes about 5 minutes, a simple one about 10, a moderate one about 25.',
      language,
    ].join('\n'),
    [
      'How to review:',
      ...(tests
        ? [
            '- Before saying tests are missing, look for them: the files in scope of the merge request (other parts of a split review included) and the test files of the checkout (`__tests__/`, `*.test.*`, `*.spec.*`, the computed impact section). Name the test file you looked at in `evidence`.',
          ]
        : []),
      `- Go through every changed file in the diff. Before judging a change, open the code around it, its callers and the code paths it touches with the tools; the larger the diff, the more you read.`,
      '- Check error paths, retries and idempotency, edge cases (empty, missing, boundary values), concurrency and ordering, and the contract with callers (types, return values, side effects).',
      '- Report every distinct problem you find, up to the comment limit; do not stop after the first one. A single comment on a large change is right only when the rest really is clean.',
    ].join('\n'),
    packageRules(input),
    `Severity:\n${severityGuide(tests)}`,
  ]
  return parts.join('\n\n')
}

/** Prompt block on dependencies and public API: when to reach for the catalog tools and how. */
function packageRules(input: ReviewPromptInput): string {
  const paths = input.part?.files ?? input.files.map((file) => file.path)
  const go = paths.some((path) => GO_FILE.test(path))
  return [
    'Packages and public API:',
    '- A dependency version change (the computed dependency section lists `a → b`): for an organization package call upgrade_impact with `package`, `from` = a, `to` = b and `repo` = this repository, and diff_versions for what changed; for a third-party library call library_changes between the two versions. Report the uses in this checkout the change breaks or that need a check, at the changed manifest line, with the affected files named. No comment when nothing used changed.',
    '- A change to the public API of a package other repositories import (exports removed, renamed or with a new signature, a type or interface changed, behavior a caller relies on): call package_usage or find_usages for the changed export and say which repositories and how many uses break. Without users outside this repository, judge it as an internal change. A breaking change needs a major version bump; say so when the change ships under a minor or patch release.',
    '- Before flagging code as reinventing something, search_symbols for an organization package that already offers it; report only an exact equivalent the repository could import, as `minor`.',
    ...(go
      ? [
          '- Go: packages under `internal/` and `main` packages cannot be imported by other modules, so their changes only reach callers in this module: find those with the search tools, not the catalog. Exported identifiers of other packages are public API: adding a method to an exported interface breaks every type outside the module that implements it, and removing or changing an exported function, method, field or constant breaks its callers. A new major version of a module changes its import path (`/v2`); a breaking change without it is a problem.',
          '- Go: the version this repository uses is the `require` line of the go.mod that owns the file (a `replace` with a local path means the code is in this checkout). Pass it as `version` to get_package_api and get_symbol, so the signatures you check against are the ones this code compiles with.',
        ]
      : []),
  ].join('\n')
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
  const diff = input.crossPart
    ? ''
    : input.files
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
    input.crossPart ? crossPartBlock(input.crossPart) : '',
    threads.length ? `Open threads (do not repeat them):\n${threads.join('\n')}` : '',
    input.dependencies?.trim() ?? '',
    input.apiChanges?.trim() ?? '',
    input.impact?.trim() ?? '',
    input.goGuidelines?.trim() ?? '',
    input.crossPart ? onDemandDiff(input.files, input.mode) : `Diff:\n\n${diff}`,
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
  /**
   * The computed impact section of the files one pass reviews (`impact` of its prompt input);
   * a failure or an empty answer leaves the section out.
   */
  impactFor?: (files: readonly FileScope[]) => Promise<string>
  toolsets?: readonly Toolset[]
  /** Turn limit of each agent pass. Default: `reviewTurns` of the pass's files. */
  maxTurns?: number
  /** Told when the passes start and as parts finish; must not throw. */
  onProgress?: (event: AgentProgress) => void
  /**
   * Soft spend limit of the whole review in USD, shared out by `REVIEW_BUDGET_SHARES`: a pass that
   * reaches its share is asked for its answer instead of reading on. No limit when unset or 0.
   */
  costLimitUsd?: number
  /** Gets one line per finished pass: turns, prompt tokens, first request size and cost. */
  log?: (line: string) => void
  signal?: AbortSignal
}

/**
 * Where an agent review is: `review` when its passes start and each time a part finishes (`parts`
 * is 1 for a diff reviewed in one pass), `cross` when the cross-part pass of a split review starts.
 */
export type AgentProgress =
  | { stage: 'review'; parts: number; done: number }
  | { stage: 'cross'; parts: number }

/** The prompt block of the cross-part pass: its task and what the parts already found. */
function crossPartBlock(cross: NonNullable<ReviewPromptInput['crossPart']>): string {
  const findings = cross.findings.map(
    (f) =>
      `- ${f.id === undefined ? '' : `[${f.id}] `}${f.path}:${f.line}${f.severity ? ` (${f.severity})` : ''} ${f.title.replace(/\s+/g, ' ').slice(0, 160)}`,
  )
  const summaries = (cross.summaries ?? []).map((text) => text.trim()).filter(Boolean)
  return [
    `This merge request was too large for one pass: ${cross.parts} separate passes reviewed it in parts, each seeing only its slice of the diff. This is the final pass over the whole diff. Look for what the parts could not see: contracts between changed modules and their callers in other parts, the same change applied differently in parallel code, state and lifecycle that cross files, and anything a part only skimmed. Read the code with the tools. Do not repeat a problem already reported; report only new ones.`,
    'Your `summary` replaces the summaries of the parts: write one summary of the whole merge request for its author, covering what it does and the main problems the parts and you found, without mentioning parts or passes.',
    cross.findings.some((f) => f.id !== undefined)
      ? 'In `duplicates`, list the already reported findings that describe the same problem as another one in the list (often the same omission seen from two files) as `{ id, of }`, where `of` is the one to keep; leave it empty when there are none.'
      : '',
    cross.walkthrough.length
      ? `What the parts found the change does:\n${cross.walkthrough.map((line) => `- ${line}`).join('\n')}`
      : '',
    summaries.length
      ? `Summaries of the parts:\n${summaries.map((text) => `- ${text.replace(/\s+/g, ' ')}`).join('\n')}`
      : '',
    findings.length ? `Already reported (do not repeat):\n${findings.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The cross-part pass's file list in place of the diff: the whole diff on every turn is what made
 * that pass the most expensive one, and it reads only the files it looks into.
 */
function onDemandDiff(files: readonly FileScope[], mode: ReviewPromptInput['mode']): string {
  return [
    `Files of the merge request with their changed lines. Read the numbered diff of a file with \`${MR_DIFF_TOOL}\` before you judge or comment on it; comment only on lines it marks \`+\`.`,
    files.map((file) => `- ${file.path} (${weightOf(file, mode)})`).join('\n'),
  ].join('\n')
}

/** Name of the tool that gives the cross-part pass one file's numbered diff. */
export const MR_DIFF_TOOL = 'mr.diff'

/**
 * The `mr` toolset of a pass: `mr.diff` answers the numbered diff of one file in `files`, as the
 * review prompt renders it, and an error listing the files for any other path.
 */
export function mergeRequestDiffTools(files: readonly FileScope[]): Toolset {
  const byPath = new Map(files.map((file) => [file.path, file]))
  return {
    name: 'mr',
    instructions: `\`${MR_DIFF_TOOL}\` gives the numbered diff of a file of this merge request.`,
    tools: [
      {
        name: MR_DIFF_TOOL,
        description:
          'The numbered diff of one file of this merge request: `+` lines are in scope for comments, `~` lines were reviewed before, `-` lines are removed.',
        input: z.object({ path: z.string().describe('Path of a file of the merge request') }),
        run: ({ path }: { path: string }) => {
          const file = byPath.get(path.replace(/^\.?\//, ''))
          if (!file)
            return `error: ${path} is not a file of this merge request; its files: ${[...byPath.keys()].join(', ')}`
          return renderNumberedDiff(file.path, file.hunks, file.lines) || '(no changed lines)'
        },
      },
    ],
  }
}

/** Lines `read_file` returns by default in review passes: enough for a function and its context. */
export const REVIEW_READ_LINES = 400

/**
 * When review passes clear older tool results: once the results in the conversation pass about
 * 15k tokens, all but the newest four long ones go.
 */
export const REVIEW_TRIM = { maxChars: 60_000, keepLast: 4 } as const

/**
 * Shares of `costLimitUsd` each pass may spend before it is asked for its answer: a diff reviewed
 * in one pass, all parts of a split one together, its cross-part pass, and the verification.
 */
export const REVIEW_BUDGET_SHARES = { single: 0.6, parts: 0.4, cross: 0.25, verify: 0.25 } as const

/** Evidence entries kept per finding. */
const MAX_EVIDENCE = 8

/** Turn limit of a review pass by default: 40, one more per file and per 15 changed lines. */
export const REVIEW_MIN_TURNS = 40
/** Upper bound of the default turn limit of a review pass. */
export const REVIEW_MAX_TURNS = 90
/**
 * Upper bound of the default turn limit of one part of a split review: a part sees a slice, and
 * the cross-part pass reads across slices.
 */
export const PART_MAX_TURNS = 50
/** Turn limit of the cross-part pass of a split review. */
export const CROSS_PART_TURNS = 30

/** The default turn limit of a pass over `files`: larger slices of a diff get more turns. */
export function reviewTurns(files: readonly FileScope[], mode: ReviewPromptInput['mode']): number {
  const lines = sizeOf(files, mode)
  return Math.min(REVIEW_MAX_TURNS, REVIEW_MIN_TURNS + files.length + Math.ceil(lines / 15))
}

/** Changed lines above which an answer given without reading any code is followed up once. */
export const INVESTIGATE_MIN_LINES = 80
/** Files above which an answer given without reading any code is followed up once. */
export const INVESTIGATE_MIN_FILES = 3
/** Changed lines above which the diff is split into parts reviewed by separate passes. */
export const SPLIT_MAX_LINES = 600
/** Files above which the diff is split into parts reviewed by separate passes. */
export const SPLIT_MAX_FILES = 12
/** Parts of a split diff reviewed at once; enough that usual splits run in a single wave. */
export const SPLIT_CONCURRENCY = 6

const INVESTIGATE_FOLLOW_UP =
  'You answered without opening any code, but this diff is too large to judge from the diff alone. Inspect the changed files, their callers and the code paths they touch with the tools, then answer again with the complete JSON: every problem you find, including those from your previous answer, not only new ones.'

/** Lines a file contributes to the size of a review: in-scope added lines when incremental. */
const weightOf = (file: FileScope, mode: ReviewPromptInput['mode']) =>
  mode === 'incremental' ? file.lines.size : changedLineCount(file.hunks)

const sizeOf = (files: readonly FileScope[], mode: ReviewPromptInput['mode']) =>
  files.reduce((sum, file) => sum + weightOf(file, mode), 0)

// Test, mock and snapshot folders belong to the code next to them, so a part sees its tests.
const SIDE_FOLDER = /\/(?:__tests__|__mocks__|__snapshots__|__fixtures__)(?=\/|$)/g

/** The folder a file is kept with when a diff is split: its own, minus test and mock folders. */
export function splitGroupOf(path: string): string {
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return `/${directory}`.replace(SIDE_FOLDER, '').slice(1)
}

/**
 * Splits the files in scope into parts of at most `SPLIT_MAX_FILES` files that keep files of one
 * directory together and balance changed lines; one part when the diff is within
 * `SPLIT_MAX_LINES` and `SPLIT_MAX_FILES`. A directory that alone exceeds a limit is cut in path
 * order, and a single file larger than `SPLIT_MAX_LINES` forms its own part. Files under
 * `__tests__`, `__mocks__`, `__snapshots__` and `__fixtures__` count as files of the folder above,
 * so tests stay in the part of the code they test. Files keep their
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
    const directory = splitGroupOf(file.path)
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

/** A one-line changed file, for the synthetic input `reviewPromptVersion` hashes. */
const sampleFile = (path: string): FileScope => ({
  path,
  oldPath: path,
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [{ kind: 'add', text: 'x', newLine: 1 }],
    },
  ],
  lines: new Set([1]),
  visible: new Map([[1, 'x']]),
})

/** A synthetic review prompt input for `reviewPromptVersion`. */
const sampleInput = (path: string, extra: Partial<ReviewPromptInput> = {}): ReviewPromptInput => ({
  repo: 'group/project',
  mergeRequest: { id: 1, title: 'Title', description: 'Description' },
  files: [sampleFile(path)],
  mode: 'full',
  guidelines: [],
  threads: [],
  maxComments: 15,
  ...extra,
})

let cachedPromptVersion: string | undefined

/**
 * A short fingerprint of everything the review agent is told and how its passes are cut: the
 * system prompt in each variant the code builds (with and without tests, npm and Go), the task
 * prompt with every optional block set, the follow-up text and the split and follow-up limits.
 * It changes whenever one of them does, so findings can be compared per prompt version without
 * anyone bumping a number. It does not cover the prompts of thread re-checks, replies and
 * translations.
 */
export function reviewPromptVersion(): string {
  cachedPromptVersion ??= (() => {
    const everything = sampleInput('src/a.ts', {
      mode: 'incremental',
      previousHead: 'abcdef0123456789',
      guide: 'Guide',
      instructions: 'Instructions',
      pathInstructions: [{ glob: 'src/**', text: 'Rule', files: ['src/a.ts'] }],
      requests: [{ path: 'src/a.ts', line: 1, text: 'Request', category: 'tests' }],
      threads: [
        {
          discussionId: 'd',
          path: 'src/a.ts',
          line: 1,
          text: 'Thread',
          ours: true,
          findingId: 'f',
        },
      ],
      part: { index: 1, count: 2, files: ['src/a.ts', 'src/b.ts'] },
      crossPart: {
        parts: 2,
        findings: [{ id: 1, path: 'src/a.ts', line: 1, title: 'T', severity: 'minor' }],
        walkthrough: ['W'],
        summaries: ['S'],
      },
      goGuidelines: 'Go guidelines',
      dependencies: 'Dependencies',
      apiChanges: 'API changes',
      impact: 'Impact',
    })
    const hasher = new Bun.CryptoHasher('sha256')
    for (const text of [
      reviewSystemPrompt(sampleInput('src/a.ts')),
      reviewSystemPrompt(sampleInput('src/a.ts', { tests: false })),
      reviewSystemPrompt(sampleInput('main.go')),
      reviewSystemPrompt(sampleInput('main.go', { tests: false, language: 'English' })),
      reviewSystemPrompt(sampleInput('main.go', { requests: everything.requests ?? [] })),
      reviewContext(everything),
      reviewPrompt(everything),
      INVESTIGATE_FOLLOW_UP,
      JSON.stringify([
        INVESTIGATE_MIN_LINES,
        INVESTIGATE_MIN_FILES,
        SPLIT_MAX_LINES,
        SPLIT_MAX_FILES,
        REVIEW_MIN_TURNS,
        REVIEW_MAX_TURNS,
        PART_MAX_TURNS,
        CROSS_PART_TURNS,
        REVIEW_READ_LINES,
        REVIEW_TRIM,
        REVIEW_BUDGET_SHARES,
      ]),
    ])
      hasher.update(`${text}\u0000`)
    return `p-${hasher.digest('hex').slice(0, 8)}`
  })()
  return cachedPromptVersion
}

type ReviewPass = Pick<
  AgentReview,
  'summary' | 'verdict' | 'walkthrough' | 'effort' | 'reviewMinutes' | 'duplicates'
> & {
  candidates: Candidate[]
}

/** `toolsets` plus the `lockfiles` toolset, unless one of that name is already there. */
const withLockfileTools = (toolsets: readonly Toolset[] = []): Toolset[] =>
  toolsets.some((toolset) => toolset.name === 'lockfiles')
    ? [...toolsets]
    : [...toolsets, lockfileTools()]

async function reviewPass(
  options: AgentReviewOptions,
  input: ReviewPromptInput,
  maxTurns = options.maxTurns ?? reviewTurns(input.files, input.mode),
  tier: 'main' | 'deep' = options.deep ? 'deep' : 'main',
  share: number = REVIEW_BUDGET_SHARES.single,
  label = 'review pass',
) {
  const answerAt = options.costLimitUsd ? options.costLimitUsd * share : undefined
  const impact = options.impactFor
    ? await options.impactFor(input.files).catch(() => {
        options.signal?.throwIfAborted()
        return ''
      })
    : ''
  if (impact) input = { ...input, impact }
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
      tier,
      toolsets: [
        ...withLockfileTools(options.toolsets),
        ...(input.crossPart ? [mergeRequestDiffTools(input.files)] : []),
      ],
      maxTurns,
      readLines: REVIEW_READ_LINES,
      trimToolResults: REVIEW_TRIM,
      ...(answerAt !== undefined && { answerAtCostUsd: answerAt }),
      ...(investigate ? { followUpWithoutTools: INVESTIGATE_FOLLOW_UP } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    options.usage,
    { label, log: options.log },
  )
  const review = result.output ?? {
    comments: [],
    summary: result.text,
    verdict: 'looks-good' as const,
  }
  return {
    candidates: review.comments.map(({ evidence, ...comment }) => ({
      ...comment,
      source: 'agent',
      ...(evidence?.length ? { evidence: evidence.slice(0, MAX_EVIDENCE) } : {}),
    })),
    summary: review.summary,
    verdict: review.verdict,
    ...(review.walkthrough?.length ? { walkthrough: review.walkthrough } : {}),
    ...(review.effort ? { effort: review.effort } : {}),
    ...(review.reviewMinutes ? { reviewMinutes: review.reviewMinutes } : {}),
    ...(review.duplicates?.length ? { duplicates: review.duplicates } : {}),
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
 * The final pass of a split review over the whole diff, looking for problems across parts, on the
 * `deep` tier with `options.deep`. It is told the parts' findings by number and their summaries;
 * its summary covers the whole merge request and its `duplicates` name part findings to drop.
 * `undefined` when it fails for another reason than a spend limit or an abort: the parts stand.
 */
async function crossPartPass(
  options: AgentReviewOptions,
  parts: number,
  passes: readonly ReviewPass[],
  walkthrough: NonNullable<ReviewPass['walkthrough']>,
): Promise<ReviewPass | undefined> {
  const { part: _part, ...input } = options.input
  options.onProgress?.({ stage: 'cross', parts })
  try {
    const pass = await reviewPass(
      options,
      {
        ...input,
        crossPart: {
          parts,
          findings: passes
            .flatMap((done) => done.candidates)
            .map((c, index) => ({
              id: index + 1,
              path: c.path,
              line: c.line,
              title: c.title,
              severity: c.severity,
            })),
          walkthrough: walkthrough.map((step) => step.change),
          summaries: passes.map((done) => done.summary),
        },
      },
      options.maxTurns ?? CROSS_PART_TURNS,
      options.deep ? 'deep' : 'main',
      REVIEW_BUDGET_SHARES.cross,
      'cross-part pass',
    )
    // Its walkthrough would repeat the parts'; findings, summary and duplicates count.
    return {
      candidates: pass.candidates,
      summary: pass.summary,
      verdict: pass.verdict,
      ...(pass.duplicates?.length ? { duplicates: pass.duplicates } : {}),
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    if (isBudgetStop(error)) throw error
    return undefined
  }
}

/**
 * `candidates` (numbered from 1 as the cross-part pass saw them) without the ones `duplicates`
 * names; each kept finding takes the highest severity of the duplicates folded into it. Pairs
 * naming an unknown number, the same finding, or a finding already dropped are ignored.
 */
export function dropDuplicates(
  candidates: readonly Candidate[],
  duplicates: readonly { id: number; of: number }[] = [],
): Candidate[] {
  const kept = [...candidates]
  const dropped = new Set<number>()
  for (const { id, of } of duplicates) {
    const target = kept[of - 1]
    const duplicate = kept[id - 1]
    if (!target || !duplicate || id === of || dropped.has(id) || dropped.has(of)) continue
    dropped.add(id)
    if (severityRank(duplicate.severity) > severityRank(target.severity))
      kept[of - 1] = { ...target, severity: duplicate.severity }
  }
  return kept.filter((_, index) => !dropped.has(index + 1))
}

/**
 * Asks the agent for a structured review; comments come back as unvalidated candidates. A diff
 * within `SPLIT_MAX_LINES` and `SPLIT_MAX_FILES` gets one pass on the `main` tier (`deep` with
 * `options.deep`). A larger one is split with `splitReviewFiles` and each part reviewed by its own
 * pass on the `main` tier (`SPLIT_CONCURRENCY` at once, each with `maxTurns`, by default
 * `reviewTurns` capped at `PART_MAX_TURNS`); then one cross-part pass (`CROSS_PART_TURNS`, on the
 * `deep` tier with `options.deep`) reviews the whole diff for problems spanning parts, told what
 * the parts found. Its findings are added, the part findings it names as duplicates dropped, and
 * its summary replaces the parts' (joined when it fails or has none); walkthroughs are
 * concatenated, `effort` is the highest, `reviewMinutes` the sum of the parts' (absent when a part
 * failed) and the verdict the worst. The cross-part pass failing is ignored unless a spend limit
 * stopped it. A failed part does not lose the others: its files are listed as not reviewed in the
 * summary and the verdict becomes `needs-changes`. The review fails when every part fails, a
 * spend limit stops a part, or the run is aborted. A pass over more than `INVESTIGATE_MIN_FILES`
 * files or `INVESTIGATE_MIN_LINES` changed lines that answers without reading any code is followed
 * up once (`followUpWithoutTools`). Every pass adds to `usage`; `onProgress` hears when the passes
 * start, as parts finish and when the cross-part pass starts.
 */
export async function runAgentReview(options: AgentReviewOptions): Promise<ReviewPass> {
  const parts = splitReviewFiles(options.input.files, options.input.mode)
  options.onProgress?.({ stage: 'review', parts: parts.length, done: 0 })
  if (parts.length <= 1) return reviewPass(options, options.input)
  let done = 0
  const settled = await settledInParallel(
    parts,
    SPLIT_CONCURRENCY,
    options.signal,
    (files, index) =>
      reviewPass(
        options,
        partInput(options.input, files, index + 1, parts.length),
        options.maxTurns ?? Math.min(PART_MAX_TURNS, reviewTurns(files, options.input.mode)),
        'main',
        REVIEW_BUDGET_SHARES.parts / parts.length,
        `review part ${index + 1}/${parts.length}`,
      ).finally(() => {
        done++
        options.onProgress?.({ stage: 'review', parts: parts.length, done })
      }),
  )
  const errors = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  const passes = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const stop = errors.find(isBudgetStop)
  if (stop || !passes.length) throw stop ?? errors[0]
  const failed = parts.filter((_, index) => settled[index]?.status !== 'fulfilled')
  const walkthrough = passes.flatMap((pass) => pass.walkthrough ?? [])
  const cross = await crossPartPass(options, parts.length, passes, walkthrough)
  const effort = Math.max(0, ...passes.map((pass) => pass.effort ?? 0))
  // Each part estimated its own slice; the cross-part pass gives none.
  const reviewMinutes = failed.length
    ? 0
    : passes.reduce((sum, pass) => sum + (pass.reviewMinutes ?? 0), 0)
  const notReviewed = failed.flat().map((file) => `\`${file.path}\``)
  const summaries = cross?.summary.trim()
    ? [cross.summary.trim()]
    : passes.map((pass) => pass.summary.trim())
  const all = cross ? [...passes, cross] : passes
  return {
    candidates: [
      ...dropDuplicates(
        passes.flatMap((pass) => pass.candidates),
        cross?.duplicates,
      ),
      ...(cross?.candidates ?? []),
    ],
    summary: [
      ...summaries,
      notReviewed.length
        ? `Not reviewed, a review pass failed on these files: ${notReviewed.join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    verdict:
      failed.length || all.some((pass) => pass.verdict === 'needs-changes')
        ? 'needs-changes'
        : 'looks-good',
    ...(walkthrough.length ? { walkthrough } : {}),
    ...(effort ? { effort } : {}),
    ...(reviewMinutes ? { reviewMinutes } : {}),
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
