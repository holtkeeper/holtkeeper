import { ticketKeys } from '@holtkeeper/commit-conventions'
import { parseCommit } from '@holtkeeper/release'

import type { QaChange, QaCommit, QaMergeRequest, QaRepoHistory } from './model.ts'

const shortSha = (sha: string) => sha.slice(0, 8)

const distinct = (values: readonly string[]) => [...new Set(values)]

const mergedBranch =
  /^Merge (?:remote-tracking )?branch '(?<branch>[^']+)'|^Merge pull request #\d+ from [^/\s]+\/(?<pr>\S+)/u

/** The branch a merge commit message says it merged, without a remote prefix. */
export function mergedBranchOf(title: string): string | undefined {
  const groups = mergedBranch.exec(title)?.groups
  const branch = groups?.branch ?? groups?.pr
  return branch?.replace(/^origin\//u, '')
}

/** A commit or merge request title without its type, scope and ticket keys. */
export function cleanTitle(text: string, body = ''): string {
  const description = parseCommit(text, body).description || text
  return description
    .replace(/\[[A-Z][A-Z0-9]{1,9}-\d+\]/gu, '')
    .replace(/^\s*[A-Z][A-Z0-9]{1,9}-\d+\s*[:\-–]?\s*/u, '')
    .replace(/\(\s*[A-Z][A-Z0-9]{1,9}-\d+\s*\)\s*$/u, '')
    .replace(/\s{2,}/gu, ' ')
    .trim()
}

/** Commits reachable from `starts` inside `commits`, stopping at `stop`, newest first as listed. */
function sideCommits(
  starts: readonly string[],
  commits: ReadonlyMap<string, QaCommit>,
  stop: ReadonlySet<string>,
): QaCommit[] {
  const found = new Set<string>()
  const queue = [...starts]
  while (queue.length) {
    const sha = queue.pop()!
    if (found.has(sha) || stop.has(sha)) continue
    const commit = commits.get(sha)
    if (!commit) continue
    found.add(sha)
    queue.push(...commit.parents)
  }
  return [...commits.values()].filter((commit) => found.has(commit.sha))
}

interface Landing {
  commit: QaCommit
  side: QaCommit[]
}

/**
 * The changes of one repository's history: each commit on a branch's first-parent line (what
 * landed on it) becomes part of a change. A landing that is the merge, squash or a commit of a
 * merged merge request belongs to that merge request (fast-forward merges of several commits make
 * one change); a merge commit without one is a `merge`, with the commits it brought; anything else
 * is a `commit` pushed without a merge request. Open merge requests into the branches are changes
 * of their own.
 *
 * Branches are read in order and a commit belongs to the first change that claims it, so list
 * the branch work lands on first. Merges between the listed branches (release candidates,
 * back-merges) are no changes: what they bring is already a change of the branch it came from.
 * Ticket keys come from the merge request title and source branch and from the commit messages,
 * never from descriptions, which often mention related tasks.
 */
export function changesOf(history: QaRepoHistory): QaChange[] {
  const tracked = new Set(history.branches.map((branch) => branch.branch))
  const claimed = new Set<string>()
  const changes: QaChange[] = []
  const merged = history.mergeRequests.filter((mr) => mr.state === 'merged')

  for (const branch of history.branches) {
    const commits = new Map(branch.commits.map((commit) => [commit.sha, commit]))
    const line: QaCommit[] = []
    for (let sha: string | undefined = branch.head; sha && commits.has(sha);) {
      const commit: QaCommit = commits.get(sha)!
      line.push(commit)
      sha = commit.parents[0]
    }
    const onLine = new Set(line.map((commit) => commit.sha))

    const anchors = new Map<string, QaMergeRequest>()
    for (const mr of merged.filter((item) => item.targetBranch === branch.branch)) {
      for (const sha of mr.commits ?? []) anchors.set(sha, mr)
      if (!mr.mergeCommitSha && !mr.squashCommitSha && mr.headSha) anchors.set(mr.headSha, mr)
      if (mr.squashCommitSha) anchors.set(mr.squashCommitSha, mr)
      if (mr.mergeCommitSha) anchors.set(mr.mergeCommitSha, mr)
    }

    const byMergeRequest = new Map<number, { mr: QaMergeRequest; landings: Landing[] }>()
    // Oldest first, so a fast-forward merge request's base is the parent of its oldest commit.
    for (const commit of line.toReversed()) {
      if (claimed.has(commit.sha)) continue
      const side =
        commit.parents.length > 1
          ? sideCommits(commit.parents.slice(1), commits, onLine).filter(
              (item) => !claimed.has(item.sha),
            )
          : []
      const mr = anchors.get(commit.sha)
      const from = mr ? mr.sourceBranch : mergedBranchOf(commit.title)
      if (from !== undefined && tracked.has(from)) continue
      claimed.add(commit.sha)
      for (const item of side) claimed.add(item.sha)
      const landing = { commit, side }
      if (mr) {
        const group = byMergeRequest.get(mr.id) ?? { mr, landings: [] }
        group.landings.push(landing)
        byMergeRequest.set(mr.id, group)
      } else changes.push(landingChange(history, branch.branch, landing))
    }
    for (const { mr, landings } of byMergeRequest.values())
      changes.push(mergeRequestChange(history, branch.branch, mr, landings))
  }

  for (const mr of history.mergeRequests)
    if (
      mr.state === 'open' &&
      mr.headSha &&
      tracked.has(mr.targetBranch) &&
      !tracked.has(mr.sourceBranch)
    )
      changes.push(openChange(history, mr, mr.headSha))

  return changes.toSorted((a, b) => b.at.localeCompare(a.at))
}

const keysOf = (...texts: string[]) => distinct(texts.flatMap((text) => ticketKeys(text)))

function landingChange(history: QaRepoHistory, branch: string, landing: Landing): QaChange {
  const { commit, side } = landing
  const isMerge = commit.parents.length > 1
  const source = isMerge ? mergedBranchOf(commit.title) : undefined
  const all = [commit, ...side]
  const title = isMerge
    ? (side[0] ? cleanTitle(side[0].title) : '') || cleanTitle(commit.title, commit.message)
    : cleanTitle(commit.title, commit.message)
  return {
    repo: history.repo,
    kind: isMerge ? 'merge' : 'commit',
    id: shortSha(commit.sha),
    branch,
    title: title || commit.title,
    at: commit.at,
    authors: distinct(all.map((item) => item.author).filter(Boolean)),
    keys: keysOf(...(source ? [source] : []), ...all.map((item) => item.message)),
    commits: all.map((item) => item.sha),
    ...(commit.parents[0] ? { base: commit.parents[0] } : {}),
    head: commit.sha,
    ...(commit.url ? { url: commit.url } : {}),
  }
}

function mergeRequestChange(
  history: QaRepoHistory,
  branch: string,
  mr: QaMergeRequest,
  landings: readonly Landing[],
): QaChange {
  // `landings` are oldest first; commits are listed newest first.
  const commits = landings.toReversed().flatMap((landing) => [landing.commit, ...landing.side])
  const oldest = landings[0]!.commit
  const newest = landings.at(-1)!.commit
  return {
    repo: history.repo,
    kind: 'merge-request',
    id: `!${mr.id}`,
    branch,
    title: cleanTitle(mr.title) || mr.title,
    at: mr.mergedAt ?? newest.at,
    authors: distinct(commits.map((item) => item.author).filter(Boolean)),
    keys: keysOf(mr.title, mr.sourceBranch, ...commits.map((item) => item.message)),
    commits: commits.map((item) => item.sha),
    ...(oldest.parents[0] ? { base: oldest.parents[0] } : {}),
    head: newest.sha,
    url: mr.url,
    mergeRequest: mergeRequestOf(mr),
  }
}

function openChange(history: QaRepoHistory, mr: QaMergeRequest, head: string): QaChange {
  return {
    repo: history.repo,
    kind: 'open-merge-request',
    id: `!${mr.id}`,
    branch: mr.targetBranch,
    title: cleanTitle(mr.title) || mr.title,
    at: mr.updatedAt,
    authors: mr.author ? [mr.author] : [],
    keys: keysOf(mr.title, mr.sourceBranch),
    commits: [head],
    head,
    url: mr.url,
    mergeRequest: mergeRequestOf(mr),
  }
}

const mergeRequestOf = (mr: QaMergeRequest): NonNullable<QaChange['mergeRequest']> => ({
  id: mr.id,
  title: mr.title,
  description: mr.description,
  sourceBranch: mr.sourceBranch,
  author: mr.author,
  url: mr.url,
  draft: mr.draft,
})
