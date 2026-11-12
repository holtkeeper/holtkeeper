import { type RepoTarget, groupLineage } from '@holtkeeper/access'
import type {
  AuditRunSummary,
  HomeAttentionAction,
  HomeAttentionItem,
  HomeChange,
  HomeChangeKind,
  HomeRepoRef,
  HomeSeverity,
  ReleaseCard,
} from '@holtkeeper/api'
import type {
  AnalysisHead,
  AuditEvent,
  Job,
  KnowledgeEntry,
  LearningCandidate,
  SettingEntry,
} from '@holtkeeper/store'
import { webPaths } from '@holtkeeper/web-paths'

import { parseRepo } from './context.ts'
import {
  allowlistNotices,
  allowlistTitle,
  awaitingVersionTitle,
  releaseAwaitsDecision,
} from './inbox.ts'
import { awaitsAcceptance } from './releases.ts'
import { type HealthAccess, STALE_ANALYSIS_DAYS, isStale } from './repo-health.ts'
import { failureSnoozeId } from './snoozes.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** Failed and budget-blocked jobs count for Needs attention this long after they ended. */
const ATTENTION_WINDOW_MS = DAY_MS

/** What changed covers this many days of the audit log. */
export const CHANGES_DAYS = 7

/** The newest and the one before it of one repository's audits. */
export interface RepoAudits {
  latest: AuditRunSummary
  previous?: AuditRunSummary
}

/** Everything Needs attention is computed from, already narrowed to what the caller may read. */
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
  audits: readonly RepoAudits[]
  releases: readonly ReleaseCard[]
  /** Proposed learned rules the caller may decide. */
  learnings: readonly LearningCandidate[]
  /** Proposed knowledge entries the caller may decide. */
  knowledge: readonly KnowledgeEntry[]
  /**
   * The newest record head per repository and kind, of analyzers that still exist, with metrics
   * (computed at read time for records stored without).
   */
  analyses: readonly AnalysisHead[]
  /** `audit.allowlist` setting entries the caller may write. */
  allowlists: readonly SettingEntry[]
  /** Repositories (`forge:path`) the caller may see; the ones without any record are not analysed. */
  repos: readonly string[]
  /** What the caller may read on a repository; everything when absent. */
  access?: (repo: RepoTarget) => HealthAccess
  /** Whether the caller may queue `analyzer` on the repository again; never when absent. */
  canRetry?: (repo: string, analyzer: string) => boolean
}

const severityRank: Record<HomeSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

const keyOf = (repo: { forge: string; path: string }) => `${repo.forge}:${repo.path}`

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

const firstLine = (text: string, max = 160) => {
  const line = text.split('\n').find((part) => part.trim()) ?? text
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim()
}

const open = (label: string, href: string): HomeAttentionAction => ({ type: 'open', label, href })

const review = (href: string): HomeAttentionAction => ({ type: 'review', label: 'Review', href })

const repoRef = (sources: Pick<HomeSources, 'groupsOf'>, repo: string): HomeRepoRef => ({
  repo,
  groups: sources.groupsOf(repo),
})

const jobRepo = (sources: Pick<HomeSources, 'groupsOf'>, job: Job): HomeRepoRef =>
  job.group !== undefined
    ? { repo: keyOf(job.repo), groups: groupLineage(job.group) }
    : repoRef(sources, keyOf(job.repo))

const endedAt = (job: Job) => job.finishedAt ?? job.createdAt

const recent = (jobs: readonly Job[], now: Date) =>
  jobs.filter((job) => now.getTime() - Date.parse(endedAt(job)) <= ATTENTION_WINDOW_MS)

const uniqueRepos = (refs: readonly HomeRepoRef[]) => [
  ...new Map(refs.map((ref) => [ref.repo, ref])).values(),
]

/**
 * Jobs that failed in the attention window, one item per analyzer and failure signature, or per
 * analyzer and repository for failures without a signature; ids are `failureSnoozeId`s.
 */
