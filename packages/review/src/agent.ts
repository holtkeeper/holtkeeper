import type { Agent, AgentResult, AgentTask, Toolset } from '@holtkeeper/agent'
import { lockfileTools } from '@holtkeeper/agent-tools'
import type { IssueDetails } from '@holtkeeper/issues'
import { z } from 'zod'

import { type OpenThread, sameFinding, severityRank } from './dedupe.ts'
import { changedLineCount, renderNumberedDiff } from './diff.ts'
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

/** A cross-file scenario the cross-part pass must trace: a flow through the changed code. */
export interface ReviewScenario {
  title: string
  /** Changed files the scenario crosses. */
  files: readonly string[]
  /** What to check along the way. */
  check: string
}

export interface ReviewPromptInput {
  repo: string
  mergeRequest: { id: number; title: string; description: string }
  /**
   * Tickets the merge request names, as read from the issue tracker; only tickets that were
   * actually read, so the prompt never points at one the agent cannot see.
   */
  tickets?: readonly IssueDetails[]
  files: readonly FileScope[]
  mode: 'full' | 'incremental'
  previousHead?: string
  /** The resolved rules (panel rules, repository rules files, policies, learnings). */
  guide?: string
  instructions?: string
  /** REVIEW.md path rules that match files in scope, with those files. */
  pathInstructions?: readonly { glob: string; text: string; files: readonly string[] }[]
  /** Deterministic findings to turn into comments with suggestions, in the project's style. */
  requests?: readonly { path: string; line: number; text: string; category: string }[]
  threads: readonly OpenThread[]
  /** Our resolved threads: fixed, withdrawn or left to the author; the agent must not raise them again. */
  settled?: readonly OpenThread[]
  maxComments: number
  /**
   * Set when this pass reviews one part of a split diff: its 1-based `index`, the `count` of
   * parts, and every file in scope of the merge request.
   */
  part?: { index: number; count: number; files: readonly string[] }
  /**
   * Set for the cross-part pass after a split review: what the parts already reported (`path`,
   * `line`, `title`) and their walkthrough entries (`change (files)`), so this pass looks only for
   * problems that span parts and writes one walkthrough of the whole merge request.
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
    /** Cross-file scenarios to trace one by one (`planScenarios`), numbered from 1. */
    scenarios?: readonly ReviewScenario[]
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
    'Category: `bug` for anything that makes the program do the wrong thing or leave out what it should do (a missing call, event, log record, check or request), `maintainability` only for code that works but is hard to read or change. Over the comment limit, findings about behavior are kept before tests, maintainability, docs and style.',
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
    `Dependencies are usually not installed (node_modules or the module cache may be missing). Check how the change uses a dependency with the package tools you have before saying it cannot be checked: the organization’s own packages and third-party libraries answer through the same tools (find_packages by export name, then package_api with \`symbol\` or \`query\`; versions default to what this repository uses, from ${dependencySources(input)}); package_docs has the docs of third-party libraries and package_source reads the code of both, so read the implementation when the behavior matters, not only the declaration. Packages defined in this checkout: read their source here; the package tools show indexed versions, not this merge request.`,
    [
      'Rules:',
      '- Report only real problems the change introduces or exposes. No praise, no restating the diff, no nitpicks a formatter or linter would catch.',
      '- `line` (and `startLine` for a range) are new-side line numbers exactly as listed in the diff. Comment only on lines marked `+`; lines marked `~` were reviewed before.',
      '- A `suggestion.replacement` replaces exactly the full lines `startLine..line` (or just `line`): include their complete new text with indentation, and nothing from the lines around them. Suggest only when you are sure the replacement is correct.',
      `- At most ${input.maxComments} comments; when there are more, keep the most severe.`,
      `- Categories: ${listed.join(', ')}.${requestedTests ? ' Use `tests` only for the lines the checks flagged with it.' : ''}`,
      '- Do not repeat open threads listed in the prompt, and do not raise again the resolved threads listed there: they were fixed, withdrawn after discussion or left to the author.',
      '- `summary`: what the change does and the problems you report in this answer. Do not restate open or resolved threads in it; the review counts earlier threads itself.',
      '- Ground findings in code you read. A claim about code outside the diff (a caller, a guard that does or does not exist, another method relying on a value, a test that is missing) should come from reading that code with the tools: list what you read in `evidence` (path, line, what it shows).',
      '- Do not drop a suspicion because you could not prove it. When something looks wrong but a premise is still open after you looked (you ran out of turns, the code path is too indirect), report it with `unverified: true`: a second reviewer checks every such finding against the code and posts it only when it holds, so a missed bug costs more than a suspicion that turns out wrong. Write its title and body as the problem it would be (what breaks, when), and say in `evidence` what you read; do not write that you did not check something. Leave `unverified` out for findings you confirmed.',
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
      '- Investigate every suspicious pattern instead of explaining it away: a flag reset in one path but not another, state kept across calls, a case the old code handled and the new one does not, an early return, an ordering assumption. When in doubt, look closer and report.',
      '- Report every distinct problem you find, up to the comment limit; do not stop after the first one. A single comment on a large change is right only when the rest really is clean.',
    ].join('\n'),
    packageRules(input),
    `Severity:\n${severityGuide(tests)}`,
  ]
  return parts.join('\n\n')
}

