import type {
  AuditRunSummary,
  HomeAttentionItem,
  HomeChange,
  HomeChangeKind,
  HomeRepoRef,
  HomeRepoStatus,
  HomeRepoTile,
  HomeSeverity,
  ReleaseCard,
} from '@holtkeeper/api'
import type {
  AnalysisHead,
  AuditEvent,
  Job,
  KnowledgeEntry,
  LearningCandidate,
} from '@holtkeeper/store'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Failed and budget-blocked jobs count for Needs attention this long after they ended. */
const ATTENTION_WINDOW_MS = DAY_MS

/** An analysis whose newest record is older than this counts as stale. */
const STALE_ANALYSIS_DAYS = 14

/** What changed covers this many days of History. */
export const CHANGES_DAYS = 7

/** The newest and the one before it of one repository's audits. */
export interface RepoAudits {
  latest: AuditRunSummary
  previous?: AuditRunSummary
}

/**
 * Everything Needs attention and the repository grid are computed from, already narrowed to what
 * the caller may read.
 */
export interface HomeSources {
  now: Date
  /** `forge:path` → groups the config gives the repository. */
  groupsOf: (repo: string) => string[]
  /** Label of an analyzer kind for sentences. */
  analyzerLabel: (kind: string) => string
  /** Failed jobs, newest first. */
  failedJobs: readonly Job[]
  /** Budget-blocked jobs, newest first. */
  blockedJobs: readonly Job[]
  /** Recent jobs of any status, newest first: the newest one per repository feeds its tile. */
  recentJobs: readonly Job[]
  audits: readonly RepoAudits[]
  releases: readonly ReleaseCard[]
  /** Proposed learned rules the caller may decide. */
  learnings: readonly LearningCandidate[]
  /** Proposed knowledge entries the caller may decide. */
  knowledge: readonly KnowledgeEntry[]
  /** The newest record head per repository and kind, of analyzers that still exist. */
  analyses: readonly AnalysisHead[]
}

const severityRank: Record<HomeSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

const keyOf = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

const firstLine = (text: string, max = 160) => {
  const line = text.split('\n').find((part) => part.trim()) ?? text
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim()
}

const repoRef = (sources: Pick<HomeSources, 'groupsOf'>, repo: string): HomeRepoRef => ({
  repo,
  groups: sources.groupsOf(repo),
})

const jobRepo = (sources: Pick<HomeSources, 'groupsOf'>, job: Job): HomeRepoRef =>
  job.group !== undefined
    ? { repo: keyOf(job.repo), groups: [job.group] }
    : repoRef(sources, keyOf(job.repo))

const endedAt = (job: Job) => job.finishedAt ?? job.createdAt

const recent = (jobs: readonly Job[], now: Date) =>
  jobs.filter((job) => now.getTime() - Date.parse(endedAt(job)) <= ATTENTION_WINDOW_MS)

const uniqueRepos = (refs: readonly HomeRepoRef[]) => [
  ...new Map(refs.map((ref) => [ref.repo, ref])).values(),
]

const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** Jobs that failed in the attention window, one item per analyzer and failure signature. */
export function failureItems(sources: HomeSources): HomeAttentionItem[] {
  const groups = new Map<string, Job[]>()
  for (const job of recent(sources.failedJobs, sources.now)) {
    const cause = job.errorSignature ?? firstLine(job.error ?? 'unknown error')
    const id = `${job.analyzer}\n${cause}`
    groups.set(id, [...(groups.get(id) ?? []), job])
  }
  return [...groups.values()].map((jobs) => {
    const last = jobs[0]!
    const repos = uniqueRepos(jobs.map((job) => jobRepo(sources, job)))
    const label = sources.analyzerLabel(last.analyzer)
    return {
      id: `job-failures:${last.analyzer}:${last.errorSignature ?? last.id}`,
      kind: 'job-failures',
      severity: jobs.length >= 3 || repos.length > 1 ? 'high' : 'medium',
      title:
        repos.length > 1
          ? `${label} failed ${plural(jobs.length, 'time')} in ${plural(repos.length, 'repository', 'repositories')}`
          : `${label} failed ${plural(jobs.length, 'time')}`,
      ...(last.error && { detail: firstLine(last.error) }),
      repos,
      count: jobs.length,
      at: endedAt(last),
      href: `/jobs${query({
        status: 'failed',
        analyzer: last.analyzer,
        signature: last.errorSignature,
        ...(repos.length === 1 && { repo: repos[0]!.repo }),
      })}`,
    }
  })
}