export function failureItems(sources: HomeSources): HomeAttentionItem[] {
  const groups = new Map<string, Job[]>()
  for (const job of recent(sources.failedJobs, sources.now)) {
    const id = failureSnoozeId({
      analyzer: job.analyzer,
      ...(job.errorSignature !== undefined && { signature: job.errorSignature }),
      repo: keyOf(job.repo),
    })
    groups.set(id, [...(groups.get(id) ?? []), job])
  }
  return [...groups.entries()].map(([id, jobs]) => {
    const last = jobs[0]!
    const repos = uniqueRepos(jobs.map((job) => jobRepo(sources, job)))
    const label = sources.analyzerLabel(last.analyzer)
    const href = webPaths.runs({
      status: 'failed',
      analyzer: last.analyzer,
      signature: last.errorSignature,
      ...(repos.length === 1 && { repo: repos[0]!.repo }),
    })
    const retry =
      sources.canRetry !== undefined &&
      jobs.every((job) => job.group === undefined) &&
      repos.every((repo) => sources.canRetry!(repo.repo, last.analyzer))
    return {
      id,
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
      href,
      action: retry
        ? { type: 'retry', label: 'Retry', analyzer: last.analyzer }
        : open('View runs', href),
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
    href: webPaths.runs({ status: 'blocked' }),
    action: open('View runs', webPaths.runs({ status: 'blocked' })),
  }))
}

const urgent = (summary: AuditRunSummary) => summary.severities.critical + summary.severities.high

/** Critical and high vulnerabilities of each repository's latest audit. */
export function auditItems(sources: HomeSources): HomeAttentionItem[] {
  return sources.audits.flatMap(({ latest, previous }): HomeAttentionItem[] => {
    const repo = repoRef(sources, keyOf(latest.repo))
    const href = webPaths.securityRun(latest.id)
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
        action: open('Open audit', href),
      })
    }
    return items
  })
}

/**
 * `audit.allowlist` entries that expired (`allowlist`) or expire within 7 days
 * (`allowlist-expiring`), one item per entry with the id of its Inbox item.
 */
export function allowlistItems(sources: HomeSources): HomeAttentionItem[] {
  return sources.allowlists.flatMap((setting) =>
    allowlistNotices(setting, sources.now).map((notice): HomeAttentionItem => {
      const href = webPaths.inbox({ item: notice.id, kind: 'allowlist' })
      return {
        id: notice.id,
        kind: notice.expired ? 'allowlist' : 'allowlist-expiring',
        severity: notice.expired ? 'medium' : 'low',
        title: allowlistTitle(notice),
        detail: firstLine(notice.entry.reason),
        repos: notice.repos.map((repo) => repoRef(sources, repo)),
        count: 1,
        at: notice.since,
        href,
        action: { type: 'renew', label: 'Renew', href },
      }
    }),
  )
}

/**
 * What a release card needs from a person, as a severity and a sentence: a failed read, a failed
 * deploy, an acceptance nobody gave, a version blocked by a gate. `undefined` for states that need
 * no decision (ready to propose, ready to create or deploy a version): the Releases page shows them.
 */
function releaseNeed(card: ReleaseCard): { severity: HomeSeverity; title: string } | undefined {
  if (card.error !== undefined)
    return { severity: 'medium', title: 'Reading the release state failed' }
  const failed = card.deploy?.environments.find((env) => env.status === 'failed')
  if (failed && card.deploy)
    return { severity: 'high', title: `Deploy of ${card.deploy.tag} to ${failed.name} failed` }
  if (awaitsAcceptance(card) || (card.stage === 'awaiting-version' && card.blockers.length))
    return { severity: 'medium', title: awaitingVersionTitle(card) }
  return undefined
}

/**
 * Releases that need a person: a failed read or deploy, an acceptance nobody gave, a blocked
 * version. One the caller may decide in the Inbox (`releaseAwaitsDecision` and `can.run`) opens
 * its Inbox item.
 */
export function releaseItems(sources: HomeSources): HomeAttentionItem[] {
  return sources.releases.flatMap((card): HomeAttentionItem[] => {
    const need = card.needsAction ? releaseNeed(card) : undefined
    if (!need) return []
    const repo = repoRef(sources, keyOf(card.repo))
    const id = `release:${repo.repo}`
    const decides = card.can.run && releaseAwaitsDecision(card)
    const href = decides
      ? webPaths.inbox({ item: id, kind: 'release' })
      : webPaths.releaseTimeline(repo.repo)
    return [
      {
        id,
        kind: 'release',
        ...need,
        repos: [repo],
        count: 1,
        at: card.waitingSince ?? card.acceptance?.at ?? sources.now.toISOString(),
        href,
        action: decides ? { type: 'review', label: 'Review', href } : open('Open release', href),
      },
    ]
  })
}

