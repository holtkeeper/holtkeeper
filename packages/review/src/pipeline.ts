import { join } from 'node:path'

import type { Agent, Toolset } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import type {
  DiffFile,
  Discussion,
  GitForge,
  MergeRequest,
  MergeRequestDiff,
  RepoRef,
  ReviewComment,
} from '@holtkeeper/forge'
import { type IssueDetails, issueKeysIn } from '@holtkeeper/issues'
import type { QualityCheck } from '@holtkeeper/quality'
import { type RepoRuleFile, type ResolvedRules, resolveRules } from '@holtkeeper/rules'
import type { AnalysisStore } from '@holtkeeper/store'

import {
  type AgentProgress,
  type RecheckVerdict,
  localizeFindings,
  reviseSummary,
  recheckThreads,
  reviewPromptVersion,
  runAgentReview,
} from './agent.ts'
import {
  type ReviewCheckName,
  agentCompletedChecks,
  deterministicFindings,
  findingId,
  reviewCheckNames,
} from './checks.ts'
import type { CitationStyle } from './cite.ts'
import {
  type OpenThread,
  dedupe,
  openThreads,
  rankAndCap,
  settledThreads,
  severityRank,
} from './dedupe.ts'
import { dependencySection } from './dependencies.ts'
import { DEFAULT_REVIEW_DEPTH, type ReviewDepth, resolveReviewDepth } from './depth.ts'
import { commentBody, isSummaryNote, summaryNote, threadNote } from './format.ts'
import { changedGoModules, goGuidelinesSection } from './go-guidelines/prompt.ts'
import type { GoGuidelineSet } from './go-guidelines/schema.ts'
import {
  type PathInstruction,
  ignoredInReviewMd,
  pathInstructionsInReviewMd,
  readCheckoutRules,
} from './guidelines.ts'
import { impactSection } from './impact.ts'
import { type MediaReviewer, noopMediaReviewer, reviewMedia } from './media.ts'
import { type ReviewMessages, englishReviewMessages } from './messages.ts'
import { withPhase } from './phase.ts'
import type { ReviewStage } from './progress.ts'
import {
  type ReviewData,
  type ReviewFinding,
  type ReviewSeverity,
  type ReviewSize,
  type ReviewUsage,
  type ReviewWalkthrough,
  type ThreadAction,
  reviewDataSchema,
} from './schema.ts'
import { type FileScope, type ReviewScope, matchesAny, scopeDiff } from './scope.ts'
import {
  DEFAULT_REVIEW_TIME_MODEL,
  DEFAULT_SIZE_THRESHOLDS,
  type ReviewTimeModel,
  type SizeThresholds,
  adviceTexts,
  estimateReviewMinutes,
  logicalChanges,
  planSplit,
  reviewSizeLevel,
  sizeEscalated,
  sizedFiles,
} from './size.ts'
import { type Candidate, validateCandidate } from './validate.ts'
import {
  type RefutedFinding,
  type Verification,
  dropUnverified,
  existingEvidence,
  verifyFindings,
} from './verify.ts'

/** Validated options of one review run; see the `review` analyzer for defaults. */
export interface ReviewOptions {
  mergeRequest: number
  mode: 'auto' | 'full' | 'incremental'
  maxComments: number
  minSeverity: ReviewSeverity
  includeChecks: boolean | ReviewCheckName[]
  approve: 'never' | 'when-clean'
  /**
   * Which of our unresolved summary threads to resolve after posting: `when-clean` (default) all
   * of them when the verdict is `looks-good`, `always` all of them after every posted review,
   * `never` none.
   */
  resolveSummary?: 'when-clean' | 'always' | 'never'
  /**
   * `standard` reviews on the `main` model tier (Sonnet), `deep` on the `deep` tier (Opus), `auto`
   * (default) on `deep` when the estimated review time of the files under review reaches
   * `deepFromMinutes` (see `resolveReviewDepth`).
   */
  depth?: ReviewDepth
  /** Estimated minutes from which `auto` reviews on the `deep` tier; default `DEFAULT_DEEP_FROM_MINUTES`. */
  deepFromMinutes?: number
  /**
   * A second agent pass tries to disprove the agent's findings before they are posted and drops
   * the ones the code contradicts (`verifyFindings`); on unless `false`. Without it, the agent's
   * unverified suspicions are dropped.
   */
  verify?: boolean
  /**
   * The computed impact section (callers, readers and writers, tests of the changed declarations)
   * in the review prompt; on unless `false`.
   */
  impact?: boolean
  ignore: string[]
  maxDiffLines: number
  language?: string
  instructions?: string
  /** How posted notes show the rules and learnings they cite; `link` unless set. */
  citations?: CitationStyle
  /** Answer the replies people left in our threads instead of reviewing. */
  replies?: boolean
  /** Reviews added or changed images with the injected `MediaReviewer`. */
  media: boolean
  /** `source:target` branch globs of release merge requests the analyzer does not review. */
  releaseBranches?: string[]
  /** Review merge requests Holtkeeper authored. */
  reviewOwn?: boolean
  /** Review even what `releaseBranches` and `reviewOwn` would skip. */
  force?: boolean
  /**
   * Modern Go guidelines in the prompt of merge requests changing Go modules; on unless `enabled`
   * is `false`. `tag` pins an upstream release.
   */
  goGuidelines?: { enabled: boolean; tag?: string }
  /**
   * The estimated human review time in the summary and, from `largeMinutes`, the advice to split
   * the merge request; on unless `enabled` is `false`. Thresholds default to
   * `DEFAULT_SIZE_THRESHOLDS`, the review time `model` to `DEFAULT_REVIEW_TIME_MODEL`.
   */
  sizeAdvice?: { enabled: boolean; model?: ReviewTimeModel } & Partial<SizeThresholds>
  /** How long the review took and what it cost in the summary note; on unless `false`. */
  showCost?: boolean
  /**
   * Soft spend limit of the agent passes in USD, split between them by `REVIEW_BUDGET_SHARES`: a
   * pass past its share answers with what it has instead of failing. Unset or `0`: no limit.
   */
  costLimitUsd?: number
}

/** Default `costLimitUsd` of the `review` analyzer. */
export const DEFAULT_REVIEW_COST_LIMIT_USD = 4.5

/** A forge with every method a review needs; `compareCommits`, replies and resolving stay optional. */
export type ReviewForge = GitForge &
  Required<
    Pick<GitForge, 'getMergeRequest' | 'getMergeRequestDiff' | 'listDiscussions' | 'submitReview'>
  >