/** Jobs an AI budget stopped in the attention window, one item per reason. */
function blockedItems(sources: HomeSources): HomeAttentionItem[] {
  const groups = new Map<string, Job[]>()
  for (const job of recent(sources.blockedJobs, sources.now)) {
    const reason = firstLine(job.error ?? 'AI budget reached')
    groups.set(reason, [...(groups.get(reason) ?? []), job])
  }
  return [...groups.entries()].map(([reason, jobs]) => ({
    id: `budget-blocked:${reason}`,
    kind: 'budget-blocked',
    severity: 'high',
    title: `${plural(jobs.length, 'job')} stopped by the AI budget`,
    detail: reason,
    repos: uniqueRepos(jobs.map((job) => jobRepo(sources, job))),
    count: jobs.length,
    at: endedAt(jobs[0]!),
    href: '/jobs?status=blocked',
  }))
}

const urgent = (summary: AuditRunSummary) => summary.severities.critical + summary.severities.high

/** Critical and high vulnerabilities of each repository's latest audit, and expired allowlist entries. */
export function auditItems(sources: HomeSources): HomeAttentionItem[] {
  return sources.audits.flatMap(({ latest, previous }): HomeAttentionItem[] => {
    const repo = repoRef(sources, keyOf(latest.repo))
    const href = `/audits/${latest.id}`
    const items: HomeAttentionItem[] = []
    const { critical, high } = latest.severities
    if (critical + high > 0) {
      const parts = [
        ...(critical ? [`${critical} critical`] : []),
        ...(high ? [`${high} high`] : []),
      ]
      const before = previous ? urgent(previous) : undefined
      items.push({
        id: `vulnerabilities:${repo.repo}`,
        kind: 'vulnerabilities',
        severity: critical ? 'critical' : 'high',
        title: `${parts.join(' and ')} ${critical + high === 1 ? 'vulnerability' : 'vulnerabilities'}`,
        ...(before !== undefined &&
          before !== critical + high && {
            detail: `${before < critical + high ? 'Up' : 'Down'} from ${before} in the audit before`,
          }),
        repos: [repo],
        count: critical + high,
        at: latest.finishedAt,
        href,
      })
    }
    if (latest.expiredAllowlist > 0)
      items.push({
        id: `allowlist:${repo.repo}`,
        kind: 'allowlist',
        severity: 'medium',
        title: `${plural(latest.expiredAllowlist, 'allowlist entry', 'allowlist entries')} expired`,
        repos: [repo],
        count: latest.expiredAllowlist,
        at: latest.finishedAt,
        href,
      })
    return items
  })
}

/** What a release card waits for, as a severity and a sentence; `undefined` when nothing. */
function releaseNeed(card: ReleaseCard): { severity: HomeSeverity; title: string } | undefined {
  if (card.error !== undefined)
    return { severity: 'medium', title: 'Reading the release state failed' }
  const failed = card.deploy?.environments.find((env) => env.status === 'failed')
  if (failed && card.deploy)
    return { severity: 'high', title: `Deploy of ${card.deploy.tag} to ${failed.name} failed` }
  if (card.stage === 'awaiting-version')
    return {
      severity: 'medium',
      title: card.next
        ? `Accepted, waiting for version ${card.next}`
        : 'Accepted, waiting for a version',
    }
  if (card.stage === 'proposed')
    return { severity: 'medium', title: 'Release proposed, waiting for acceptance' }
  if (card.stage === 'candidate')
    return {
      severity: 'low',
      title: `${plural(card.unreleased, 'unreleased commit')}${card.unreleasedCapped ? '+' : ''} ready to propose`,
    }
  const ready = card.deploy?.environments.find((env) => env.status === 'ready')
  if (ready && card.deploy)
    return { severity: 'low', title: `${card.deploy.tag} is ready to deploy to ${ready.name}` }
  return undefined
}