const oldestOf = <T extends { id: string; createdAt: string }>(list: readonly T[]) =>
  list.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]!

const newestUpdate = (list: readonly { updatedAt: string }[]) =>
  list
    .map((each) => each.updatedAt)
    .toSorted()
    .at(-1)!

/**
 * Proposed learned rules per repository, and proposed knowledge entries as one item; each opens
 * the oldest of its proposals in the Inbox.
 */
function reviewItems(sources: HomeSources): HomeAttentionItem[] {
  const byRepo = new Map<string, LearningCandidate[]>()
  for (const candidate of sources.learnings)
    byRepo.set(candidate.repo, [...(byRepo.get(candidate.repo) ?? []), candidate])
  const items = [...byRepo.entries()].map(([repo, candidates]): HomeAttentionItem => {
    const href = webPaths.inbox({
      item: `learning:${oldestOf(candidates).id}`,
      kind: 'learning',
    })
    return {
      id: `learnings:${repo}`,
      kind: 'learnings',
      severity: 'low',
      title: `${plural(candidates.length, 'learned rule')} ${candidates.length === 1 ? 'waits' : 'wait'} for review`,
      repos: [repoRef(sources, repo)],
      count: candidates.length,
      at: newestUpdate(candidates),
      href,
      action: review(href),
    }
  })
  if (sources.knowledge.length) {
    const href = webPaths.inbox({ item: `note:${oldestOf(sources.knowledge).id}`, kind: 'note' })
    items.push({
      id: 'knowledge',
      kind: 'knowledge',
      severity: 'low',
      title: `${plural(sources.knowledge.length, 'knowledge proposal')} ${sources.knowledge.length === 1 ? 'waits' : 'wait'} for review`,
      repos: [],
      count: sources.knowledge.length,
      at: newestUpdate(sources.knowledge),
      href,
      action: review(href),
    })
  }
  return items
}

const targetOf = (sources: Pick<HomeSources, 'groupsOf'>, repo: string): RepoTarget => ({
  ...(parseRepo(repo) ?? { forge: '', path: repo }),
  groups: sources.groupsOf(repo),
})

/** Repositories whose newest analysis of some kind is older than `STALE_ANALYSIS_DAYS`. */
export function staleItems(sources: HomeSources): HomeAttentionItem[] {
  const byRepo = new Map<string, AnalysisHead[]>()
  for (const head of sources.analyses) {
    if (!isStale(head, sources.now)) continue
    const repo = keyOf(head.repo)
    if (sources.access?.(targetOf(sources, repo))('analyses:read') === false) continue
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
      href: webPaths.repo(repo),
      action: open('Open repository', webPaths.repo(repo)),
    }
  })
}

/**
 * Repositories the caller may see and read analyses of that have no record at all: no analysis
 * head and no audit run.
 */
export function notAnalysedItems(sources: HomeSources): HomeAttentionItem[] {
  const recorded = new Set([
    ...sources.analyses.map((head) => keyOf(head.repo)),
    ...sources.audits.map((audit) => keyOf(audit.latest.repo)),
  ])
  return [...new Set(sources.repos)]
    .filter(
      (repo) =>
        !recorded.has(repo) && sources.access?.(targetOf(sources, repo))('analyses:read') !== false,
    )
    .toSorted()
    .map((repo) => ({
      id: `not-analysed:${repo}`,
      kind: 'not-analysed',
      severity: 'low',
      title: 'Not analysed yet',
      repos: [repoRef(sources, repo)],
      count: 1,
      at: sources.now.toISOString(),
      href: webPaths.repo(repo),
      action: open('Open repository', webPaths.repo(repo)),
    }))
}

/**
 * Every Needs-attention item, most urgent first, then newest first; not-analysed repositories have
 * no meaningful time and come after the other low items.
 */