/** Prompt block on dependencies and public API: when to reach for the package tools and how. */
function packageRules(input: ReviewPromptInput): string {
  const paths = input.part?.files ?? input.files.map((file) => file.path)
  const go = paths.some((path) => GO_FILE.test(path))
  return [
    'Packages and public API:',
    '- A dependency version change (the computed dependency section lists `a → b`): call package_changes with `package`, `from` = a and `to` = b: it returns the API diff, for a third-party library its changelog, and the uses the upgrade affects. Report the uses in this checkout the change breaks or that need a check, at the changed manifest line, with the affected files named. No comment when nothing used changed.',
    '- A change to the public API of a package other repositories import (exports removed, renamed or with a new signature, a type or interface changed, behavior a caller relies on): call package_usage for the package, then with `export` for the code of the uses of the changed export, and say which repositories and how many uses break. Without users outside this repository, judge it as an internal change. A breaking change needs a major version bump; say so when the change ships under a minor or patch release.',
    '- Before flagging code as reinventing something, find_packages for an organization package that already offers it; report only an exact equivalent the repository could import, as `minor`.',
    ...(go
      ? [
          '- Go: packages under `internal/` and `main` packages cannot be imported by other modules, so their changes only reach callers in this module: find those with the search tools, not the package tools. Exported identifiers of other packages are public API: adding a method to an exported interface breaks every type outside the module that implements it, and removing or changing an exported function, method, field or constant breaks its callers. A new major version of a module changes its import path (`/v2`); a breaking change without it is a problem.',
          '- Go: the version this repository uses is the `require` line of the go.mod that owns the file (a `replace` with a local path means the code is in this checkout). Pass it as `version` to package_api, so the signatures you check against are the ones this code compiles with.',
        ]
      : []),
  ].join('\n')
}

/**
 * The stable context block (the resolved rules, then the run's own instructions) passed as the task's `context`, so adapters can cache it across runs; empty
 * when there is nothing.
 */
export function reviewContext(input: ReviewPromptInput): string {
  const parts: string[] = []
  if (input.guide?.trim()) parts.push(input.guide.trim())
  if (input.instructions?.trim())
    parts.push(`Review instructions for this run:\n\n${input.instructions.trim()}`)
  return parts.join('\n\n')
}

/** Characters of a ticket's description in a prompt. */
export const TICKET_PROMPT_CHARS = 3000

