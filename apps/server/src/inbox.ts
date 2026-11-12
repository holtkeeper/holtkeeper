import {
  type Action,
  type GroupMatch,
  type Principal,
  type Scope,
  can,
  groupsMatch,
  outerGroups,
} from '@holtkeeper/access'
import { budgetKey, budgetStatuses } from '@holtkeeper/ai-usage'
import type {
  AiBudgetStatus,
  HomeRepoRef,
  InboxCount,
  InboxFeed,
  InboxItem,
  ReleaseBoardRow,
  ReleaseCard,
} from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import { familyOf, scopesFor } from '@holtkeeper/guide'
import { pendingGenerated, rejectedHashes } from '@holtkeeper/guide-generator'
import type { CrossTeamCatalog } from '@holtkeeper/settings'
import type {
  AgentTask,
  AgentTaskGroup,
  GuideGenerated,
  GuideSection,
  KnowledgeEntry,
  LearningCandidate,
  SettingEntry,
} from '@holtkeeper/store'
import { type AllowlistEntry, allowlistSchema, isExpired } from '@holtkeeper/vuln'
import { webPaths } from '@holtkeeper/web-paths'

import { type ServerDeps, groupLabeler, parseRepo, repoTarget } from './context.ts'
import { withLiveTarget } from './learnings.ts'
import { releaseCan, releaseServiceFor } from './releases.ts'
import { canReadAiScope } from './routes/ai.ts'
import { peopleOf } from './routes/avatars.ts'
import { homeGroupsOf } from './routes/preferences.ts'
import { snoozedIds } from './snoozes.ts'
import { canSeeGroup } from './tasks.ts'
import { canSeeCatalog, crossTeamPolicy, scopeOwner } from './visibility.ts'

/** How long the raw Inbox sources are reused between requests. */
const INBOX_CACHE_MS = 30_000

/** An allowlist entry shows up this long before it expires. */
const ALLOWLIST_NOTICE_DAYS = 7

const DAY_MS = 86_400_000

const budgetSeenKey = (budget: string, week: string) => `inbox:budget:${budget}:${week}`

/** Everything Inbox items come from, before any permission check; shared by every caller. */
interface InboxSources {
  /** Task groups with at least one `proposed` task, with those tasks. */
  tasks: { group: AgentTaskGroup; proposed: AgentTask[] }[]
  notes: KnowledgeEntry[]
  learnings: LearningCandidate[]
  /** Repository sections with generated text waiting for a person that nobody rejected. */
  guides: { section: GuideSection; pending: GuideGenerated }[]
  /** Every stored release card, `can` all false. */
  releases: ReleaseCard[]
  /** `audit.allowlist` setting entries. */
  allowlists: SettingEntry[]
  /** Budgets whose spend this week reached their `warnPercent`, with when that was first seen. */
  budgets: { status: AiBudgetStatus; since: string }[]
  crossTeam: CrossTeamCatalog
}

/** An item with the group memberships that decide its section. */
interface Placed {
  item: InboxItem
  /** Groups of each repository or owning team; empty for items above every team. */
  memberships: string[][]
}

const keyOf = (repo: RepoRef) => `${repo.forge}:${repo.path}`

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

