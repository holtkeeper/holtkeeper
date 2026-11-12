import type { Principal } from '@holtkeeper/access'
import { type AuditFindingMetric, type AuditMetrics, auditFindingKey } from '@holtkeeper/analyzers'
import type {
  FindingGroup,
  FindingRepo,
  FindingStatus,
  FindingsResponse,
  SeverityCounts,
} from '@holtkeeper/api'
import type { HoltkeeperConfig } from '@holtkeeper/core'
import type { RepoRef } from '@holtkeeper/forge'
import type { AnalysisKind } from '@holtkeeper/report'
import type { AgentTask, AgentTaskStatus, Store } from '@holtkeeper/store'
import { type Severity, compareSeverity } from '@holtkeeper/vuln'

import { latestHeadsWithMetrics } from './analyses.ts'
import { repoKey, repoTarget } from './context.ts'
import type { FleetCache } from './fleet-cache.ts'
import { canSee } from './visibility.ts'

const FIXING: readonly AgentTaskStatus[] = ['approved', 'queued', 'running', 'mr-open']

const severityOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']

/** What `readFindings` reads. */
export interface FindingsDeps {
  config: HoltkeeperConfig
  store: Pick<Store, 'analyses' | 'tasks'>
  /** Analysis kinds by name, to fill in metrics of records stored without them. */
  // oxlint-disable-next-line typescript/no-explicit-any -- kinds differ in their data type
  kinds: ReadonlyMap<string, AnalysisKind<any, any>>
  /** Today as `YYYY-MM-DD`, to tell expired allowlist entries apart. */
  today: string
  /** Keeps the grouping while the latest audits stay the same; read fresh without it. */
  cache?: FleetCache
}

/** Which findings `readFindings` returns besides what the principal may read. */
export interface FindingsFilter {
  /** Only these repositories, as `forge:path`. */
  repos?: readonly string[]
}

interface StoredRow {
  metric: AuditFindingMetric
  firstSeenAt: string
}

interface StoredRepo {
  repo: string
  groups: string[]
  rows: StoredRow[]
}

interface StoredGroup {
  key: string
  first: AuditFindingMetric
  repos: StoredRepo[]
}

const auditMetricsOf = (metrics: object | undefined): AuditMetrics | undefined =>
  metrics && 'advisories' in metrics && Array.isArray(metrics.advisories)
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by auditMetrics
      (metrics as AuditMetrics)
    : undefined

const union = (lists: readonly (readonly string[])[]) => [...new Set(lists.flat())]

const groupStored = (
  config: HoltkeeperConfig,
  heads: readonly { repo: RepoRef; createdAt: string; metrics?: object }[],
): StoredGroup[] => {
  const groups = new Map<string, StoredGroup>()
  for (const head of heads) {
    const metrics = auditMetricsOf(head.metrics)
    if (!metrics) continue
    const repo = repoKey(head.repo)
    const target = repoTarget(config, head.repo)
    for (const metric of metrics.advisories) {
      const key = auditFindingKey(metric)
      let group = groups.get(key)
      if (!group) groups.set(key, (group = { key, first: metric, repos: [] }))
      let entry = group.repos.find((candidate) => candidate.repo === repo)
      if (!entry) group.repos.push((entry = { repo, groups: [...target.groups], rows: [] }))
      entry.rows.push({ metric, firstSeenAt: metrics.firstSeen?.[key] ?? head.createdAt })
    }
  }
  return [...groups.values()]
}

const matchesTask = (task: AgentTask, repo: string, metric: AuditFindingMetric) =>
  task.repo === repo &&
  task.source.type === 'dependency-upgrade' &&
  task.source.package === metric.package &&
  task.source.ecosystem.toLowerCase() === metric.ecosystem.toLowerCase()

const rank: Record<FindingStatus, number> = { open: 0, fixing: 1, allowlisted: 2 }

const settle = (stored: StoredGroup, tasks: readonly AgentTask[], today: string): FindingGroup => {
  const { first } = stored
  const repos: FindingRepo[] = stored.repos.map((entry) => {
    const allowlisted = entry.rows.every(({ metric }) => {
      const until = metric.allowlisted?.until
      return !!metric.allowlisted && (until === undefined || until >= today)
    })
    const task = allowlisted
      ? undefined
      : tasks.find((candidate) => matchesTask(candidate, entry.repo, first))
    const status: FindingStatus = allowlisted ? 'allowlisted' : task ? 'fixing' : 'open'
    return {
      repo: entry.repo,
      groups: entry.groups,
      versions: union(entry.rows.map(({ metric }) => [metric.version])),
      sources: union(entry.rows.map(({ metric }) => [metric.source])),
      status,
      ...(task && { taskId: task.id }),
    }
  })
  repos.sort((a, b) => rank[a.status] - rank[b.status] || a.repo.localeCompare(b.repo))
  const lead = repos[0]
  const rows = stored.repos.flatMap((entry) => entry.rows)
  const severity = rows
    .map(({ metric }) => metric.severity)
    .reduce((worst, next) => (compareSeverity(next, worst) > 0 ? next : worst))
  return {
    advisory: first.id,
    aliases: union(rows.map(({ metric }) => metric.aliases)),
    ...(first.summary && { summary: first.summary }),
    ...(first.url && { url: first.url }),
    package: first.package,
    ecosystem: first.ecosystem,
    severity,
    fixedIn: first.fixedIn,
    repos,
    status: lead?.status ?? 'open',
    ...(lead?.taskId && { taskId: lead.taskId }),
    firstSeenAt: rows
      .map((row) => row.firstSeenAt)
      .reduce((earliest, next) => (next < earliest ? next : earliest)),
  }
}

/**
 * The findings of the newest audit (main line) of every repository `principal` may read audits of
 * (`audits:read`), narrowed by `filter`, one group per advisory and package, as
 * `GET /api/audits/findings` answers. Read from stored metrics only, never from records' data
 * (except metrics `latestHeadsWithMetrics` computes once for records stored without any). A group
 * or repository is `fixing` while an approved or running agent task upgrades that package in that
 * repository, and `allowlisted` while every finding there was hidden by an allowlist entry that has
 * not expired since. `firstSeenAt` is the record time where no first-seen time was stored.
 */
export async function readFindings(
  deps: FindingsDeps,
  principal: Principal,
  filter: FindingsFilter = {},
): Promise<FindingsResponse> {
  const { config, store } = deps
  const wanted = filter.repos ? new Set(filter.repos) : undefined
  const heads = (
    await latestHeadsWithMetrics(store.analyses, deps.kinds, { kind: 'audit' })
  ).filter(
    (head) =>
      (!wanted || wanted.has(repoKey(head.repo))) &&
      canSee(principal, 'audits:read', repoTarget(config, head.repo)),
  )
  const repos = heads.map((head) => repoKey(head.repo))
  const load = async () => groupStored(config, heads)
  const [stored, tasks] = await Promise.all([
    deps.cache
      ? deps.cache.read(
          { endpoint: 'audits/findings', analysisIds: heads.map((head) => head.id), repos },
          load,
        )
      : load(),
    repos.length ? store.tasks.list({ repos, status: FIXING }) : [],
  ])
  const groups = stored
    .map((group) => settle(group, tasks, deps.today))
    .toSorted(
      (a, b) =>
        severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity) ||
        b.repos.length - a.repos.length ||
        a.advisory.localeCompare(b.advisory) ||
        a.package.localeCompare(b.package),
    )
  const severities: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  for (const group of groups) severities[group.severity] += 1
  return { groups, severities }
}
