import type {
  AuditEvent,
  AuditVerifyLast,
  AuditVerifyResponse,
  HistorySummary,
} from '@holtkeeper/api'

/** Sentences for the actions Holtkeeper records, by full action name. */
const sentences: Record<string, string> = {
  'setting.create': 'Added a setting',
  'setting.update': 'Changed a setting',
  'setting.delete': 'Removed a setting',
  'setting.seed': 'Seeded default settings',
  'setting.draft': 'Saved several setting changes',
  'config.seed': 'Seeded the default config',
  'credential.create': 'Added a credential',
  'credential.update': 'Changed a credential',
  'credential.delete': 'Removed a credential',
  'credential.rotate': 'Rotated a credential',
  'user.create': 'Added a person',
  'user.update': 'Changed a person',
  'user.delete': 'Removed a person',
  'user.invited': 'Invited a person',
  'user.invite': 'Sent an invite again',
  'user.recovery': 'Issued a recovery link',
  'user.link_issued': 'Issued a sign-in link',
  'user.preferences': 'Changed preferences',
  'user.avatar': 'Changed an avatar',
  'account.link': 'Linked an account',
  'account.unlink': 'Unlinked an account',
  'account.verify': 'Verified an account',
  'account.challenge': 'Asked to verify an account',
  'mcp_token.create': 'Created an agent token',
  'mcp_token.delete': 'Revoked an agent token',
  'release.cut': 'Cut a release',
  'release.dismiss': 'Dismissed a release',
  'task.approve': 'Approved a write task',
  'task.reject': 'Rejected a write task',
  'task.cancel': 'Cancelled a write task',
  'task.retry': 'Retried a write task',
  'job.create': 'Ran an analyzer by hand',
  'job.cancel': 'Cancelled a job',
  'allowlist.renew': 'Extended an allowlist entry',
  'guide.accept': 'Accepted a Guide change',
  'guide.reject': 'Rejected a Guide change',
  'guide.update': 'Edited the Guide',
  'guide.restore': 'Restored a Guide revision',
  'guide.regenerate': 'Regenerated a Guide section',
  'learning.propose': 'Proposed a learning',
  'learnings.accept': 'Accepted learnings',
  'repo.discover': 'Discovered repositories',
  'repo.avatar_set': 'Set a repository avatar',
  'repo.avatar_delete': 'Removed a repository avatar',
  'storage.clear': 'Cleared a storage area',
  'egress_cache.delete': 'Cleared cached downloads',
  'audit.export': 'Exported the audit log',
  'audit.verify': 'Verified the hash chain',
  'ai.budget_exceeded': 'Stopped work at the AI budget',
  'chat.thread.create': 'Started a chat thread',
  'chat.thread.update': 'Changed a chat thread',
  'chat.thread.export': 'Exported a chat thread',
  'chat.message': 'Sent a chat message',
  'analysis.ingest': 'Uploaded an analysis',
  'tracker.publish': 'Published to a tracker',
  'slack.connect': 'Connected Slack',
  'slack.disconnect': 'Disconnected Slack',
}

const verbs: Record<string, string> = {
  create: 'Added',
  update: 'Changed',
  delete: 'Removed',
}

/**
 * An action as a sentence for the audit log: `credential.rotate` → `Rotated a credential`.
 * Actions without a sentence read `Changed a trigger` for create/update/delete verbs and
 * `Mr policy run` otherwise, so new actions still show.
 */