/** Releases that wait on a person: a pending step, a failed or ready deploy, a failed read. */
export function releaseItems(sources: HomeSources): HomeAttentionItem[] {
  return sources.releases.flatMap((card): HomeAttentionItem[] => {
    const need = card.needsAction ? releaseNeed(card) : undefined
    if (!need) return []
    const repo = repoRef(sources, keyOf(card.repo))
    return [
      {
        id: `release:${repo.repo}`,
        kind: 'release',
        ...need,
        repos: [repo],
        count: 1,
        at: card.waitingSince ?? card.acceptance?.at ?? sources.now.toISOString(),
        href: `/releases/${repo.repo}`,
      },
    ]
  })
}

/** Proposed learned rules per repository, and proposed knowledge entries as one item. */
function reviewItems(sources: HomeSources): HomeAttentionItem[] {
  const byRepo = new Map<string, LearningCandidate[]>()
  for (const candidate of sources.learnings)
    byRepo.set(candidate.repo, [...(byRepo.get(candidate.repo) ?? []), candidate])
  const items: HomeAttentionItem[] = [...byRepo.entries()].map(([repo, candidates]) => ({
    id: `learnings:${repo}`,
    kind: 'learnings',
    severity: 'low',
    title: `${plural(candidates.length, 'learned rule')} ${candidates.length === 1 ? 'waits' : 'wait'} for review`,
    repos: [repoRef(sources, repo)],
    count: candidates.length,
    at: candidates
      .map((c) => c.updatedAt)
      .toSorted()
      .at(-1)!,
    href: `/knowledge${query({ space: `repo:${repo}`, tab: 'learnings' })}`,
  }))
  if (sources.knowledge.length)
    items.push({
      id: 'knowledge',
      kind: 'knowledge',
      severity: 'low',
      title: `${plural(sources.knowledge.length, 'knowledge proposal')} ${sources.knowledge.length === 1 ? 'waits' : 'wait'} for review`,
      repos: [],
      count: sources.knowledge.length,
      at: sources.knowledge
        .map((entry) => entry.updatedAt)
        .toSorted()
        .at(-1)!,
      href: '/knowledge?tab=notes',
    })
  return items
}

const isStale = (head: AnalysisHead, now: Date) =>
  now.getTime() - Date.parse(head.createdAt) > STALE_ANALYSIS_DAYS * DAY_MS

/** Repositories whose newest analysis of some kind is older than `STALE_ANALYSIS_DAYS`. */
export function staleItems(sources: HomeSources): HomeAttentionItem[] {
  const byRepo = new Map<string, AnalysisHead[]>()
  for (const head of sources.analyses) {
    if (!isStale(head, sources.now)) continue
    const repo = keyOf(head.repo)
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), head])
  }
  return [...byRepo.entries()].map(([repo, heads]) => {
    const kinds = [...new Set(heads.map((head) => sources.analyzerLabel(head.kind)))].toSorted()
    const oldest = heads.map((head) => head.createdAt).toSorted()[0]!
    return {
      id: `stale-analyses:${repo}`,
      kind: 'stale-analyses',
      severity: 'low',
      title: `${plural(heads.length, 'analysis', 'analyses')} older than ${STALE_ANALYSIS_DAYS} days`,
      detail: kinds.join(', '),
      repos: [repoRef(sources, repo)],
      count: heads.length,
      at: oldest,
      href: `/repos/view${query({ repo })}`,
    }
  })
}