/** The prompt block of the tickets the merge request names; empty without any. */
export function ticketBlock(tickets: readonly IssueDetails[] = []): string {
  if (!tickets.length) return ''
  const entries = tickets.map((ticket) => {
    const facts = [ticket.type, ticket.status].filter(Boolean).join(', ')
    const description = ticket.description?.trim().slice(0, TICKET_PROMPT_CHARS)
    return [
      `### ${ticket.key}${facts ? ` (${facts})` : ''}: ${ticket.title.replace(/\s+/g, ' ')}`,
      description || 'The ticket has no description.',
    ].join('\n\n')
  })
  return [
    `${tickets.length === 1 ? 'The ticket this merge request implements' : 'The tickets this merge request names'}, from the issue tracker. ${tickets.length === 1 ? 'It says' : 'They say'} what the change is meant to do: check the change against it and report where the code contradicts it or leaves out something it asks for, at the changed line it concerns, as for any other finding. A ticket may be outdated or broader than this merge request; do not report work the merge request does not claim to do.`,
    ...entries,
  ].join('\n\n')
}

const threadLine = (t: OpenThread) =>
  `- ${t.path}:${t.line} ${t.text.replace(/\s+/g, ' ').slice(0, 160)}`

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
  const threads = input.threads.map(threadLine)
  const settled = (input.settled ?? []).map(threadLine)
  return [
    `# ${input.mergeRequest.title}`,
    description ? `Description:\n\n${description}` : 'The merge request has no description.',
    ticketBlock(input.tickets),
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
      ? `The diff is split for review; this is part ${input.part.index} of ${input.part.count}. Comment only on lines of the diff below, and read the other files of the merge request when the change depends on them. You are the only reviewer of these lines: before you answer, read with the tools the code each changed function relies on and its callers, and check the cases the change has to handle; an answer after a read or two misses problems. Every file in scope:\n${input.part.files.map((path) => `- ${path}`).join('\n')}`
      : '',
    input.crossPart ? crossPartBlock(input.crossPart) : '',
    threads.length ? `Open threads (do not repeat them):\n${threads.join('\n')}` : '',
    settled.length
      ? `Resolved threads (fixed, withdrawn or left to the author; do not raise them again):\n${settled.join('\n')}`
      : '',
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
 * Where an agent review is: `review` when its passes start and each time a pass over a part
 * finishes (`parts` counts those passes, second passes included, and is 1 for a diff reviewed in
 * one pass), `cross` when the cross-part pass of a split review starts.
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
    cross.walkthrough.length
      ? 'Your `walkthrough` replaces the walkthroughs of the parts: merge their entries into one list by logical change, most important first, each file in one entry where it fits, without mentioning parts.'
      : '',
    cross.findings.some((f) => f.id !== undefined)
      ? 'In `duplicates`, list the already reported findings that describe the same problem as another one in the list (often the same omission seen from two files) as `{ id, of }`, where `of` is the one to keep; leave it empty when there are none.'
      : '',
    cross.walkthrough.length
      ? `Walkthroughs of the parts (change and its files):\n${cross.walkthrough.map((line) => `- ${line}`).join('\n')}`
      : '',
    summaries.length
      ? `Summaries of the parts:\n${summaries.map((text) => `- ${text.replace(/\s+/g, ' ')}`).join('\n')}`
      : '',
    findings.length ? `Already reported (do not repeat):\n${findings.join('\n')}` : '',
    scenarioChecklist(cross.scenarios),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The cross-part pass's mandatory checklist of scenarios; empty without any. */
function scenarioChecklist(scenarios: readonly ReviewScenario[] = []): string {
  if (!scenarios.length) return ''
  return [
    'Scenarios to trace (mandatory): each is a flow through several changed files where a bug is likely. Take them one by one: follow the flow through the code with the tools (the diffs of its files, the code they call and the state they share), check what it says to check, and report every problem you find on the way, at the changed line that causes it. A scenario may be wrong or harmless; then move on. In `scenarios`, answer for each by its number: `problem` when you reported something for it, `fine` when you traced it and it holds, `not-checked` when you did not get to it.',
    scenarios
      .map(
        (scenario, index) =>
          `${index + 1}. ${scenario.title.replace(/\s+/g, ' ')} (${scenario.files.join(', ')}): ${scenario.check.replace(/\s+/g, ' ')}`,
      )
      .join('\n'),
  ].join('\n')
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
 * When review passes clear older tool results: only once the results in the conversation pass
 * about 100k tokens, a guard for the context window, not a saving. Clearing changes the cached
 * prefix, so the provider writes the conversation after it again at 1.25x the input price, while
 * keeping a result costs a cache read (0.05x) per later turn: clearing early costs more.
 */
export const REVIEW_TRIM = { maxChars: 400_000, keepLast: 8 } as const

/**
 * Shares of `costLimitUsd` each pass may spend before it is asked for its answer: a diff reviewed
 * in one pass, all parts of a split one together, its cross-part pass, and the verification.
 */
export const REVIEW_BUDGET_SHARES = { single: 0.6, parts: 0.55, cross: 0.25, verify: 0.25 } as const

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

/**
 * Reasoning effort of a part's pass. At the `main` tier's medium effort parts answered after a
 * read or two and left the work to the cross-part pass; high effort keeps them on the cheaper tier.
 */
export const PART_EFFORT = 'high' as const
/** Turn limit of the cross-part pass of a split review, before its scenarios. */
export const CROSS_PART_TURNS = 30

/** Scenarios `planScenarios` keeps for the cross-part pass. */
export const SCENARIO_MAX = 6
/** Turns the cross-part pass gets per scenario on top of `CROSS_PART_TURNS`. */
export const SCENARIO_TURNS = 3
/** Characters of numbered diff the scenario planner reads; files past it are listed by path. */
export const SCENARIO_DIFF_MAX_CHARS = 200_000

/**
 * Changed lines of logic (code that is not a test, story, style, fixture, translation, config or
 * docs) from which a part of a split review gets a second, independent pass.
 */
export const SECOND_PASS_MIN_LINES = 150
/** Parts of a split review that get a second pass at most: those with the most logic lines. */
export const SECOND_PASS_MAX_PARTS = 2

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

/**
 * The prompt input of one part: its files (in reverse order for a second pass, so it reads them
 * differently), and the requests, threads and path rules on them.
 */
function partInput(
  input: ReviewPromptInput,
  files: readonly FileScope[],
  index: number,
  count: number,
  second = false,
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
    files: second ? files.toReversed() : files,
    threads: input.threads.filter((thread) => paths.has(thread.path)),
    ...(input.settled && {
      settled: input.settled.filter((thread) => paths.has(thread.path)),
    }),
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
      guide: 'Rules',
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
        scenarios: [{ title: 'Scenario', files: ['src/a.ts', 'src/b.ts'], check: 'Check' }],
      },
      tickets: [
        { key: 'ABC-1', title: 'Ticket', type: 'Story', status: 'Open', description: 'Text' },
      ],
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
      scenarioPrompt(everything),
      SCENARIO_SYSTEM,
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
        PART_EFFORT,
        SCENARIO_MAX,
        SCENARIO_TURNS,
        SCENARIO_DIFF_MAX_CHARS,
        SECOND_PASS_MIN_LINES,
        SECOND_PASS_MAX_PARTS,
        TICKET_PROMPT_CHARS,
        NOT_LOGIC_FOLDER.source,
        NOT_LOGIC_FILE.source,
      ]),
    ])
      hasher.update(`${text}\u0000`)
    return `p-${hasher.digest('hex').slice(0, 8)}`
  })()
  return cachedPromptVersion
}

