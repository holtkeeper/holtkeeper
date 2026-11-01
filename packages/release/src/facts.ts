import type { CommitRecord, GitForge, Pipeline, RepoRef } from '@holtkeeper/forge'

import type { ReleaseSettings } from './settings.ts'
import type {
  Acceptance,
  PipelineState,
  ReleaseCommit,
  ReleaseFacts,
  ReleaseStage,
} from './types.ts'
import { latestVersion, versionTags } from './version.ts'

/** Commits read per range; the board counts at most this many. */
export const commitCap = 300

const TAGS = 100

/** A forge commit in the shape the release assistant uses. */
export const toReleaseCommit = (commit: CommitRecord): ReleaseCommit => {
  const newline = commit.message.indexOf('\n')
  return {
    sha: commit.sha,
    parents: commit.parents,
    author: { name: commit.authorName, email: commit.authorEmail },
    date: commit.authoredAt,
    subject: commit.title,
    body: newline === -1 ? '' : commit.message.slice(newline + 1).trim(),
  }
}

const toPipeline = (pipeline: Pipeline | undefined): PipelineState | undefined =>
  pipeline
    ? { id: pipeline.id, status: pipeline.status, sha: pipeline.sha, webUrl: pipeline.webUrl }
    : undefined

/** Thrown when a forge lacks the reads the release assistant needs. */
export class UnsupportedForgeError extends Error {
  constructor(operation: string) {
    super(`the forge cannot ${operation}`)
    this.name = 'UnsupportedForgeError'
  }
}

export interface CollectFactsOptions {
  forge: GitForge
  repo: RepoRef
  settings: ReleaseSettings
  /** The acceptance recorded by Holtkeeper, if any; labels and merges are read from the forge. */
  recorded?: Acceptance
}

/**
 * Reads what the release flow needs from the forge: branch heads, version tags, commits waiting
 * on the source and target branches (at most `commitCap` each), the open and the last merged
 * release merge request, latest pipelines and blocking merge requests. Acceptance comes from
 * `recorded`, else from the acceptance label on the merged merge request or the merge itself, as
 * the settings' signals allow.
 */
export async function collectFacts({
  forge,
  repo,
  settings,
  recorded,
}: CollectFactsOptions): Promise<ReleaseFacts> {
  if (!forge.listCommits) throw new UnsupportedForgeError('list commits')
  const listCommits = forge.listCommits.bind(forge)
  const repository = await forge.getRepository(repo.path)
  const targetName = settings.flow.target ?? repository.defaultBranch
  const mergeRequestMode = settings.flow.mode === 'merge-request'
  const sourceName = settings.flow.source

  const head = async (ref: string) => {
    try {
      return (await listCommits(repo.path, { ref, limit: 1 }))[0]
    } catch {
      return undefined
    }
  }
  const latestPipeline = async (ref: string) =>
    toPipeline((await forge.listPipelines(repo.path, { ref }).catch(() => []))[0])

  const [targetHead, sourceHead, tags] = await Promise.all([
    head(targetName),
    mergeRequestMode && sourceName !== targetName ? head(sourceName) : undefined,
    forge.listTags ? forge.listTags(repo.path, { limit: TAGS }) : [],
  ])
  if (!targetHead) throw new Error(`branch ${targetName} does not exist`)
  const versions = versionTags(settings, tags)
  const latest = latestVersion(settings, versions)

  const range = async (ref: string, since: string | undefined) => {
    const list = await listCommits(repo.path, {
      ref,
      ...(since ? { since } : {}),
      limit: commitCap + 1,
    })
    return {
      commits: list.slice(0, commitCap).map(toReleaseCommit),
      capped: list.length > commitCap,
    }
  }

  const [unreleased, ahead, request, mergedList, targetPipeline, sourcePipeline, open] =
    await Promise.all([
      latest?.sha === targetHead.sha
        ? { commits: [], capped: false }
        : range(targetName, latest?.sha),
      sourceHead ? range(sourceName, targetName) : { commits: [], capped: false },
      sourceHead
        ? forge.findMergeRequest(repo.path, {
            sourceBranch: sourceName,
            targetBranch: targetName,
            state: 'open',
          })
        : undefined,
      sourceHead && forge.listMergeRequests
        ? forge.listMergeRequests(repo.path, {
            state: 'merged',
            targetBranch: targetName,
            limit: 20,
          })
        : [],
      latestPipeline(targetName),
      sourceHead ? latestPipeline(sourceName) : undefined,
      settings.gates.blockingLabels.length && forge.listMergeRequests
        ? forge.listMergeRequests(repo.path, { state: 'open', limit: 100 })
        : [],
    ])

  const releasedAt = latest?.date ? Date.parse(latest.date) : undefined
  const mergedRecord = mergedList
    .filter((mr) => mr.sourceBranch === sourceName && mr.mergedAt)
    .toSorted((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))
    .find(
      (mr) =>
        unreleased.commits.length > 0 &&
        (releasedAt === undefined || Date.parse(mr.mergedAt ?? '') > releasedAt),
    )
  const merged = mergedRecord
    ? {
        id: mergedRecord.id,
        title: mergedRecord.title,
        description: mergedRecord.description,
        sourceBranch: mergedRecord.sourceBranch,
        targetBranch: mergedRecord.targetBranch,
        state: mergedRecord.state,
        draft: mergedRecord.draft,
        labels: mergedRecord.labels,
        author: mergedRecord.author,
        webUrl: mergedRecord.webUrl,
        ...(mergedRecord.mergedAt ? { mergedAt: mergedRecord.mergedAt } : {}),
      }
    : undefined

  const target = { name: targetName, sha: targetHead.sha, date: targetHead.authoredAt }
  const signals = settings.acceptance.signals
  const acceptance: Acceptance | undefined =
    recorded && signals.includes('manual')
      ? recorded
      : merged && signals.includes('label') && merged.labels.includes(settings.acceptance.label)
        ? { sha: target.sha, by: merged.author, at: merged.mergedAt ?? '', via: 'label' }
        : merged && signals.includes('merge')
          ? { sha: target.sha, by: merged.author, at: merged.mergedAt ?? '', via: 'merge' }
          : undefined

  const blocking = settings.gates.blockingLabels
  return {
    repo,
    webUrl: repository.webUrl,
    defaultBranch: repository.defaultBranch,
    target,
    ...(sourceHead
      ? { source: { name: sourceName, sha: sourceHead.sha, date: sourceHead.authoredAt } }
      : {}),
    versions,
    ...(latest ? { latest } : {}),
    ahead: ahead.commits,
    aheadCapped: ahead.capped,
    unreleased: unreleased.commits,
    unreleasedCapped: unreleased.capped,
    ...(request ? { request } : {}),
    ...(merged ? { merged } : {}),
    pipelines: {
      ...(sourcePipeline ? { source: sourcePipeline } : {}),
      ...(targetPipeline ? { target: targetPipeline } : {}),
    },
    ...(acceptance ? { acceptance } : {}),
    blockers: open
      .filter((mr) => mr.labels.some((label) => blocking.includes(label)))
      .map((mr) => ({ id: mr.id, title: mr.title, webUrl: mr.webUrl, labels: mr.labels })),
  }
}

/** The most advanced pending step of a repository; see `ReleaseStage`. */
export function releaseStage(settings: ReleaseSettings, facts: ReleaseFacts): ReleaseStage {
  if (settings.flow.mode === 'external') return 'external'
  if (facts.unreleased.length > 0) return 'awaiting-version'
  if (facts.request) return 'proposed'
  if (facts.ahead.length > 0) return 'candidate'
  return facts.latest ? 'released' : 'idle'
}