/** Every Needs-attention item, most urgent first, then newest first. */
export function attentionItems(sources: HomeSources): HomeAttentionItem[] {
  return [
    ...failureItems(sources),
    ...blockedItems(sources),
    ...auditItems(sources),
    ...releaseItems(sources),
    ...reviewItems(sources),
    ...staleItems(sources),
  ].toSorted(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      b.at.localeCompare(a.at) ||
      a.id.localeCompare(b.id),
  )
}

interface ChangeRule {
  kind: HomeChangeKind
  matches: (action: string) => boolean
  /** Action prefixes that cover every action `matches` accepts, for querying the History. */
  prefixes: string[]
  words: [one: string, many: string]
}

const exactly = (...actions: string[]) => ({
  matches: (action: string) => actions.includes(action),
  prefixes: actions,
})

const changeRules: ChangeRule[] = [
  { kind: 'release', ...exactly('release.version'), words: ['version cut', 'versions cut'] },
  {
    kind: 'release',
    ...exactly('release.propose'),
    words: ['release proposed', 'releases proposed'],
  },
  {
    kind: 'release',
    ...exactly('release.accept'),
    words: ['release accepted', 'releases accepted'],
  },
  {
    kind: 'deploy',
    ...exactly('release.deploy'),
    words: ['deploy started', 'deploys started'],
  },
  {
    kind: 'settings',
    ...exactly('setting.update', 'setting.delete'),
    words: ['settings change', 'settings changes'],
  },
  {
    kind: 'knowledge',
    ...exactly('knowledge.create', 'knowledge.update', 'knowledge.delete'),
    words: ['knowledge edit', 'knowledge edits'],
  },
  {
    kind: 'knowledge',
    ...exactly('learning.accept'),
    words: ['learned rule accepted', 'learned rules accepted'],
  },
  {
    kind: 'guide',
    ...exactly('guide.update', 'guide.accept', 'guide.restore'),
    words: ['Guide edit', 'Guide edits'],
  },
  {
    kind: 'repo',
    ...exactly('repo.discover'),
    words: ['new repository found', 'new repositories found'],
  },
  {
    kind: 'credentials',
    matches: (action) => action.startsWith('credential.'),
    prefixes: ['credential.'],
    words: ['credential change', 'credential changes'],
  },
  {
    kind: 'access',
    matches: (action) =>
      action.startsWith('user.') && action !== 'user.preferences' && action !== 'user.avatar',
    prefixes: ['user.'],
    words: ['access change', 'access changes'],
  },
]

/** The History action prefixes `summarizeChanges` may count, each queried on its own. */
export const changeActionPrefixes = [...new Set(changeRules.flatMap((rule) => rule.prefixes))]

/**
 * History events summed per area and repository, newest first, at most `limit`: only the
 * high-signal actions (releases, deploys, settings, knowledge, the Guide, new repositories,
 * credentials, access) that succeeded. Deterministic: the same events give the same sentences.
 */
export function summarizeChanges(
  events: readonly AuditEvent[],
  groupsOf: (repo: string) => string[],
  limit = 40,
): HomeChange[] {
  const groups = new Map<string, { rule: ChangeRule; repo?: string; events: AuditEvent[] }>()
  for (const event of events) {
    if (event.outcome !== 'ok') continue
    const index = changeRules.findIndex((rule) => rule.matches(event.action))
    if (index < 0) continue
    const repo = event.target.repo
    const id = `${index}\n${repo ?? ''}`
    const group = groups.get(id) ?? { rule: changeRules[index]!, events: [], ...(repo && { repo }) }
    group.events.push(event)
    groups.set(id, group)
  }
  return [...groups.values()]
    .map(({ rule, repo, events: list }): HomeChange => {
      const sorted = list.toSorted((a, b) => b.at.localeCompare(a.at))
      const [one, many] = rule.words
      return {
        kind: rule.kind,
        text: `${sorted.length} ${sorted.length === 1 ? one : many}`,
        ...(repo !== undefined && { repo: { repo, groups: groupsOf(repo) } }),
        count: sorted.length,
        actors: [...new Set(sorted.map((event) => event.actor.id))],
        firstAt: sorted.at(-1)!.at,
        lastAt: sorted[0]!.at,
      }
    })
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt) || a.text.localeCompare(b.text))
    .slice(0, limit)
}

