// oxlint-disable no-await-in-loop -- steps touch the same checkout and run in order
import type { Agent, Toolset } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import type { GitForge, RepoRef } from '@holtkeeper/forge'
import {
  type ChangedFile,
  type CheckOptions,
  type CheckResult,
  changedFiles,
  createAgentFixer,
  defaultVerifier,
  type FixContext,
  type Fixer,
  type FixLoopOutcome,
  fixUntilPassing,
  noopFixer,
  publishChanges,
  type Verifier,
  verifyCheckout,
} from '@holtkeeper/propagate'

import { type Adapter, createAgentAdapter, noopAdapter } from './adapt.ts'
import { type PatchApplier, defaultPatchApplier } from './apply.ts'
import { sourceComment } from './comment.ts'
import { mergeRequestDescription, mergeRequestTitle } from './describe.ts'
import { gitIn, grepLocations, resetCheckout, trackedFiles } from './git.ts'
import { changedSymbols, formatPatch } from './patch.ts'
import {
  type CheckoutFn,
  defaultSourceLoader,
  intentSummary,
  parseRepo,
  type SourceLoader,
  sourceSlug,
  storedFiles,
} from './source.ts'
import { resolveTargets } from './targets.ts'
import { type Triage, agentTriage, ruleTriage } from './triage.ts'
import type {
  AdaptReport,
  DiffStat,
  PathMapping,
  PortData,
  PortMethod,
  PortOutcome,
  SourceChange,
  SourceFile,
  SourceSpec,
  TargetOutcome,
  TriageResult,
} from './types.ts'

/** The replaceable steps of the pipeline; each defaults to the built-in implementation. */
export interface PortSteps {
  source?: SourceLoader
  triage?: Triage
  applier?: PatchApplier
  adapter?: Adapter
  verifier?: Verifier
  fixer?: Fixer
}

/** Settings of the fix step. */
export interface PortFixSettings {
  /** Default: true when an agent is configured. */
  enabled?: boolean
  /** Default 3. */
  maxAttempts?: number
  /** Per attempt; default 40. */
  maxTurns?: number
  timeoutMinutes?: number
}

/** Options of the merge requests the port opens. */
export interface PortMergeRequestSettings {
  /** Default `holtkeeper/port`. */
  branchPrefix?: string
  /** Default `['holtkeeper', 'port']`. */
  labels?: string[]
  /** Open a draft labeled `needs-attention` when checks still fail; otherwise none. Default true. */
  draftOnFailure?: boolean
}

/** Rules for a fixer working on a port, passed as its instructions. */
export const portFixInstructions = [
  'A change from a sibling repository was ported into this repository and some checks now fail.',
  'Make the checks pass while keeping the port: never revert or weaken the ported change, keep',
  'the fix minimal and follow the conventions of this repository.',
].join(' ')

/** Fix context for a port: what the change does and the source diff. */
export function portContext(intent: string, patch: string): FixContext[] {
  return [
    { title: 'Change being ported', text: intent },
    { title: 'Source diff', text: `\`\`\`diff\n${patch}\n\`\`\`` },
  ]
}

/** Result of porting the change into one checkout, before publishing. */
export interface PortCheckoutResult {
  outcome: PortOutcome
  method?: PortMethod
  reason?: string
  triage: TriageResult
  remapped: PathMapping[]
  adapt?: AdaptReport
  checks: CheckResult[]
  fix?: FixLoopOutcome
  /** Files to publish: what the port changed plus what the fixer touched. */
  files: ChangedFile[]
  diffStat: DiffStat
  notes: string[]
}

/** Input of `portCheckout`. */
export interface PortCheckoutInput {
  dir: string
  runner: CommandRunner
  files: SourceFile[]
  intent: string
  triage: Triage
  applier: PatchApplier
  adapter: Adapter
  verifier: Verifier
  fixer: Fixer
  maxAttempts: number
  checks?: CheckOptions
  signal?: AbortSignal
  log?: (line: string) => void
}

const emptyStat: DiffStat = { files: 0, additions: 0, deletions: 0 }