const NOT_LOGIC_FOLDER =
  /(?:^|\/)(?:__tests__|__mocks__|__snapshots__|__fixtures__|tests?|fixtures?|testdata|e2e|locales?|i18n|translations|docs?|stories)\//i
const NOT_LOGIC_FILE =
  /\.(?:test|spec|stories|story|styles?|styled|css|d)\.[^/.]+$|_test\.go$|\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|md|mdx|txt|json|jsonc|ya?ml|toml|ini|lock|snap|html?|xml|csv|po|sum|mod)$/i

/**
 * Whether a file holds logic a second review pass is worth: code, not tests, stories, styles,
 * fixtures, translations, config, docs or assets.
 */
export const isLogicFile = (path: string): boolean =>
  !NOT_LOGIC_FOLDER.test(path) && !NOT_LOGIC_FILE.test(path)

/**
 * Indexes of the parts of a split review that get a second pass: those with at least
 * `SECOND_PASS_MIN_LINES` changed lines of logic (`isLogicFile`), the most first, at most
 * `SECOND_PASS_MAX_PARTS`, in part order.
 */
export function riskyParts(
  parts: readonly (readonly FileScope[])[],
  mode: ReviewPromptInput['mode'],
): number[] {
  return parts
    .map((files, index) => ({
      index,
      lines: sizeOf(
        files.filter((file) => isLogicFile(file.path)),
        mode,
      ),
    }))
    .filter((part) => part.lines >= SECOND_PASS_MIN_LINES)
    .toSorted((a, b) => b.lines - a.lines)
    .slice(0, SECOND_PASS_MAX_PARTS)
    .map((part) => part.index)
    .toSorted((a, b) => a - b)
}

