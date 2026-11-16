import type { CommitRecord, GitForge, MergeRequestRecord, RepoRef } from '@holtkeeper/forge'

import type { QaBranchHistory, QaCommit, QaMergeRequest, QaRepoHistory } from './model.ts'

/** At most this many commits are read per branch and period. */
export const QA_COMMIT_CAP = 1000

/** Messages and descriptions are kept up to this many characters. */
const TEXT_CAP = 4000

/** Merge requests whose commits are read in one refresh, for fast-forward merges. */
const MR_COMMIT_READS = 40

/** Overlap of incremental merge request reads, for clock skew between Holtkeeper and the forge. */
const OVERLAP_MS = 5 * 60_000

type HistoryForge = Pick<GitForge, 'listCommits' | 'listMergeRequests' | 'listMergeRequestCommits'>

const trim = (text: string) => (text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text)

const toCommit = (commit: CommitRecord): QaCommit => ({
  sha: commit.sha,
  parents: commit.parents,
  title: commit.title,
  message: trim(commit.message),
  author: commit.authorName,
  at: commit.authoredAt,
  ...(commit.webUrl ? { url: commit.webUrl } : {}),
})

const toMergeRequest = (mr: MergeRequestRecord): QaMergeRequest | undefined =>
  mr.state === 'open' || mr.state === 'merged'
    ? {
        id: mr.id,
        title: mr.title,
        description: trim(mr.description ?? ''),
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        state: mr.state,
        draft: mr.draft,
        author: mr.author,
        url: mr.webUrl,
        updatedAt: mr.updatedAt,
        ...(mr.mergedAt ? { mergedAt: mr.mergedAt } : {}),
        ...(mr.headSha ? { headSha: mr.headSha } : {}),
        ...(mr.mergeCommitSha ? { mergeCommitSha: mr.mergeCommitSha } : {}),
        ...(mr.squashCommitSha ? { squashCommitSha: mr.squashCommitSha } : {}),
      }
    : undefined

/** Whether `added` (newest first) continues `previousHead` along its first-parent line. */
function continues(added: readonly QaCommit[], previousHead: string): boolean {
  const bySha = new Map(added.map((commit) => [commit.sha, commit]))
  let sha = added[0]?.sha
  while (sha && bySha.has(sha)) sha = bySha.get(sha)!.parents[0]
  return sha === previousHead
}

async function readBranch(
  forge: HistoryForge,
  repo: RepoRef,
  branch: string,
  since: string,
  previous: QaBranchHistory | undefined,
): Promise<QaBranchHistory | undefined> {
  const listCommits = forge.listCommits!.bind(forge)
  let head: string | undefined
  try {
    head = (await listCommits(repo.path, { ref: branch, limit: 1 }))[0]?.sha
  } catch {
    // A listed branch that does not exist (yet) is simply skipped.
    return undefined
  }
  if (!head) return undefined
  const inPeriod = (commit: QaCommit) => commit.at >= since
  if (previous?.head === head) return { ...previous, commits: previous.commits.filter(inPeriod) }
  if (previous) {
    const added = (
      await listCommits(repo.path, { ref: head, since: previous.head, limit: QA_COMMIT_CAP + 1 })
    ).map(toCommit)
    if (added.length <= QA_COMMIT_CAP && continues(added, previous.head)) {
      const commits = [...added, ...previous.commits].filter(inPeriod)
      return {
        branch,
        head,
        commits: commits.slice(0, QA_COMMIT_CAP),
        capped: previous.capped || commits.length > QA_COMMIT_CAP,
      }
    }
  }
  // First read, or the branch was rewritten: read the whole period again.
  const list = (
    await listCommits(repo.path, { ref: head, after: since, limit: QA_COMMIT_CAP + 1 })
  ).map(toCommit)
  const commits = list.filter(inPeriod)
  return {
    branch,
    head,
    commits: commits.slice(0, QA_COMMIT_CAP),
    capped: commits.length > QA_COMMIT_CAP,
  }
}

/**
 * Reads what `branches` of a repository hold since `since`: their commits (at most
 * `QA_COMMIT_CAP` per branch) and the merge requests merged into them in the period plus every
 * open one. With `previous` (an earlier read of the same repository) only what is new is read:
 * a branch whose head did not move costs one request, one that moved on reads the commits since
 * its old head, and merge requests are read from the previous read on; a branch that was
 * rewritten is read again in full. Branches that do not exist are left out. The commits of a merge
 * request merged without a merge or squash commit (fast-forward) are read once and kept.
 */
export async function readRepoHistory(options: {
  forge: HistoryForge
  repo: RepoRef
  defaultBranch: string
  branches: readonly string[]
  since: string
  now: Date
  previous?: QaRepoHistory
}): Promise<QaRepoHistory> {
  const { forge, repo, since, now } = options
  if (!forge.listCommits) throw new Error('the forge cannot list commits')
  const previous =
    options.previous && options.previous.since <= since ? options.previous : undefined
  const branches: QaBranchHistory[] = []
  for (const branch of new Set(options.branches)) {
    const before = previous?.branches.find((item) => item.branch === branch)
    // oxlint-disable-next-line no-await-in-loop -- branches one at a time keep the forge calm
    const read = await readBranch(forge, repo, branch, since, before)
    if (read) branches.push(read)
  }

  const tracked = new Set(branches.map((branch) => branch.branch))
  const kept = new Map<number, QaMergeRequest>()
  for (const mr of previous?.mergeRequests ?? [])
    if (mr.state === 'merged' && (mr.mergedAt ?? mr.updatedAt) >= since) kept.set(mr.id, mr)
  if (forge.listMergeRequests) {
    const updatedAfter = previous
      ? new Date(
          Math.max(Date.parse(previous.readAt) - OVERLAP_MS, Date.parse(since)),
        ).toISOString()
      : since
    const [merged, open] = await Promise.all([
      forge.listMergeRequests(repo.path, { state: 'merged', updatedAfter }),
      forge.listMergeRequests(repo.path, { state: 'open', limit: 200 }),
    ])
    for (const record of [...merged, ...open]) {
      const mr = toMergeRequest(record)
      if (!mr || !tracked.has(mr.targetBranch)) continue
      if (mr.state === 'merged' && (mr.mergedAt ?? mr.updatedAt) < since) continue
      const commits = kept.get(mr.id)?.commits
      kept.set(mr.id, commits && kept.get(mr.id)?.headSha === mr.headSha ? { ...mr, commits } : mr)
    }
  }

  const fastForward = [...kept.values()]
    .filter(
      (mr) => mr.state === 'merged' && !mr.mergeCommitSha && !mr.squashCommitSha && !mr.commits,
    )
    .slice(0, MR_COMMIT_READS)
  if (forge.listMergeRequestCommits)
    for (const mr of fastForward) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- a handful of reads, one at a time
        const commits = await forge.listMergeRequestCommits(repo.path, mr.id)
        kept.set(mr.id, { ...mr, commits })
      } catch {
        // Without its commits the merge request still matches its head commit.
      }
    }

  return {
    repo,
    readAt: now.toISOString(),
    since,
    defaultBranch: options.defaultBranch,
    branches,
    mergeRequests: [...kept.values()].toSorted((a, b) => b.id - a.id),
  }
}