/** Line counts of `files` against `HEAD`, untracked ones included. */
export async function diffStatOf(
  dir: string,
  runner: CommandRunner,
  files: ChangedFile[],
): Promise<DiffStat> {
  if (files.length === 0) return emptyStat
  const git = gitIn(dir, runner)
  const paths = files.map((file) => file.path)
  await git.run('add', '-A', '--', ...paths)
  const result = await git.run(
    'diff',
    '--cached',
    '--numstat',
    '--no-renames',
    'HEAD',
    '--',
    ...paths,
  )
  await git.run('reset', '-q')
  const stat = { files: 0, additions: 0, deletions: 0 }
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const [added, deleted] = line.split('\t')
    stat.files++
    stat.additions += Number(added) || 0
    stat.deletions += Number(deleted) || 0
  }
  return stat
}

const skippedResult = (
  outcome: PortOutcome,
  reason: string,
  triage: TriageResult,
  extra: Partial<PortCheckoutResult> = {},
): PortCheckoutResult => ({
  outcome,
  reason,
  triage,
  remapped: [],
  checks: [],
  files: [],
  diffStat: emptyStat,
  notes: [],
  ...extra,
})

/**
 * Triage, apply (clean, then remapped), adapt with the agent when the patch does not apply,
 * then verify and fix one writable checkout. Skipped and failed ports leave the checkout clean.
 */
export async function portCheckout(input: PortCheckoutInput): Promise<PortCheckoutResult> {
  const { dir, runner, signal } = input
  const git = gitIn(dir, runner, signal)
  const notes: string[] = []
  const triage = await input.triage.triage({
    dir,
    runner,
    files: input.files,
    intent: input.intent,
    ...(signal ? { signal } : {}),
  })
  input.log?.(`triage: ${triage.verdict} (${triage.reason})`)
  if (triage.verdict === 'already-present' || triage.verdict === 'not-applicable')
    return skippedResult(triage.verdict, triage.reason, triage)

  const applied = await input.applier.apply({
    dir,
    runner,
    files: input.files,
    ...(signal ? { signal } : {}),
  })
  let method: PortMethod
  let adapt: AdaptReport | undefined
  const remapped = applied.remapped
  if (applied.applied) {
    method = applied.method
    if (applied.skipped.length) notes.push(`binary files not ported: ${applied.skipped.join(', ')}`)
    input.log?.(`applied ${method}`)
  } else {
    const symbols = triage.symbols?.length ? triage.symbols : changedSymbols(input.files)
    const locations = [
      ...remapped.map((mapping) => `${mapping.from} probably is ${mapping.to} here`),
      ...(await grepLocations(git, symbols)),
    ]
    const conflicts = applied.conflicts.length
      ? `\nConflicting files: ${applied.conflicts.join(', ')}`
      : ''
    adapt = await input.adapter.adapt({
      dir,
      intent: input.intent,
      patch: formatPatch(input.files),
      applyOutput: `${applied.output}${conflicts}`,
      locations,
      ...(signal ? { signal } : {}),
    })
    if (!adapt) {
      await resetCheckout(git)
      return skippedResult(
        'failed',
        `the patch does not apply${applied.conflicts.length ? ` (conflicts in ${applied.conflicts.join(', ')})` : ''} and no agent is configured to adapt it`,
        triage,
        { remapped },
      )
    }
    input.log?.(`adapt: ${adapt.status}`)
    if (adapt.status !== 'ported') {
      await resetCheckout(git)
      return skippedResult(
        adapt.status === 'failed' ? 'failed' : adapt.status,
        adapt.summary,
        triage,
        {
          remapped,
          adapt,
        },
      )
    }
    method = 'adapted'
  }

  const ported = await changedFiles(dir, runner)
  if (ported.length === 0)
    return skippedResult('failed', 'the port changed no file', triage, {
      method,
      remapped,
      ...(adapt ? { adapt } : {}),
    })

  const go = (await trackedFiles(git)).includes('go.mod')
  const verified = await verifyCheckout({
    dir,
    runner,
    verifier: input.verifier,
    ...(input.checks ? { checks: input.checks } : {}),
    ...(go ? { go: true } : {}),
    ...(signal ? { signal } : {}),
  })
  let checks = verified.results
  let fix: FixLoopOutcome | undefined
  if (checks.some((check) => !check.ok) && input.maxAttempts > 0) {
    fix = await fixUntilPassing({
      dir,
      runner,
      verifier: input.verifier,
      fixer: input.fixer,
      specs: verified.specs,
      checks,
      maxAttempts: input.maxAttempts,
      context: portContext(input.intent, formatPatch(input.files)),
      instructions: portFixInstructions,
      ...(signal ? { signal } : {}),
      ...(input.log ? { log: input.log } : {}),
    })
    checks = fix.checks
  }

  const keep = new Set([...ported.map((file) => file.path), ...(fix?.touched ?? [])])
  const files = (await changedFiles(dir, runner)).filter((file) => keep.has(file.path))
  const failing = checks.filter((check) => !check.ok).map((check) => check.name)
  return {
    outcome: failing.length ? 'failed' : (`ported-${method}` as PortOutcome),
    method,
    ...(failing.length ? { reason: `checks fail: ${failing.join(', ')}` } : {}),
    triage,
    remapped,
    ...(adapt ? { adapt } : {}),
    checks,
    ...(fix ? { fix } : {}),
    files,
    diffStat: await diffStatOf(dir, runner, files),
    notes,
  }
}

