# @holtkeeper/branches

The `branches` analyzer and analysis kind: lists the branches of a repository that are worth deleting — merged but left behind, abandoned after a closed merge request, or without commits for a long time — with who last committed to each, so everyone can see what to clean up after themselves. It only reports; it never deletes a branch.

## Public API

- `branchesAnalyzer` — `Analyzer<BranchesData, BranchesOptions>`, kind `branches`, scope `repo`, needs `forge`. `createBranchesAnalyzer({ now? })` makes one with another clock. Options (`branchesOptionsSchema`):
  - `staleDays: number` (`--stale-days`) — default 90: days without commits after which a branch is stale.
  - `ignore: string[]` (`--ignore`, comma-separated) — glob patterns of branch names never reported, e.g. `release/*`.
  - `includeProtected: boolean` (`--include-protected`) — default false: judge protected branches too.
- `branchesAnalysis` — the `AnalysisKind` (`schema: branchesDataSchema`, `summarize`, `toReport(current, previous)`); `branchesReport(data, { previous?, ref?, compareTo? })` builds the report directly.
- `analyzeBranches({ forge, repo, now, staleDays, ignore?, includeProtected?, log? }): Promise<BranchesData>` — reads through the forge, then classifies. Throws when the forge has no `listBranches`.
- `classifyBranches(branches, mergeRequests, { defaultBranch, now, staleDays, ignore?, includeProtected? }): BranchesData` — the pure classification.

## How branches are judged

The forge's `listBranches` gives every branch with its head commit; `listMergeRequests` (when the forge has it) gives the merge requests updated since the oldest branch commit. The default branch, `ignore` matches and protected branches (unless `includeProtected`) are never judged. A branch with an open merge request is in review and never a candidate. Of the rest, the first reason that holds wins:

1. **merged** — the forge reports the head as reachable from the default branch, or the branch's newest merged merge request points at the branch's head (squash and rebase merges leave the head unreachable). When the merge request carries no head commit, it counts when it was merged at or after the branch's last commit.
2. **closed** — the branch's newest merge request was closed without merging and the branch gained no commits since.
3. **stale** — no commits for `staleDays`.

Ages are whole days from the head commit's date to the run. Without merge request reads only the first half of `merged` and `stale` apply.

The default `branches-weekly` schedule (`@holtkeeper/managed-config`) runs it on Tuesday nights.

## Data

```ts
interface BranchesData {
  defaultBranch: string
  staleDays: number
  checkedAt: string // ISO 8601, ages count up to it
  total: number // branches judged
  open: number // of them, with an open merge request
  candidates: {
    name: string
    reason: 'merged' | 'closed' | 'stale'
    committedAt: string
    ageDays: number
    author?: string // head commit author
    protected?: true
    webUrl?: string
    mergeRequest?: {
      id: number
      state: 'open' | 'merged' | 'closed'
      title: string
      author: string
      webUrl: string
    }
  }[] // merged, then closed, then stale; oldest first within each
}
```

## Report

- **Metrics** — branches to clean up, merged not deleted, closed merge request, stale (all `better: 'down'`; merged and closed are warnings above zero), branches judged.
- **To clean up** — up to 200 candidates with why, last commit, age, author and merge request.
- **By author** — candidates per head commit author, split by reason, with the oldest age.
- **Changes** (with a previous analysis) — branches cleaned up and new candidates since then.

The web panel shows it under **Branches** (`/branches`).
