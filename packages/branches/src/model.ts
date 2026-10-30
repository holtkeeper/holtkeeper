import { z } from 'zod'

/**
 * Why a branch is worth deleting: its work reached the default branch (`merged`), its last merge
 * request was closed without merging (`closed`), or nobody committed to it for `staleDays`
 * (`stale`).
 */
export type CleanupReason = 'merged' | 'closed' | 'stale'

/** A branch the analysis suggests deleting. Times are ISO 8601. */
export interface BranchCandidate {
  name: string
  reason: CleanupReason
  /** Commit date of the head commit. */
  committedAt: string
  /** Whole days from `committedAt` to the analysis. */
  ageDays: number
  /** Author of the head commit, when the forge reports it. */
  author?: string
  /** Set when protected branches were included and this is one. */
  protected?: true
  webUrl?: string
  /** The newest merge request from the branch, when the forge lists merge requests. */
  mergeRequest?: {
    id: number
    state: 'open' | 'merged' | 'closed'
    title: string
    author: string
    webUrl: string
  }
}

/** Everything a `branches` analysis found; serializable, stored as analysis data. */
export interface BranchesData {
  defaultBranch: string
  staleDays: number
  /** When the branches were read; ages count up to it. */
  checkedAt: string
  /** Branches judged: all but the default branch, ignored ones and, unless included, protected ones. */
  total: number
  /** Of `total`, branches with an open merge request; they are never candidates. */
  open: number
  candidates: BranchCandidate[]
}

/** Validates `BranchesData` uploads. */
export const branchesDataSchema: z.ZodType<BranchesData> = z.object({
  defaultBranch: z.string(),
  staleDays: z.number(),
  checkedAt: z.string(),
  total: z.number(),
  open: z.number(),
  candidates: z.array(
    z.object({
      name: z.string(),
      reason: z.enum(['merged', 'closed', 'stale']),
      committedAt: z.string(),
      ageDays: z.number(),
      author: z.string().optional(),
      protected: z.literal(true).optional(),
      webUrl: z.string().optional(),
      mergeRequest: z
        .object({
          id: z.number(),
          state: z.enum(['open', 'merged', 'closed']),
          title: z.string(),
          author: z.string(),
          webUrl: z.string(),
        })
        .optional(),
    }),
  ),
})