const reviewMethods = [
  'getMergeRequest',
  'getMergeRequestDiff',
  'listDiscussions',
  'submitReview',
] as const

const isReviewForge = (forge: GitForge): forge is ReviewForge =>
  reviewMethods.every((method) => typeof forge[method] === 'function')

/** Narrows a forge to `ReviewForge` or throws naming what is missing. */
export function requireReviewForge(forge: GitForge): ReviewForge {
  if (isReviewForge(forge)) return forge
  const missing = reviewMethods.filter((method) => typeof forge[method] !== 'function')
  throw new Error(
    `forge ${forge.kind} cannot review merge requests (missing ${missing.join(', ')})`,
  )
}

/** The rules a review follows: the resolved text and where its included blocks come from, in order. */
export interface ReviewGuide {
  text: string
  sources: string[]
}

/** A `ReviewGuide` from resolved rules: their text and the sources of the blocks that made it in. */
export function reviewGuideOf(resolved: Pick<ResolvedRules, 'text' | 'blocks'>): ReviewGuide {
  return {
    text: resolved.text,
    sources: [
      ...new Set(resolved.blocks.filter((block) => block.text).map((block) => block.source)),
    ],
  }
}

/** Everything one review run uses. */
export interface ReviewRun {
  repo: RepoRef
  forge: ReviewForge
  /** Checkout at the merge request head. Without it there are no checks, rules files or agent. */
  dir?: string
  runner: CommandRunner
  agent?: Agent
  analyses?: AnalysisStore
  options: ReviewOptions
  /**
   * Shows the rule citations of a note before it is posted (`citationRenderer`); stored records
   * keep the text as the agent wrote it. Without it notes are posted as written.
   */
  cite?: (text: string) => Promise<string>
  checks?: Partial<Record<ReviewCheckName, QualityCheck>>
  /**
   * Resolves the rules of the review from the checkout's rules files and the changed files in
   * scope (panel rules, learnings and policies on top). Without it, or when it fails, the review
   * follows the repository's rules files alone.
   */
  guide?: (
    repoFiles: readonly RepoRuleFile[],
    files: readonly string[],
  ) => Promise<ReviewGuide | undefined>
  /** Passed to the agent as `toolsets`, e.g. code navigation and knowledge tools. */
  toolsets?: readonly Toolset[]
  /**
   * The public API changes of the merge request, computed from its base and head without storing
   * anything (Markdown for the prompt, `undefined` when nothing public changed). A failure leaves
   * the section out.
   */
  apiChanges?: (context: {
    dir: string
    baseSha: string
    files: readonly string[]
    signal?: AbortSignal
  }) => Promise<string | undefined>
  /**
   * The tickets among `keys` (ticket keys the merge request names) that can be read, with their
   * descriptions; tickets that do not exist or cannot be read are left out. Without it, or when it
   * fails or reads none, the prompt says nothing about tickets.
   */
  tickets?: (keys: readonly string[]) => Promise<IssueDetails[]>
  /**
   * `false` for a repository with no tests by design: the agent is not asked about tests and its
   * findings of category `tests` are dropped, except those completing a requested check finding
   * (test ids stay checked).
   */
  tests?: false
  botUsername?: string
  /** Reviews images when `options.media` is on. Default: a reviewer that reports nothing. */
  mediaReviewer?: MediaReviewer
  /**
   * The modern Go guidelines to use, for an optional pinned tag; without it the prompt never gets
   * a guidelines section.
   */
  goGuidelines?: (tag?: string) => Promise<GoGuidelineSet>
  /**
   * The fixed texts of the summary note, thread replies and skipped summaries, in the review
   * language. Default: English.
   */
  messages?: ReviewMessages
  /** Replaces pipeline steps, e.g. in tests or for another review strategy. */
  steps?: Partial<ReviewSteps>
  /**
   * Told as the review moves through its agent passes, the verification and posting (see
   * `ReviewStage`); must not throw. Steps replaced through `steps` report nothing of their own.
   */
  onProgress?: (stage: ReviewStage) => void
  log?: (line: string) => void
  signal?: AbortSignal
}

/** What the `load` step gathers. */
export interface LoadedReview {
  mr: MergeRequest & { headSha: string }
  diff: MergeRequestDiff
  discussions: Discussion[]
  threads: OpenThread[]
  /** Our resolved diff threads (`settledThreads`); findings that repeat them are dropped. */
  settled?: OpenThread[]
  /** The latest earlier review of this merge request that reviewed something. */
  previous?: ReviewData
}

/** What the `plan` step decides. */
export interface ReviewPlan {
  mode: 'full' | 'incremental'
  previousHead?: string
  scope: ReviewScope
  /**
   * The whole merge request minus ignored paths, when `scope` is narrowed to new commits; the
   * review time is estimated on it.
   */
  fullScope?: ReviewScope
  /** Files changed since `previousHead`, when incremental. */
  since?: DiffFile[]
  /** The checkout's rules files. */
  ruleFiles: RepoRuleFile[]
  /** Rules for paths from REVIEW.md's `## Paths` section. */
  pathInstructions?: PathInstruction[]
}

export interface AgentOutcome {
  candidates: Candidate[]
  summary: string
  verdict: 'looks-good' | 'needs-changes'
  walkthrough?: ReviewWalkthrough
  effort?: number
  /** The agent's estimate of a careful human review of the diff it saw, in minutes. */
  reviewMinutes?: number
  /** Where the rules that reached the agent come from, in prompt order. */
  ruleSources?: string[]
  /** `reviewPromptVersion()` of the prompts that were sent. */
  promptVersion?: string
  /** Whether the review ran on the `deep` tier. */
  deep?: boolean
}

