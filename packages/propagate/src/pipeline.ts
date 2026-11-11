// oxlint-disable no-await-in-loop -- steps touch the same checkout or forge branch and run in order
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { type CommandRunner, runChecked } from '@holtkeeper/exec'
import type { GitForge, RepoRef } from '@holtkeeper/forge'

import { defaultBumpers } from './bump.ts'
import { type CheckOptions, defaultVerifier, detectChecks } from './checks.ts'
import { chainNotes, forgeNotes, nodeModulesNotes, trimText } from './notes.ts'
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
  Bump,
  Bumper,
  CheckResult,
  FixProposer,
  FixRequest,
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
}

/** Result of bumping and verifying one checkout. */
export interface CheckoutOutcome {
  status: RepoStatus
  bumps: Bump[]
  checks: CheckResult[]
  /** Release notes of the bumped packages, looked up only when checks fail. */
  releaseNotes: ReleaseNotes[]
  notes: string[]
  /** Files to publish: the bump's manifests and lockfiles. */
  files: ChangedFile[]
  /** What a write task needs to make failing checks pass; only when checks fail in a git checkout. */
  fix?: Omit<FixRequest, 'repo'>
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
  checks?: CheckOptions
  allowInstallScripts: boolean
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

/** Rules for the agent of a fix task, at the top of its prompt. */
export const bumpInstructions = [
  'Dependencies were updated in this repository and some checks now fail. The update is already',
  'applied in the checkout. Adapt the code to the new versions. Never edit lockfiles, never change',
  'dependency versions or ranges in manifests and never downgrade a package.',
].join(' ')

/** Longest prompt a fix task gets; write tasks accept 20 000 characters. */
const MAX_FIX_PROMPT = 19_000

/** The prompt of a fix task: the rules, the bumps, the failing checks' output and the release notes. */
export function fixPrompt(input: {
  bumps: Bump[]
  checks: CheckResult[]
  releaseNotes: ReleaseNotes[]
}): string {
  const failing = input.checks.filter((check) => !check.ok)
  const parts = [
    bumpInstructions,
    '## Updated dependencies',
    input.bumps
      .map((bump) => `- ${bump.package}: ${bump.from} → ${bump.to} (${bump.manifest})`)
      .join('\n'),
    '## Failing checks',
    ...failing.map(
      (check) =>
        `### ${check.name} (\`${check.command}\`, exit ${check.exitCode})\n\n\`\`\`\n${trimText(check.output.split('\n').slice(-120).join('\n'), 4000)}\n\`\`\``,
    ),
    ...input.releaseNotes.map(
      (note) =>
        `## Release notes of ${note.package} ${note.from ?? ''} → ${note.to} (${note.source})\n\n${trimText(note.text, 5000)}`,
    ),
  ]
  return trimText(parts.join('\n\n'), MAX_FIX_PROMPT)
}

/** The staged diff of `files` against `HEAD`, binary-safe, for `git apply -3` elsewhere. */
async function diffOf(dir: string, runner: CommandRunner, files: ChangedFile[]) {
  const paths = files.map((file) => file.path)
  await runChecked(runner, ['git', 'add', '-A', '--', ...paths], { cwd: dir })
  const { stdout } = await runChecked(
    runner,
    ['git', 'diff', '--cached', '--binary', '--no-color', '--', ...paths],
    { cwd: dir },
  )
  return stdout
}

/**
 * Bumps and verifies one writable checkout. When checks fail it looks up the release notes and
 * prepares a fix request (the bump as a patch, the prompt for a write task's agent). Rejects only
 * when a bumper fails.
 */
export async function updateCheckout(input: UpdateCheckoutInput): Promise<CheckoutOutcome> {
  const { dir, runner, signal } = input
  const toBump = input.plan.usages.filter((usage) => usage.next !== undefined)
  const base = { checks: [], releaseNotes: [], files: [] }
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
  const specs = await detectChecks(dir, {
    ...(input.checks ? { checks: input.checks } : {}),
    go: bumps.some((bump) => bump.manifest.endsWith('go.mod')),
    allowInstallScripts: input.allowInstallScripts,
  })
  const checks = await input.verifier.verify({
    dir,
    checks: specs,
    runner,
    ...(signal ? { signal } : {}),
  })
  const ok = checks.every((check) => check.ok)

  const releaseNotes: ReleaseNotes[] = []
  if (!ok)
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

  let files: ChangedFile[] = []
  let fix: CheckoutOutcome['fix']
  if (afterBump) {
    files = (await changedFiles(dir, runner)).filter((file) => afterBump.has(file.path))
    if (!ok && files.length)
      fix = {
        prompt: fixPrompt({ bumps, checks, releaseNotes }),
        patch: await diffOf(dir, runner, files),
      }
  } else {
    files = [...new Set(bumps.map((bump) => bump.manifest))].map((path) => ({
      path,
      action: 'update' as const,
    }))
    notes.push('not a git checkout; changed files are the bumped manifests only')
  }
  return {
    status: ok ? 'updated' : 'failed',
    bumps,
    checks,
    releaseNotes,
    notes,
    files,
    ...(fix && { fix }),
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
  /**
   * Open a draft labeled `needs-attention` when checks fail and no fix task takes the repository
   * over; otherwise no merge request. Default true.
   */
  draftOnFailure?: boolean
  /** Default `['holtkeeper', 'dependencies']`. */
  labels?: string[]
  /** Default `holtkeeper/update`. */
  branchPrefix?: string
}

/** A checkout as the task engine provides it. */
export interface Checkout {
  dir: string
  sha: string
  ref: string
  cleanup(): Promise<void>
  /** Commits signed with the forge's key; see `AnalyzerContext.checkout`. */
  publisher?: GitPublisher
}

/** Checks out a repository; mirrors `AnalyzerContext.checkout`. */
export type CheckoutFn = (
  repo: RepoRef,
  options?: { ref?: string; writable?: boolean },
) => Promise<Checkout>

/** Longest bump patch a fix task takes; write tasks accept 1 000 000 characters. */
const MAX_FIX_PATCH = 1_000_000

/** Everything one wave across a group needs. */
export interface PropagationInput {
  group: string
  forgeId: string
  repos: RepoRef[]
  forge: GitForge
  checkout: CheckoutFn
  runner: CommandRunner
  registry?: VersionRegistry
  packages: PackageRequest[]
  onlyRepos?: string[]
  checks?: CheckOptions
  allowInstallScripts?: boolean
  /**
   * Proposes one write task per repository whose checks fail after the bump, all in one task
   * group; such repositories get no merge request from the wave. Without it (or with `dryRun`),
   * and for repositories it proposed no task for or when proposing fails, they get a draft
   * (`draftOnFailure`), made again from the bump patch after proposing.
   */
  fixes?: FixProposer
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

function stepsOf(steps: PropagateSteps, extraNotes: ReleaseNotesSource[]) {
  return {
    planner: steps.planner ?? defaultPlanner,
    bumpers: steps.bumpers ?? defaultBumpers,
    verifier: steps.verifier ?? defaultVerifier,
    notes: steps.notes ?? chainNotes([nodeModulesNotes(), ...extraNotes]),
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
  changedFiles: [],
  notes: [],
  ...extra,
})

const bumpedTargets = (targets: PackageTarget[], bumps: Bump[]) =>
  targets.filter((target) => bumps.some((bump) => bump.package === target.name))

/**
 * Rolls package updates out across the repositories of a group: plans through the forge, then
 * per repository checks out, bumps, verifies and (unless `dryRun`) commits and opens or updates a
 * merge request. Repositories whose checks fail go to one task group of write tasks (`fixes`)
 * that carry the bump as a patch. Per-repository failures end up in the outcome, never as a
 * rejection; rejects only when a `latest` version cannot be resolved.
 */
export async function runPropagation(input: PropagationInput) {
  const targets = await resolveTargets(input.packages, input.registry ?? createHttpRegistry())
  const steps = stepsOf(input.steps ?? {}, [
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
  const fixes = dryRun ? undefined : input.fixes
  const requests: (FixRequest & {
    bumps: Bump[]
    ref: RepoRef
    targetBranch: string
    files: ChangedFile[]
    checks: CheckResult[]
    releaseNotes: ReleaseNotes[]
  })[] = []

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
          ...(input.checks ? { checks: input.checks } : {}),
          allowInstallScripts: input.allowInstallScripts ?? false,
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
          changedFiles: result.files.map((file) => file.path),
          notes: result.notes,
        }
        const manifests = new Set(result.bumps.map((bump) => bump.manifest))
        const changed = result.files.some((file) => manifests.has(file.path))
        const failed = result.status === 'failed'
        if (failed && changed && fixes && result.fix) {
          if (result.fix.patch.length <= MAX_FIX_PATCH) {
            requests.push({
              repo: `${input.forgeId}:${ref.path}`,
              ...result.fix,
              bumps: result.bumps,
              ref,
              targetBranch: repository.defaultBranch,
              files: result.files,
              checks: result.checks,
              releaseNotes: result.releaseNotes,
            })
            return { outcome, releaseNotes: result.releaseNotes }
          }
          outcome.notes.push('the bump is too large for a fix task')
        }
        if (failed && !settings.draftOnFailure)
          outcome.notes.push('checks fail; no merge request opened')
        if (!dryRun && changed && (!failed || settings.draftOnFailure)) {
          const bumped = bumpedTargets(targets, result.bumps)
          const mergeRequest = await publishChanges({
            forge: input.forge,
            repo: ref.path,
            dir: checkout.dir,
            files: result.files,
            branch: branchName(settings.branchPrefix, bumped),
            title: mergeRequestTitle(bumped),
            description: mergeRequestBody({
              bumps: result.bumps,
              checks: result.checks,
              notes: result.releaseNotes,
            }),
            labels: settings.labels,
            failed,
            targetBranch: repository.defaultBranch,
            ...(checkout.publisher && { mode: 'git' as const, git: checkout.publisher }),
          })
          if (mergeRequest) outcome.mergeRequest = mergeRequest
        } else if (result.bumps.length && !changed)
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

  /** Opens the `needs-attention` draft of a repository no fix task took, from its bump patch. */
  const publishDraft = async (request: (typeof requests)[number], outcome: RepoOutcome) => {
    if (!settings.draftOnFailure) {
      outcome.notes.push('checks fail; no merge request opened')
      return
    }
    const checkout = await input.checkout(request.ref, {
      ref: request.targetBranch,
      writable: true,
    })
    try {
      const file = join(checkout.dir, '.holtkeeper-bump.patch')
      await Bun.write(file, request.patch)
      try {
        await runChecked(input.runner, ['git', 'apply', '--whitespace=nowarn', file], {
          cwd: checkout.dir,
        })
      } finally {
        await rm(file, { force: true })
      }
      const bumped = bumpedTargets(targets, request.bumps)
      const mergeRequest = await publishChanges({
        forge: input.forge,
        repo: request.ref.path,
        dir: checkout.dir,
        files: request.files,
        branch: branchName(settings.branchPrefix, bumped),
        title: mergeRequestTitle(bumped),
        description: mergeRequestBody({
          bumps: request.bumps,
          checks: request.checks,
          notes: request.releaseNotes,
        }),
        labels: settings.labels,
        failed: true,
        targetBranch: request.targetBranch,
        ...(checkout.publisher && { mode: 'git' as const, git: checkout.publisher }),
      })
      if (mergeRequest) outcome.mergeRequest = mergeRequest
    } catch (error) {
      outcome.notes.push(`opening a draft failed: ${message(error)}`)
    } finally {
      await checkout.cleanup().catch(() => undefined)
    }
  }

  const outcomes = results.map((result) => result.outcome)
  let fixGroup: string | undefined
  if (fixes && requests.length) {
    const byRepo = new Map<string, RepoOutcome>(
      outcomes.map((outcome) => [`${input.forgeId}:${outcome.repo}`, outcome]),
    )
    let tasks: Record<string, string> = {}
    try {
      const proposed = await fixes.propose({
        group: input.group,
        title: mergeRequestTitle(
          bumpedTargets(
            targets,
            requests.flatMap((request) => request.bumps),
          ),
        ),
        fixes: requests.map(({ repo, prompt, patch }) => ({ repo, prompt, patch })),
      })
      fixGroup = proposed?.groupId
      tasks = proposed?.tasks ?? {}
    } catch (error) {
      input.log?.(`fix tasks: ${message(error)}`)
      for (const request of requests)
        byRepo.get(request.repo)?.notes.push(`proposing a fix task failed: ${message(error)}`)
    }
    for (const request of requests) {
      const outcome = byRepo.get(request.repo)
      if (!outcome) continue
      const task = tasks[request.repo]
      if (task) {
        outcome.fixTask = task
        continue
      }
      outcome.notes.push('no fix task was proposed')
      await publishDraft(request, outcome)
    }
  }

  return {
    group: input.group,
    packages: targets,
    dryRun,
    repos: outcomes,
    releaseNotes: dedupeNotes(results),
    ...(fixGroup && { fixGroup }),
  }
}

/** Input of `propagateLocal`. */
export interface PropagateLocalInput {
  /** Writable project directories; they are changed in place. */
  dirs: string[]
  packages: PackageRequest[]
  checks?: CheckOptions
  runner: CommandRunner
  /** Needed only for `latest`; default npm registry / Go proxy. */
  registry?: VersionRegistry
  allowInstallScripts?: boolean
  steps?: PropagateSteps
  concurrency?: number
  signal?: AbortSignal
  log?: (line: string) => void
}

/**
 * Plan, bump and verify on local directories without publishing or proposing anything. Each
 * outcome's `repo` is its directory. Rejects only when a `latest` version cannot be resolved.
 */
export async function propagateLocal(input: PropagateLocalInput) {
  const targets = await resolveTargets(
    input.packages,
    input.registry ??
      (input.packages.some((pkg) => pkg.version === 'latest') ? createHttpRegistry() : undefined),
  )
  const steps = stepsOf(input.steps ?? {}, [])
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
        ...(input.checks ? { checks: input.checks } : {}),
        allowInstallScripts: input.allowInstallScripts ?? false,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.log ? { log: (line: string) => input.log?.(`${dir}: ${line}`) } : {}),
      })
      const outcome: RepoOutcome = {
        repo: dir,
        status: result.status,
        usages: plan.usages,
        bumps: result.bumps,
        checks: result.checks,
        changedFiles: result.files.map((file) => file.path),
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