const firstLine = (text: string, max = 160) => {
  const line =
    text
      .split('\n')
      .find((part) => part.trim())
      ?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const formatMatch = (entry: GroupMatch, label: (key: string) => string) =>
  typeof entry === 'string' ? label(entry) : entry.map(label).join(' + ')

/**
 * A scope as people read it: `All repositories`, `Team Web (web)`, a repository path or pattern.
 * A subgroup named next to its parent is left out: the parent already covers it.
 */
function scopeText(scope: Scope, label: (key: string) => string): string {
  if (scope.all) return 'All repositories'
  const groups = scope.groups ?? []
  const outer = new Set(outerGroups(groups.filter((entry) => typeof entry === 'string')))
  const parts = [
    ...groups
      .filter((entry) => typeof entry !== 'string' || outer.has(entry))
      .map((entry) => `Team ${formatMatch(entry, label)}`),
    ...(scope.repos ?? []).map((pattern) => {
      const repo = exactRepo(pattern)
      return repo ? repo.path : pattern
    }),
  ]
  return parts.join(', ') || 'Nothing'
}

const exactRepo = (pattern: string): RepoRef | undefined => {
  const separator = pattern.indexOf(':')
  if (separator < 1 || /[*?[{]/.test(pattern)) return undefined
  return { forge: pattern.slice(0, separator), path: pattern.slice(separator + 1) }
}

/** An `audit.allowlist` entry that expires within 7 days or has expired. */
export interface AllowlistNotice {
  /** The Inbox item id: `allowlist:<settingId>:<advisory>[:<package>]`. */
  id: string
  entry: AllowlistEntry
  /** Last day the entry applies, `YYYY-MM-DD`. */
  expires: string
  /** End of `expires` (UTC), epoch milliseconds. */
  endsAt: number
  /** When it started waiting: 7 days before `endsAt`. */
  since: string
  expired: boolean
  /** Exact repositories (`forge:path`) of the setting's scope. */
  repos: string[]
}

/**
 * The entries of an `audit.allowlist` setting entry that expire within 7 days or have expired, in
 * stored order; none when the value does not validate.
 */
export function allowlistNotices(setting: SettingEntry, now: Date): AllowlistNotice[] {
  const parsed = allowlistSchema.safeParse(setting.value)
  if (!parsed.success) return []
  const repos = (setting.scope.repos ?? []).flatMap((pattern) => {
    const repo = exactRepo(pattern)
    return repo ? [keyOf(repo)] : []
  })
  return parsed.data.flatMap((entry) => {
    if (entry.expires === undefined) return []
    const endsAt = Date.parse(`${entry.expires}T23:59:59.999Z`)
    if (endsAt - now.getTime() > ALLOWLIST_NOTICE_DAYS * DAY_MS) return []
    return [
      {
        id: `allowlist:${setting.id}:${entry.id}${entry.package ? `:${entry.package}` : ''}`,
        entry,
        expires: entry.expires,
        endsAt,
        since: new Date(endsAt - ALLOWLIST_NOTICE_DAYS * DAY_MS + 1).toISOString(),
        expired: isExpired(entry, now),
        repos,
      },
    ]
  })
}

/**
 * Budgets at or over their `warnPercent` this week. The first time one is seen over it in a week
 * is kept in kv, so its item keeps that date and appears at most once per budget and week.
 */
async function warnedBudgets(deps: ServerDeps): Promise<InboxSources['budgets']> {
  const { store } = deps
  const at = deps.now()
  const statuses = await budgetStatuses(await store.settings.list(budgetKey), store.aiUsage, at, {
    includeDefault: true,
  })
  const over = statuses.filter(
    (status) =>
      status.weeklyUsd > 0 && status.spentUsd >= (status.weeklyUsd * status.warnPercent) / 100,
  )
  return Promise.all(
    over.map(async (status) => {
      const key = budgetSeenKey(status.id, status.week.key)
      const seen = await store.kv?.get(key)
      if (typeof seen === 'string') return { status, since: seen }
      const since = at.toISOString()
      await store.kv?.set(key, since, 8 * 86_400)
      return { status, since }
    }),
  )
}

async function loadSources(deps: ServerDeps): Promise<InboxSources> {
  const { store } = deps
  const [
    proposedTasks,
    notes,
    proposedLearnings,
    families,
    sections,
    releases,
    allowlists,
    budgets,
    crossTeam,
  ] = await Promise.all([
    store.tasks.list({ status: ['proposed'] }),
    store.knowledge.list({ status: 'proposed' }),
    store.learnings.list({ status: ['proposed'] }),
    store.families.list(),
    store.guides.list(),
    releaseServiceFor(deps).snapshot(),
    store.settings.list('audit.allowlist'),
    warnedBudgets(deps),
    crossTeamPolicy(store.settings),
  ])

  const byGroup = new Map<string, AgentTask[]>()
  for (const task of proposedTasks)
    byGroup.set(task.groupId, [...(byGroup.get(task.groupId) ?? []), task])
  const tasks = (
    await Promise.all(
      [...byGroup].map(async ([id, proposed]) => {
        const group = await store.tasks.getGroup(id)
        return group && { group, proposed }
      }),
    )
  ).filter((entry) => entry !== undefined)

  const waiting = sections.flatMap((section) => {
    const pending = section.scope.startsWith('repo:') ? pendingGenerated(section) : undefined
    return pending ? [{ section, pending }] : []
  })
  const rejected = await Promise.all(
    waiting.map(async (entry) => ({
      ...entry,
      hashes: await rejectedHashes(store.kv, entry.section.scope, entry.section.section),
    })),
  )
  const learnings = proposedLearnings.map((candidate) => {
    const repo = parseRepo(candidate.repo)
    if (!repo) return candidate
    const family = familyOf(families, candidate.repo)?.id
    return withLiveTarget(candidate, scopesFor(repoTarget(deps.config, repo), family))
  })

  const guides = rejected
    .filter(({ pending, hashes }) => !hashes.has(pending.inputHash))
    .map(({ section, pending }) => ({ section, pending }))

  return {
    tasks,
    notes,
    learnings,
    guides,
    releases,
    allowlists,
    budgets,
    crossTeam,
  }
}

/** An allowlist notice in a sentence. */
export const allowlistTitle = (notice: AllowlistNotice) =>
  notice.expired
    ? `Allowlist entry for ${notice.entry.id} expired`
    : `Allowlist entry for ${notice.entry.id} expires on ${notice.expires}`

const usd = (value: number) => `$${value.toFixed(2)}`

/**
 * What a release whose target branch waits for a version needs, in a sentence: the acceptance
 * when the flow asks for one, else the first blocker, else the version itself.
 */
export function awaitingVersionTitle(card: ReleaseBoardRow): string {
  const version = card.next ? `version ${card.next}` : 'a version'
  if (card.acceptanceRequired && !card.acceptance)
    return `Changes wait for acceptance before ${version}`
  if (card.blockers.length) return `Creating ${version} is blocked: ${card.blockers[0]}`
  return card.acceptance ? `Accepted, waiting for ${version}` : `Ready to create ${version}`
}

/** What a release card waits for, in a sentence. */
function releaseTitle(card: ReleaseCard): string {
  const failed = card.deploy?.environments.find((env) => env.status === 'failed')
  if (failed && card.deploy) return `Deploy of ${card.deploy.tag} to ${failed.name} failed`
  if (card.stage === 'awaiting-version') return awaitingVersionTitle(card)
  if (card.stage === 'proposed') return 'Release proposed, waiting for acceptance'
  if (card.stage === 'candidate')
    return `${plural(card.unreleased, 'unreleased commit')}${card.unreleasedCapped ? '+' : ''} ready to propose`
  const ready = card.deploy?.environments.find((env) => env.status === 'ready')
  if (ready && card.deploy) return `${card.deploy.tag} is ready to deploy to ${ready.name}`
  return 'Release waits for a decision'
}

/**
 * The Inbox items `principal` may decide, from shared sources: task groups whose every proposed
 * task it may run, proposed notes and learnings it may read and accept (`knowledge:read` and
 * `knowledge:write`), generated Guide text of repositories it may read and edit, releases it may run
 * (`releases:run`) and allowlist entries expiring within `ALLOWLIST_NOTICE_DAYS` (or expired) whose
 * setting it may read and write (`settings:read` and `settings:write`), and budgets at or over their
 * `warnPercent` this week whose scope it may read AI usage in and change settings of (`ai:read`
 * and `settings:write`).
 */
function inboxItems(
  deps: Pick<ServerDeps, 'config'>,
  principal: Principal,
  sources: InboxSources,
  now: Date,
): Placed[] {
  const { config } = deps
  const label = groupLabeler(config)
  const groupsOfKey = (key: string) => {
    const repo = parseRepo(key)
    return repo ? repoTarget(config, repo).groups : []
  }
  const ref = (key: string): HomeRepoRef => ({ repo: key, groups: groupsOfKey(key) })
  const known = (key: string) => {
    const repo = parseRepo(key)
    return repo !== undefined && config.forges[repo.forge] !== undefined ? repo : undefined
  }
  const onRepo = (action: Parameters<typeof can>[1], key: string) => {
    const repo = known(key)
    return (
      repo !== undefined && can(principal, action, { kind: 'repo', repo: repoTarget(config, repo) })
    )
  }
  const mayEditRepo = (key: string) =>
    onRepo('knowledge:read', key) && onRepo('knowledge:write', key)
  const mayEditScope = (read: Action, write: Action, scope: Scope) =>
    can(principal, read, { kind: 'scope', scope }) &&
    can(principal, write, { kind: 'scope', scope })
  const mayRunTask = (key: string) => {
    const repo = known(key)
    if (!repo) return false
    const target = repoTarget(config, repo)
    if (!can(principal, 'tasks:run', { kind: 'repo', repo: target })) return false
    return (
      can(principal, 'repos:read', { kind: 'repo', repo: target }) ||
      canSeeCatalog(principal, target, sources.crossTeam)
    )
  }
  const scopeRepos = (scope: Scope) =>
    (scope.repos ?? []).flatMap((pattern) => {
      const repo = exactRepo(pattern)
      return repo ? [ref(keyOf(repo))] : []
    })
  const scopeMemberships = (scope: Scope) =>
    scopeOwner(scope, (repo) => repoTarget(config, repo).groups).map((group) => [group])
  const placed: Placed[] = []

  for (const { group, proposed } of sources.tasks) {
    if (!canSeeGroup({ config }, principal, group)) continue
    if (!proposed.every((task) => mayRunTask(task.repo))) continue
    const repos = [...new Set(proposed.map((task) => task.repo))].map(ref)
    placed.push({
      item: {
        id: `task:${group.id}`,
        kind: 'task',
        title: group.title,
        scope:
          repos.length === 1
            ? parseRepo(repos[0]!.repo)!.path
            : plural(repos.length, 'repository', 'repositories'),
        repos,
        ...(group.plan || group.prompt ? { detail: firstLine(group.plan ?? group.prompt) } : {}),
        href: webPaths.tasks({ group: group.id }),
        createdAt: group.createdAt,
        proposedBy: group.proposedBy,
        snoozed: false,
        groupId: group.id,
        taskKind: group.kind,
      },
      memberships: repos.map((repo) => repo.groups),
    })
  }

  for (const entry of sources.notes) {
    if (!mayEditScope('knowledge:read', 'knowledge:write', entry.scope)) continue
    placed.push({
      item: {
        id: `note:${entry.id}`,
        kind: 'note',
        title: entry.title,
        scope: scopeText(entry.scope, label),
        repos: scopeRepos(entry.scope),
        ...(firstLine(entry.body) && { detail: firstLine(entry.body) }),
        href: webPaths.knowledge('notes'),
        createdAt: entry.createdAt,
        proposedBy: entry.author,
        snoozed: false,
        entryId: entry.id,
        version: entry.version,
      },
      memberships: scopeMemberships(entry.scope),
    })
  }

  for (const candidate of sources.learnings) {
    if (!mayEditRepo(candidate.repo)) continue
    const repo = ref(candidate.repo)
    placed.push({
      item: {
        id: `learning:${candidate.id}`,
        kind: 'learning',
        title: candidate.rule,
        scope: parseRepo(candidate.repo)!.path,
        repos: [repo],
        ...(candidate.proposal?.reason && { detail: firstLine(candidate.proposal.reason) }),
        href: webPaths.knowledge('learnings', { space: `repo:${candidate.repo}` }),
        createdAt: candidate.createdAt,
        ...(candidate.proposal && { proposedBy: candidate.proposal.by }),
        snoozed: false,
        learningId: candidate.id,
        section: candidate.section,
        suggestedScope: candidate.suggestedScope,
        ...(candidate.targetScope && { targetScope: candidate.targetScope }),
      },
      memberships: [repo.groups],
    })
  }

  for (const { section, pending } of sources.guides) {
    const key = section.scope.slice('repo:'.length)
    if (!mayEditRepo(key)) continue
    const repo = ref(key)
    placed.push({
      item: {
        id: `guide:${section.scope}:${section.section}`,
        kind: 'guide',
        title: `New generated ${section.section} guidance`,
        scope: parseRepo(key)!.path,
        repos: [repo],
        ...(firstLine(pending.body) && { detail: firstLine(pending.body) }),
        href: webPaths.knowledge('guide', { space: section.scope, section: section.section }),
        createdAt: pending.generatedAt,
        snoozed: false,
        guideScope: section.scope,
        section: section.section,
        inputHash: pending.inputHash,
        generatedAt: pending.generatedAt,
      },
      memberships: [repo.groups],
    })
  }

  for (const card of sources.releases) {
    if (!card.needsAction || card.dismissed || card.head === undefined) continue
    const key = keyOf(card.repo)
    if (!onRepo('releases:read', key)) continue
    const allowed = releaseCan(config, principal, card)
    if (!allowed.run) continue
    const repo = ref(key)
    placed.push({
      item: {
        id: `release:${key}`,
        kind: 'release',
        title: releaseTitle(card),
        scope: card.repo.path,
        repos: [repo],
        href: webPaths.releaseTimeline(key),
        createdAt: card.waitingSince ?? card.acceptance?.at ?? now.toISOString(),
        snoozed: false,
        repo: key,
        stage: card.stage,
        ...(card.next !== undefined && { next: card.next }),
        head: card.head,
        can: allowed,
      },
      memberships: [repo.groups],
    })
  }

  for (const setting of sources.allowlists) {
    if (!mayEditScope('settings:read', 'settings:write', setting.scope)) continue
    for (const notice of allowlistNotices(setting, now)) {
      const { entry, expired } = notice
      placed.push({
        item: {
          id: notice.id,
          kind: 'allowlist',
          title: allowlistTitle(notice),
          scope: scopeText(setting.scope, label),
          repos: notice.repos.map(ref),
          detail: firstLine(entry.reason),
          href: webPaths.security(),
          createdAt: notice.since,
          snoozed: false,
          dueAt: new Date(notice.endsAt).toISOString(),
          settingId: setting.id,
          settingScope: setting.scope,
          entry,
          expires: notice.expires,
          expired,
        },
        memberships: scopeMemberships(setting.scope),
      })
    }
  }

  for (const { status, since } of sources.budgets) {
    if (!canReadAiScope(principal, status.scope)) continue
    if (!can(principal, 'settings:write', { kind: 'scope', scope: status.scope })) continue
    placed.push({
      item: {
        id: `budget:${status.id}:${status.week.key}`,
        kind: 'budget',
        title: `AI spend reached ${Math.floor(status.percent)}% of the ${usd(status.weeklyUsd)} weekly budget`,
        scope: scopeText(status.scope, label),
        repos: scopeRepos(status.scope),
        detail:
          status.action === 'block'
            ? `${usd(status.spentUsd)} spent; automatic work stops at ${usd(status.weeklyUsd - status.reserveUsd)}, everything at ${usd(status.weeklyUsd)}`
            : `${usd(status.spentUsd)} spent; this budget only warns, nothing stops`,
        href: webPaths.settings('ai'),
        createdAt: since,
        snoozed: false,
        dueAt: status.week.to,
        week: status.week.key,
        spentUsd: status.spentUsd,
        weeklyUsd: status.weeklyUsd,
        warnPercent: status.warnPercent,
        ...(status.id !== 'default' && { settingId: status.id }),
      },
      memberships: scopeMemberships(status.scope),
    })
  }
  return placed
}

const oldestFirst = (a: InboxItem, b: InboxItem) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

const awake = (items: readonly InboxItem[]) => items.filter((item) => !item.snoozed).length

/**
 * Splits items into `mine` (within the home groups, or above every team) and `teams`; without home
 * groups everything is `mine`. Each section is oldest first.
 */
function sectionItems(
  placed: readonly Placed[],
  homeGroups: readonly GroupMatch[],
  snoozed: ReadonlySet<string>,
): Pick<InboxFeed, 'mine' | 'teams'> {
  const mine: InboxItem[] = []
  const teams: InboxItem[] = []
  for (const { item, memberships } of placed) {
    const marked = { ...item, snoozed: snoozed.has(item.id) }
    const home =
      homeGroups.length === 0 ||
      memberships.length === 0 ||
      memberships.some((groups) => groupsMatch(homeGroups, groups))
    ;(home ? mine : teams).push(marked)
  }
  return { mine: mine.toSorted(oldestFirst), teams: teams.toSorted(oldestFirst) }
}

/** The Inbox of a server: raw sources cached for `INBOX_CACHE_MS`, filtered per caller. */
function createInboxService(deps: ServerDeps) {
  let cached: { expires: number; sources: Promise<InboxSources> } | undefined

  const sources = () => {
    const at = deps.now().getTime()
    if (cached && cached.expires > at) return cached.sources
    const loading = loadSources(deps)
    const entry = { expires: at + INBOX_CACHE_MS, sources: loading }
    cached = entry
    loading.catch(() => {
      if (cached === entry) cached = undefined
    })
    return loading
  }

  const sectioned = async (principal: Principal) => {
    const now = deps.now()
    const [raw, homeGroups, snoozed] = await Promise.all([
      sources(),
      homeGroupsOf(deps, principal),
      snoozedIds(deps.store.kv, principal.id, now),
    ])
    return sectionItems(inboxItems(deps, principal, raw, now), homeGroups, snoozed)
  }

  /** `GET /api/inbox` for `principal`. */
  const feed = async (principal: Principal): Promise<InboxFeed> => {
    const { mine, teams } = await sectioned(principal)
    const proposers = [...mine, ...teams].flatMap((item) =>
      item.proposedBy ? [item.proposedBy] : [],
    )
    return { mine, teams, people: await peopleOf(deps, proposers) }
  }

  /** `GET /api/inbox/count` for `principal`: sizes of the sections without snoozed items. */
  const count = async (principal: Principal): Promise<InboxCount> => {
    const { mine, teams } = await sectioned(principal)
    const result = { mine: awake(mine), teams: awake(teams) }
    return { ...result, total: result.mine + result.teams }
  }

  /** Drops the cached sources, so the next read sees a decision just made. */
  const invalidate = () => {
    cached = undefined
  }

  return { feed, count, invalidate }
}

type InboxService = ReturnType<typeof createInboxService>

const services = new WeakMap<ServerDeps, InboxService>()

/** The one Inbox service of a server, shared by its routes and the invalidating middleware. */
export function inboxServiceFor(deps: ServerDeps): InboxService {
  let service = services.get(deps)
  if (!service) {
    service = createInboxService(deps)
    services.set(deps, service)
  }
  return service
}