/**
 * The findings of a second pass over the same part joined to the first pass's: a finding that
 * reports the same problem as one of `first` (`sameFinding`) is folded into it, which takes the higher severity, stays a suspicion only when
 * both were, and keeps its own evidence or else the other's; the rest are added.
 */
export function mergePassFindings(
  first: readonly Candidate[],
  second: readonly Candidate[],
): Candidate[] {
  const merged = [...first]
  for (const candidate of second) {
    const at = merged.findIndex(
      (other, index) => index < first.length && sameFinding(other, candidate),
    )
    const target = merged[at]
    if (!target) {
      merged.push(candidate)
      continue
    }
    const { unverified: _either, ...rest } = target
    merged[at] = {
      ...rest,
      ...(severityRank(candidate.severity) > severityRank(target.severity) && {
        severity: candidate.severity,
      }),
      ...(target.unverified && candidate.unverified && { unverified: true }),
      ...(!target.evidence?.length &&
        candidate.evidence?.length && { evidence: candidate.evidence }),
    }
  }
  return merged
}

const scenarioSchema = z.object({
  scenarios: z.array(
    z.object({
      title: z.string(),
      files: z.array(z.string()),
      check: z.string(),
    }),
  ),
})

const SCENARIO_SYSTEM = [
  'You plan the review of a merge request that is too large for one reviewer: separate passes review its parts, and a final pass looks across them. Name the scenarios that final pass must trace: concrete flows through several changed files where a bug is likely and no single file shows it.',
  'Good scenarios follow state and time across modules: an action and its undo or retry, an action after another one removed or changed the data it relies on, two inputs at once (two touches, double clicks, concurrent requests), a failure halfway, a reload, reconnect or restart, a flag or cache set in one place and read in another, a contract between a changed module and its callers. Name the concrete actions, not categories.',
  `List at most ${SCENARIO_MAX}, the likeliest bugs first. Each has a short \`title\`, the changed \`files\` it crosses (paths as listed) and \`check\`: one or two sentences on what must hold along the way. Leave out scenarios inside one file, styling, naming, tests and documentation. When the change has no such flows, answer with an empty list.`,
  KEEP_ENGLISH,
].join('\n')