function jobStatus(sources: HomeSources, job: Job | undefined): HomeRepoStatus {
  if (!job) return { key: 'jobs', tone: 'none', label: 'No jobs yet' }
  const label = sources.analyzerLabel(job.analyzer)
  if (job.status === 'succeeded') return { key: 'jobs', tone: 'ok', label: `${label} succeeded` }
  if (job.status === 'failed') return { key: 'jobs', tone: 'danger', label: `${label} failed` }
  if (job.status === 'blocked')
    return { key: 'jobs', tone: 'warning', label: `${label} stopped by the AI budget` }
  if (job.status === 'canceled') return { key: 'jobs', tone: 'none', label: `${label} canceled` }
  return { key: 'jobs', tone: 'info', label: `${label} ${job.status}` }
}

function auditStatus(audits: RepoAudits | undefined): HomeRepoStatus {
  if (!audits) return { key: 'vulnerabilities', tone: 'none', label: 'Not audited' }
  const { severities, active } = audits.latest
  if (severities.critical)
    return { key: 'vulnerabilities', tone: 'danger', label: `${severities.critical} critical` }
  if (severities.high)
    return { key: 'vulnerabilities', tone: 'warning', label: `${severities.high} high` }
  if (active) return { key: 'vulnerabilities', tone: 'info', label: `${active} lower severity` }
  return { key: 'vulnerabilities', tone: 'ok', label: 'No active vulnerabilities' }
}

function releaseStatus(card: ReleaseCard | undefined): HomeRepoStatus {
  if (!card) return { key: 'release', tone: 'none', label: 'Releases off' }
  const need = card.needsAction ? releaseNeed(card) : undefined
  if (need)
    return {
      key: 'release',
      tone: need.severity === 'high' ? 'danger' : 'warning',
      label: need.title,
    }
  if (card.unreleased > 0)
    return {
      key: 'release',
      tone: 'info',
      label: `${plural(card.unreleased, 'unreleased commit')}${card.unreleasedCapped ? '+' : ''}`,
    }
  return { key: 'release', tone: 'ok', label: 'Up to date' }
}

function analysisStatus(heads: readonly AnalysisHead[], now: Date): HomeRepoStatus {
  if (!heads.length) return { key: 'analyses', tone: 'none', label: 'No analyses yet' }
  const stale = heads.filter((head) => isStale(head, now)).length
  return stale
    ? {
        key: 'analyses',
        tone: 'warning',
        label: plural(stale, 'stale analysis', 'stale analyses'),
      }
    : { key: 'analyses', tone: 'ok', label: 'Analyses fresh' }
}

/**
 * One tile per repository in `repos` (sorted), with its status ticks: the newest job, the latest
 * audit, the release state and analysis freshness. Group jobs are left out.
 */
export function repoTiles(sources: HomeSources, repos: Iterable<string>): HomeRepoTile[] {
  const lastJob = new Map<string, Job>()
  for (const job of sources.recentJobs)
    if (job.group === undefined && !lastJob.has(keyOf(job.repo))) lastJob.set(keyOf(job.repo), job)
  const audits = new Map(sources.audits.map((entry) => [keyOf(entry.latest.repo), entry]))
  const releases = new Map(sources.releases.map((card) => [keyOf(card.repo), card]))
  const heads = new Map<string, AnalysisHead[]>()
  for (const head of sources.analyses)
    heads.set(keyOf(head.repo), [...(heads.get(keyOf(head.repo)) ?? []), head])
  return [...new Set(repos)].toSorted().map((repo) => ({
    ...repoRef(sources, repo),
    status: [
      jobStatus(sources, lastJob.get(repo)),
      auditStatus(audits.get(repo)),
      releaseStatus(releases.get(repo)),
      analysisStatus(heads.get(repo) ?? [], sources.now),
    ],
  }))
}