export function attentionItems(sources: HomeSources): HomeAttentionItem[] {
  return [
    ...failureItems(sources),
    ...blockedItems(sources),
    ...auditItems(sources),
    ...allowlistItems(sources),
    ...releaseItems(sources),
    ...reviewItems(sources),
    ...staleItems(sources),
    ...notAnalysedItems(sources),
  ].toSorted(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      Number(a.kind === 'not-analysed') - Number(b.kind === 'not-analysed') ||
      b.at.localeCompare(a.at) ||
      a.id.localeCompare(b.id),
  )
}

/** What one event reads as: the sentence and the page that shows it. */
interface ChangeLine {
  text: string
  href: string
}

interface ChangeRule {
  kind: HomeChangeKind
  matches: (action: string) => boolean
  /** Action prefixes that cover every action `matches` accepts, for querying the audit log. */
  prefixes: string[]
  /** Reads only whitelisted fields of `event`; `path` is the repository path when there is one. */
  line: (event: AuditEvent, path: string | undefined) => ChangeLine
}

const exactly = (...actions: string[]) => ({
  matches: (action: string) => actions.includes(action),
  prefixes: actions,
})

/** A detail value when it is a short token (version, tag, environment, setting key, advisory id). */
const token = (event: AuditEvent, name: string): string | undefined => {
  const value = event.details?.[name]
  return typeof value === 'string' && /^[\w.@+/:-]{1,80}$/.test(value) ? value : undefined
}

const verb = (event: AuditEvent) => event.action.slice(event.action.indexOf('.') + 1)

const ofRepo = (path: string | undefined) => (path ? ` of ${path}` : '')

const forRepo = (path: string | undefined) => (path ? ` for ${path}` : '')

const releaseHref = (event: AuditEvent) =>
  event.target.repo ? webPaths.releaseTimeline(event.target.repo) : webPaths.settings('audit')

const guideHref = (event: AuditEvent) =>
  webPaths.knowledge('guide', event.target.repo ? { space: `repo:${event.target.repo}` } : {})

const knowledgeVerbs: Record<string, string> = {
  create: 'Added',
  update: 'Edited',
  delete: 'Deleted',
}

const credentialVerbs: Record<string, string> = {
  create: 'Added',
  update: 'Changed',
  delete: 'Deleted',
  rotate: 'Rotated',
}

const guideTexts: Record<string, string> = {
  update: 'Edited the Guide',
  accept: 'Accepted generated Guide text',
  restore: 'Restored a Guide version',
}

const accessTexts: Record<string, string> = {
  invited: 'Invited a user',
  signed_up: 'Signed up',
  recovered: 'Recovered access with a link',
  link_issued: 'Issued a sign-in link',
}

