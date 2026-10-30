// oxlint-disable no-await-in-loop -- steps touch the same checkout or forge branch and run in order
import { join } from 'node:path'

import type { Agent } from '@holtkeeper/agent'
import type { CommandRunner } from '@holtkeeper/exec'
import type { GitForge, RepoRef } from '@holtkeeper/forge'

import { defaultBumpers, detectNodeProject, writeUsages } from './bump.ts'
import { type CheckOptions, defaultVerifier, detectChecks } from './checks.ts'
import { createAgentFixer, fixUntilPassing, noopFixer } from './fix.ts'
import { chainNotes, forgeNotes, nodeModulesNotes } from './notes.ts'
import { type Planner, defaultPlanner, diskFiles, forgeFiles } from './plan.ts'
import {
  type ChangedFile,
  type GitPublisher,
  branchName,
  changedFiles,
  mergeRequestBody,
  mergeRequestTitle,
  publishChanges,
  snapshot,
} from './publish.ts'
import { createHttpRegistry, resolveTargets } from './registry.ts'
import { globToRegExp } from './semver.ts'
import type {
  AgentReport,
  Bump,
  Bumper,
  CheckResult,
  FixContext,
  Fixer,
  PackageRequest,
  PackageTarget,
  ReleaseNotes,
  ReleaseNotesSource,
  RepoOutcome,
  RepoPlan,
  RepoStatus,
  Verifier,
  VersionRegistry,
} from './types.ts'

/** The replaceable steps of the pipeline; each defaults to the built-in implementation. */
export interface PropagateSteps {
  planner?: Planner
  bumpers?: Bumper[]
  verifier?: Verifier
  notes?: ReleaseNotesSource
  fixer?: Fixer
}

/** Result of bumping, verifying and fixing one checkout. */
export interface CheckoutOutcome {
  status: RepoStatus
  bumps: Bump[]
  checks: CheckResult[]
  attempts: number
  agent?: AgentReport
  releaseNotes: ReleaseNotes[]
  notes: string[]
  /** Files to publish: the bump's manifests and lockfiles plus what the fixer touched. */
  files: ChangedFile[]
  fixedFiles: string[]
}

/** Input of `updateCheckout`. */
export interface UpdateCheckoutInput {
  dir: string
  plan: RepoPlan
  targets: PackageTarget[]
  runner: CommandRunner
  bumpers: Bumper[]
  verifier: Verifier
  notes: ReleaseNotesSource
  fixer: Fixer
  checks?: CheckOptions
  allowInstallScripts: boolean
  maxAttempts: number
  signal?: AbortSignal
  log?: (line: string) => void
}

async function trySnapshot(dir: string, runner: CommandRunner) {
  try {
    return await snapshot(dir, runner)
  } catch {
    return undefined
  }
}

/** Rules for a fixer working on a dependency bump, passed as its instructions. */
export const bumpInstructions = [
  'Dependencies were updated in this repository and some checks now fail.',
  'Adapt the code to the new versions. Never edit lockfiles, never change dependency versions or',
  'ranges in manifests and never downgrade a package.',
].join(' ')

/** Fix context for a bump: the bumped declarations and the release notes found. */
export function bumpContext(bumps: Bump[], notes: ReleaseNotes[]): FixContext[] {
  return [
    {
      title: 'Updated dependencies',
      text: bumps
        .map((bump) => `- ${bump.package}: ${bump.from} → ${bump.to} (${bump.manifest})`)
        .join('\n'),
    },
    ...notes.map((note) => ({
      title: `Release notes of ${note.package} ${note.from ?? ''} → ${note.to} (${note.source})`,
      text: note.text,
    })),
  ]
}

/**
 * Bumps, verifies and (when checks fail and the fixer can) fixes one writable checkout. The
 * fixer may not change the lockfile or the bumped values: both are restored after each attempt.
 * Rejects only when a bumper fails.
 */
