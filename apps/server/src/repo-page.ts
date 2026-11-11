import type {
  RepoOverview,
  RepoReviewList,
  RepoReviewView,
  RepoStackView,
  StackConventionStatus,
  StackSupport,
} from '@holtkeeper/api'
import { summarizeRun } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { type ReviewData, reviewDataSchema } from '@holtkeeper/review'
import type { ReactionSignal, Store } from '@holtkeeper/store'

import { summarizeAnalysis } from './analyses.ts'
import type { ServerDeps } from './context.ts'
import { readHead } from './freshness.ts'
import { repoDependencies, stackGroupViews } from './stack.ts'

const REVIEWS = 20

const supportRank: Record<StackSupport, number> = {
  eol: 0,
  'eol-soon': 1,
  unknown: 2,
  lts: 3,
  active: 4,
}

const sameRepo = (a: RepoRef, b: RepoRef) => a.forge === b.forge && a.path === b.path

/** The repository's stack from the newest `stack` records of the groups that list it. */
async function repoStack(
  analyses: Store['analyses'],
  repo: RepoRef,
  groupsOf: (repo: RepoRef) => string[],
): Promise<RepoStackView | undefined> {
  const views = (
    await stackGroupViews(analyses, { canRead: (other) => sameRepo(other, repo), groupsOf })
  ).filter((view) => view.forge === repo.forge && view.repos.some((r) => r.path === repo.path))
  if (!views.length) return undefined
  const tools = new Map<string, RepoStackView['tools'][number]>()
  const conventions: Record<StackConventionStatus, number> = {
    matches: 0,
    drifts: 0,
    missing: 0,
    error: 0,
  }
  const files = new Set<string>()
  for (const view of views) {
    for (const tool of view.tools)
      for (const use of tool.uses) {
        if (use.repo !== repo.path) continue
        const key = `${tool.id}\0${use.file}\0${use.declared}`
        if (tools.has(key)) continue
        tools.set(key, {
          id: tool.id,
          name: tool.name,
          declared: use.declared,
          file: use.file,
          support: use.support,
          ...(use.eolDate ? { eolDate: use.eolDate } : {}),
        })
      }
    for (const result of view.conventions) {
      if (result.repo !== repo.path || files.has(result.file)) continue
      files.add(result.file)
      conventions[result.status]++
    }
  }
  return {
    checkedAt: views.reduce(
      (newest, view) => (view.checkedAt > newest ? view.checkedAt : newest),
      views[0]?.checkedAt ?? '',
    ),
    tools: [...tools.values()].toSorted(
      (a, b) => supportRank[a.support] - supportRank[b.support] || a.name.localeCompare(b.name),
    ),
    conventions,
  }
}

/** What the Overview tab of the repository page shows; stored records only, nothing from the forge. */
export async function repoOverview(
  deps: Pick<ServerDeps, 'store' | 'analyses'>,
  repo: RepoRef & { groups: string[] },
  options: { audits: boolean; groupsOf: (repo: RepoRef) => string[] },
): Promise<RepoOverview> {
  const { store } = deps
  const ref = { forge: repo.forge, path: repo.path }
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))
  const [latest, head, audits, dependencies, stack] = await Promise.all([
    store.analyses.latest({ repo: ref }),
    store.kv ? readHead(store.kv, ref) : undefined,
    options.audits ? store.auditRuns.list({ repo: ref, limit: 1 }) : [],
    repoDependencies(store.analyses, ref),
    repoStack(store.analyses, ref, options.groupsOf),
  ])
  const depgraph = latest.find((record) => record.kind === 'depgraph')
  const [audit] = audits
  return {
    repo: ref,
    groups: repo.groups,
    ...(head ? { head: { sha: head.sha, at: head.at } } : {}),
    analyses: latest
      .filter((record) => record.kind !== 'review')
      .map((record) => summarizeAnalysis(kinds, record)),
    ...(audit ? { audit: summarizeRun(audit) } : {}),
    ...(depgraph
      ? {
          dependencies: {
            direct: dependencies.length,
            analysisId: depgraph.id,
            createdAt: depgraph.createdAt,
          },
        }
      : {}),
    ...(stack ? { stack } : {}),
  }
}

function reviewView(
  record: { id: string; createdAt: string },
  data: ReviewData,
  signals: readonly ReactionSignal[],
): RepoReviewView {
  const iid = data.mergeRequest.id
  const findings = new Set(data.comments.filter((c) => c.posted).map((c) => c.id))
  const reactions = { up: 0, down: 0 }
  for (const signal of signals)
    if (
      signal.mergeRequest === iid &&
      signal.findingId !== undefined &&
      findings.has(signal.findingId)
    ) {
      reactions.up += signal.up
      reactions.down += signal.down
    }
  return {
    analysisId: record.id,
    createdAt: record.createdAt,
    mergeRequest: {
      iid,
      title: data.mergeRequest.title,
      webUrl: data.mergeRequest.webUrl,
      author: data.mergeRequest.author,
    },
    mode: data.mode,
    verdict: data.verdict,
    posted: findings.size,
    resolved: data.threads.filter((thread) => thread.action === 'resolved').length,
    ...(data.usage?.costUsd !== undefined ? { costUsd: data.usage.costUsd } : {}),
    reactions,
  }
}

/**
 * The newest review runs of a repository with their cost and the 👍/👎 last read on the comments
 * each run posted; records that do not parse are skipped.
 */
export async function repoReviews(store: Store, repo: RepoRef): Promise<RepoReviewList> {
  const parsed = (await store.analyses.list({ repo, kind: 'review', limit: REVIEWS })).flatMap(
    (record) => {
      const data = reviewDataSchema.safeParse(record.data).data
      return data ? [{ record, data }] : []
    },
  )
  const signals = parsed.length
    ? await store.learnings.reactions({
        repo: `${repo.forge}:${repo.path}`,
        mergeRequests: [...new Set(parsed.map(({ data }) => data.mergeRequest.id))],
      })
    : []
  const reviews = parsed.map(({ record, data }) => reviewView(record, data, signals))
  const totals = { costUsd: 0, posted: 0, up: 0, down: 0 }
  for (const review of reviews) {
    totals.costUsd += review.costUsd ?? 0
    totals.posted += review.posted
    totals.up += review.reactions.up
    totals.down += review.reactions.down
  }
  return { reviews, totals }
}