/** The replaceable steps of a review. */
export interface ReviewSteps {
  load(run: ReviewRun): Promise<LoadedReview>
  plan(run: ReviewRun, loaded: LoadedReview): Promise<ReviewPlan>
  deterministic(
    run: ReviewRun,
    plan: ReviewPlan,
  ): Promise<{ candidates: Candidate[]; checks: ReviewData['checks'] }>
  agentReview(
    run: ReviewRun,
    loaded: LoadedReview,
    plan: ReviewPlan,
    usage: ReviewUsage,
    /** Deterministic findings the agent should turn into comments with suggestions. */
    requests?: readonly Candidate[],
  ): Promise<AgentOutcome | undefined>
  /** Image and inline SVG findings, translated into `options.language` when one is set. */
  media(
    run: ReviewRun,
    loaded: LoadedReview,
    usage?: ReviewUsage,
  ): Promise<{ candidates: Candidate[]; summary?: string } | undefined>
  recheck(
    run: ReviewRun,
    loaded: LoadedReview,
    plan: ReviewPlan,
    usage: ReviewUsage,
  ): Promise<Map<string, RecheckVerdict | 'gone'>>
  /**
   * Checks the agent's findings that are about to be posted and drops the ones the code
   * contradicts and the `unverified` suspicions it does not confirm; without an agent or with
   * `options.verify: false` everything but those suspicions stays. `kept` is in the order of
   * `candidates`.
   */
  verify(
    run: ReviewRun,
    loaded: LoadedReview,
    candidates: readonly Candidate[],
    usage: ReviewUsage,
  ): Promise<Verification>
  /**
   * The agent's `summary` without the claims of `refuted` findings; unchanged without an agent or
   * when the edit fails.
   */
  reviseSummary(
    run: ReviewRun,
    summary: string,
    refuted: readonly RefutedFinding[],
    usage: ReviewUsage,
  ): Promise<string>
  post(run: ReviewRun, loaded: LoadedReview, data: ReviewData): Promise<ReviewData>
}

/** The `ref` review records are stored under. */
export const reviewRef = (mergeRequest: number) => `!${mergeRequest}`

/** The newest stored review of a merge request, optionally only those that reviewed something. */
export async function previousReview(
  analyses: AnalysisStore,
  repo: RepoRef,
  mergeRequest: number,
  reviewedOnly = true,
): Promise<ReviewData | undefined> {
  const records = await analyses.list({ repo, kind: 'review', limit: 100 })
  for (const record of records) {
    if (record.ref !== reviewRef(mergeRequest)) continue
    const parsed = reviewDataSchema.safeParse(record.data)
    if (!parsed.success) continue
    if (!reviewedOnly || parsed.data.mode === 'full' || parsed.data.mode === 'incremental')
      return parsed.data
  }
  return undefined
}

/** Whether `ancestor` is an ancestor of `head` in the checkout. */
export async function isAncestor(
  runner: CommandRunner,
  dir: string,
  ancestor: string,
  head: string,
) {
  const result = await runner.run(['git', 'merge-base', '--is-ancestor', ancestor, head], {
    cwd: dir,
  })
  return result.exitCode === 0
}

const load: ReviewSteps['load'] = async (run) => {
  const id = run.options.mergeRequest
  const [mr, diff, discussions] = await Promise.all([
    run.forge.getMergeRequest(run.repo.path, id),
    run.forge.getMergeRequestDiff(run.repo.path, id),
    run.forge.listDiscussions(run.repo.path, id),
  ])
  const previous = run.analyses ? await previousReview(run.analyses, run.repo, id) : undefined
  return {
    mr,
    diff,
    discussions,
    threads: openThreads(discussions, run.botUsername),
    settled: settledThreads(discussions, run.botUsername),
    ...(previous ? { previous } : {}),
  }
}

/** `loaded` with the discussions read again; unchanged when the forge fails to list them. */
export async function withFreshThreads(
  run: Pick<ReviewRun, 'forge' | 'repo' | 'botUsername' | 'log'>,
  loaded: LoadedReview,
): Promise<LoadedReview> {
  try {
    const discussions = await run.forge.listDiscussions(run.repo.path, loaded.mr.id)
    return {
      ...loaded,
      discussions,
      threads: openThreads(discussions, run.botUsername),
      settled: settledThreads(discussions, run.botUsername),
    }
  } catch (error) {
    run.log?.(`reading threads again failed: ${errorText(error)}`)
    return loaded
  }
}

const plan: ReviewSteps['plan'] = async (run, loaded) => {
  const ruleFiles = run.dir ? await readCheckoutRules(run.runner, run.dir, run.signal) : []
  const reviewMd = ruleFiles.find((file) => file.path === 'REVIEW.md')
  const ignore = [...run.options.ignore, ...(reviewMd ? ignoredInReviewMd(reviewMd.text) : [])]
  const head = loaded.diff.refs.headSha
  const last = loaded.previous?.head

  let since: DiffFile[] | undefined
  if (run.options.mode !== 'full' && last && last !== head && run.forge.compareCommits) {
    const dir = run.dir
    const linear = dir ? await isAncestor(run.runner, dir, last, head) : true
    // An amended or force-pushed head on the same base: the tree diff from the last head is
    // exactly what the author changed. A rebase moves the base, and the diff would carry the
    // target branch's commits.
    const rewritten =
      !linear && dir ? await isAncestor(run.runner, dir, loaded.diff.refs.baseSha, last) : false
    if (linear || rewritten) {
      if (rewritten)
        run.log?.(
          `previous head ${last.slice(0, 8)} was rewritten on the same base; reviewing the changes since it`,
        )
      since = await run.forge.compareCommits(run.repo.path, last, head)
    } else
      run.log?.(
        `previous head ${last.slice(0, 8)} is not an ancestor of ${head.slice(0, 8)} and the base moved; reviewing everything`,
      )
  } else if (run.options.mode !== 'full' && last === head) since = []

  if (run.options.mode === 'incremental' && !since)
    run.log?.('no usable previous review; reviewing everything')
  return {
    mode: since ? 'incremental' : 'full',
    ...(since && last ? { previousHead: last, since } : {}),
    scope: scopeDiff(loaded.diff.files, { ignore, ...(since ? { since } : {}) }),
    ...(since ? { fullScope: scopeDiff(loaded.diff.files, { ignore }) } : {}),
    ruleFiles,
    ...(reviewMd ? { pathInstructions: pathInstructionsInReviewMd(reviewMd.text) } : {}),
  }
}

const deterministic: ReviewSteps['deterministic'] = async (run, planned) => {
  const wanted =
    run.options.includeChecks === true ? reviewCheckNames : run.options.includeChecks || []
  const checks = wanted.flatMap((name) => {
    const check = run.checks?.[name]
    if (!check) run.log?.(`check ${name} is not available`)
    return check ? [check] : []
  })
  if (!run.dir || checks.length === 0) return { candidates: [], checks: [] }
  const { candidates, tools } = await deterministicFindings({
    dir: run.dir,
    checks,
    runner: run.runner,
    files: filesOf(planned.scope),
    ...(run.signal ? { signal: run.signal } : {}),
  })
  return { candidates, checks: tools }
}

