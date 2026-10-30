import type { BranchRecord, GitForge, MergeRequestRecord } from '@holtkeeper/forge'

import type { BranchCandidate, BranchesData, CleanupReason } from './model.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** How `classifyBranches` judges branches. */
export interface BranchSettings {
  /** Days without commits after which a branch is stale. */
  staleDays: number
  /** Glob patterns of branch names never reported, e.g. `release/*`. */
  ignore?: readonly string[]
  /** Judge protected branches too. Default false. */
  includeProtected?: boolean
}

const after = (a: string | undefined, b: string) =>
  a !== undefined && Date.parse(a) >= Date.parse(b)

function reasonOf(
  branch: BranchRecord,
  newest: MergeRequestRecord | undefined,
  merged: MergeRequestRecord | undefined,
  ageDays: number,
  staleDays: number,
): CleanupReason | undefined {
  // Squash and rebase merges leave the head unreachable from the default branch, so a merged
  // merge request counts when the branch gained no commits after it.
  if (branch.merged) return 'merged'
  if (
    merged &&
    (merged.headSha ? merged.headSha === branch.sha : after(merged.mergedAt, branch.committedAt))
  )
    return 'merged'
  if (
    newest?.state === 'closed' &&
    (newest.headSha ? newest.headSha === branch.sha : after(newest.closedAt, branch.committedAt))
  )
    return 'closed'
  return ageDays >= staleDays ? 'stale' : undefined
}

/**
 * Picks the branches worth deleting. The default branch, branches matching `ignore`, protected
 * branches (unless included) and branches with an open merge request are never candidates.
 * Candidates come merged first, then closed, then stale, oldest first within each.
 */
export function classifyBranches(
  branches: readonly BranchRecord[],
  mergeRequests: readonly MergeRequestRecord[],
  settings: BranchSettings & { defaultBranch: string; now: Date },
): BranchesData {
  const ignored = (settings.ignore ?? []).map((pattern) => new Bun.Glob(pattern))
  const bySource = new Map<string, MergeRequestRecord[]>()
  for (const mr of mergeRequests)
    bySource.set(mr.sourceBranch, [...(bySource.get(mr.sourceBranch) ?? []), mr])

  const judged = branches.filter(
    (branch) =>
      branch.name !== settings.defaultBranch &&
      !branch.default &&
      (settings.includeProtected || !branch.protected) &&
      !ignored.some((glob) => glob.match(branch.name)),
  )
  let open = 0
  const candidates: BranchCandidate[] = []
  for (const branch of judged) {
    const requests = (bySource.get(branch.name) ?? []).toSorted(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    )
    if (requests.some((mr) => mr.state === 'open')) {
      open++
      continue
    }
    const ageDays = Math.max(
      0,
      Math.floor((settings.now.getTime() - Date.parse(branch.committedAt)) / DAY_MS),
    )
    const newest = requests[0]
    const merged = requests.find((mr) => mr.state === 'merged')
    const reason = reasonOf(branch, newest, merged, ageDays, settings.staleDays)
    if (!reason) continue
    const shown = reason === 'merged' && merged ? merged : newest
    candidates.push({
      name: branch.name,
      reason,
      committedAt: branch.committedAt,
      ageDays,
      ...(branch.authorName ? { author: branch.authorName } : {}),
      ...(branch.protected ? { protected: true as const } : {}),
      ...(branch.webUrl ? { webUrl: branch.webUrl } : {}),
      ...(shown
        ? {
            mergeRequest: {
              id: shown.id,
              state: shown.state,
              title: shown.title,
              author: shown.author,
              webUrl: shown.webUrl,
            },
          }
        : {}),
    })
  }
  const order: Record<CleanupReason, number> = { merged: 0, closed: 1, stale: 2 }
  candidates.sort(
    (a, b) =>
      order[a.reason] - order[b.reason] || b.ageDays - a.ageDays || a.name.localeCompare(b.name),
  )
  return {
    defaultBranch: settings.defaultBranch,
    staleDays: settings.staleDays,
    checkedAt: settings.now.toISOString(),
    total: judged.length,
    open,
    candidates,
  }
}

/**
 * Reads a repository's branches and the merge requests from them through the forge, then
 * `classifyBranches`. Throws when the forge cannot list branches; without merge request reads,
 * only branches the forge reports as merged and stale ones are found.
 */
export async function analyzeBranches(
  options: BranchSettings & {
    forge: Pick<GitForge, 'getRepository' | 'listBranches' | 'listMergeRequests'>
    repo: string
    now: Date
    log?: (line: string) => void
  },
): Promise<BranchesData> {
  const { forge, repo } = options
  if (!forge.listBranches) throw new Error(`this forge cannot list the branches of ${repo}`)
  const branches = await forge.listBranches(repo)
  const defaultBranch =
    branches.find((branch) => branch.default)?.name ??
    (await forge.getRepository(repo)).defaultBranch
  const oldest = branches
    .filter((branch) => branch.name !== defaultBranch && branch.committedAt)
    .map((branch) => Date.parse(branch.committedAt))
    .filter((time) => !Number.isNaN(time))
    .reduce((a, b) => Math.min(a, b), Infinity)
  const mergeRequests =
    forge.listMergeRequests && Number.isFinite(oldest)
      ? await forge.listMergeRequests(repo, {
          state: 'all',
          updatedAfter: new Date(oldest).toISOString(),
        })
      : []
  options.log?.(`${branches.length} branches, ${mergeRequests.length} merge requests`)
  return classifyBranches(branches, mergeRequests, { ...options, defaultBranch })
}
