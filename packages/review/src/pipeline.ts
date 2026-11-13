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
import type { QualityCheck } from '@holtkeeper/quality'
import type { AnalysisStore } from '@holtkeeper/store'

import { type RecheckVerdict, localizeFindings, recheckThreads, runAgentReview } from './agent.ts'
import {
  type ReviewCheckName,
  agentCompletedChecks,
  deterministicFindings,
  findingId,
  reviewCheckNames,
} from './checks.ts'
import { type OpenThread, dedupe, openThreads, rankAndCap, severityRank } from './dedupe.ts'
import { dependencySection } from './dependencies.ts'
import { commentBody, isSummaryNote, summaryNote, threadNote } from './format.ts'
import { changedGoModules, goGuidelinesSection } from './go-guidelines/prompt.ts'
import type { GoGuidelineSet } from './go-guidelines/schema.ts'
import {
  type Guideline,
  type PathInstruction,
  ignoredInReviewMd,
  pathInstructionsInReviewMd,
  readGuidelines,
} from './guidelines.ts'
import { type MediaReviewer, noopMediaReviewer, reviewMedia } from './media.ts'
import {
  type ReviewData,
  type ReviewFinding,
  type ReviewSeverity,
  type ReviewUsage,
  type ReviewWalkthrough,
  type ThreadAction,
  reviewDataSchema,
} from './schema.ts'
import { type FileScope, type ReviewScope, matchesAny, scopeDiff } from './scope.ts'
import { type Candidate, validateCandidate } from './validate.ts'

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
  /** `deep` reviews on the `deep` model tier (Opus) instead of `main` (Sonnet). Default `standard`. */
  depth?: 'standard' | 'deep'
  ignore: string[]
  maxDiffLines: number
  language?: string
  instructions?: string
  replyTo?: string
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
}

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

/** A resolved Guide: its text and the Guide scopes whose rules it carries, broad to narrow. */
export interface ReviewGuide {
  text: string
  scopes: string[]
}

/** Everything one review run uses. */
export interface ReviewRun {
  repo: RepoRef
  forge: ReviewForge
  /** Checkout at the merge request head. Without it there are no checks, guidelines or agent. */
  dir?: string
  runner: CommandRunner
  agent?: Agent
  analyses?: AnalysisStore
  options: ReviewOptions
  checks?: Partial<Record<ReviewCheckName, QualityCheck>>
  /**
   * Resolves the repository's Guide for the review from its rules files and the text notes are
   * ranked by (title and files in scope); replaces the plain guidelines block in the context.
   */
  guide?: (docs: readonly Guideline[], query: string) => Promise<ReviewGuide | undefined>
  /** Passed to the agent as `toolsets`, e.g. code navigation and knowledge tools. */
  toolsets?: readonly Toolset[]
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
  /** Replaces pipeline steps, e.g. in tests or for another review strategy. */
  steps?: Partial<ReviewSteps>
  log?: (line: string) => void
  signal?: AbortSignal
}

/** What the `load` step gathers. */
export interface LoadedReview {
  mr: MergeRequest & { headSha: string }
  diff: MergeRequestDiff
  discussions: Discussion[]
  threads: OpenThread[]
  /** The latest earlier review of this merge request that reviewed something. */
  previous?: ReviewData
}

/** What the `plan` step decides. */
export interface ReviewPlan {
  mode: 'full' | 'incremental'
  previousHead?: string
  scope: ReviewScope
  /** Files changed since `previousHead`, when incremental. */
  since?: DiffFile[]
  guidelines: Guideline[]
  /** Rules for paths from REVIEW.md's `## Paths` section. */
  pathInstructions?: PathInstruction[]
}

export interface AgentOutcome {
  candidates: Candidate[]
  summary: string
  verdict: 'looks-good' | 'needs-changes'
  walkthrough?: ReviewWalkthrough
  effort?: number
  /** Guide scopes whose rules reached the agent, broad to narrow. */
  guideScopes?: string[]
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
    ...(previous ? { previous } : {}),
  }
}

