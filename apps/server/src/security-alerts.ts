import { rootPrincipal } from '@holtkeeper/access'
import type { FindingGroup, FindingRepo } from '@holtkeeper/api'
import type { RepoRef } from '@holtkeeper/forge'
import type { KvStore } from '@holtkeeper/store'
import {
  type SecurityAlertsSettings,
  type TriageVerdict,
  fetchAdvisoryDetails,
  isMalwareAdvisory,
  securityAlertsSettingKey,
  securityAlertsSettings,
  triageAdvisory,
  triageCategories,
} from '@holtkeeper/vuln-triage'
import { webPaths, webUrl } from '@holtkeeper/web-paths'
import { z } from 'zod'

import type { ServerDeps } from './context.ts'
import { readFindings } from './findings.ts'
import { type SlackPoster, slackWebPoster } from './slack/client.ts'
import { slackConnection } from './slack/connection.ts'
import {
  type AlertRepository,
  type SecurityAlertContent,
  securityAlertMessage,
  securityAlertReply,
} from './slack/security-alert.ts'

/** Where the alerts' state lives in `store.kv`. */
const SECURITY_ALERTS_KEY = 'security:alerts:state'
const AGENT_ACTOR = 'agent:security-alerts'
/** AI triage calls per sweep at most; the rest wait for the next sweep. */
const TRIAGE_PER_SWEEP = 10
/** New messages per sweep at most, so turning alerts on over a large backlog does not flood. */
const POSTS_PER_SWEEP = 10
/** Slack errors meaning a posted message can no longer be edited: it is dropped from the alert. */
const GONE_ERRORS: ReadonlySet<string> = new Set([
  'message_not_found',
  'channel_not_found',
  'is_archived',
  'not_in_channel',
])
/** Alerts nobody has seen for this long are forgotten. */
const FORGET_MS = 90 * 86_400_000

const repoSchema = z.object({
  label: z.string(),
  url: z.string().optional(),
  versions: z.array(z.string()),
  fixing: z.boolean().optional(),
})

const contentSchema = z.object({
  advisory: z.object({
    id: z.string(),
    url: z.string().optional(),
    aliases: z.array(z.string()),
    summary: z.string().optional(),
  }),
  package: z.string(),
  ecosystem: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']),
  fixedIn: z.array(z.string()),
  category: z.enum(triageCategories),
  reason: z.string(),
  repos: z.array(repoSchema),
  resolvedAt: z.string().optional(),
  moreUrl: z.string().optional(),
})

const alertSchema = z.object({
  advisory: z.string(),
  package: z.string(),
  ecosystem: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  verdict: z
    .object({
      urgent: z.boolean(),
      category: z.enum(triageCategories),
      reason: z.string(),
      by: z.enum(['rule', 'ai']),
      at: z.string(),
    })
    .optional(),
  triageAttempts: z.number().int().default(0),
  triageRetryAt: z.string().optional(),
  /** `waiting`: not posted yet (untriaged or urgent); `quiet`: triaged as not urgent. */
  status: z.enum(['waiting', 'posted', 'quiet']),
  postAttempts: z.number().int().default(0),
  postRetryAt: z.string().optional(),
  posts: z.array(z.object({ channel: z.string(), ts: z.string() })).default([]),
  /** Repositories (`forge:path`) the posted message names. */
  repos: z.array(z.string()).default([]),
  /** What the posted message shows, to rewrite it once resolved. */
  shown: contentSchema.optional(),
  resolvedAt: z.string().optional(),
})

const stateSchema = z.object({ alerts: z.record(z.string(), alertSchema) })

/** One advisory and package the alerts follow, and how far reporting it got. */
type SecurityAlert = z.infer<typeof alertSchema>
/** What the store keeps: every followed advisory and package by `advisory|ecosystem|package`. */
type SecurityAlertsState = z.infer<typeof stateSchema>