/** The scenario planner's prompt: the merge request, its ticket and as much of the diff as fits. */
function scenarioPrompt(input: ReviewPromptInput): string {
  let room = SCENARIO_DIFF_MAX_CHARS
  const diffs: string[] = []
  const unseen: string[] = []
  for (const file of input.files) {
    const text = renderNumberedDiff(file.path, file.hunks, file.lines)
    if (!text) continue
    if (text.length <= room) {
      diffs.push(text)
      room -= text.length
    } else unseen.push(file.path)
  }
  const description = input.mergeRequest.description.trim().slice(0, 3000)
  return [
    `# ${input.mergeRequest.title}`,
    description ? `Description:\n\n${description}` : '',
    ticketBlock(input.tickets),
    unseen.length
      ? `Changed files whose diff is left out:\n${unseen.map((path) => `- ${path}`).join('\n')}`
      : '',
    `Diff:\n\n${diffs.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Cross-file scenarios for the cross-part pass of a split review, from one call on the `fast` tier
 * without tools (task kind `review-plan`) over the merge request, its tickets and its diff: at
 * most `SCENARIO_MAX`, with files outside the merge request left out. Empty when the call fails
 * or finds none; an abort is rethrown.
 */
export async function planScenarios(options: AgentReviewOptions): Promise<ReviewScenario[]> {
  const paths = new Set(options.input.files.map((file) => file.path))
  try {
    const result = await runTracked(
      options.agent,
      {
        dir: options.dir,
        system: SCENARIO_SYSTEM,
        prompt: scenarioPrompt(options.input),
        capabilities: [],
        output: scenarioSchema,
        taskKind: 'review-plan',
        tier: 'fast',
        maxTurns: 1,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.usage,
      { label: 'scenario plan', log: options.log },
    )
    return (result.output?.scenarios ?? [])
      .map((scenario) => ({
        title: scenario.title.trim(),
        check: scenario.check.trim(),
        files: scenario.files
          .map((path) => path.replace(/^\.?\//, ''))
          .filter((path) => paths.has(path)),
      }))
      .filter((scenario) => scenario.title && scenario.check)
      .slice(0, SCENARIO_MAX)
  } catch (error) {
    options.signal?.throwIfAborted()
    options.log?.(`scenario plan failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

type ReviewPass = Pick<
  AgentReview,
  'summary' | 'verdict' | 'walkthrough' | 'effort' | 'reviewMinutes' | 'duplicates' | 'scenarios'
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
  effort?: 'high',
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
      ...(effort ? { effort } : {}),
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
    candidates: review.comments.map(({ evidence, unverified, ...comment }) => ({
      ...comment,
      source: 'agent',
      ...(evidence?.length ? { evidence: evidence.slice(0, MAX_EVIDENCE) } : {}),
      ...(unverified && { unverified: true }),
    })),
    summary: review.summary,
    verdict: review.verdict,
    ...(review.walkthrough?.length ? { walkthrough: review.walkthrough } : {}),
    ...(review.effort ? { effort: review.effort } : {}),
    ...(review.reviewMinutes ? { reviewMinutes: review.reviewMinutes } : {}),
    ...(review.duplicates?.length ? { duplicates: review.duplicates } : {}),
    ...(review.scenarios?.length ? { scenarios: review.scenarios } : {}),
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
  scenarios: readonly ReviewScenario[],
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
          walkthrough: walkthrough.map((step) => `${step.change} (${step.files.join(', ')})`),
          summaries: passes.map((done) => done.summary),
          ...(scenarios.length ? { scenarios } : {}),
        },
      },
      options.maxTurns ?? CROSS_PART_TURNS + SCENARIO_TURNS * scenarios.length,
      options.deep ? 'deep' : 'main',
      REVIEW_BUDGET_SHARES.cross,
      'cross-part pass',
    )
    if (scenarios.length) {
      const answers = new Map((pass.scenarios ?? []).map((answer) => [answer.id, answer.result]))
      const results = scenarios.map((_, index) => answers.get(index + 1) ?? 'not-checked')
      const count = (result: string) => results.filter((value) => value === result).length
      options.log?.(
        `scenarios traced: ${count('problem')} with a problem, ${count('fine')} fine, ${count('not-checked')} not checked of ${scenarios.length}`,
      )
    }
    // Its effort and review time would repeat the parts'.
    return {
      candidates: pass.candidates,
      summary: pass.summary,
      verdict: pass.verdict,
      ...(pass.walkthrough?.length ? { walkthrough: pass.walkthrough } : {}),
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
 * Asks the agent for a structured review; comments come back as unvalidated candidates, the
 * agent's unconfirmed suspicions marked `unverified`. A diff within `SPLIT_MAX_LINES` and
 * `SPLIT_MAX_FILES` gets one pass on the `main` tier (`deep` with `options.deep`). A larger one is
 * split with `splitReviewFiles` and each part reviewed by its own pass on the `main` tier
 * (`SPLIT_CONCURRENCY` at once, each with `maxTurns`, by default `reviewTurns` capped at
 * `PART_MAX_TURNS`); the parts with the most logic (`riskyParts`) get a second, independent pass
 * with their files in reverse order, whose findings are joined to the first's
 * (`mergePassFindings`). Meanwhile `planScenarios` lists cross-file scenarios. Then one cross-part
 * pass (`CROSS_PART_TURNS` plus `SCENARIO_TURNS` per scenario, on the `deep` tier with
 * `options.deep`) reviews the whole diff for problems spanning parts, told what the parts found
 * and given the scenarios as a checklist. Its findings are added, the part findings it names as
 * duplicates dropped, and its summary and walkthrough replace the parts' (joined when it fails or
 * gives none), `effort` is the highest, `reviewMinutes` the sum of the parts' (absent when a part
 * failed) and the verdict the worst. The cross-part pass failing is ignored unless a spend limit
 * stopped it. A part fails only when all its passes fail, and does not lose the others: its files
 * are listed as not reviewed in the summary and the verdict becomes `needs-changes`. The review
 * fails when every part fails, a spend limit stops a pass, or the run is aborted. A pass over more
 * than `INVESTIGATE_MIN_FILES` files or `INVESTIGATE_MIN_LINES` changed lines that answers without
 * reading any code is followed up once (`followUpWithoutTools`). Every pass adds to `usage`;
 * `onProgress` hears when the passes start, as part passes finish and when the cross-part pass
 * starts.
 */