const changeRules: ChangeRule[] = [
  {
    kind: 'release',
    ...exactly('release.versioned'),
    line: (event, path) => {
      const version = token(event, 'version')
      return {
        text: `Cut ${version ? `version ${version}` : 'a version'}${ofRepo(path)}`,
        href: releaseHref(event),
      }
    },
  },
  {
    kind: 'release',
    ...exactly('release.proposed'),
    line: (event, path) => ({
      text: `Proposed a release${ofRepo(path)}`,
      href: releaseHref(event),
    }),
  },
  {
    kind: 'release',
    ...exactly('release.accepted'),
    line: (event, path) => ({
      text: `Accepted the release${ofRepo(path)}`,
      href: releaseHref(event),
    }),
  },
  {
    kind: 'release',
    ...exactly('release.dismiss'),
    line: (event, path) => ({
      text: `Dismissed the waiting release${ofRepo(path)}`,
      href: releaseHref(event),
    }),
  },
  {
    kind: 'deploy',
    ...exactly('release.deploy-started'),
    line: (event, path) => {
      const tag = token(event, 'tag')
      const environment = token(event, 'environment')
      return {
        text: `Started deploying ${tag ?? 'a release'}${ofRepo(path)}${environment ? ` to ${environment}` : ''}`,
        href: releaseHref(event),
      }
    },
  },
  {
    kind: 'settings',
    ...exactly('setting.update', 'setting.delete'),
    line: (event) => {
      const key = token(event, 'key')
      const action = verb(event) === 'delete' ? 'Removed' : 'Changed'
      return {
        text: key ? `${action} the setting ${key}` : `${action} a setting`,
        href: webPaths.settings('audit'),
      }
    },
  },
  {
    kind: 'settings',
    ...exactly('setting.draft'),
    line: (event) => {
      const saved = event.details?.saved
      const removed = event.details?.removed
      const count =
        (typeof saved === 'number' ? saved : 0) + (typeof removed === 'number' ? removed : 0)
      return {
        text: count > 1 ? `Saved ${count} setting changes at once` : 'Saved a setting change',
        href: webPaths.settings('policies'),
      }
    },
  },
  {
    kind: 'settings',
    ...exactly('allowlist.renew'),
    line: (event) => {
      const advisory = token(event, 'advisory')
      return {
        text: `Renewed the allowlist entry${advisory ? ` for ${advisory}` : ''}`,
        href: webPaths.security(),
      }
    },
  },
  {
    kind: 'knowledge',
    ...exactly('knowledge.create', 'knowledge.update', 'knowledge.delete'),
    line: (event) => ({
      text: `${knowledgeVerbs[verb(event)]!} a knowledge note`,
      href: webPaths.knowledge(
        'notes',
        verb(event) !== 'delete' && event.target.id ? { note: event.target.id } : {},
      ),
    }),
  },
  {
    kind: 'knowledge',
    ...exactly('learning.accept'),
    line: (event, path) => ({
      text: `Accepted a learned rule${forRepo(path)}`,
      href: webPaths.knowledge(
        'learnings',
        event.target.repo ? { space: `repo:${event.target.repo}` } : {},
      ),
    }),
  },
  {
    kind: 'guide',
    ...exactly('guide.update', 'guide.accept', 'guide.restore'),
    line: (event, path) => ({
      text: `${guideTexts[verb(event)]!}${forRepo(path)}`,
      href: guideHref(event),
    }),
  },
  {
    kind: 'guide',
    ...exactly('guide.reject'),
    line: (event, path) => ({
      text: `Rejected generated Guide text${forRepo(path)}`,
      href: guideHref(event),
    }),
  },
  {
    kind: 'repo',
    ...exactly('repo.discover'),
    line: (event, path) => ({
      text: path ? `Found the new repository ${path}` : 'Found a new repository',
      href: event.target.repo ? webPaths.repo(event.target.repo) : webPaths.repos(),
    }),
  },
  {
    kind: 'credentials',
    ...exactly('credential.create', 'credential.update', 'credential.delete', 'credential.rotate'),
    line: (event) => ({
      text: `${credentialVerbs[verb(event)]!} a credential`,
      href: webPaths.settings('integrations'),
    }),
  },
  {
    kind: 'task',
    ...exactly('task.reject'),
    line: (event) => ({
      text: 'Rejected a proposed agent task',
      href: webPaths.tasks({ group: event.target.id }),
    }),
  },
  {
    kind: 'access',
    ...exactly('user.invited', 'user.signed_up', 'user.recovered', 'user.link_issued'),
    line: (event) => ({ text: accessTexts[verb(event)]!, href: webPaths.settings('people') }),
  },
]

/** The audit log action prefixes `summarizeChanges` may list, each queried on its own. */
export const changeActionPrefixes = [...new Set(changeRules.flatMap((rule) => rule.prefixes))]

/**
 * One change per audit log event, newest first, at most `limit`: only the high-signal actions
 * (releases, deploys, settings, the allowlist, knowledge, the Guide, new repositories,
 * credentials, access, rejected agent tasks) that succeeded. Deterministic: the same events give the same sentences.
 */
export function summarizeChanges(
  events: readonly AuditEvent[],
  groupsOf: (repo: string) => string[],
  limit = 40,
): HomeChange[] {
  return events
    .flatMap((event): HomeChange[] => {
      if (event.outcome !== 'ok') return []
      const rule = changeRules.find((each) => each.matches(event.action))
      if (!rule) return []
      const repo = event.target.repo
      const parsed = repo === undefined ? undefined : parseRepo(repo)
      const { text, href } = rule.line(event, parsed?.path)
      return [
        {
          id: event.id,
          kind: rule.kind,
          text,
          href,
          at: event.at,
          actor: event.actor.id,
          ...(repo !== undefined && { repo: { repo, groups: groupsOf(repo) } }),
        },
      ]
    })
    .toSorted((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .slice(0, limit)
}