/** The modern Go guidelines section for the Go modules the scope changes; `''` when none apply. */
async function goGuidelinesFor(run: ReviewRun, files: readonly FileScope[]): Promise<string> {
  const settings = run.options.goGuidelines
  if (!run.goGuidelines || !run.dir || settings?.enabled === false) return ''
  const goFiles = files.filter((file) => file.path.endsWith('.go'))
  if (!goFiles.length) return ''
  try {
    const modules = await changedGoModules(
      run.dir,
      goFiles.map((file) => file.path),
    )
    if (!modules.length) return ''
    const set = await run.goGuidelines(settings?.tag)
    if (settings?.tag && set.tag !== settings.tag)
      run.log?.(`go guidelines ${settings.tag} are not available; using ${set.tag}`)
    const addedCode = goFiles
      .flatMap((file) => [...file.lines].map((line) => file.visible.get(line) ?? ''))
      .join('\n')
    const section = goGuidelinesSection({ set, modules, addedCode })
    run.log?.(
      `go guidelines ${set.tag} (${set.source}${set.fetchedAt ? `, fetched ${set.fetchedAt}` : ''}) for ${modules.map((module) => `${module.dir} go ${module.go}`).join(', ')}: ${section ? `${section.length} characters` : 'none apply'}`,
    )
    return section
  } catch (error) {
    run.log?.(`go guidelines skipped: ${errorText(error)}`)
    return ''
  }
}

/** The computed dependency section for the merge request; `''` when it touches no dependency file. */
async function dependenciesFor(run: ReviewRun, loaded: LoadedReview): Promise<string> {
  if (!run.dir) return ''
  const { baseSha } = loaded.diff.refs
  try {
    const section = await dependencySection({
      files: loaded.diff.files,
      dir: run.dir,
      readBase: (path) => run.forge.readFile(run.repo.path, path, baseSha),
    })
    if (section) run.log?.(`dependency changes computed: ${section.length} characters`)
    return section
  } catch (error) {
    run.log?.(`dependency changes skipped: ${errorText(error)}`)
    return ''
  }
}

/** Ticket keys of a merge request that are looked up for its review, at most. */
export const REVIEW_TICKETS_MAX = 2

/**
 * The readable tickets the merge request names: keys from its title, source branch (upper-cased,
 * so `feature/abc-1-x` counts) and description, in that order, at most `REVIEW_TICKETS_MAX`.
 */
async function ticketsFor(run: ReviewRun, loaded: LoadedReview): Promise<IssueDetails[]> {
  if (!run.tickets) return []
  const { title, sourceBranch, description } = loaded.mr
  const keys = issueKeysIn(title, sourceBranch.toUpperCase(), description).slice(
    0,
    REVIEW_TICKETS_MAX,
  )
  if (!keys.length) return []
  try {
    const tickets = await run.tickets(keys)
    run.log?.(
      tickets.length
        ? `ticket context: ${tickets.map((ticket) => ticket.key).join(', ')}`
        : `ticket context: none of ${keys.join(', ')} could be read`,
    )
    return tickets
  } catch (error) {
    run.signal?.throwIfAborted()
    run.log?.(`ticket context skipped: ${errorText(error)}`)
    return []
  }
}

async function apiChangesFor(
  run: ReviewRun,
  loaded: LoadedReview,
  files: readonly FileScope[],
): Promise<string> {
  if (!run.apiChanges || !run.dir) return ''
  try {
    const section = await run.apiChanges({
      dir: run.dir,
      baseSha: loaded.diff.refs.baseSha,
      files: files.map((file) => file.path),
      ...(run.signal ? { signal: run.signal } : {}),
    })
    if (section) run.log?.(`public API changes computed: ${section.length} characters`)
    return section ?? ''
  } catch (error) {
    run.signal?.throwIfAborted()
    run.log?.(`public API changes skipped: ${errorText(error)}`)
    return ''
  }
}

