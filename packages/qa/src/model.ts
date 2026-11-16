import type { RepoRef } from '@holtkeeper/forge'
import type { Issue } from '@holtkeeper/issues'
import { z } from 'zod'

/** A commit as the QA history keeps it. Times are ISO 8601. */
export interface QaCommit {
  sha: string
  parents: string[]
  title: string
  /** The whole message, title included, trimmed to a few kilobytes. */
  message: string
  author: string
  at: string
  url?: string
}

/** A merged or open merge request as the QA history keeps it. */
export interface QaMergeRequest {
  id: number
  title: string
  /** Trimmed to a few kilobytes. */
  description: string
  sourceBranch: string
  targetBranch: string
  state: 'open' | 'merged'
  draft: boolean
  author: string
  url: string
  updatedAt: string
  mergedAt?: string
  headSha?: string
  mergeCommitSha?: string
  squashCommitSha?: string
  /** Its commits, read once for merges that left no merge or squash commit (fast-forward). */
  commits?: string[]
}

/** The commits of one branch read for the QA history, newest first. */
export interface QaBranchHistory {
  branch: string
  head: string
  commits: QaCommit[]
  /** More commits than the read cap; the oldest ones are missing. */
  capped: boolean
}

/** What one repository's branches and merge requests hold since `since`. */
export interface QaRepoHistory {
  repo: RepoRef
  /** When the forge was last read. */
  readAt: string
  /** Start of the period the history covers. */
  since: string
  defaultBranch: string
  branches: QaBranchHistory[]
  /** Merged merge requests of the period and every open one into the branches. */
  mergeRequests: QaMergeRequest[]
}

/**
 * How a change reached a branch: `merge-request` (merged), `open-merge-request` (not merged yet),
 * `commit` (pushed directly, no merge request) or `merge` (a merge commit made outside the forge).
 */
export type QaChangeKind = 'merge-request' | 'open-merge-request' | 'commit' | 'merge'

/** One change on a branch: a merge request or a commit pushed without one. */
export interface QaChange {
  repo: RepoRef
  kind: QaChangeKind
  /** `!12` for merge requests, the short sha for commits; unique within the repository. */
  id: string
  /** Branch the change landed on or targets. */
  branch: string
  title: string
  /** When it landed (merged, pushed) or, for open merge requests, was last updated. */
  at: string
  /** Commit author names, distinct, in order. */
  authors: string[]
  /** Ticket keys it names, distinct, in order; placeholders included. */
  keys: string[]
  /** Shas of its commits on the branch, newest first. */
  commits: string[]
  /** What it changes is the diff from `base` to `head`; `base` is absent for root commits. */
  base?: string
  head: string
  url?: string
  mergeRequest?: {
    id: number
    title: string
    description: string
    sourceBranch: string
    author: string
    url: string
    draft: boolean
  }
}

/** A tracker key with the changes that name it, across repositories. */
export interface QaTask {
  key: string
  /** From the tracker when it knows the key, else from merge request and commit titles. */
  title: string
  issue?: Issue
  /** Newest first. */
  changes: QaChange[]
  /** Repositories the changes are in, by newest change. */
  repos: RepoRef[]
  /** Time of the newest change. */
  lastAt: string
}

/** One file of a change's diff. */
export interface QaFileChange {
  path: string
  /** The path before a rename. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  binary?: boolean
}

/** A test attribute as written in a template, e.g. `data-testid="save"`. */
export interface TestIdRef {
  attribute: string
  /** The literal value, or the expression as written when `dynamic`. */
  value: string
  dynamic?: boolean
}

/** Test attributes a change adds and removes in one file. */
export interface TestIdFileChange {
  file: string
  added: TestIdRef[]
  removed: TestIdRef[]
}

/** What a change's diff touches, without the diff itself. */
export interface QaChangeDetail {
  files: QaFileChange[]
  testIds: TestIdFileChange[]
  /** The forge left some diffs out or more files changed than were read. */
  partial?: boolean
}

const testIdRef = z.object({
  attribute: z.string(),
  value: z.string(),
  dynamic: z.boolean().optional(),
})

/** Validates stored `QaChangeDetail` values. */
export const qaChangeDetailSchema: z.ZodType<QaChangeDetail> = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().optional(),
      status: z.enum(['added', 'modified', 'deleted', 'renamed']),
      additions: z.number(),
      deletions: z.number(),
      binary: z.boolean().optional(),
    }),
  ),
  testIds: z.array(
    z.object({ file: z.string(), added: z.array(testIdRef), removed: z.array(testIdRef) }),
  ),
  partial: z.boolean().optional(),
})

const repoRef = z.object({ forge: z.string(), path: z.string() })

/** Validates stored `QaRepoHistory` values. */
export const qaRepoHistorySchema: z.ZodType<QaRepoHistory> = z.object({
  repo: repoRef,
  readAt: z.string(),
  since: z.string(),
  defaultBranch: z.string(),
  branches: z.array(
    z.object({
      branch: z.string(),
      head: z.string(),
      capped: z.boolean(),
      commits: z.array(
        z.object({
          sha: z.string(),
          parents: z.array(z.string()),
          title: z.string(),
          message: z.string(),
          author: z.string(),
          at: z.string(),
          url: z.string().optional(),
        }),
      ),
    }),
  ),
  mergeRequests: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      description: z.string(),
      sourceBranch: z.string(),
      targetBranch: z.string(),
      state: z.enum(['open', 'merged']),
      draft: z.boolean(),
      author: z.string(),
      url: z.string(),
      updatedAt: z.string(),
      mergedAt: z.string().optional(),
      headSha: z.string().optional(),
      mergeCommitSha: z.string().optional(),
      squashCommitSha: z.string().optional(),
      commits: z.array(z.string()).optional(),
    }),
  ),
})
