import type { Commit, ForgeRelease, GitForge, MergeRequest, RepoRef } from '@holtkeeper/forge'

import { blockingGates, releaseMarker } from './plan.ts'
import type { ReleaseSettings } from './settings.ts'
import { fillTemplate } from './template.ts'
import type { GateResult, ReleaseFacts, ReleasePlan } from './types.ts'

/** A step refused because gates failed; `gates` lists the failing ones. */
export class GateError extends Error {
  readonly gates: GateResult[]

  constructor(gates: GateResult[]) {
    super(gates.map((gate) => gate.message).join('; '))
    this.name = 'GateError'
    this.gates = gates
  }
}

export interface StepContext {
  forge: GitForge
  repo: RepoRef
  settings: ReleaseSettings
  now: Date
  /** Report what would happen without changing the forge. */
  dryRun?: boolean
}

const checkPlan = (plan: ReleasePlan, force: boolean) => {
  const blocking = blockingGates(plan.gates, force)
  if (blocking.length) throw new GateError(blocking)
}

export interface ProposalResult {
  request: Pick<MergeRequest, 'id' | 'title' | 'webUrl'>
  created: boolean
  dryRun?: true
}

/**
 * Opens the release candidate merge request from the source to the target branch, or brings
 * the open one up to date (title, description, labels added). Refuses when gates fail, unless
 * `force` overrides those that may be overridden.
 */
export async function proposeRelease(
  context: StepContext,
  facts: ReleaseFacts,
  plan: ReleasePlan,
  { force = false }: { force?: boolean } = {},
): Promise<ProposalResult> {
  const { forge, repo, settings } = context
  if (settings.flow.mode !== 'merge-request')
    throw new Error('only the merge request flow proposes releases')
  if (!facts.source) throw new Error(`branch ${settings.flow.source} does not exist`)
  checkPlan(plan, force)
  const existing = facts.request
  if (context.dryRun)
    return {
      request: existing ?? { id: 0, title: plan.title, webUrl: '' },
      created: !existing,
      dryRun: true,
    }
  if (existing) {
    const labels = [...new Set([...existing.labels, ...settings.mergeRequest.labels])]
    const request = await forge.updateMergeRequest(repo.path, existing.id, {
      title: plan.title,
      description: plan.body,
      ...(labels.length !== existing.labels.length ? { labels } : {}),
    })
    return { request, created: false }
  }
  const request = await forge.createMergeRequest(repo.path, {
    sourceBranch: facts.source.name,
    targetBranch: facts.target.name,
    title: plan.title,
    description: plan.body,
    ...(settings.mergeRequest.labels.length ? { labels: settings.mergeRequest.labels } : {}),
    ...(settings.mergeRequest.reviewers.length
      ? { reviewers: settings.mergeRequest.reviewers }
      : {}),
    draft: settings.mergeRequest.draft,
  })
  return { request, created: true }
}

/**
 * Rewrites the description of the open release candidate merge request with `plan`, when the
 * settings keep it updated and Holtkeeper opened it (its description carries the marker). The
 * title stays as people may have edited it. Resolves `false` when nothing was changed.
 */
export async function refreshProposal(
  context: StepContext,
  facts: ReleaseFacts,
  plan: ReleasePlan,
): Promise<boolean> {
  const request = facts.request
  if (!request || !context.settings.mergeRequest.autoUpdate) return false
  if (!request.description.includes(releaseMarker) || request.description === plan.body)
    return false
  if (context.dryRun) return true
  await context.forge.updateMergeRequest(context.repo.path, request.id, { description: plan.body })
  return true
}

/** `content` of a changelog file with `section` added on top, below a leading `#` title. */
export function prependChangelog(content: string | undefined, section: string): string {
  const block = `${section.trim()}\n`
  if (!content?.trim()) return `# Changelog\n\n${block}`
  const lines = content.split('\n')
  if (lines[0]?.startsWith('# ')) {
    let end = 1
    while (end < lines.length && lines[end]?.trim() === '') end++
    return [...lines.slice(0, 1), '', block, ...lines.slice(end)].join('\n')
  }
  return `${block}\n${content}`
}

export interface VersionResult {
  version: string
  tag: string
  sha: string
  release?: ForgeRelease
  changelogCommit?: Commit
  dryRun?: true
}

/**
 * Creates the version: optionally commits the notes to the changelog file on the target branch,
 * tags the target head (or that commit) with an annotated tag, and creates a forge release with
 * the notes when the settings ask and the forge can. Refuses when gates fail, unless `force`.
 */
export async function createVersion(
  context: StepContext,
  facts: ReleaseFacts,
  plan: ReleasePlan,
  { force = false }: { force?: boolean } = {},
): Promise<VersionResult> {
  const { forge, repo, settings, now } = context
  checkPlan(plan, force)
  const { version, tag } = plan
  if (!version || !tag) throw new Error('no version chosen')
  const values = {
    version,
    tag,
    previous: facts.latest?.version ?? 'none',
    previousTag: facts.latest?.tag ?? 'none',
    target: facts.target.name,
    repo: repo.path,
  }
  const fill = (template: string) => fillTemplate(template, values, now, settings.timezone)
  if (context.dryRun) return { version, tag, sha: facts.target.sha, dryRun: true }

  let sha = facts.target.sha
  let changelogCommit: Commit | undefined
  const file = settings.tag.changelogFile
  if (file.enabled) {
    const current = await forge.readFile(repo.path, file.path, facts.target.name)
    const section = [fill(file.heading), plan.summary.markdown, plan.changelog]
      .filter((part) => part.trim())
      .join('\n\n')
    changelogCommit = await forge.commit(repo.path, {
      branch: facts.target.name,
      message: fill(file.message),
      changes: [
        {
          action: current === undefined ? 'create' : 'update',
          path: file.path,
          content: prependChangelog(current, section),
        },
      ],
    })
    sha = changelogCommit.sha
  }

  const created = await forge.createTag(repo.path, {
    name: tag,
    ref: sha,
    message: fill(settings.tag.message),
  })
  const release =
    settings.tag.release && forge.createRelease
      ? await forge.createRelease(repo.path, { tag, name: plan.title, description: plan.body })
      : undefined
  return {
    version,
    tag,
    sha: created.sha,
    ...(release ? { release } : {}),
    ...(changelogCommit ? { changelogCommit } : {}),
  }
}