const agentReview: ReviewSteps['agentReview'] = async (run, loaded, planned, usage, requests) => {
  if (!run.agent || !run.dir) return undefined
  const dir = run.dir
  const goGuidelines = await goGuidelinesFor(run, planned.scope.files)
  const dependencies = await dependenciesFor(run, loaded)
  const apiChanges = await apiChangesFor(run, loaded, planned.scope.files)
  const tickets = await ticketsFor(run, loaded)
  const instructions = run.options.instructions?.trim()
  const changedPaths = planned.scope.files.map((f) => f.path)
  const resolved = run.guide
    ? await run.guide(planned.ruleFiles, changedPaths).catch((error: unknown) => {
        run.log?.(`rules lookup failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
    : undefined
  const guide =
    resolved ??
    reviewGuideOf(
      resolveRules({
        repo: { forge: run.repo.forge, path: run.repo.path, teams: [] },
        agent: 'review',
        files: changedPaths,
        rules: [],
        repoFiles: planned.ruleFiles,
        learnings: [],
      }),
    )
  const pathRules = (planned.pathInstructions ?? []).flatMap((rule) => {
    const files = planned.scope.files
      .map((f) => f.path)
      .filter((path) => matchesAny(path, [rule.glob]))
    return files.length ? [{ ...rule, files }] : []
  })
  const depth = resolveReviewDepth(
    run.options.depth ?? DEFAULT_REVIEW_DEPTH,
    planned.scope.files,
    run.options.deepFromMinutes,
  )
  run.log?.(
    `review depth: ${depth.deep ? 'deep' : 'standard'}${depth.minutes === undefined ? '' : ` (auto, estimated ${depth.minutes} min)`}`,
  )
  const outcome = await runAgentReview({
    agent: run.agent,
    dir: run.dir,
    usage,
    ...(run.options.costLimitUsd ? { costLimitUsd: run.options.costLimitUsd } : {}),
    ...(run.log ? { log: run.log } : {}),
    input: {
      repo: run.repo.path,
      mergeRequest: {
        id: loaded.mr.id,
        title: loaded.mr.title,
        description: loaded.mr.description,
      },
      ...(tickets.length ? { tickets } : {}),
      files: planned.scope.files,
      mode: planned.mode,
      ...(planned.previousHead ? { previousHead: planned.previousHead } : {}),
      ...(run.tests === false && { tests: false as const }),
      ...(guide.text ? { guide: guide.text } : {}),
      ...(instructions ? { instructions } : {}),
      ...(pathRules.length ? { pathInstructions: pathRules } : {}),
      ...(requests?.length
        ? {
            requests: requests.map((r) => ({
              path: r.path,
              line: r.line,
              text: r.body,
              category: r.category,
            })),
          }
        : {}),
      threads: loaded.threads,
      ...(loaded.settled?.length ? { settled: loaded.settled } : {}),
      maxComments: run.options.maxComments,
      ...(run.options.language ? { language: run.options.language } : {}),
      ...(goGuidelines ? { goGuidelines } : {}),
      ...(dependencies ? { dependencies } : {}),
      ...(apiChanges ? { apiChanges } : {}),
    },
    ...(depth.deep ? { deep: true } : {}),
    ...(run.options.impact === false
      ? {}
      : {
          impactFor: (files: readonly FileScope[]) =>
            impactSection({ dir, files, ...(run.signal ? { signal: run.signal } : {}) }),
        }),
    ...(run.toolsets ? { toolsets: run.toolsets } : {}),
    ...(run.onProgress && {
      onProgress: (event: AgentProgress) => run.onProgress?.({ ...event, deep: depth.deep }),
    }),
    ...(run.signal ? { signal: run.signal } : {}),
  })
  const versioned = {
    ...outcome,
    promptVersion: reviewPromptVersion(),
    ...(depth.deep ? { deep: true } : {}),
  }
  return guide.text && guide.sources.length
    ? { ...versioned, ruleSources: guide.sources }
    : versioned
}

const verify: ReviewSteps['verify'] = async (run, loaded, candidates, usage) => {
  if (!run.agent || !run.dir || run.options.verify === false) {
    const unchecked = dropUnverified(candidates)
    if (unchecked.refuted.length)
      run.log?.(`dropped ${unchecked.refuted.length} unverified suspicion(s) without verification`)
    return unchecked
  }
  const dir = run.dir
  const cited = await Promise.all(
    candidates.map(async (candidate) => {
      if (!candidate.evidence?.length) return candidate
      const evidence = await existingEvidence(dir, candidate.evidence)
      const { evidence: _all, ...rest } = candidate
      return evidence.length ? { ...rest, evidence } : rest
    }),
  )
  const findings = cited.filter((candidate) => candidate.source === 'agent').length
  if (findings) run.onProgress?.({ stage: 'verify', findings })
  const result = await verifyFindings({
    agent: run.agent,
    dir,
    candidates: cited,
    usage,
    mergeRequest: { title: loaded.mr.title, description: loaded.mr.description },
    ...(run.options.costLimitUsd ? { costLimitUsd: run.options.costLimitUsd } : {}),
    ...(run.toolsets ? { toolsets: run.toolsets } : {}),
    ...(run.signal ? { signal: run.signal } : {}),
    ...(run.log ? { log: run.log } : {}),
  })
  const suspicions = cited.filter((candidate) => candidate.unverified).length
  if (suspicions)
    run.log?.(
      `verification confirmed ${suspicions - result.refuted.filter((r) => r.candidate.unverified).length} of ${suspicions} unverified suspicion(s)`,
    )
  if (result.refuted.length)
    run.log?.(`verification dropped ${result.refuted.length} of ${candidates.length} finding(s)`)
  return result
}

const revise: ReviewSteps['reviseSummary'] = async (run, summary, refuted, usage) => {
  if (!run.agent || !run.dir) return summary
  return reviseSummary({
    agent: run.agent,
    dir: run.dir,
    summary,
    dropped: refuted
      .filter(({ candidate }) => candidate.source === 'agent')
      .map(({ candidate, reason }) => ({ title: candidate.title, reason })),
    usage,
    ...(run.signal ? { signal: run.signal } : {}),
  })
}

const media: ReviewSteps['media'] = async (run, loaded, usage) => {
  if (!run.options.media) return undefined
  const outcome = await reviewMedia({
    reviewer: run.mediaReviewer ?? noopMediaReviewer,
    forge: run.forge,
    repo: run.repo,
    mergeRequest: loaded.mr.id,
    refs: loaded.diff.refs,
    files: loaded.diff.files,
  })
  if (!outcome || !run.agent || !run.dir || !run.options.language || !usage) return outcome
  const candidates = await localizeFindings({
    agent: run.agent,
    dir: run.dir,
    language: run.options.language,
    candidates: outcome.candidates,
    usage,
    ...(run.signal ? { signal: run.signal } : {}),
  })
  return { ...outcome, candidates }
}

/** Most threads re-checked per run, to bound the triage cost. */
export const MAX_RECHECKS = 10

/**
 * Our open threads worth re-checking, at most `MAX_RECHECKS`: after new commits every open thread
 * whose file is still in the diff, those a person replied in first, then those whose file changed,
 * since a fix may land in another file (a test, a caller); with no previous review none; and those whose file left the diff, which
 * count as `gone`. `changed` lists the files changed since the last review, when known.
 */
export function threadsToRecheck(
  loaded: Pick<LoadedReview, 'diff' | 'threads' | 'previous'>,
  planned: Pick<ReviewPlan, 'since'>,
): { recheck: OpenThread[]; gone: OpenThread[]; changed?: string[] } {
  const inDiff = new Set(
    loaded.diff.files.filter((f) => f.status !== 'deleted').map((f) => f.newPath),
  )
  const changed = planned.since ? [...new Set(planned.since.map((f) => f.newPath))] : undefined
  const ours = loaded.threads.filter((t) => t.ours)
  const open = ours.filter((t) => inDiff.has(t.path))
  const due = changed ? (changed.length ? open : []) : loaded.previous ? open : []
  const touched = (t: OpenThread) => changed?.includes(t.path) ?? true
  const ordered = [...due.filter(touched), ...due.filter((t) => !touched(t))]
  return {
    gone: ours.filter((t) => !inDiff.has(t.path)),
    recheck: [...ordered.filter((t) => t.reply), ...ordered.filter((t) => !t.reply)].slice(
      0,
      MAX_RECHECKS,
    ),
    ...(changed ? { changed } : {}),
  }
}

async function excerpt(dir: string, path: string, line: number, context = 8): Promise<string> {
  const file = Bun.file(join(dir, path))
  if (!(await file.exists())) return '(file deleted)'
  const lines = (await file.text()).split('\n')
  const from = Math.max(1, line - context)
  const to = Math.min(lines.length, line + context)
  const width = String(to).length
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(`${String(n).padStart(width)}  ${lines[n - 1] ?? ''}`)
  return out.join('\n')
}

const recheck: ReviewSteps['recheck'] = async (run, loaded, planned, usage) => {
  const { recheck: threads, gone, changed } = threadsToRecheck(loaded, planned)
  const verdicts = new Map<string, RecheckVerdict | 'gone'>(
    gone.map((t) => [t.discussionId, 'gone' as const]),
  )
  if (!run.agent || !run.dir || threads.length === 0) return verdicts
  const dir = run.dir
  const items = await Promise.all(
    threads.map(async (thread) => ({ thread, code: await excerpt(dir, thread.path, thread.line) })),
  )
  const answers = await recheckThreads({
    agent: withPhase(run.agent, 'recheck'),
    dir,
    threads: items,
    ...(changed ? { changed } : {}),
    usage,
    ...(run.options.language ? { language: run.options.language } : {}),
    ...(run.toolsets ? { toolsets: run.toolsets } : {}),
    ...(run.signal ? { signal: run.signal } : {}),
  })
  for (const [id, verdict] of answers) verdicts.set(id, verdict)
  return verdicts
}

const post: ReviewSteps['post'] = async (run, loaded, data) => {
  const toPost = data.comments
  const cite = run.cite ?? (async (text: string) => text)
  const comments: ReviewComment[] = await Promise.all(
    toPost.map(async (finding) => ({
      path: finding.path,
      line: finding.line,
      ...(finding.startLine ? { startLine: finding.startLine } : {}),
      side: 'new' as const,
      body: await cite(commentBody(finding)),
      ...(finding.suggestion
        ? { suggestion: { replacement: finding.suggestion.replacement } }
        : {}),
    })),
  )
  const approve = data.approved
  const worthPosting =
    data.mode === 'full' ||
    comments.length > 0 ||
    data.threads.some((t) => t.action !== 'kept') ||
    approve
  if (!worthPosting && data.mode !== 'skipped') return data

  const outcome = await run.forge.submitReview(run.repo.path, loaded.mr.id, {
    refs: loaded.diff.refs,
    comments,
    summary: await cite(
      summaryNote(
        run.options.showCost === false
          ? { ...data, usage: undefined, durationMs: undefined }
          : data,
        run.messages,
      ),
    ),
    event: approve ? 'approve' : 'comment',
  })
  const failed = new Map(outcome.failed.map((f) => [f.comment, f.error]))
  return {
    ...data,
    comments: data.comments.map((finding, index) => {
      const comment = comments[index]
      const error = comment ? failed.get(comment) : undefined
      return error === undefined ? finding : { ...finding, posted: false, error }
    }),
  }
}

/**
 * Ids of unresolved summary threads (`summaryNote` bodies outside the diff) started by `owner`.
 * Finding threads and notes of other accounts are never among them.
 */
export function summaryThreads(discussions: readonly Discussion[], owner: string): string[] {
  const own = owner.toLowerCase()
  return discussions.flatMap((discussion) => {
    const first = discussion.notes.find((note) => !note.system)
    if (discussion.position || !discussion.resolvable || discussion.resolved || !first) return []
    if (!isSummaryNote(first.body) || first.author.toLowerCase() !== own) return []
    return [discussion.id]
  })
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function resolveSummaries(run: ReviewRun, loaded: LoadedReview, data: ReviewData) {
  const policy = run.options.resolveSummary ?? 'when-clean'
  if (!run.forge.resolveDiscussion || policy === 'never') return
  if (policy === 'when-clean' && data.verdict !== 'looks-good') return
  const owner =
    (await run.forge.getCurrentUser?.().catch(() => undefined))?.username ?? run.botUsername
  if (!owner) {
    run.log?.('resolving summary threads skipped: the forge account is unknown')
    return
  }
  let ids: string[]
  try {
    ids = summaryThreads(await run.forge.listDiscussions(run.repo.path, loaded.mr.id), owner)
  } catch (error) {
    run.log?.(`listing summary threads failed: ${errorText(error)}`)
    return
  }
  for (const id of ids) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      await run.forge.resolveDiscussion(run.repo.path, loaded.mr.id, id, true)
      run.log?.(`resolved summary thread ${id}`)
    } catch (error) {
      run.log?.(`resolving summary thread ${id} failed: ${errorText(error)}`)
    }
  }
}

/**
 * The estimated review time of the whole merge request and, when it reaches `largeMinutes`, the
 * advice to split it (with a plan from the agent when there is one). The advice is given in full
 * and skipped runs, and in incremental runs only when the level got worse than the last review's,
 * so pushes to a large merge request do not repeat it.
 */
async function reviewSize(
  run: ReviewRun,
  loaded: LoadedReview,
  planned: ReviewPlan,
  usage: ReviewUsage,
  outcome?: AgentOutcome,
): Promise<ReviewSize | undefined> {
  const settings = run.options.sizeAdvice
  if (settings?.enabled === false) return undefined
  const thresholds: SizeThresholds = {
    largeMinutes: settings?.largeMinutes ?? DEFAULT_SIZE_THRESHOLDS.largeMinutes,
    tooLargeMinutes: settings?.tooLargeMinutes ?? DEFAULT_SIZE_THRESHOLDS.tooLargeMinutes,
  }
  const files = sizedFiles((planned.fullScope ?? planned.scope).files)
  const previous = planned.mode === 'incremental' ? loaded.previous : undefined
  // An incremental run sees only the new commits; the earlier review saw the rest.
  const effort = Math.max(outcome?.effort ?? 0, previous?.effort ?? 0)
  const groups = Math.max(
    logicalChanges(outcome?.walkthrough ?? []),
    previous?.size?.groups ?? logicalChanges(previous?.walkthrough ?? []),
  )
  const model = settings?.model ?? DEFAULT_REVIEW_TIME_MODEL
  // An incremental run's agent saw only the new commits; the full review's estimate stands.
  const agentMinutes =
    planned.mode === 'incremental' ? previous?.size?.agentMinutes : outcome?.reviewMinutes
  const minutes = estimateReviewMinutes({
    files,
    model,
    ...(effort ? { effort } : {}),
    ...(agentMinutes ? { agentMinutes } : {}),
  })
  const level = reviewSizeLevel(minutes, thresholds)
  const size: ReviewSize = {
    minutes,
    level,
    files: files.length,
    lines: files.reduce((sum, file) => sum + file.added + file.removed, 0),
    groups,
    model,
    ...(agentMinutes ? { agentMinutes } : {}),
  }
  if (level === 'ok' || (previous && !sizeEscalated(level, previous.size?.level))) return size
  const texts = adviceTexts(level, minutes)
  const advice =
    run.agent && run.dir
      ? await planSplit({
          agent: run.agent,
          dir: run.dir,
          usage,
          mergeRequest: { title: loaded.mr.title, description: loaded.mr.description },
          files,
          ...(outcome?.walkthrough ? { walkthrough: outcome.walkthrough } : {}),
          texts,
          ...(run.options.language ? { language: run.options.language } : {}),
          ...(run.signal ? { signal: run.signal } : {}),
        })
      : { texts, splittable: true }
  run.log?.(
    `review time ~${minutes} min (${level}): ${advice.splittable ? 'splittable' : 'not splittable'}`,
  )
  return { ...size, advice }
}

/** The default steps. */
export const defaultSteps: ReviewSteps = {
  load,
  plan,
  deterministic,
  agentReview,
  media,
  recheck,
  verify,
  reviseSummary: revise,
  post,
}

const filesOf = (scope: ReviewScope) =>
  new Map<string, FileScope>(scope.files.map((f) => [f.path, f]))

const baseData = (loaded: LoadedReview, planned?: ReviewPlan) => ({
  mergeRequest: {
    id: loaded.mr.id,
    title: loaded.mr.title,
    webUrl: loaded.mr.webUrl,
    sourceBranch: loaded.mr.sourceBranch,
    targetBranch: loaded.mr.targetBranch,
    author: loaded.mr.author,
  },
  head: loaded.diff.refs.headSha,
  ...(planned?.previousHead ? { previousHead: planned.previousHead } : {}),
})

/**
 * Findings verified beyond `maxComments`, so refuted ones leave no empty places; the extra ones
 * that survive are cut after verification.
 */
export const VERIFY_HEADROOM = 5

const emptyDropped = { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 }

/**
 * Reviews one merge request: loads it, scopes the diff, collects deterministic and agent findings,
 * validates, deduplicates and ranks them, re-checks our earlier threads and posts one review.
 * Returns the stored data with the run's wall time; what the forge rejected is marked in
 * `comments`.
 */
export async function reviewMergeRequest(run: ReviewRun): Promise<ReviewData> {
  const started = performance.now()
  const data = await reviewOnce(run, started)
  return { ...data, durationMs: Math.round(performance.now() - started) }
}

async function reviewOnce(input: ReviewRun, started: number): Promise<ReviewData> {
  const elapsed = () => Math.round(performance.now() - started)
  const steps = { ...defaultSteps, ...input.steps }
  const messages = input.messages ?? englishReviewMessages
  const usage: ReviewUsage = { turns: 0 }
  let loaded = await steps.load(input)
  const run: ReviewRun = input.agent
    ? { ...input, agent: withPhase(input.agent, loaded.previous ? 'update' : 'initial') }
    : input
  const planned = await steps.plan(run, loaded)
  const { scope } = planned
  const stats: ReviewData['stats'] = {
    files: scope.files.length,
    changedLines: scope.changedLines,
    dropped: { ...emptyDropped },
  }

  if (scope.changedLines > run.options.maxDiffLines || scope.files.length === 0) {
    const tooLarge = scope.files.length > 0
    const size = tooLarge ? await reviewSize(run, loaded, planned, usage) : undefined
    const data: ReviewData = {
      ...baseData(loaded, planned),
      mode: 'skipped',
      verdict: 'skipped',
      summary: tooLarge
        ? messages.t('summary.tooLarge', {
            lines: scope.changedLines,
            limit: run.options.maxDiffLines,
          })
        : messages.t('summary.nothingNew'),
      ...(size ? { size } : {}),
      comments: [],
      threads: [],
      skipped: tooLarge
        ? [
            ...scope.skipped,
            ...scope.files.map((f) => ({ path: f.path, reason: 'too-large' as const })),
          ]
        : scope.skipped,
      stats,
      approved: false,
      checks: [],
      ...(usage.turns > 0 || usage.costUsd !== undefined ? { usage } : {}),
      durationMs: elapsed(),
    }
    if (!tooLarge) return data
    const last = run.analyses
      ? await previousReview(run.analyses, run.repo, loaded.mr.id, false)
      : undefined
    if (
      last?.mode === 'skipped' &&
      last.verdict === 'skipped' &&
      last.skipped.some((s) => s.reason === 'too-large')
    )
      return data
    return postAndResolve(steps, run, loaded, data)
  }

  const files = filesOf(scope)
  const found = await steps.deterministic(run, planned)
  const requests =
    run.agent && run.dir
      ? found.candidates.filter((c) => agentCompletedChecks.has(c.source) && !c.suggestion)
      : []
  const agentOutcome = await steps.agentReview(run, loaded, planned, usage, requests)
  const mediaOutcome = await steps.media(run, loaded, usage)
  const size = await reviewSize(run, loaded, planned, usage, agentOutcome)

  const validate = (candidates: readonly Candidate[]) =>
    candidates.flatMap((candidate) => {
      const valid = validateCandidate(candidate, files, {
        inScopeOnly: planned.mode === 'incremental',
      })
      if (!valid) stats.dropped.invalid++
      return valid ? [valid] : []
    })
  const deterministicValid = validate(
    agentOutcome ? found.candidates.filter((c) => !requests.includes(c)) : found.candidates,
  )
  const requested = new Set(requests.map((request) => `${request.path}:${request.line}`))
  const agentValid = validate([
    ...(mediaOutcome?.candidates ?? []),
    ...(agentOutcome?.candidates ?? []).filter(
      (candidate) =>
        run.tests !== false ||
        candidate.category !== 'tests' ||
        requested.has(`${candidate.path}:${candidate.line}`),
    ),
  ])

  // The agent takes minutes, and replies resolve threads meanwhile.
  if (agentOutcome) loaded = await withFreshThreads(run, loaded)
  const fixedDeterministic = dedupe(deterministicValid, {
    threads: loaded.threads,
    settled: loaded.settled ?? [],
    deterministic: [],
  })
  const fromAgent = dedupe(agentValid, {
    threads: loaded.threads,
    settled: loaded.settled ?? [],
    deterministic: fixedDeterministic.kept,
  })
  const repeats = [...fixedDeterministic.repeats, ...fromAgent.repeats]
  const settledRepeats = fixedDeterministic.settled.length + fromAgent.settled.length
  if (settledRepeats) run.log?.(`dropped ${settledRepeats} finding(s) repeating resolved threads`)
  stats.dropped.duplicates =
    fixedDeterministic.duplicates.length +
    fromAgent.duplicates.length +
    repeats.length +
    settledRepeats

  const verdicts = await steps.recheck(run, loaded, planned, usage)
  const threads: ThreadAction[] = []
  const repeated = new Set(repeats.filter((r) => r.thread.ours).map((r) => r.thread.discussionId))
  for (const thread of loaded.threads.filter((t) => t.ours)) {
    const verdict = verdicts.get(thread.discussionId)
    if (!verdict) continue
    const base = { discussionId: thread.discussionId, path: thread.path, line: thread.line }
    if (verdict === 'gone')
      threads.push({
        ...base,
        action: 'resolved',
        reason: 'The file is no longer changed by this merge request.',
      })
    // A reply waits for the replies run, which answers it with the code at hand; a status note
    // here would read past a decline and leave the reply unanswered.
    else if (thread.reply && verdict.status !== 'fixed')
      threads.push({ ...base, action: 'kept', reason: verdict.note })
    else if (verdict.status === 'fixed')
      threads.push({ ...base, action: 'resolved', reason: verdict.note })
    else if (verdict.status === 'still-relevant' && repeated.has(thread.discussionId))
      threads.push({ ...base, action: 'replied', reason: verdict.note })
    else threads.push({ ...base, action: 'kept', reason: verdict.note })
  }
  await applyThreadActions(run, loaded, threads)

  const ranked = rankAndCap(
    [...fixedDeterministic.kept, ...fromAgent.kept],
    run.options.minSeverity,
    run.options.maxComments + VERIFY_HEADROOM,
  )
  stats.dropped.belowSeverity = ranked.belowSeverity
  const checked = await steps.verify(run, loaded, ranked.kept, usage)
  // The headroom fills the places of refuted findings; verification keeps the rank order, so
  // what is left over the limit is cut from the end.
  const verification = { ...checked, kept: checked.kept.slice(0, run.options.maxComments) }
  stats.dropped.overLimit = ranked.overLimit + checked.kept.length - verification.kept.length
  if (verification.refuted.length) stats.dropped.refuted = verification.refuted.length
  const refutedSerious = verification.refuted.some(
    (r) => severityRank(r.candidate.severity) >= severityRank('major'),
  )

  const comments: ReviewFinding[] = verification.kept.map((candidate) => ({
    id: findingId(candidate),
    path: candidate.path,
    line: candidate.line,
    ...(candidate.startLine ? { startLine: candidate.startLine } : {}),
    severity: candidate.severity,
    category: candidate.category,
    title: candidate.title,
    body: candidate.body,
    source: candidate.source,
    ...(candidate.suggestion ? { suggestion: candidate.suggestion } : {}),
    ...(candidate.evidence?.length ? { evidence: candidate.evidence } : {}),
    posted: true,
    href: `${loaded.mr.webUrl}/diffs`,
  }))
  const serious = comments.some((c) => severityRank(c.severity) >= severityRank('major'))
  const stillOpen = threads.some((t) => t.action !== 'resolved')
  // The agent's verdict may rest on findings the verification refuted; the rest still decide.
  const agentVerdict = refutedSerious ? undefined : agentOutcome?.verdict
  const verdict = serious || agentVerdict === 'needs-changes' ? 'needs-changes' : 'looks-good'

  const agentSummary =
    agentOutcome?.summary && verification.refuted.length
      ? await steps.reviseSummary(run, agentOutcome.summary, verification.refuted, usage)
      : agentOutcome?.summary

  const data: ReviewData = {
    ...baseData(loaded, planned),
    mode: planned.mode,
    verdict,
    summary: [
      agentSummary ?? (comments.length ? '' : 'No problems found on the changed lines.'),
      mediaOutcome?.summary ? `#### Images\n\n${mediaOutcome.summary}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    ...(agentOutcome?.walkthrough ? { walkthrough: agentOutcome.walkthrough } : {}),
    ...(agentOutcome?.effort ? { effort: agentOutcome.effort } : {}),
    ...(size ? { size } : {}),
    ...(agentOutcome?.ruleSources?.length ? { ruleSources: agentOutcome.ruleSources } : {}),
    ...(agentOutcome?.promptVersion ? { promptVersion: agentOutcome.promptVersion } : {}),
    comments,
    ...(verification.refuted.length
      ? {
          refuted: verification.refuted.map(({ candidate, reason }) => ({
            path: candidate.path,
            line: candidate.line,
            severity: candidate.severity,
            title: candidate.title,
            reason,
          })),
        }
      : {}),
    threads,
    skipped: scope.skipped,
    stats,
    approved: run.options.approve === 'when-clean' && verdict === 'looks-good' && !stillOpen,
    checks: found.checks,
    ...(usage.turns > 0 || usage.costUsd !== undefined ? { usage } : {}),
    durationMs: elapsed(),
  }
  return postAndResolve(steps, run, loaded, data)
}

async function postAndResolve(
  steps: ReviewSteps,
  run: ReviewRun,
  loaded: LoadedReview,
  data: ReviewData,
) {
  run.onProgress?.({ stage: 'post' })
  const posted = await steps.post(run, loaded, data)
  await resolveSummaries(run, loaded, posted)
  return posted
}

async function applyThreadActions(run: ReviewRun, loaded: LoadedReview, threads: ThreadAction[]) {
  const head = loaded.diff.refs.headSha
  for (const thread of threads) {
    if (thread.action === 'kept') continue
    // Sequential on purpose: forges rate-limit note creation.
    // oxlint-disable-next-line no-await-in-loop
    await run.forge.replyToDiscussion?.(
      run.repo.path,
      loaded.mr.id,
      thread.discussionId,
      threadNote(thread.action, thread.reason, head, run.messages),
    )
    if (thread.action === 'resolved')
      // oxlint-disable-next-line no-await-in-loop
      await run.forge.resolveDiscussion?.(run.repo.path, loaded.mr.id, thread.discussionId, true)
    const reply = loaded.threads.find((t) => t.discussionId === thread.discussionId)?.reply
    if (reply)
      // oxlint-disable-next-line no-await-in-loop
      await run.forge
        .removeNoteMark?.(run.repo.path, loaded.mr.id, reply.noteId, 'seen')
        .catch(() => undefined)
  }
}