export async function updateCheckout(input: UpdateCheckoutInput): Promise<CheckoutOutcome> {
  const { dir, runner, signal } = input
  const toBump = input.plan.usages.filter((usage) => usage.next !== undefined)
  const base = { checks: [], attempts: 0, releaseNotes: [], files: [], fixedFiles: [] }
  if (input.plan.usages.length === 0)
    return { ...base, status: 'skipped', bumps: [], notes: [...input.plan.notes] }
  if (toBump.length === 0)
    return { ...base, status: 'unchanged', bumps: [], notes: [...input.plan.notes] }

  const notes = [...input.plan.notes]
  const bumps: Bump[] = []
  for (const bumper of input.bumpers) {
    const usages = toBump.filter((usage) => usage.ecosystem === bumper.ecosystem)
    if (usages.length === 0) continue
    const result = await bumper.bump({
      dir,
      usages,
      targets: input.targets,
      runner,
      allowInstallScripts: input.allowInstallScripts,
      ...(signal ? { signal } : {}),
    })
    bumps.push(...result.bumps)
    notes.push(...result.notes)
  }
  if (bumps.length === 0) return { ...base, status: 'unchanged', bumps, notes }
  input.log?.(
    `bumped ${bumps.map((bump) => `${bump.package} ${bump.from} → ${bump.to}`).join(', ')}`,
  )

  const afterBump = await trySnapshot(dir, runner)
  const lockfile = (await detectNodeProject(dir))?.lockfile
  const lockText = lockfile ? await Bun.file(join(dir, lockfile)).text() : undefined
  const specs = await detectChecks(dir, {
    ...(input.checks ? { checks: input.checks } : {}),
    go: bumps.some((bump) => bump.manifest.endsWith('go.mod')),
    allowInstallScripts: input.allowInstallScripts,
  })
  let checks = await input.verifier.verify({
    dir,
    checks: specs,
    runner,
    attempt: 0,
    ...(signal ? { signal } : {}),
  })
  let attempts = 0
  let agent: AgentReport | undefined
  const releaseNotes: ReleaseNotes[] = []
  const fixed = new Set<string>()

  if (checks.some((check) => !check.ok) && input.maxAttempts > 0) {
    for (const name of new Set(bumps.map((bump) => bump.package))) {
      const usage = toBump.find((candidate) => candidate.package === name)
      const target = input.targets.find((candidate) => candidate.name === name)
      if (!usage || !target) continue
      const found = await input.notes.notes({
        dir,
        package: name,
        ecosystem: target.ecosystem,
        ...(usage.current ? { from: usage.current } : {}),
        to: target.version,
      })
      if (found) releaseNotes.push(found)
    }
    const loop = await fixUntilPassing({
      dir,
      runner,
      verifier: input.verifier,
      fixer: input.fixer,
      specs,
      checks,
      maxAttempts: input.maxAttempts,
      context: bumpContext(bumps, releaseNotes),
      instructions: bumpInstructions,
      async afterAttempt(attempt) {
        if (
          lockfile &&
          lockText !== undefined &&
          (await Bun.file(join(dir, lockfile)).text()) !== lockText
        ) {
          await Bun.write(join(dir, lockfile), lockText)
          notes.push(`attempt ${attempt}: restored ${lockfile}, which the fixer changed`)
        }
        const reapplied = await writeUsages(
          dir,
          toBump.filter((usage) => usage.ecosystem === 'npm'),
        )
        notes.push(...reapplied.notes)
      },
      ...(signal ? { signal } : {}),
      ...(input.log ? { log: input.log } : {}),
    })
    checks = loop.checks
    attempts = loop.attempts
    agent = loop.report
    for (const path of loop.touched) fixed.add(path)
  }

  const ok = checks.every((check) => check.ok)
  const status: RepoStatus = ok ? (attempts > 0 ? 'fixed' : 'updated') : 'failed'
  let files: ChangedFile[] = []
  try {
    const keep = new Set([...(afterBump?.keys() ?? []), ...fixed])
    files = (await changedFiles(dir, runner)).filter((file) => keep.has(file.path))
  } catch {
    files = [...new Set(bumps.map((bump) => bump.manifest))].map((path) => ({
      path,
      action: 'update' as const,
    }))
    notes.push('not a git checkout; changed files are the bumped manifests only')
  }
  const fixedFiles = [...fixed].filter((path) => !afterBump?.has(path)).toSorted()
  return {
    status,
    bumps,
    checks,
    attempts,
    ...(agent ? { agent } : {}),
    releaseNotes,
    notes,
    files,
    fixedFiles,
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
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

function dedupeNotes(outcomes: { releaseNotes: ReleaseNotes[] }[]): ReleaseNotes[] {
  const seen = new Map<string, ReleaseNotes>()
  for (const { releaseNotes } of outcomes)
    for (const note of releaseNotes) {
      const key = `${note.package}\0${note.from ?? ''}\0${note.source}`
      if (!seen.has(key)) seen.set(key, note)
    }
  return [...seen.values()]
}

/** Options of the merge requests the wave opens. */
export interface MergeRequestSettings {
  /** Open a draft labeled `needs-attention` when checks still fail; otherwise no merge request. Default true. */
  draftOnFailure?: boolean
  /** Default `['holtkeeper', 'dependencies']`. */
  labels?: string[]
  /** Default `holtkeeper/update`. */
  branchPrefix?: string
}

/** Settings of the fix step. */
export interface FixSettings {
  /** Default: true when an agent is configured. */
  enabled?: boolean
  /** Default 3. */
  maxAttempts?: number
  maxTurns?: number
  timeoutMinutes?: number
}

/** A checkout as the task engine provides it. */
export interface Checkout {
  dir: string
  sha: string
  ref: string
  cleanup(): Promise<void> /** Commits signed with the forge's key; see `AnalyzerContext.checkout`. */
  publisher?: GitPublisher
}

/** Checks out a repository; mirrors `AnalyzerContext.checkout`. */
export type CheckoutFn = (
  repo: RepoRef,
  options?: { ref?: string; writable?: boolean },
) => Promise<Checkout>

/** Everything one wave across a group needs. */
export interface PropagationInput {
  group: string
  forgeId: string
  repos: RepoRef[]
  forge: GitForge
  checkout: CheckoutFn
  runner: CommandRunner
  agent?: Agent
  registry?: VersionRegistry
  packages: PackageRequest[]
  onlyRepos?: string[]
  checks?: CheckOptions
  allowInstallScripts?: boolean
  fix?: FixSettings
  mergeRequest?: MergeRequestSettings
  /** Package name → `forge:path` of its source repository, for release notes. */
  sources?: Record<string, string>
  dryRun?: boolean
  /** Repositories processed at once. Default 2. */
  concurrency?: number
  steps?: PropagateSteps
  signal?: AbortSignal
  log?: (line: string) => void
}

function stepsOf(
  steps: PropagateSteps,
  agent: Agent | undefined,
  fix: FixSettings | undefined,
  extraNotes: ReleaseNotesSource[],
) {
  const enabled = fix?.enabled ?? agent !== undefined
  return {
    planner: steps.planner ?? defaultPlanner,
    bumpers: steps.bumpers ?? defaultBumpers,
    verifier: steps.verifier ?? defaultVerifier,
    notes: steps.notes ?? chainNotes([nodeModulesNotes(), ...extraNotes]),
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
  status: RepoStatus,
  extra: Partial<RepoOutcome> = {},
): RepoOutcome => ({
  repo,
  status,
  usages: [],
  bumps: [],
  checks: [],
  attempts: 0,
  changedFiles: [],
  fixedFiles: [],
  notes: [],
  ...extra,
})

/**
 * Rolls package updates out across the repositories of a group: plans through the forge, then
 * per repository checks out, bumps, verifies, fixes and (unless `dryRun`) commits and opens or
 * updates a merge request. Per-repository failures end up in the outcome, never as a rejection;
 * rejects only when a `latest` version cannot be resolved.
 */
export async function runPropagation(input: PropagationInput) {
  const targets = await resolveTargets(input.packages, input.registry ?? createHttpRegistry())
  const steps = stepsOf(input.steps ?? {}, input.agent, input.fix, [
    forgeNotes({ forge: input.forge, forgeId: input.forgeId, sources: input.sources ?? {} }),
  ])
  const only = (input.onlyRepos ?? []).map(globToRegExp)
  const repos = input.repos.filter(
    (repo) => only.length === 0 || only.some((regexp) => regexp.test(repo.path)),
  )
  const settings = {
    draftOnFailure: input.mergeRequest?.draftOnFailure ?? true,
    labels: input.mergeRequest?.labels ?? ['holtkeeper', 'dependencies'],
    branchPrefix: input.mergeRequest?.branchPrefix ?? 'holtkeeper/update',
  }
  const dryRun = input.dryRun ?? false

  const results = await mapLimit(repos, input.concurrency ?? 2, async (ref) => {
    const log = input.log ? (line: string) => input.log?.(`${ref.path}: ${line}`) : undefined
    let webUrl: string | undefined
    try {
      const repository = await input.forge.getRepository(ref.path)
      webUrl = repository.webUrl
      if (repository.archived)
        return {
          outcome: emptyOutcome(ref.path, 'skipped', { webUrl, notes: ['archived'] }),
          releaseNotes: [],
        }
      const plan = await steps.planner.plan(
        forgeFiles(input.forge, ref.path, repository.defaultBranch),
        targets,
      )
      if (!plan.usages.some((usage) => usage.next !== undefined)) {
        const status = plan.usages.length ? 'unchanged' : 'skipped'
        return {
          outcome: emptyOutcome(ref.path, status, {
            webUrl,
            usages: plan.usages,
            notes: plan.notes,
          }),
          releaseNotes: [],
        }
      }
      const checkout = await input.checkout(ref, { ref: repository.defaultBranch, writable: true })
      try {
        const result = await updateCheckout({
          dir: checkout.dir,
          plan,
          targets,
          runner: input.runner,
          bumpers: steps.bumpers,
          verifier: steps.verifier,
          notes: steps.notes,
          fixer: steps.fixer,
          ...(input.checks ? { checks: input.checks } : {}),
          allowInstallScripts: input.allowInstallScripts ?? false,
          maxAttempts: steps.maxAttempts,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(log ? { log } : {}),
        })
        const outcome: RepoOutcome = {
          repo: ref.path,
          webUrl,
          status: result.status,
          usages: plan.usages,
          bumps: result.bumps,
          checks: result.checks,
          attempts: result.attempts,
          ...(result.agent ? { agent: result.agent } : {}),
          changedFiles: result.files.map((file) => file.path),
          fixedFiles: result.fixedFiles,
          notes: result.notes,
        }
        const manifests = new Set(result.bumps.map((bump) => bump.manifest))
        const publishable =
          result.files.some((file) => manifests.has(file.path)) &&
          (result.status !== 'failed' || settings.draftOnFailure)
        if (result.status === 'failed' && !settings.draftOnFailure)
          outcome.notes.push('checks fail; no merge request opened')
        if (
          !dryRun &&
          publishable &&
          (result.status === 'updated' || result.status === 'fixed' || result.status === 'failed')
        ) {
          const failed = result.status === 'failed'
          const mergeRequest = await publishChanges({
            forge: input.forge,
            repo: ref.path,
            dir: checkout.dir,
            files: result.files,
            branch: branchName(
              settings.branchPrefix,
              targets.filter((target) => result.bumps.some((bump) => bump.package === target.name)),
            ),
            title: mergeRequestTitle(
              targets.filter((target) => result.bumps.some((bump) => bump.package === target.name)),
            ),
            description: mergeRequestBody({
              bumps: result.bumps,
              checks: result.checks,
              attempts: result.attempts,
              ...(result.agent ? { agent: result.agent } : {}),
              fixedFiles: result.fixedFiles,
              notes: result.releaseNotes,
            }),
            labels: settings.labels,
            failed,
            targetBranch: repository.defaultBranch,
            ...(checkout.publisher && { mode: 'git' as const, git: checkout.publisher }),
          })
          if (mergeRequest) outcome.mergeRequest = mergeRequest
        } else if (result.bumps.length && !result.files.some((file) => manifests.has(file.path)))
          outcome.notes.push('no manifest changed in the checkout; nothing to publish')
        return { outcome, releaseNotes: result.releaseNotes }
      } finally {
        await checkout.cleanup().catch(() => undefined)
      }
    } catch (error) {
      log?.(`error: ${message(error)}`)
      return {
        outcome: emptyOutcome(ref.path, 'error', {
          ...(webUrl ? { webUrl } : {}),
          error: message(error),
        }),
        releaseNotes: [],
      }
    }
  })

  return {
    group: input.group,
    packages: targets,
    dryRun,
    repos: results.map((result) => result.outcome),
    releaseNotes: dedupeNotes(results),
  }
}

/** Input of `propagateLocal`. */
export interface PropagateLocalInput {
  /** Writable project directories; they are changed in place. */
  dirs: string[]
  packages: PackageRequest[]
  checks?: CheckOptions
  agent?: Agent
  runner: CommandRunner
  /** Needed only for `latest`; default npm registry / Go proxy. */
  registry?: VersionRegistry
  allowInstallScripts?: boolean
  fix?: FixSettings
  steps?: PropagateSteps
  concurrency?: number
  signal?: AbortSignal
  log?: (line: string) => void
}

/**
 * Plan, bump, verify and fix on local directories without publishing anything. Each outcome's
 * `repo` is its directory. Rejects only when a `latest` version cannot be resolved.
 */
export async function propagateLocal(input: PropagateLocalInput) {
  const targets = await resolveTargets(
    input.packages,
    input.registry ??
      (input.packages.some((pkg) => pkg.version === 'latest') ? createHttpRegistry() : undefined),
  )
  const steps = stepsOf(input.steps ?? {}, input.agent, input.fix, [])
  const results = await mapLimit(input.dirs, input.concurrency ?? 1, async (dir) => {
    try {
      const plan = await steps.planner.plan(diskFiles(dir), targets)
      const result = await updateCheckout({
        dir,
        plan,
        targets,
        runner: input.runner,
        bumpers: steps.bumpers,
        verifier: steps.verifier,
        notes: steps.notes,
        fixer: steps.fixer,
        ...(input.checks ? { checks: input.checks } : {}),
        allowInstallScripts: input.allowInstallScripts ?? false,
        maxAttempts: steps.maxAttempts,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.log ? { log: (line: string) => input.log?.(`${dir}: ${line}`) } : {}),
      })
      const outcome: RepoOutcome = {
        repo: dir,
        status: result.status,
        usages: plan.usages,
        bumps: result.bumps,
        checks: result.checks,
        attempts: result.attempts,
        ...(result.agent ? { agent: result.agent } : {}),
        changedFiles: result.files.map((file) => file.path),
        fixedFiles: result.fixedFiles,
        notes: result.notes,
      }
      return { outcome, releaseNotes: result.releaseNotes }
    } catch (error) {
      return { outcome: emptyOutcome(dir, 'error', { error: message(error) }), releaseNotes: [] }
    }
  })
  return {
    packages: targets,
    repos: results.map((result) => result.outcome),
    releaseNotes: dedupeNotes(results),
  }
}