export function auditActionLabel(action: string): string {
  const known = sentences[action]
  if (known) return known
  const parts = action.split('.')
  const verb = parts.at(-1) ?? action
  const object = parts.slice(0, -1).join(' ').replaceAll('_', ' ')
  const past = verbs[verb]
  if (past && object) return `${past} ${/^[aeiou]/i.test(object) ? 'an' : 'a'} ${object}`
  const words = action.replaceAll('.', ' ').replaceAll('_', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Who acted: a person, one of Holtkeeper's agents, or Holtkeeper itself (jobs, webhooks, sweeps). */
type AuditActorKind = 'person' | 'agent' | 'system'

/** The kind of an event's actor, from its id and provider. */
export function auditActorKind(actor: AuditEvent['actor']): AuditActorKind {
  if (actor.id.startsWith('agent:') || actor.provider === 'agent') return 'agent'
  if (actor.id === 'system' || actor.provider === 'job' || actor.provider === 'system')
    return 'system'
  return 'person'
}

/** Where an event applies: its repository, or `Organization` for instance-wide events. */
export const auditScopeLabel = (event: Pick<AuditEvent, 'target'>): string =>
  event.target.repo ?? 'Organization'

/** An event's sequence number as the log shows it: `#48,210`. */
export const formatSeq = (seq: number): string => `#${seq.toLocaleString('en-US')}`

const pad = (value: number) => String(value).padStart(2, '0')

/** `14:41` in the viewer's time zone, 24-hour, the same in every locale. */
export function formatClock(at: string | Date): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const localDay = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** One day of the audit log: `title` is `Today`, `Yesterday` or the weekday, `date` the full day. */
interface AuditDay<E> {
  /** Local `YYYY-MM-DD`. */
  key: string
  title: string
  /** `Wednesday, Nov 11`, with the year when it is not the current one. */
  date: string
  events: E[]
}

/**
 * Events grouped by the viewer's local calendar day, in the order given (newest first in the
 * log). Today and yesterday are named; days within the last week show their weekday, older ones
 * their date.
 */
export function auditDays<E extends Pick<AuditEvent, 'at'>>(
  events: readonly E[],
  now: Date,
): AuditDay<E>[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days: AuditDay<E>[] = []
  for (const event of events) {
    const at = new Date(event.at)
    const key = localDay(at)
    let day = days.at(-1)
    if (day?.key !== key) {
      const start = new Date(at.getFullYear(), at.getMonth(), at.getDate())
      const ago = Math.round((today.getTime() - start.getTime()) / 86_400_000)
      const weekday = weekdays[at.getDay()] ?? ''
      const year = at.getFullYear() === now.getFullYear() ? '' : `, ${at.getFullYear()}`
      const date = `${weekday}, ${months[at.getMonth()] ?? ''} ${at.getDate()}${year}`
      const title =
        ago === 0
          ? 'Today'
          : ago === 1
            ? 'Yesterday'
            : ago > 1 && ago < 7
              ? weekday
              : `${months[at.getMonth()] ?? ''} ${at.getDate()}${year}`
      day = { key, title, date, events: [] }
      days.push(day)
    }
    day.events.push(event)
  }
  return days
}

/** The figures of the audit log's summary strip. */
interface AuditStripCounts {
  total: number
  denied: number
  failed: number
  people: number
  agents: number
  system: boolean
}

/**
 * Summary strip figures: events, denied and failed ones, and how many people and agents acted,
 * plus whether Holtkeeper itself did. Actor kinds come from the summary's actor ids.
 */
export function auditStripCounts(
  summary: Pick<HistorySummary, 'total' | 'actors'>,
  denied: number,
  failed: number,
): AuditStripCounts {
  const kinds = summary.actors.map((actor) =>
    auditActorKind({ id: actor.key, name: actor.name, provider: '' }),
  )
  return {
    total: summary.total,
    denied,
    failed,
    people: kinds.filter((kind) => kind === 'person').length,
    agents: kinds.filter((kind) => kind === 'agent').length,
    system: kinds.includes('system'),
  }
}

/** The chain check banner: tone, headline and the line under it. */
interface ChainStatus {
  tone: 'success' | 'danger' | 'default'
  title: string
  detail: string
}

const brokenReason = {
  hash: 'its content does not match its hash',
  link: 'it does not link to the event before it',
  gap: 'events before it are missing',
  tail: 'events at the end of the range are missing',
} as const

/**
 * The newest chain check as a banner: `Chain intact` with how many events it covered and when,
 * `Chain broken at #n` with the reason, or `Not checked yet`. `newestSeq` (the newest event the
 * viewer loaded) adds how many events wait for the next check. A check run by hand replaces the
 * daily one when given.
 */
export function chainStatus(
  last: AuditVerifyLast | undefined,
  newestSeq: number | undefined,
  manual?: AuditVerifyResponse,
): ChainStatus {
  const result = manual ?? last?.result
  if (!result)
    return { tone: 'default', title: 'Not checked yet', detail: 'The chain is checked daily.' }
  const range =
    result.firstSeq !== undefined && result.lastSeq !== undefined
      ? ` ${formatSeq(result.firstSeq)}–${formatSeq(result.lastSeq)}`
      : ''
  const when = manual
    ? 'checked just now'
    : last?.at
      ? `checked daily, last at ${formatClock(last.at)}`
      : ''
  const waiting =
    newestSeq !== undefined && result.lastSeq !== undefined && newestSeq > result.lastSeq
      ? newestSeq - result.lastSeq
      : 0
  const tail = [
    when,
    waiting
      ? `${waiting} newer ${waiting === 1 ? 'event waits' : 'events wait'} for the next check`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const checked = `${result.checked.toLocaleString('en-US')} ${result.checked === 1 ? 'event' : 'events'} checked${range}`
  if (result.ok || !result.broken)
    return {
      tone: 'success',
      title: 'Chain intact',
      detail: [checked, tail].filter(Boolean).join(' · '),
    }
  return {
    tone: 'danger',
    title: `Chain broken at ${formatSeq(result.broken.seq)}`,
    detail: [`${brokenReason[result.broken.reason]}; ${checked}`, tail].filter(Boolean).join(' · '),
  }
}