export async function runAgentReview(options: AgentReviewOptions): Promise<ReviewPass> {
  const parts = splitReviewFiles(options.input.files, options.input.mode)
  if (parts.length <= 1) {
    options.onProgress?.({ stage: 'review', parts: 1, done: 0 })
    return reviewPass(options, options.input)
  }
  const jobs = [
    ...parts.map((files, index) => ({ files, index, second: false })),
    ...riskyParts(parts, options.input.mode).flatMap((index) => {
      const files = parts[index]
      return files ? [{ files, index, second: true }] : []
    }),
  ]
  options.onProgress?.({ stage: 'review', parts: jobs.length, done: 0 })
  // Planned while the parts run; it only feeds the cross-part pass. Never rejects.
  const planned = planScenarios(options).catch((): ReviewScenario[] => [])
  let done = 0
  const settled = await settledInParallel(jobs, SPLIT_CONCURRENCY, options.signal, (job) =>
    reviewPass(
      options,
      partInput(options.input, job.files, job.index + 1, parts.length, job.second),
      options.maxTurns ?? Math.min(PART_MAX_TURNS, reviewTurns(job.files, options.input.mode)),
      'main',
      REVIEW_BUDGET_SHARES.parts / jobs.length,
      `review part ${job.index + 1}/${parts.length}${job.second ? ' (second pass)' : ''}`,
      PART_EFFORT,
    ).finally(() => {
      done++
      options.onProgress?.({ stage: 'review', parts: jobs.length, done })
    }),
  )
  const errors = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  const stop = errors.find(isBudgetStop)
  const byPart = parts.map((_, index) => {
    const [first, ...others] = jobs.flatMap((job, at) => {
      const result = settled[at]
      return job.index === index && result?.status === 'fulfilled' ? [result.value] : []
    })
    if (!first) return undefined
    const pass: ReviewPass = { ...first }
    for (const other of others) {
      const candidates = mergePassFindings(pass.candidates, other.candidates)
      options.log?.(
        `second pass over part ${index + 1}/${parts.length}: ${other.candidates.length} finding(s), ${candidates.length - pass.candidates.length} new`,
      )
      pass.candidates = candidates
      if (other.verdict === 'needs-changes') pass.verdict = other.verdict
    }
    return pass
  })
  const passes = byPart.filter((pass) => pass !== undefined)
  if (stop || !passes.length) throw stop ?? errors[0]
  const failed = parts.filter((_, index) => !byPart[index])
  const partWalkthrough = passes.flatMap((pass) => pass.walkthrough ?? [])
  const cross = await crossPartPass(options, parts.length, passes, partWalkthrough, await planned)
  const walkthrough = cross?.walkthrough?.length ? cross.walkthrough : partWalkthrough
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
      /** The author's reply asks or argues something one status sentence would not answer. */
      needsAnswer: z.boolean().optional(),
    }),
  ),
})