/** A finding group the settings make a candidate: its repositories without allowlisted ones. */
interface Candidate {
  group: FindingGroup
  repos: FindingRepo[]
  malware: boolean
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const keyOf = (group: Pick<FindingGroup, 'advisory' | 'ecosystem' | 'package'>) =>
  `${group.advisory}|${group.ecosystem}|${group.package}`

const refOf = (key: string): RepoRef => {
  const at = key.indexOf(':')
  return { forge: key.slice(0, at), path: key.slice(at + 1) }
}

/** Hours before the next try after `attempts` failures: 1, 2, 4, … up to a day. */
const triageDelayMs = (attempts: number) => Math.min(2 ** Math.max(attempts - 1, 0), 24) * 3_600_000

/** Minutes before the next post after `attempts` refused ones: 1, 2, 4, … up to an hour. */
const postDelayMs = (attempts: number) => Math.min(2 ** Math.max(attempts - 1, 0), 60) * 60_000

const malwareVerdict = (group: FindingGroup): Omit<TriageVerdict, 'urgent'> => ({
  category: 'malware',
  reason: `${group.advisory} reports ${group.package} as a malicious package. Remove it, then rotate the credentials and check the machines that installed it.`,
})

/** Posts an alert to every channel; answers the messages Slack accepted and the errors. */
const postAll = async (
  poster: SlackPoster,
  channels: readonly string[],
  content: SecurityAlertContent,
) => {
  const posts: { channel: string; ts: string }[] = []
  const errors: string[] = []
  const message = securityAlertMessage(content)
  for (const channel of channels) {
    // oxlint-disable-next-line no-await-in-loop -- channels in order, within Slack's rate limits
    const result = await poster.post({ channel, ...message })
    if (result.ok && result.ts) posts.push({ channel: result.channel ?? channel, ts: result.ts })
    else errors.push(result.error ?? 'unknown_error')
  }
  return { posts, errors }
}

/** Urgent vulnerability alerts in Slack; see `createSecurityAlerts`. */
export interface SecurityAlerts {
  /** Triages new candidates, posts what is due and updates posted alerts. */
  sweep(): Promise<void>
  /** The stored state: every followed advisory and package. */
  state(): Promise<SecurityAlertsState>
}

/** Options of `createSecurityAlerts`. */
export interface SecurityAlertsOptions {
  /** For OSV advisory details. Default: global `fetch`. */
  fetch?: typeof fetch
  log?: (line: string) => void
}

/**
 * Urgent vulnerability alerts: a Slack message in the `security.alerts` channels per advisory and
 * package that needs a reaction now, naming every repository whose newest audit has it. Each sweep
 * groups the fleet's findings (`readFindings`, allowlisted repositories left out) and keeps those
 * that are malware (always) or of a listed severity. Malware is urgent by rule; the others are
 * triaged once by the AI (`triageAdvisory`, with OSV details) and the verdict is kept, so a
 * non-urgent advisory is never asked about again. An urgent one is posted `windowMinutes` after it
 * was first seen, so audits of other repositories can join the same message. Posted messages
 * follow the fleet: repositories that get the advisory are added to the message and named in its
 * thread, repositories that lose it are dropped, and when none has it left the message is marked
 * resolved (and reopened with a thread reply if it comes back). State lives in one `kv` document;
 * the sweep runs as a leader duty, so one process posts. Nothing here throws to the caller except
 * store failures; Slack and AI failures are logged and retried with backoff.
 */
export function createSecurityAlerts(
  deps: ServerDeps,
  options: SecurityAlertsOptions = {},
): SecurityAlerts {
  const { config, store } = deps
  const log = options.log ?? ((line: string) => console.error(line))
  const kv: KvStore | undefined = store.kv
  const kinds = new Map(deps.analyses.map((kind) => [kind.kind, kind]))

  const nowIso = () => deps.now().toISOString()

  const read = async (): Promise<SecurityAlertsState> =>
    stateSchema.safeParse(await kv?.get(SECURITY_ALERTS_KEY)).data ?? { alerts: {} }

  const save = async (state: SecurityAlertsState) => kv?.set(SECURITY_ALERTS_KEY, state)

  const settingsOf = async (): Promise<SecurityAlertsSettings> => {
    const entry = (await store.settings.list(securityAlertsSettingKey)).find(
      (candidate) => candidate.scope.all === true && !candidate.secret,
    )
    return securityAlertsSettings(entry?.value)
  }

  const posterFor = async (): Promise<SlackPoster | undefined> => {
    const connection = await slackConnection(deps)
    if (!connection) return undefined
    return (
      deps.slackPoster?.(connection.botToken) ?? slackWebPoster({ token: connection.botToken, log })
    )
  }

  const repoUrl = (repo: RepoRef) => {
    const forge = config.forges[repo.forge]
    return forge ? `${forge.url.replace(/\/+$/u, '')}/${repo.path}` : undefined
  }

  const moreUrl = () => {
    const base = config.server?.publicUrl
    return base ? webUrl(base, webPaths.security()) : undefined
  }

  const alertRepos = (repos: readonly FindingRepo[]): AlertRepository[] =>
    repos.map((entry) => {
      const repo = refOf(entry.repo)
      const url = repoUrl(repo)
      return {
        label: repo.path,
        ...(url && { url }),
        versions: entry.versions,
        ...(entry.status === 'fixing' && { fixing: true }),
      }
    })

  const contentOf = (candidate: Candidate, alert: SecurityAlert): SecurityAlertContent => {
    const { group } = candidate
    const more = moreUrl()
    return {
      advisory: {
        id: group.advisory,
        aliases: group.aliases,
        ...(group.url && { url: group.url }),
        ...(group.summary && { summary: group.summary }),
      },
      package: group.package,
      ecosystem: group.ecosystem,
      severity: group.severity,
      fixedIn: group.fixedIn,
      category: alert.verdict?.category ?? 'other',
      reason: alert.verdict?.reason ?? '',
      repos: alertRepos(candidate.repos),
      ...(more && { moreUrl: more }),
    }
  }

  const candidatesOf = async (settings: SecurityAlertsSettings) => {
    const { groups } = await readFindings(
      { config, store, kinds, today: nowIso().slice(0, 10) },
      rootPrincipal('system', 'security-alerts'),
    )
    const candidates = new Map<string, Candidate>()
    for (const group of groups) {
      const repos = group.repos.filter((repo) => repo.status !== 'allowlisted')
      if (repos.length === 0) continue
      const malware = isMalwareAdvisory({
        id: group.advisory,
        aliases: group.aliases,
        ...(group.summary && { summary: group.summary }),
      })
      if (!malware && !settings.severities.includes(group.severity)) continue
      candidates.set(keyOf(group), { group, repos, malware })
    }
    return candidates
  }

  const triage = async (
    candidate: Candidate,
    settings: SecurityAlertsSettings,
  ): Promise<TriageVerdict> => {
    const { group, repos } = candidate
    const lead = repos[0]
    const agent = lead ? await deps.automaticAgentFor?.(refOf(lead.repo), AGENT_ACTOR) : undefined
    if (!agent) throw new Error('no AI agent is configured')
    const details = await fetchAdvisoryDetails(group.advisory, {
      ...(options.fetch && { fetch: options.fetch }),
    })
    return triageAdvisory(
      agent,
      {
        id: group.advisory,
        aliases: group.aliases,
        ...(group.summary && { summary: group.summary }),
        package: group.package,
        ecosystem: group.ecosystem,
        severity: group.severity,
        versions: [...new Set(repos.flatMap((repo) => repo.versions))],
        fixedIn: group.fixedIn,
        repositories: repos.length,
        ...(details && { details }),
      },
      settings.language ? { language: settings.language } : {},
    )
  }

  /** Rewrites every posted message of an alert; `true` when Slack took each update. */
  const rewrite = async (
    poster: SlackPoster,
    alert: SecurityAlert,
    content: SecurityAlertContent,
  ) => {
    const message = securityAlertMessage(content)
    let ok = true
    const kept: SecurityAlert['posts'] = []
    for (const target of alert.posts) {
      // oxlint-disable-next-line no-await-in-loop -- one message per channel
      const result = await poster.update({ channel: target.channel, ts: target.ts, ...message })
      if (result.ok) kept.push(target)
      else if (result.error && GONE_ERRORS.has(result.error)) {
        log(
          `security alerts: message of ${alert.advisory} is gone (${result.error}); no longer followed there`,
        )
      } else {
        ok = false
        kept.push(target)
        log(`security alerts: updating ${alert.advisory} refused: ${result.error ?? '?'}`)
      }
    }
    alert.posts = kept
    return ok
  }

  const reply = async (
    poster: SlackPoster,
    alert: SecurityAlert,
    kind: 'added' | 'reopened',
    repos: readonly AlertRepository[],
  ) => {
    const message = securityAlertReply(kind, repos, moreUrl())
    for (const target of alert.posts) {
      // oxlint-disable-next-line no-await-in-loop -- one reply per channel
      const result = await poster.post({ channel: target.channel, threadTs: target.ts, ...message })
      if (!result.ok)
        log(`security alerts: thread reply on ${alert.advisory} refused: ${result.error ?? '?'}`)
    }
  }

  const sweep = async () => {
    if (!kv) return
    const settings = await settingsOf()
    if (settings.channels.length === 0) return
    const now = deps.now().getTime()
    const at = nowIso()
    const candidates = await candidatesOf(settings)
    const state = await read()

    for (const [key, candidate] of candidates) {
      const known = state.alerts[key]
      if (known) known.lastSeenAt = at
      else
        state.alerts[key] = {
          advisory: candidate.group.advisory,
          package: candidate.group.package,
          ecosystem: candidate.group.ecosystem,
          firstSeenAt: at,
          lastSeenAt: at,
          triageAttempts: 0,
          status: 'waiting',
          postAttempts: 0,
          posts: [],
          repos: [],
        }
    }
    // Forget what has been gone for long; a resolved or unposted alert that comes back starts over.
    for (const [key, alert] of Object.entries(state.alerts)) {
      if (candidates.has(key) || now - Date.parse(alert.lastSeenAt) < FORGET_MS) continue
      if (alert.status === 'posted' && !alert.resolvedAt) continue
      delete state.alerts[key]
    }
    await save(state)

    // Triage: malware by rule, the rest by the AI, each advisory once.
    let calls = 0
    for (const [key, candidate] of candidates) {
      const alert = state.alerts[key]
      if (!alert || alert.verdict) continue
      if (candidate.malware) {
        alert.verdict = { urgent: true, ...malwareVerdict(candidate.group), by: 'rule', at }
      } else {
        if (alert.triageRetryAt && Date.parse(alert.triageRetryAt) > now) continue
        if (calls >= TRIAGE_PER_SWEEP) continue
        calls += 1
        try {
          // oxlint-disable-next-line no-await-in-loop -- one AI call at a time, capped per sweep
          const verdict = await triage(candidate, settings)
          alert.verdict = { ...verdict, by: 'ai', at }
          delete alert.triageRetryAt
          if (!verdict.urgent) alert.status = 'quiet'
        } catch (error) {
          alert.triageAttempts += 1
          alert.triageRetryAt = new Date(now + triageDelayMs(alert.triageAttempts)).toISOString()
          log(`security alerts: triage of ${alert.advisory} failed: ${messageOf(error)}`)
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- keep each verdict even if a later call dies
      await save(state)
    }

    const waiting = [...candidates].filter(([key]) => {
      const alert = state.alerts[key]
      return alert?.status === 'waiting' && alert.verdict?.urgent
    })
    const due = waiting.filter(([key]) => {
      const alert = state.alerts[key]!
      return (
        now >= Date.parse(alert.firstSeenAt) + settings.windowMinutes * 60_000 &&
        !(alert.postRetryAt && Date.parse(alert.postRetryAt) > now)
      )
    })
    const posted = Object.values(state.alerts).filter((alert) => alert.status === 'posted')
    if (due.length === 0 && posted.length === 0) return

    const poster = await posterFor()
    if (!poster) {
      if (due.length) log('security alerts: no Slack credential; urgent alerts wait')
      return
    }

    // New alerts.
    let sent = 0
    for (const [key, candidate] of due) {
      if (sent >= POSTS_PER_SWEEP) break
      const alert = state.alerts[key]!
      sent += 1
      const content = contentOf(candidate, alert)
      let result: { posts: { channel: string; ts: string }[]; errors: string[] }
      try {
        // oxlint-disable-next-line no-await-in-loop -- one alert at a time, within Slack's limits
        result = await postAll(poster, settings.channels, content)
      } catch (error) {
        result = { posts: [], errors: [messageOf(error)] }
      }
      if (result.errors.length)
        log(
          `security alerts: ${alert.advisory} ${result.posts.length ? 'partly posted' : 'not posted yet'}: ${result.errors.join(', ')}`,
        )
      if (result.posts.length) {
        alert.status = 'posted'
        alert.posts = result.posts
        alert.repos = candidate.repos.map((repo) => repo.repo)
        alert.shown = content
        delete alert.postRetryAt
      } else {
        alert.postAttempts += 1
        alert.postRetryAt = new Date(now + postDelayMs(alert.postAttempts)).toISOString()
      }
      // oxlint-disable-next-line no-await-in-loop -- a posted alert is recorded before the next
      await save(state)
    }

    // Posted alerts follow the fleet.
    for (const alert of posted) {
      const key = keyOf({
        advisory: alert.advisory,
        ecosystem: alert.ecosystem,
        package: alert.package,
      })
      const candidate = candidates.get(key)
      try {
        if (candidate) {
          const repos = candidate.repos.map((repo) => repo.repo)
          const content = contentOf(candidate, alert)
          const added = candidate.repos.filter((repo) => !alert.repos.includes(repo.repo))
          const reopened = alert.resolvedAt !== undefined
          const changed =
            reopened ||
            added.length > 0 ||
            repos.length !== alert.repos.length ||
            JSON.stringify(content.repos) !== JSON.stringify(alert.shown?.repos)
          if (!changed) continue
          // oxlint-disable-next-line no-await-in-loop -- one alert at a time
          if (!(await rewrite(poster, alert, content))) continue
          if (reopened) {
            // oxlint-disable-next-line no-await-in-loop -- see above
            await reply(poster, alert, 'reopened', content.repos)
          } else if (added.length) {
            // oxlint-disable-next-line no-await-in-loop -- see above
            await reply(poster, alert, 'added', alertRepos(added))
          }
          delete alert.resolvedAt
          alert.repos = repos
          alert.shown = content
        } else if (!alert.resolvedAt && alert.shown) {
          const content = { ...alert.shown, resolvedAt: at }
          // oxlint-disable-next-line no-await-in-loop -- one alert at a time
          if (!(await rewrite(poster, alert, content))) continue
          alert.resolvedAt = at
          alert.shown = content
        } else continue
      } catch (error) {
        log(`security alerts: updating ${alert.advisory} failed: ${messageOf(error)}`)
        continue
      }
      // oxlint-disable-next-line no-await-in-loop -- each change recorded once Slack took it
      await save(state)
    }
  }

  return { sweep, state: read }
}