const plan: ReviewSteps['plan'] = async (run, loaded) => {
  const guidelines = run.dir ? await readGuidelines(run.dir) : []
  const reviewMd = guidelines.find((g) => g.file === 'REVIEW.md')
  const ignore = [...run.options.ignore, ...(reviewMd ? ignoredInReviewMd(reviewMd.text) : [])]
  const head = loaded.diff.refs.headSha
  const last = loaded.previous?.head

  let since: DiffFile[] | undefined
  if (run.options.mode !== 'full' && last && last !== head && run.forge.compareCommits) {
    const linear = run.dir ? await isAncestor(run.runner, run.dir, last, head) : true
    if (linear) since = await run.forge.compareCommits(run.repo.path, last, head)
    else
      run.log?.(
        `previous head ${last.slice(0, 8)} is not an ancestor of ${head.slice(0, 8)}; reviewing everything`,
      )
  } else if (run.options.mode !== 'full' && last === head) since = []

  if (run.options.mode === 'incremental' && !since)
    run.log?.('no usable previous review; reviewing everything')
  return {
    mode: since ? 'incremental' : 'full',
    ...(since && last ? { previousHead: last, since } : {}),
    scope: scopeDiff(loaded.diff.files, { ignore, ...(since ? { since } : {}) }),
    guidelines,
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

const agentReview: ReviewSteps['agentReview'] = async (run, loaded, planned, usage, requests) => {
  if (!run.agent || !run.dir) return undefined
  const goGuidelines = await goGuidelinesFor(run, planned.scope.files)
  const dependencies = await dependenciesFor(run, loaded)
  const instructions = run.options.instructions?.trim()
  const guide = run.guide
    ? await run
        .guide(
          planned.guidelines,
          `${loaded.mr.title}\n${planned.scope.files
            .slice(0, 30)
            .map((f) => f.path)
            .join('\n')}`,
        )
        .catch((error: unknown) => {
          run.log?.(
            `guide lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          return undefined
        })
    : undefined
  const pathRules = (planned.pathInstructions ?? []).flatMap((rule) => {
    const files = planned.scope.files
      .map((f) => f.path)
      .filter((path) => matchesAny(path, [rule.glob]))
    return files.length ? [{ ...rule, files }] : []
  })
  const outcome = await runAgentReview({
    agent: run.agent,
    dir: run.dir,
    usage,
    input: {
      repo: run.repo.path,
      mergeRequest: {
        id: loaded.mr.id,
        title: loaded.mr.title,
        description: loaded.mr.description,
      },
      files: planned.scope.files,
      mode: planned.mode,
      ...(planned.previousHead ? { previousHead: planned.previousHead } : {}),
      guidelines: planned.guidelines,
      ...(run.tests === false && { tests: false as const }),
      ...(guide?.text ? { guide: guide.text } : {}),
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
      maxComments: run.options.maxComments,
      ...(run.options.language ? { language: run.options.language } : {}),
      ...(goGuidelines ? { goGuidelines } : {}),
      ...(dependencies ? { dependencies } : {}),
    },
    ...(run.options.depth === 'deep' ? { deep: true } : {}),
    ...(run.toolsets ? { toolsets: run.toolsets } : {}),
    ...(run.signal ? { signal: run.signal } : {}),
  })
  return guide?.text && guide.scopes.length ? { ...outcome, guideScopes: guide.scopes } : outcome
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
 * Our open threads worth re-checking: those whose file changed since the last review (every one
 * after a force push), plus those whose file left the diff, which count as `gone`.
 */
export function threadsToRecheck(
  loaded: LoadedReview,
  planned: ReviewPlan,
): { recheck: OpenThread[]; gone: OpenThread[] } {
  const inDiff = new Set(
    loaded.diff.files.filter((f) => f.status !== 'deleted').map((f) => f.newPath),
  )
  const changed = planned.since ? new Set(planned.since.map((f) => f.newPath)) : undefined
  const ours = loaded.threads.filter((t) => t.ours)
  return {
    gone: ours.filter((t) => !inDiff.has(t.path)),
    recheck: ours
      .filter(
        (t) =>
          inDiff.has(t.path) && (changed ? changed.has(t.path) : loaded.previous !== undefined),
      )
      .slice(0, MAX_RECHECKS),
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
  const { recheck: threads, gone } = threadsToRecheck(loaded, planned)
  const verdicts = new Map<string, RecheckVerdict | 'gone'>(
    gone.map((t) => [t.discussionId, 'gone' as const]),
  )
  if (!run.agent || !run.dir || threads.length === 0) return verdicts
  const dir = run.dir
  const items = await Promise.all(
    threads.map(async (thread) => ({ thread, code: await excerpt(dir, thread.path, thread.line) })),
  )
  const answers = await recheckThreads({
    agent: run.agent,
    dir,
    threads: items,
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
  const comments: ReviewComment[] = toPost.map((finding) => ({
    path: finding.path,
    line: finding.line,
    ...(finding.startLine ? { startLine: finding.startLine } : {}),
    side: 'new',
    body: commentBody(finding),
    ...(finding.suggestion ? { suggestion: { replacement: finding.suggestion.replacement } } : {}),
  }))
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
    summary: summaryNote(data),
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

/** The default steps. */
export const defaultSteps: ReviewSteps = {
  load,
  plan,
  deterministic,
  agentReview,
  media,
  recheck,
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

const emptyDropped = { belowSeverity: 0, overLimit: 0, duplicates: 0, invalid: 0 }

/**
 * Reviews one merge request: loads it, scopes the diff, collects deterministic and agent findings,
 * validates, deduplicates and ranks them, re-checks our earlier threads and posts one review.
 * Returns the stored data with the run's wall time; what the forge rejected is marked in
 * `comments`.
 */
export async function reviewMergeRequest(run: ReviewRun): Promise<ReviewData> {
  const started = performance.now()
  const data = await reviewOnce(run)
  return { ...data, durationMs: Math.round(performance.now() - started) }
}

async function reviewOnce(run: ReviewRun): Promise<ReviewData> {
  const steps = { ...defaultSteps, ...run.steps }
  const usage: ReviewUsage = { turns: 0 }
  const loaded = await steps.load(run)
  const planned = await steps.plan(run, loaded)
  const { scope } = planned
  const stats = {
    files: scope.files.length,
    changedLines: scope.changedLines,
    dropped: { ...emptyDropped },
  }

  if (scope.changedLines > run.options.maxDiffLines || scope.files.length === 0) {
    const tooLarge = scope.files.length > 0
    const data: ReviewData = {
      ...baseData(loaded, planned),
      mode: 'skipped',
      verdict: 'skipped',
      summary: tooLarge
        ? `The diff has ${scope.changedLines} changed lines, more than the limit of ${run.options.maxDiffLines}; it was not reviewed. Split the merge request or review it with \`/holtkeeper review maxDiffLines=<n>\`.`
        : 'Nothing new to review.',
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

  const fixedDeterministic = dedupe(deterministicValid, {
    threads: loaded.threads,
    deterministic: [],
  })
  const fromAgent = dedupe(agentValid, {
    threads: loaded.threads,
    deterministic: fixedDeterministic.kept,
  })
  const repeats = [...fixedDeterministic.repeats, ...fromAgent.repeats]
  stats.dropped.duplicates =
    fixedDeterministic.duplicates.length + fromAgent.duplicates.length + repeats.length

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
    run.options.maxComments,
  )
  stats.dropped.belowSeverity = ranked.belowSeverity
  stats.dropped.overLimit = ranked.overLimit

  const comments: ReviewFinding[] = ranked.kept.map((candidate) => ({
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
    posted: true,
    href: `${loaded.mr.webUrl}/diffs`,
  }))
  const serious = comments.some((c) => severityRank(c.severity) >= severityRank('major'))
  const stillOpen = threads.some((t) => t.action !== 'resolved')
  const verdict =
    serious || agentOutcome?.verdict === 'needs-changes' ? 'needs-changes' : 'looks-good'

  const data: ReviewData = {
    ...baseData(loaded, planned),
    mode: planned.mode,
    verdict,
    summary: [
      agentOutcome?.summary ?? (comments.length ? '' : 'No problems found on the changed lines.'),
      mediaOutcome?.summary ? `#### Images\n\n${mediaOutcome.summary}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    ...(agentOutcome?.walkthrough ? { walkthrough: agentOutcome.walkthrough } : {}),
    ...(agentOutcome?.effort ? { effort: agentOutcome.effort } : {}),
    ...(agentOutcome?.guideScopes?.length ? { guideScopes: agentOutcome.guideScopes } : {}),
    comments,
    threads,
    skipped: scope.skipped,
    stats,
    approved: run.options.approve === 'when-clean' && verdict === 'looks-good' && !stillOpen,
    checks: found.checks,
    ...(usage.turns > 0 || usage.costUsd !== undefined ? { usage } : {}),
  }
  return postAndResolve(steps, run, loaded, data)
}

async function postAndResolve(
  steps: ReviewSteps,
  run: ReviewRun,
  loaded: LoadedReview,
  data: ReviewData,
) {
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
      threadNote(thread.action, thread.reason, head),
    )
    if (thread.action === 'resolved')
      // oxlint-disable-next-line no-await-in-loop
      await run.forge.resolveDiscussion?.(run.repo.path, loaded.mr.id, thread.discussionId, true)
  }
}