export type RecheckVerdict = z.infer<typeof recheckSchema>['threads'][number]

/**
 * Asks the cheaper triage model whether each of our earlier comments still applies to the code at
 * the current head. `changed` names the files changed since the last review, where a fix outside
 * the thread's own file may be. A thread's `reply` (the author's latest answer to the comment) is
 * shown with it, and `needsAnswer` says the reply wants more than the status note. Threads the
 * answer leaves out count as `unclear`.
 */
export async function recheckThreads(options: {
  agent: Agent
  dir: string
  threads: readonly { thread: OpenThread; code: string }[]
  changed?: readonly string[]
  usage: ReviewUsage
  language?: string
  toolsets?: readonly Toolset[]
  signal?: AbortSignal
}): Promise<Map<string, RecheckVerdict>> {
  if (options.threads.length === 0) return new Map()
  const items = options.threads.map(({ thread, code }) =>
    [
      `## Thread ${thread.discussionId} at ${thread.path}:${thread.line}`,
      `Comment:\n${thread.text}`,
      ...(thread.reply ? [`Reply of ${thread.reply.author}:\n${thread.reply.text}`] : []),
      `Code now:\n\`\`\`\n${code}\n\`\`\``,
    ].join('\n\n'),
  )
  const replied = options.threads.some(({ thread }) => thread.reply)
  const result = await runTracked(
    options.agent,
    {
      dir: options.dir,
      system: [
        'You check whether earlier code review comments were addressed. For each thread answer `fixed` when the problem is gone from the current code, `still-relevant` when it remains, `unclear` when you cannot tell. Read the files when the excerpt is not enough: a comment about a missing test is fixed by a test file, one about a caller by that caller.',
        'note: one short sentence for the author explaining your answer.',
        ...(replied
          ? [
              'Some threads show the reply of the author. Judge the code, not the claim: a reply saying it is fixed does not make it fixed, and say in the note what you still see. Set `needsAnswer` to true when the reply asks a question or argues that the comment is wrong, so one status sentence would not answer it.',
            ]
          : []),
        `${options.language ? `Write notes in ${options.language}.` : 'Write notes in the language of the comment.'} ${KEEP_ENGLISH}`,
      ].join('\n'),
      prompt: [
        ...(options.changed?.length
          ? [
              `Files changed since the last review (a fix may be in one of them, not only in the commented file):\n${options.changed.map((path) => `- ${path}`).join('\n')}`,
            ]
          : []),
        ...items,
      ].join('\n\n'),
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

const revisedSummarySchema = z.object({ summary: z.string() })

/**
 * `summary` without the claims of the `dropped` findings, which the verification refuted, by one
 * `fast` call without tools; the rest of the text, its language and Markdown stay. Returns
 * `summary` unchanged when nothing was dropped and when the call fails or answers an empty text.
 */
export async function reviseSummary(options: {
  agent: Agent
  dir: string
  summary: string
  dropped: readonly { title: string; reason: string }[]
  usage: ReviewUsage
  signal?: AbortSignal
}): Promise<string> {
  const { summary, dropped } = options
  if (!summary.trim() || dropped.length === 0) return summary
  try {
    const result = await runTracked(
      options.agent,
      {
        dir: options.dir,
        system: [
          'You edit the summary of a code review. A second reviewer refuted some of the findings, so they are not posted: remove every claim of the summary that rests on them, and fix sentences that count the problems or call them already reported.',
          'Change nothing else: keep the language, the wording, the Markdown and the other findings. Do not mention the removed findings or that the summary was edited.',
          'Answer with the whole revised summary.',
        ].join('\n'),
        prompt: JSON.stringify({
          summary,
          refuted: dropped.map(({ title, reason }) => ({ title, reason })),
        }),
        capabilities: [],
        output: revisedSummarySchema,
        taskKind: 'triage',
        tier: 'fast',
        maxTurns: 1,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.usage,
    )
    return result.output?.summary.trim() || summary
  } catch {
    return summary
  }
}