/** Everything one port across a group needs. */
export interface PortInput {
  group: string
  forgeId: string
  repos: RepoRef[]
  forge: GitForge
  checkout: CheckoutFn
  runner: CommandRunner
  agent?: Agent
  /** Code tools for the agent, mounted for adaptation and triage. */
  toolsets?: Toolset[]
  source: SourceSpec
  /** Repository globs or group names; default every repository of the group but the source. */
  targets?: string[]
  checks?: CheckOptions
  fix?: PortFixSettings
  mergeRequest?: PortMergeRequestSettings
  /** Default true. */
  commentOnSource?: boolean
  dryRun?: boolean
  /** Default 2. */
  concurrency?: number
  steps?: PortSteps
  signal?: AbortSignal
  log?: (line: string) => void
}

async function mapLimit<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>) {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function stepsOf(input: PortInput) {
  const steps = input.steps ?? {}
  const { agent, fix, toolsets } = input
  const enabled = fix?.enabled ?? agent !== undefined
  return {
    source: steps.source ?? defaultSourceLoader,
    triage:
      steps.triage ??
      (agent ? agentTriage(agent, ruleTriage, toolsets ? { toolsets } : {}) : ruleTriage),
    applier: steps.applier ?? defaultPatchApplier,
    adapter:
      steps.adapter ??
      (agent ? createAgentAdapter(agent, toolsets ? { toolsets } : {}) : noopAdapter),
    verifier: steps.verifier ?? defaultVerifier,
    fixer:
      steps.fixer ??
      (enabled && agent
        ? createAgentFixer(agent, {
            ...(fix?.maxTurns ? { maxTurns: fix.maxTurns } : {}),
            ...(fix?.timeoutMinutes ? { timeoutMinutes: fix.timeoutMinutes } : {}),
          })
        : noopFixer),
    maxAttempts: enabled || steps.fixer ? (fix?.maxAttempts ?? 3) : 0,
  }
}

const emptyOutcome = (
  repo: string,
  outcome: PortOutcome,
  extra: Partial<TargetOutcome> = {},
): TargetOutcome => ({
  repo,
  outcome,
  remapped: [],
  checks: [],
  changedFiles: [],
  diffStat: emptyStat,
  notes: [],
  ...extra,
})

/** `PortData.source` of a loaded change. */
export function sourceData(source: SourceChange): PortData['source'] {
  return {
    repo: source.repo,
    kind: source.kind,
    ...(source.mergeRequest !== undefined ? { mergeRequest: source.mergeRequest } : {}),
    ...(source.commits ? { commits: source.commits } : {}),
    ...(source.range ? { range: source.range } : {}),
    title: source.title,
    description: source.description,
    ...(source.webUrl ? { webUrl: source.webUrl } : {}),
    issues: source.issues,
    intent: intentSummary(source),
    files: storedFiles(source.files),
  }
}

/**
 * Ports a change from one repository to its siblings: loads the source, then per target checks
 * out, triages, applies or adapts, verifies, fixes and (unless `dryRun`) opens or updates a merge
 * request on `<branchPrefix>/<source-slug>`; finally comments on the source merge request.
 * Per-target failures end up in the outcome; rejects only when the source cannot be loaded.
 */
export async function runPort(input: PortInput): Promise<PortData> {
  const steps = stepsOf(input)
  const sourceRef = parseRepo(input.source.repo, input.forgeId)
  if (sourceRef.forge !== input.forgeId)
    throw new Error(`the source ${input.source.repo} is not on the group's forge ${input.forgeId}`)
  const source = await steps.source.load({
    spec: input.source,
    forge: input.forge,
    forgeId: input.forgeId,
    checkout: input.checkout,
    runner: input.runner,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const stored = sourceData(source)
  const intent = stored.intent
  const settings = {
    branchPrefix: input.mergeRequest?.branchPrefix ?? 'holtkeeper/port',
    labels: input.mergeRequest?.labels ?? ['holtkeeper', 'port'],
    draftOnFailure: input.mergeRequest?.draftOnFailure ?? true,
  }
  const branch = `${settings.branchPrefix.replace(/\/+$/, '')}/${sourceSlug(source)}`.slice(0, 100)
  const dryRun = input.dryRun ?? false
  const targets = await resolveTargets({
    patterns: input.targets ?? [],
    group: input.group,
    repos: input.repos,
    source: sourceRef.path,
    forge: input.forge,
    forgeId: input.forgeId,
  })
  input.log?.(`porting "${source.title}" to ${targets.length} repositories`)

  const outcomes = await mapLimit(targets, input.concurrency ?? 2, async (ref) => {
    const log = input.log ? (line: string) => input.log?.(`${ref.path}: ${line}`) : undefined
    let webUrl: string | undefined
    try {
      const repository = await input.forge.getRepository(ref.path)
      webUrl = repository.webUrl
      if (repository.archived)
        return emptyOutcome(ref.path, 'not-applicable', { webUrl, reason: 'archived' })
      const checkout = await input.checkout(ref, { ref: repository.defaultBranch, writable: true })
      const runner = checkout.runner ?? input.runner
      try {
        const result = await portCheckout({
          dir: checkout.dir,
          runner,
          files: source.files,
          intent,
          triage: steps.triage,
          applier: steps.applier,
          adapter: steps.adapter,
          verifier: steps.verifier,
          fixer: steps.fixer,
          maxAttempts: steps.maxAttempts,
          ...(input.checks ? { checks: input.checks } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(log ? { log } : {}),
        })
        const outcome: TargetOutcome = {
          repo: ref.path,
          webUrl,
          outcome: result.outcome,
          ...(result.method ? { method: result.method } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          triage: result.triage,
          remapped: result.remapped,
          ...(result.adapt ? { adapt: result.adapt } : {}),
          checks: result.checks,
          ...(result.fix && result.fix.attempts > 0
            ? {
                fix: {
                  attempts: result.fix.attempts,
                  ...(result.fix.report ? { report: result.fix.report } : {}),
                  files: result.fix.touched,
                },
              }
            : {}),
          changedFiles: result.files.map((file) => file.path),
          diffStat: result.diffStat,
          notes: result.notes,
        }
        const failed = result.outcome === 'failed'
        const publishable =
          result.files.length > 0 &&
          (result.outcome.startsWith('ported-') || (failed && result.method !== undefined))
        if (failed && publishable && !settings.draftOnFailure) {
          outcome.notes.push('checks fail; no merge request opened')
        } else if (publishable && !dryRun) {
          const mergeRequest = await publishChanges({
            forge: input.forge,
            repo: ref.path,
            dir: checkout.dir,
            files: result.files,
            branch,
            title: mergeRequestTitle(source.title),
            description: mergeRequestDescription({ source: stored, outcome, files: source.files }),
            labels: settings.labels,
            failed,
            targetBranch: repository.defaultBranch,
          })
          if (mergeRequest) outcome.mergeRequest = mergeRequest
        }
        return outcome
      } finally {
        await checkout.cleanup().catch(() => undefined)
      }
    } catch (error) {
      log?.(`error: ${message(error)}`)
      return emptyOutcome(ref.path, 'error', {
        ...(webUrl ? { webUrl } : {}),
        error: message(error),
      })
    }
  })

  const data: PortData = { group: input.group, source: stored, branch, dryRun, targets: outcomes }
  if (
    (input.commentOnSource ?? true) &&
    !dryRun &&
    source.kind === 'merge-request' &&
    outcomes.length
  ) {
    try {
      await input.forge.commentOnMergeRequest(
        source.path,
        source.mergeRequest!,
        sourceComment(data),
      )
      data.sourceComment = { posted: true }
    } catch (error) {
      data.sourceComment = { posted: false, error: message(error) }
    }
  }
  return data
}
